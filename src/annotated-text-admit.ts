// Commit admission for annotated-text operations (issue #33 blockless).
//
// One continuous RGA text per document; annotations are document-scoped
// ranges; authoring positions are document-scoped frames carrying an absolute
// UTF-16 offset basis. This module does NOT write DB rows, mint authoring
// frames, or fold client ops — it admits a validated v9 command and returns the
// blockless operated event/plan.

import { createHash } from 'node:crypto';
import { ValidationError, type FieldDescriptor } from './field-strategy.ts';
import * as eventHandles from './event-handle.ts';
import { authorizeFieldOp } from './strategy/index.ts';
import { write } from './grant.ts';
import { restoreTextFamilySerialized, materializeText, textFamilyBasis, type ContinuousTextFamily } from './annotated-text-continuous.ts';
import { resolveAnnotatedTextOwningScope } from './annotated-text-field.ts';
import { resolveStream, resolveLease, resolvePosition } from './annotated-text-authoring-stream.ts';
import { readSeq } from './committed-log.ts';
import { planAnnotationRemove, planTextOffsetEdit, planTextRangeApply } from './annotated-text-plan.ts';
import type { StructuralEndpoint } from './annotated-text-family.ts';
import type { Principal } from './principal.ts';
import { rawRow } from './entity/query.ts';

interface Statement {
  run(...args: unknown[]): { changes: number };
  get(...args: unknown[]): any;
  all(...args: unknown[]): any[];
}

interface DbHandle {
  prepare(sql: string): Statement;
  exec(sql: string): unknown;
}

interface PositionToken {
  positionToken: string;
  offset: number;
  affinity: 'left' | 'right';
}

interface V9Annotation {
  id: string;
  family: string;
  fields?: Record<string, unknown>;
  protectedTargetIds?: readonly string[];
}

// The v9 edit is validated (shape-checked) before this module runs; the loose
// shape below reflects only the fields this admission reads, across every
// supported and rejected edit kind.
interface V9EditLoose {
  kind: string;
  at?: PositionToken;
  from?: PositionToken;
  to?: PositionToken;
  text?: string;
  positionToken?: string;
  annotationId?: string;
  annotation?: V9Annotation;
}

interface V9Command {
  version: 9;
  id: string;
  authoring: { version: 1; stream: string; lease: string; mutationId: string };
  edit: V9EditLoose;
}

interface EntityRecordLike {
  name: string;
  fields: Record<string, any>;
}

interface AuthoringStream {
  id: string;
}

interface AuthoringLease {
  id: string;
}

interface AuthoringPosition {
  visible_at_issue: number;
  family_checkpoint: string;
}

interface V9AdmitContext {
  name: string;
  fieldName: string;
  prefix: string;
  descriptor: FieldDescriptor;
  record: EntityRecordLike;
  compiledMeta: any;
  command: V9Command;
  db: DbHandle;
  scope: string;
  principal: Principal | null | undefined;
  actionId: string;
  handlers?: unknown;
}

interface V9Prelude extends V9AdmitContext {
  row: any;
  documentScope: string;
  stream: AuthoringStream;
  lease: AuthoringLease;
  state: any;
  family: ContinuousTextFamily;
  cursor: number;
  position: AuthoringPosition | null;
  actor: string;
  lamport: number;
}

interface LoadedAnnotation {
  id: string;
  family: string;
  empty: 'delete' | 'orphan';
  protectedTargetIds: string[];
}

interface LoadedRange {
  annotationId: string;
  start: StructuralEndpoint;
  end: StructuralEndpoint;
}

interface V9RangeApplyEdit {
  kind: 'annotation.apply';
  annotation: V9Annotation;
  from: PositionToken;
  to: PositionToken;
}

/** Resolve the authoring stream + lease for a v9 command. */
export function assertV9AuthoringBinding({ name, fieldName, prefix, command, db, principal }: {
  name: string;
  fieldName: string;
  prefix: string;
  command: V9Command;
  db: DbHandle;
  principal: Principal | null | undefined;
}): { stream: AuthoringStream; lease: AuthoringLease } {
  const stream = resolveStream({ db, prefix, streamToken: command.authoring.stream, documentId: command.id, principalType: principal?.type ?? 'principal', principalId: principal?.id ?? '' }) as AuthoringStream | null;
  if (!stream) throw new ValidationError(`${name}.${fieldName}.operation authoring stream unavailable`, { code: 'authoring-stream-unavailable' });
  const lease = resolveLease({ db, prefix, leaseToken: command.authoring.lease, streamId: stream.id }) as AuthoringLease | null;
  if (!lease) throw new ValidationError(`${name}.${fieldName}.operation authoring lease unavailable`, { code: 'authoring-lease-unavailable' });
  return { stream, lease };
}

function loadAnnotations({ db, prefix, compiledMeta, documentId }: {
  db: DbHandle;
  prefix: string;
  compiledMeta: any;
  documentId: string;
}): LoadedAnnotation[] {
  const rows = db.prepare(`SELECT id, family FROM ${prefix}_annotation WHERE document_id = ? ORDER BY id`).all(documentId);
  const targets = db.prepare(
    `SELECT annotation_id, target_annotation_id FROM ${prefix}_annotation_protected_target
      WHERE annotation_id IN (SELECT id FROM ${prefix}_annotation WHERE document_id = ?)
      ORDER BY annotation_id, target_annotation_id`,
  ).all(documentId);
  const targetsByAnnotation = new Map();
  for (const target of targets) targetsByAnnotation.set(target.annotation_id, [...(targetsByAnnotation.get(target.annotation_id) ?? []), target.target_annotation_id]);
  const annotations: LoadedAnnotation[] = [];
  for (const row of rows) {
    const metadata = compiledMeta.annotationHandles[row.family];
    if (!metadata) throw new ValidationError(`annotated-text unknown annotation family '${row.family}'`);
    annotations.push({ id: row.id, family: row.family, empty: metadata.empty, protectedTargetIds: targetsByAnnotation.get(row.id) ?? [] });
  }
  return annotations;
}

function loadRanges({ db, prefix, documentId }: {
  db: DbHandle;
  prefix: string;
  documentId: string;
}): LoadedRange[] {
  const rows = db.prepare(`SELECT annotation_id, start_point, end_point FROM ${prefix}_membership WHERE annotation_id IN (SELECT id FROM ${prefix}_annotation WHERE document_id = ?)`).all(documentId);
  return rows.map((row) => ({
    annotationId: row.annotation_id,
    start: JSON.parse(row.start_point),
    end: JSON.parse(row.end_point),
  }));
}

/** Cross-cutting admission shared by every edit kind. */
async function assertV9AuthoringPrelude(ctx: V9AdmitContext): Promise<V9Prelude> {
  const { name, fieldName, prefix, descriptor, record, compiledMeta, command, db, scope, principal, actionId } = ctx;
  const row = rawRow(db, name, command.id);
  if (!row) throw new ValidationError(`${name}.${fieldName}.operation document does not exist`);
  const documentScope = resolveAnnotatedTextOwningScope(descriptor, record.fields, row).key;
  if (scope !== documentScope) throw new ValidationError(`${name}.${fieldName}.operation requires document scope '${documentScope}'`);
  await authorizeFieldOp(record, fieldName, write as unknown as string, row, principal);
  const { stream, lease } = assertV9AuthoringBinding({ name, fieldName, prefix, command, db, principal });
  const state = db.prepare(`SELECT structure_version, family_checkpoint FROM ${prefix}_state WHERE document_id = ?`).get(command.id);
  if (!state) throw new ValidationError(`${name}.${fieldName}.operation document does not exist`);
  const family = restoreTextFamilySerialized(state.family_checkpoint);
  const cursor = readSeq(db, documentScope) + 1;
  const token = command.edit?.at?.positionToken ?? command.edit?.from?.positionToken ?? command.edit?.to?.positionToken ?? command.edit?.positionToken;
  const position = token
    ? resolvePosition({ db, prefix, positionToken: token, leaseId: lease.id }) as unknown as AuthoringPosition | null
    : null;
  if (token && !position) throw new ValidationError(`${name}.${fieldName}.operation position token unavailable`, { code: 'position-token-unavailable' });
  if (position && !position.visible_at_issue) throw new ValidationError(`${name}.${fieldName}.operation position no longer visible`, { code: 'position-no-longer-visible' });
  if (position) {
    // Fail closed on a stale authoring basis: the client's absolute offset is
    // meaningful only against the family its position frame was issued for. If
    // the current family frontier differs, the offset can land somewhere else;
    // require the client to re-bootstrap instead of trusting the offset.
    if (!samePositionBasis(position.family_checkpoint, family)) {
      throw new ValidationError(`${name}.${fieldName}.operation authoring basis is stale; re-bootstrap the snapshot`, { code: 'position-stale' });
    }
  }
  const actor = createHash('sha256').update(`${name}\u0000${fieldName}\u0000${command.id}\u0000${principal?.id ?? ''}\u0000${command.authoring.mutationId}`).digest('hex').slice(0, 32);
  // The max element lamport is the next lamport. Never spread the elements
  // array into Math.max — a large document (100k+ elements) exceeds the call
  // stack. The scan is O(elements) but bounded.
  let maxLamport = 0;
  for (const element of Object.values(family.checkpoint.elements)) {
    if (element.lamport > maxLamport) maxLamport = element.lamport;
  }
  const lamport = maxLamport + 1;
  return Object.freeze({
    name, fieldName, prefix, descriptor, record, compiledMeta, command, row, db, scope, principal, actionId,
    documentScope, stream, lease, state, family, cursor, position, actor, lamport,
  });
}

function assertOffsetInDocument(family: ContinuousTextFamily, offset: number, label: string): void {
  const length = materializeText(family).length;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > length) {
    throw new ValidationError(`annotated-text ${label} offset ${offset} is outside the document`, { code: 'position-invalid' });
  }
}

function positionBasis(serialized: string): unknown {
  const parsed = JSON.parse(serialized);
  if (parsed?.version === 1 && typeof parsed.id === 'string' && Array.isArray(parsed.frontier)) return parsed;
  if (typeof parsed?.id === 'string' && Array.isArray(parsed?.checkpoint?.frontier)) {
    return { version: 1, id: parsed.id, frontier: parsed.checkpoint.frontier };
  }
  throw new ValidationError('annotated-text authoring basis is invalid', { code: 'position-stale' });
}

function samePositionBasis(serialized: string, family: ContinuousTextFamily): boolean {
  return JSON.stringify(positionBasis(serialized)) === JSON.stringify(textFamilyBasis(family));
}

/** text.insert | text.delete | text.replace */
async function admitTextEdit(ctx: V9Prelude & { edit: V9EditLoose }): Promise<unknown[]> {
  const { name, fieldName, command, db, prefix, documentScope, lease, family, state, actor, lamport, edit } = ctx;
  // The position's family-basis equality with the current family is enforced in
  // the prelude; the client's offset is absolute against that same basis.
  const at = (edit.at ?? edit.from)!;
  const offset = at.offset;
  assertOffsetInDocument(family, offset, 'position');
  let toOffset = offset;
  if (edit.kind !== 'text.insert') {
    if (!edit.to?.positionToken) throw new ValidationError(`${name}.${fieldName}.operation replacement end position token unavailable`, { code: 'position-token-unavailable' });
    const toPosition = resolvePosition({ db, prefix, positionToken: edit.to.positionToken, leaseId: lease.id }) as unknown as AuthoringPosition | null;
    if (!toPosition) throw new ValidationError(`${name}.${fieldName}.operation replacement end position token unavailable`, { code: 'position-token-unavailable' });
    if (!toPosition.visible_at_issue) throw new ValidationError(`${name}.${fieldName}.operation replacement end position no longer visible`, { code: 'position-no-longer-visible' });
    if (!samePositionBasis(toPosition.family_checkpoint, family)) {
      throw new ValidationError(`${name}.${fieldName}.operation replacement end authoring basis is stale; re-bootstrap the snapshot`, { code: 'position-stale' });
    }
    toOffset = edit.to.offset;
    assertOffsetInDocument(family, toOffset, 'replacement end');
  }
  const annotations = loadAnnotations({ db, prefix, compiledMeta: ctx.compiledMeta, documentId: command.id });
  const ranges = loadRanges({ db, prefix, documentId: command.id });
  const plannerEdit = edit.kind === 'text.insert'
    ? { kind: 'text.insert', at: { offset, affinity: edit.at!.affinity }, text: edit.text }
    : { kind: edit.kind, from: { offset, affinity: edit.from!.affinity }, to: { offset: toOffset, affinity: edit.to!.affinity }, text: edit.text };
  let plan;
  try {
    plan = planTextOffsetEdit({
      documentId: command.id, structureVersion: state.structure_version, family, actor, lamport,
      annotations, ranges, edit: plannerEdit as any,
    });
  } catch (error) {
    const err = error as Error & { code?: string };
    throw new ValidationError(`${name}.${fieldName}.operation ${err.message}`, err.code ? { code: err.code } : undefined);
  }
  const handle = eventHandles.native(name, fieldName, 'operated');
  return [{ handle, type: handle.type, scope: documentScope, data: plan }];
}

/** annotation.apply (document range) */
async function admitTextRangeApply(ctx: V9Prelude & { edit: V9RangeApplyEdit }): Promise<unknown[]> {
  const { name, fieldName, command, db, prefix, documentScope, lease, family, state, edit, compiledMeta } = ctx;
  const fromToken = edit.from?.positionToken;
  const toToken = edit.to?.positionToken;
  if (!fromToken || !toToken) throw new ValidationError(`${name}.${fieldName}.operation annotation selection tokens unavailable`, { code: 'position-token-unavailable' });
  const fromPos = resolvePosition({ db, prefix, positionToken: fromToken, leaseId: lease.id }) as unknown as AuthoringPosition | null;
  const toPos = resolvePosition({ db, prefix, positionToken: toToken, leaseId: lease.id }) as unknown as AuthoringPosition | null;
  if (!fromPos || !toPos) throw new ValidationError(`${name}.${fieldName}.operation annotation selection tokens unavailable`, { code: 'position-token-unavailable' });
  if (!fromPos.visible_at_issue || !toPos.visible_at_issue) throw new ValidationError(`${name}.${fieldName}.operation annotation selection position no longer visible`, { code: 'position-no-longer-visible' });
  if (!samePositionBasis(fromPos.family_checkpoint, family) ||
      !samePositionBasis(toPos.family_checkpoint, family)) {
    throw new ValidationError(`${name}.${fieldName}.operation annotation selection authoring basis is stale; re-bootstrap the snapshot`, { code: 'position-stale' });
  }
  const familyMeta = compiledMeta.annotationHandles[edit.annotation?.family];
  if (!familyMeta) throw new ValidationError(`${name}.${fieldName}.operation unknown annotation family`, { code: 'position-invalid' });
  const ranges = loadRanges({ db, prefix, documentId: command.id });
  const annotations = loadAnnotations({ db, prefix, compiledMeta, documentId: command.id });
  const sameFamilyAnnotationIds = new Set(annotations.filter((candidate) => candidate.family === edit.annotation.family).map((candidate) => candidate.id));
  const annotation = {
    id: edit.annotation.id,
    family: edit.annotation.family,
    empty: familyMeta.empty,
    fields: edit.annotation.fields ?? {},
    protectedTargetIds: Array.isArray(edit.annotation?.protectedTargetIds) ? [...edit.annotation.protectedTargetIds].sort() : [],
  };
  let plan;
  try {
    plan = planTextRangeApply({
      documentId: command.id, structureVersion: state.structure_version, family,
      annotation,
      from: { offset: edit.from.offset, affinity: edit.from.affinity },
      to: { offset: edit.to.offset, affinity: edit.to.affinity },
      ranges, actorId: ctx.principal?.id ?? '',
      cardinality: familyMeta.cardinality,
      sameFamilyAnnotationIds,
    });
  } catch (error) {
    const err = error as Error & { code?: string };
    throw new ValidationError(`${name}.${fieldName}.operation ${err.message}`, err.code ? { code: err.code } : undefined);
  }
  const handle = eventHandles.native(name, fieldName, 'operated');
  return [{ handle, type: handle.type, scope: documentScope, data: plan }];
}

/** annotation.remove (document range) */
async function admitAnnotationRemove(ctx: V9Prelude & { edit: unknown }): Promise<unknown[]> {
  const { name, fieldName, command, db, prefix, documentScope, family, state, compiledMeta } = ctx;
  const annotations = loadAnnotations({ db, prefix, compiledMeta, documentId: command.id });
  const ranges = loadRanges({ db, prefix, documentId: command.id });
  if (!annotations.some((annotation) => annotation.id === edit_annotationId(command))) {
    throw new ValidationError(`${name}.${fieldName}.operation annotation not found`);
  }
  let plan;
  try {
    plan = planAnnotationRemove({
      documentId: command.id, structureVersion: state.structure_version, family,
      annotationId: edit_annotationId(command) as string, annotations, ranges,
    });
  } catch (error) {
    const err = error as Error & { code?: string };
    throw new ValidationError(`${name}.${fieldName}.operation ${err.message}`, err.code ? { code: err.code } : undefined);
  }
  const handle = eventHandles.native(name, fieldName, 'operated');
  return [{ handle, type: handle.type, scope: documentScope, data: plan }];
}

function edit_annotationId(command: V9Command): string | undefined {
  return command.edit?.annotationId ?? command.edit?.annotation?.id;
}

/**
 * Admit a validated v9 annotated-text command. Structure edits (block.split,
 * block.merge, block.continue, block-group.assignment) are gone in the
 * blockless model and are rejected. `handlers` from the block era are ignored.
 */
export async function admitV9AnnotatedTextEdit(ctx: V9AdmitContext): Promise<unknown[]> {
  const prelude = await assertV9AuthoringPrelude(ctx);
  const edit = prelude.command.edit;
  if (edit.kind === 'text.insert' || edit.kind === 'text.delete' || edit.kind === 'text.replace') {
    return admitTextEdit({ ...prelude, edit });
  }
  if (edit.kind === 'annotation.apply') {
    return admitTextRangeApply({ ...prelude, edit: edit as V9RangeApplyEdit });
  }
  if (edit.kind === 'annotation.remove') {
    return admitAnnotationRemove({ ...prelude, edit });
  }
  throw new ValidationError(`${prelude.name}.${prelude.fieldName}.operation block-era edit '${edit.kind}' is not supported (issue #33)`, { code: 'position-invalid' });
}

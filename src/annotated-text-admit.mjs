// Commit admission for annotated-text operations (issue #33 blockless).
//
// One continuous RGA text per document; annotations are document-scoped
// ranges; authoring positions are document-scoped frames carrying an absolute
// UTF-16 offset basis. This module does NOT write DB rows, mint authoring
// frames, or fold client ops — it admits a validated v9 command and returns the
// blockless operated event/plan.

import { createHash } from 'node:crypto';
import { ValidationError } from './field-strategy.mjs';
import * as eventHandles from './event-handle.mjs';
import { authorizeFieldOp } from './strategy/index.mjs';
import { write } from './grant.mjs';
import { restoreTextFamily, materializeText } from './annotated-text-continuous.mjs';
import { resolveAnnotatedTextOwningScope } from './annotated-text-field.mjs';
import { resolveStream, resolveLease, resolvePosition } from './annotated-text-authoring-stream.mjs';
import { readSeq } from './committed-log.mjs';
import { planAnnotationRemove, planTextOffsetEdit, planTextRangeApply } from './annotated-text-plan.mjs';

/** Resolve the authoring stream + lease for a v9 command. */
export function assertV9AuthoringBinding({ name, fieldName, prefix, command, db, principal }) {
  const stream = resolveStream({ db, prefix, streamToken: command.authoring.stream, documentId: command.id, principalType: principal?.type ?? 'principal', principalId: principal?.id ?? '' });
  if (!stream) throw new ValidationError(`${name}.${fieldName}.operation authoring stream unavailable`, { code: 'authoring-stream-unavailable' });
  const lease = resolveLease({ db, prefix, leaseToken: command.authoring.lease, streamId: stream.id });
  if (!lease) throw new ValidationError(`${name}.${fieldName}.operation authoring lease unavailable`, { code: 'authoring-lease-unavailable' });
  return { stream, lease };
}

function loadAnnotations({ db, prefix, compiledMeta, documentId }) {
  const rows = db.prepare(`SELECT id, family FROM ${prefix}_annotation WHERE document_id = ? ORDER BY id`).all(documentId);
  const targets = db.prepare(
    `SELECT annotation_id, target_annotation_id FROM ${prefix}_annotation_protected_target
      WHERE annotation_id IN (SELECT id FROM ${prefix}_annotation WHERE document_id = ?)
      ORDER BY annotation_id, target_annotation_id`,
  ).all(documentId);
  const targetsByAnnotation = new Map();
  for (const target of targets) targetsByAnnotation.set(target.annotation_id, [...(targetsByAnnotation.get(target.annotation_id) ?? []), target.target_annotation_id]);
  const annotations = [];
  for (const row of rows) {
    const metadata = compiledMeta.annotationHandles[row.family];
    if (!metadata) throw new ValidationError(`annotated-text unknown annotation family '${row.family}'`);
    annotations.push({ id: row.id, family: row.family, empty: metadata.empty, protectedTargetIds: targetsByAnnotation.get(row.id) ?? [] });
  }
  return annotations;
}

function loadRanges({ db, prefix, documentId }) {
  const rows = db.prepare(`SELECT annotation_id, start_point, end_point FROM ${prefix}_membership WHERE annotation_id IN (SELECT id FROM ${prefix}_annotation WHERE document_id = ?)`).all(documentId);
  return rows.map((row) => ({
    annotationId: row.annotation_id,
    start: JSON.parse(row.start_point),
    end: JSON.parse(row.end_point),
  }));
}

/** Cross-cutting admission shared by every edit kind. */
async function assertV9AuthoringPrelude({ name, fieldName, prefix, descriptor, record, compiledMeta, command, db, scope, principal, actionId }) {
  const row = db.prepare(`SELECT * FROM ${name} WHERE id = ?`).get(command.id);
  if (!row) throw new ValidationError(`${name}.${fieldName}.operation document does not exist`);
  const documentScope = resolveAnnotatedTextOwningScope(descriptor, record.fields, row).key;
  if (scope !== documentScope) throw new ValidationError(`${name}.${fieldName}.operation requires document scope '${documentScope}'`);
  await authorizeFieldOp(record, fieldName, write, row, principal);
  const { stream, lease } = assertV9AuthoringBinding({ name, fieldName, prefix, command, db, principal });
  const state = db.prepare(`SELECT structure_version, family_checkpoint FROM ${prefix}_state WHERE document_id = ?`).get(command.id);
  if (!state) throw new ValidationError(`${name}.${fieldName}.operation document does not exist`);
  const family = restoreTextFamily(JSON.parse(state.family_checkpoint));
  const cursor = readSeq(db, documentScope) + 1;
  const token = command.edit?.at?.positionToken ?? command.edit?.from?.positionToken ?? command.edit?.to?.positionToken ?? command.edit?.positionToken;
  const position = token
    ? resolvePosition({ db, prefix, positionToken: token, leaseId: lease.id }) ?? null
    : null;
  if (token && !position) throw new ValidationError(`${name}.${fieldName}.operation position token unavailable`, { code: 'position-token-unavailable' });
  if (position && !position.visible_at_issue) throw new ValidationError(`${name}.${fieldName}.operation position no longer visible`, { code: 'position-no-longer-visible' });
  const actor = createHash('sha256').update(`${name}\u0000${fieldName}\u0000${command.id}\u0000${principal?.id ?? ''}\u0000${command.authoring.mutationId}`).digest('hex').slice(0, 32);
  const lamport = Math.max(0, ...Object.values(family.checkpoint.elements).map((element) => element.lamport)) + 1;
  return Object.freeze({
    name, fieldName, prefix, descriptor, record, compiledMeta, command, row, db, scope, principal, actionId,
    documentScope, stream, lease, state, family, cursor, position, actor, lamport,
  });
}

function assertOffsetInDocument(family, offset, label) {
  const length = materializeText(family).length;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > length) {
    throw new ValidationError(`annotated-text ${label} offset ${offset} is outside the document`, { code: 'position-invalid' });
  }
}

/** text.insert | text.delete | text.replace */
async function admitTextEdit(ctx) {
  const { name, fieldName, command, db, prefix, documentScope, lease, family, state, position, actor, lamport, edit } = ctx;
  const positionFamily = restoreTextFamily(JSON.parse(position.family_checkpoint));
  // The client's offset is absolute against the position basis; it must also be
  // within the CURRENT document.
  const at = edit.at ?? edit.from;
  const offset = at.offset;
  assertOffsetInDocument(family, offset, 'position');
  let toOffset = offset;
  if (edit.kind !== 'text.insert') {
    if (!edit.to?.positionToken) throw new ValidationError(`${name}.${fieldName}.operation replacement end position token unavailable`, { code: 'position-token-unavailable' });
    const toPosition = resolvePosition({ db, prefix, positionToken: edit.to.positionToken, leaseId: lease.id });
    if (!toPosition) throw new ValidationError(`${name}.${fieldName}.operation replacement end position token unavailable`, { code: 'position-token-unavailable' });
    toOffset = edit.to.offset;
    assertOffsetInDocument(family, toOffset, 'replacement end');
  }
  const annotations = loadAnnotations({ db, prefix, compiledMeta: ctx.compiledMeta, documentId: command.id });
  const ranges = loadRanges({ db, prefix, documentId: command.id });
  const plannerEdit = edit.kind === 'text.insert'
    ? { kind: 'text.insert', at: { offset, affinity: edit.at.affinity }, text: edit.text }
    : { kind: edit.kind, from: { offset, affinity: edit.from.affinity }, to: { offset: toOffset, affinity: edit.to.affinity }, text: edit.text };
  let plan;
  try {
    plan = planTextOffsetEdit({
      documentId: command.id, structureVersion: state.structure_version, family, actor, lamport,
      annotations, ranges, edit: plannerEdit,
    });
  } catch (error) { throw new ValidationError(`${name}.${fieldName}.operation ${error.message}`, error.code ? { code: error.code } : undefined); }
  void positionFamily;
  const handle = eventHandles.native(name, fieldName, 'operated');
  return [{ handle, type: handle.type, scope: documentScope, data: plan }];
}

/** annotation.apply (document range) */
async function admitTextRangeApply(ctx) {
  const { name, fieldName, command, db, prefix, documentScope, lease, family, state, edit, compiledMeta } = ctx;
  const fromToken = edit.from?.positionToken;
  const toToken = edit.to?.positionToken;
  if (!fromToken || !toToken) throw new ValidationError(`${name}.${fieldName}.operation annotation selection tokens unavailable`, { code: 'position-token-unavailable' });
  const fromPos = resolvePosition({ db, prefix, positionToken: fromToken, leaseId: lease.id });
  const toPos = resolvePosition({ db, prefix, positionToken: toToken, leaseId: lease.id });
  if (!fromPos || !toPos) throw new ValidationError(`${name}.${fieldName}.operation annotation selection tokens unavailable`, { code: 'position-token-unavailable' });
  const familyMeta = compiledMeta.annotationHandles[edit.annotation?.family];
  if (!familyMeta) throw new ValidationError(`${name}.${fieldName}.operation unknown annotation family`, { code: 'position-invalid' });
  const ranges = loadRanges({ db, prefix, documentId: command.id });
  let plan;
  try {
    plan = planTextRangeApply({
      documentId: command.id, structureVersion: state.structure_version, family,
      annotation: { id: edit.annotation.id, family: edit.annotation.family, empty: familyMeta.empty, fields: edit.annotation.fields ?? {}, protectedTargetIds: [] },
      from: { offset: edit.from.offset, affinity: edit.from.affinity },
      to: { offset: edit.to.offset, affinity: edit.to.affinity },
      ranges, actorId: ctx.principal?.id ?? '',
    });
  } catch (error) { throw new ValidationError(`${name}.${fieldName}.operation ${error.message}`, error.code ? { code: error.code } : undefined); }
  const handle = eventHandles.native(name, fieldName, 'operated');
  return [{ handle, type: handle.type, scope: documentScope, data: plan }];
}

/** annotation.remove (document range) */
async function admitAnnotationRemove(ctx) {
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
      annotationId: edit_annotationId(command), annotations, ranges,
    });
  } catch (error) { throw new ValidationError(`${name}.${fieldName}.operation ${error.message}`, error.code ? { code: error.code } : undefined); }
  const handle = eventHandles.native(name, fieldName, 'operated');
  return [{ handle, type: handle.type, scope: documentScope, data: plan }];
}

function edit_annotationId(command) {
  return command.edit?.annotationId ?? command.edit?.annotation?.id;
}

/**
 * Admit a validated v9 annotated-text command. Structure edits (block.split,
 * block.merge, block.continue, block-group.assignment) are gone in the
 * blockless model and are rejected. `handlers` from the block era are ignored.
 */
export async function admitV9AnnotatedTextEdit(ctx) {
  const prelude = await assertV9AuthoringPrelude(ctx);
  const edit = prelude.command.edit;
  if (edit.kind === 'text.insert' || edit.kind === 'text.delete' || edit.kind === 'text.replace') {
    return admitTextEdit({ ...prelude, edit });
  }
  if (edit.kind === 'annotation.apply') {
    return admitTextRangeApply({ ...prelude, edit });
  }
  if (edit.kind === 'annotation.remove') {
    return admitAnnotationRemove({ ...prelude, edit });
  }
  throw new ValidationError(`${prelude.name}.${prelude.fieldName}.operation block-era edit '${edit.kind}' is not supported (issue #33)`, { code: 'position-invalid' });
}

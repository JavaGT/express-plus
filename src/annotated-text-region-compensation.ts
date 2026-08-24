// W3 (#145) slices 2/3 — compound-history APPLIED document compensation.
//
// The compound-origin/compensation envelope stores only the narrow application
// transition and one canonical delete contribution; the operated v16 event the
// target applied carries the rest of the provenance (from/to window, the text
// operations with the insert opId + anchor, and the annotation transitions).
// This module plans the APPLIED inverse against CURRENT state by:
//   1. resolving the target's inserted scalars in the live family via their opId
//      (robust to later collaborator inserts — only the target's own elements
//      are located, never a same-text lookalike),
//   2. building the inverse region descriptor (delete the target's insert,
//      re-insert the text the target removed, reverse every annotation
//      transition), and
//   3. running it through W1's shared reducer machinery (planRegionEdit +
//      constructV16RegionEvent) which re-validates basis/digests/closure and
//      emits a fresh v16 operated event.
//
// Where the design's rev-2 matrix says "unsafe to compensate", the planner
// returns a whole-compound NOOP (missing anchor, collaborator divergent
// memberships, digest/closure staleness, unsupported target). It never plans a
// partial compensation: a valid target that is unsafe against current state
// becomes noop. Malformed durable v16 data and application-CAS failures throw,
// rolling the whole move back in the caller.

import type { DbHandle } from './driver.ts';
import { scalarCount } from './annotated-text.ts';
import {
  materializeText,
  projectEndpointToOffset,
  restoreTextFamilySerialized,
  textFamilyBasis,
  type ContinuousTextFamily,
} from './annotated-text-continuous.ts';
import { rgaTraversal } from './annotated-text-family.ts';
import { loadAnnotationImages } from './annotated-text-storage.ts';
import {
  scalarIndexToUtf16Offset,
  type AnnotationImage,
  type DeleteFact,
  type StoredAnnotationImage,
} from './annotated-text-delete-history.ts';
import { sha256Utf8 } from './annotated-text-region-limits.ts';
import {
  computeAffectedClosure,
  digestAffectedClosure,
  regionImageFromStored,
  REGION_POSTIMAGE_DISAGREES,
  type RegionDeclaration,
} from './annotated-text-region-reducer.ts';
import type { RegionEditTransition } from './annotated-text-region-descriptor.ts';
import {
  planRegionEdit,
  type RegionPlan,
} from './annotated-text-region-plan.ts';
import {
  constructV16RegionEvent,
  type CanonicalRegionEdit,
} from './annotated-text-operated-event.ts';
import { decodeLogRowData, type LogRowLike } from './committed-log.ts';
import { ValidationError } from './field-strategy.ts';
import { getAnnotatedTextCompiledMetadata } from './annotated-text-field.ts';
import { privateFactFromReceipt, parseCompoundApplicationTransition, type CompoundContributionEnvelope } from './compound-contribution-fact.ts';

export type RegionCompensationNoopCode = 'no-insert' | 'insert-partially-deleted' | 'target-moved' | 'missing-contribution-capture' | 'noop-target' | 'unsupported-target';

export type RegionCompensationResult =
  | Readonly<{
      outcome: 'applied';
      plan: RegionPlan;
      event: { version: 16; id: string; before: unknown; after: unknown; operation: Record<string, unknown>; facts: unknown };
      eventDataText: string;
      capability: { nonce: string };
      contribution: DeleteFact | null;
    }>
  | Readonly<{ outcome: 'noop'; code: RegionCompensationNoopCode; reason: string }>;

function noop(code: RegionCompensationNoopCode, reason: string): RegionCompensationResult {
  return Object.freeze({ outcome: 'noop', code, reason });
}

/** SHA-256 actor for a compensation move (fresh per move action id — like the
 *  native compensation path, so per-actor CRDT local counters never collide
 *  across an undo/redo chain). */
export function compensationActor(entity: string, field: string, documentId: string, principalId: string | undefined, scope: string, actionId: string): string {
  return sha256Utf8(`${entity}\u0000${field}\u0000${documentId}\u0000${principalId ?? ''}\u0000${scope}\u0000${actionId}`).slice(0, 32);
}

// ---------------------------------------------------------------------------
// Transaction-bound context loading (mirrors the field policy's admitAndPlan
// loader against the CURRENT state, but standalone so it can also serve the
// history move path).
// ---------------------------------------------------------------------------

export interface RegionCompensationContext {
  family: ContinuousTextFamily;
  structureVersion: number;
  annotations: readonly (StoredAnnotationImage & { empty?: string; cardinality?: string })[];
  declarations: readonly RegionDeclaration[];
  actor: string;
  lamport: number;
  owningScope: string;
  entity: string;
  field: string;
}

function annotationDeclarationsForLoad(compiledMeta: any, descriptor: any) {
  return compiledMeta.annotationHandles
    ? Object.values(compiledMeta.annotationHandles).map((meta: any) => ({
        annotationName: meta.annotationName,
        fields: descriptor.annotations?.find((a: any) => a.annotationName === meta.annotationName)?.fields ?? {},
      }))
    : [];
}

function buildRegionDeclarations(compiledMeta: any, descriptor: any): RegionDeclaration[] {
  return Object.values(compiledMeta.annotationHandles ?? {}).map((meta: any) => {
    const annConfig: any = descriptor.annotations?.find((a: any) => a.annotationName === meta.annotationName);
    const isProtecting = typeof (annConfig?.protects ?? null) === 'string';
    const access = compiledMeta.protectingFamilies?.[meta.annotationName]?.access;
    return Object.freeze({
      annotationName: meta.annotationName,
      fields: annConfig?.fields ?? {},
      empty: annConfig?.empty ?? 'delete',
      cardinality: meta.cardinality ?? 'many',
      kind: 'annotation',
      protects: typeof annConfig?.protects === 'string' ? annConfig.protects : null,
      placeholder: typeof compiledMeta.protectingFamilies?.[meta.annotationName]?.placeholder === 'string'
        ? compiledMeta.protectingFamilies[meta.annotationName].placeholder
        : null,
      accessPolicySource: isProtecting
        ? (typeof access === 'function' ? Function.prototype.toString.call(access) : null)
        : null,
    });
  });
}

/**
 * Load the CURRENT family, affected-annotation views, and compiled declarations
 * for one annotated document inside the move transaction.
 */
export function loadRegionCompensationContext(
  db: DbHandle,
  handle: { entity: string; field: string },
  documentId: string,
  fieldDescriptor: unknown,
  principal: { type?: string; id?: string },
  scope: string,
  actionId: string,
): RegionCompensationContext {
  const prefix = `${handle.entity}_${handle.field}`;
  const compiledMeta = getAnnotatedTextCompiledMetadata(fieldDescriptor);
  if (!compiledMeta) throw new ValidationError(`${handle.entity}.${handle.field}.operation declaration is not compiled`);
  const descriptor = fieldDescriptor as { annotations?: unknown };
  const state = db.prepare(
    `SELECT structure_version, family_checkpoint FROM ${prefix}_state WHERE document_id = ?`,
  ).get(documentId);
  if (!state) throw new ValidationError(`${handle.entity}.${handle.field}.operation document does not exist`);
  const family = restoreTextFamilySerialized(state.family_checkpoint as string);
  const annotations = loadAnnotationImages(db, {
    prefix,
    documentId,
    declarations: annotationDeclarationsForLoad(compiledMeta, descriptor),
  });
  const stored: (StoredAnnotationImage & { empty: string; cardinality: string })[] = annotations.map((image) => {
    const annConfig: any = (descriptor.annotations as Array<{ annotationName: string }> | undefined)?.find((a) => a.annotationName === image.family);
    const meta: any = compiledMeta.annotationHandles?.[image.family];
    return Object.freeze({
      id: image.id,
      family: image.family,
      fields: image.fields as Record<string, unknown>,
      protectedTargetIds: [...image.protectedTargetIds],
      memberships: image.memberships as StoredAnnotationImage['memberships'],
      prerequisites: [...image.prerequisites],
      empty: annConfig?.empty ?? 'delete',
      cardinality: meta?.cardinality ?? 'many',
    });
  });
  const actor = compensationActor(handle.entity, handle.field, documentId, principal?.id, scope, actionId);
  let maxLamport = 0;
  for (const element of Object.values(family.checkpoint.elements)) {
    if ((element as { lamport?: number }).lamport && (element as { lamport: number }).lamport > maxLamport) maxLamport = (element as { lamport: number }).lamport;
  }
  return {
    family,
    structureVersion: state.structure_version as number,
    annotations: stored,
    declarations: buildRegionDeclarations(compiledMeta, descriptor),
    actor,
    lamport: maxLamport + 1,
    // Composition validated that the declared field's owning scope equals the
    // outer action scope; the move operates in that same scope.
    owningScope: scope,
    entity: handle.entity,
    field: handle.field,
  };
}

// ---------------------------------------------------------------------------
// Target provenance extraction
// ---------------------------------------------------------------------------

interface TargetInsert {
  opId: readonly [string, number];
  text: string;
  anchor: unknown;
}

/** Extract the target's inserted text + opId from its operated text operations. */
export function targetInsertFromEvent(event: CanonicalRegionEdit): TargetInsert | null {
  const ops = event.text;
  if (ops.kind === 'insert' || ops.kind === 'replace') {
    const operation = ops.kind === 'insert' ? ops.operation : ops.operations[1];
    const op = operation as [string, number, [string, number], number, unknown, unknown];
    if (!Array.isArray(op) || op.length < 6 || op[0] !== 'workbench.text') return null;
    const payload = op[5];
    const insertPayload = Array.isArray(payload) && payload[0] === 'insert' ? payload : null;
    if (!insertPayload || typeof insertPayload[2] !== 'string') return null;
    return Object.freeze({ opId: op[2], text: insertPayload[2], anchor: insertPayload[1] });
  }
  return null;
}

/**
 * Locate the live scalars of the target's inserted run in the CURRENT family,
 * in RGA order. Returns the UTF-16 [from, to) window they occupy, or null when
 * any of the target's elements were deleted/absent (collaborator interference)
 * — which makes the inverse unsafe and the whole move a noop.
 *
 * The walk stays aligned with the family's TEXT materialization: tombstones
 * (deleted elements) contribute NOTHING to offsets, exactly like
 * `materializeText`, so a live target preceded by a deleted collaborator scalar
 * resolves to the same window the text slice verification uses (MAJOR 3).
 */
export function liveInsertWindow(family: ContinuousTextFamily, opId: readonly [string, number], text: string): { from: number; to: number } | null {
  const count = scalarCount(text);
  const keys = new Set(Array.from({ length: count }, (_, ordinal) => `${opId[0]}:${opId[1]}:${ordinal}`));
  let offset = 0;
  let first: number | null = null;
  let last = 0;
  let found = 0;
  for (const [, element] of rgaTraversal(family.checkpoint)) {
    if (element.deletedBy.length > 0) continue;
    const width = element.scalar.length;
    if (keys.has(`${element.op[0]}:${element.op[1]}:${element.ordinal}`)) {
      if (first === null) first = offset;
      last = offset + width;
      found += 1;
    } else if (first !== null && found === count) {
      break;
    }
    offset += width;
  }
  if (first === null || found !== count) return null;
  if (materializeText(family).slice(first, last) !== text) return null;
  return { from: first, to: last };
}

// ---------------------------------------------------------------------------
// Inverse descriptor construction
// ---------------------------------------------------------------------------

function relativeRangesOf(image: AnnotationImage, deletedText: string): { start: number; end: number }[] {
  return image.ranges.map((range) => Object.freeze({
    start: scalarIndexToUtf16Offset(deletedText, range.startScalar),
    end: scalarIndexToUtf16Offset(deletedText, range.endScalar),
  }));
}

function reverseTransitions(
  target: CanonicalRegionEdit,
  contribution: DeleteFact | null,
  deletedText: string,
): { transitions: RegionEditTransition[]; noop: string | null } {
  const captured = new Map<string, AnnotationImage>();
  for (const image of contribution?.contribution.annotations ?? []) captured.set(image.id, image);
  const transitions: RegionEditTransition[] = [];
  for (const transition of target.transitions) {
    if (transition.kind === 'create') {
      transitions.push(Object.freeze({ kind: 'remove', annotationId: transition.annotation.id }));
      continue;
    }
    const image = captured.get(transition.kind === 'range.set' ? transition.annotationId : transition.annotationId);
    if (transition.kind === 'remove') {
      if (!image) return { transitions, noop: `removed annotation '${transition.annotationId}' was not captured by the target contribution` };
      transitions.push(Object.freeze({
        kind: 'create',
        annotation: Object.freeze({
          id: image.id,
          family: image.family,
          fields: image.fields,
          protectedTargetIds: image.protectedTargetIds,
        }),
        ranges: relativeRangesOf(image, deletedText),
      }));
      continue;
    }
    // range.set inverse: restore the ORIGINAL (pre-target) memberships from the
    // captured image, expressed as window-relative UTF-16 ranges.
    if (!image) return { transitions, noop: `re-ranged annotation '${transition.annotationId}' was not captured by the target contribution` };
    transitions.push(Object.freeze({
      kind: 'range.set',
      annotationId: transition.annotationId,
      ranges: relativeRangesOf(image, deletedText),
    }));
  }
  return { transitions, noop: null };
}

function coveredIdsOf(annotations: readonly (StoredAnnotationImage & { empty?: string; cardinality?: string })[], family: ContinuousTextFamily, from: number, to: number): string[] {
  const ids: string[] = [];
  for (const image of annotations) {
    for (const entry of image.memberships) {
      const start = projectEndpointToOffset(family, entry.start);
      const end = projectEndpointToOffset(family, entry.end);
      if (Math.min(end, to) - Math.max(start, from) > 0) { ids.push(image.id); break; }
    }
  }
  return [...new Set(ids)].sort();
}

/**
 * Plan the APPLIED compensation for one compound history move. `target` is the
 * parsed v16 operated event the target receipt applied; `contribution` is that
 * receipt's stored delete contribution (null for insert-only targets). On the
 * rev-2 matrix outcomes: an unsafe-to-compensate target yields `noop` (the
 * caller commits the whole-compound noop); anything malformed throws.
 */
export function planRegionCompensation({
  target,
  contribution,
  context,
  actionId,
}: {
  target: CanonicalRegionEdit;
  contribution: DeleteFact | null;
  context: RegionCompensationContext;
  actionId: string;
}): RegionCompensationResult {
  const { family, structureVersion, annotations, declarations, actor, lamport } = context;
  const text = materializeText(family);

  // Locate the target's inserted run in CURRENT coordinates (by opId, not by
  // stale offsets). Delete-only targets have no insert: their inverse is a pure
  // re-insert at the target's recorded window start.
  const insert = targetInsertFromEvent(target);
  let from: number;
  let to: number;
  let covered = '';
  if (insert) {
    const window = liveInsertWindow(family, insert.opId, insert.text);
    if (!window) return noop('insert-partially-deleted', 'target insert scalars are no longer live in the document');
    from = window.from;
    to = window.to;
    covered = window.to - window.from >= 0 ? text.slice(window.from, window.to) : '';
    // Live-window verification already checks the exact covered text; keep the
    // descriptor digest consistent with the window.
    void covered;
  } else {
    if (target.from < 0 || target.from > text.length) return noop('target-moved', 'target window is outside the live document');
    from = target.from;
    to = target.from;
  }

  const deletedText = contribution?.contribution.text ?? '';
  // The inverse replaces the target's inserted text with the text the target
  // removed. For an insert-only target the removed text is empty (pure delete).
  const inverseReplacement = deletedText;

  const reversed = reverseTransitions(target, contribution, deletedText);
  if (reversed.noop) return noop('missing-contribution-capture', reversed.noop);

  // Descriptor digests from CURRENT state (mirrors the planner's validation).
  const declarationByName = new Map(declarations.map((d) => [d.annotationName, d]));
  const regionImages = annotations.map((image) => regionImageFromStored(image, declarationByName.get(image.family)));
  const namedIds = reversed.transitions
    .map((t) => (t.kind === 'create' ? t.annotation.id : t.annotationId));
  const closure = computeAffectedClosure({ annotations: regionImages, family, from, to, namedIds });
  const existingText = text.slice(from, to);
  const descriptor = Object.freeze({
    version: 10,
    kind: 'region.edit',
    id: family.id,
    basis: textFamilyBasis(family),
    from,
    to,
    coveredTextDigest: sha256Utf8(existingText),
    affectedClosureDigest: digestAffectedClosure(closure),
    expectedCoveredAnnotationIds: coveredIdsOf(annotations, family, from, to),
    replacement: inverseReplacement,
    transitions: reversed.transitions,
  });

  try {
    const plan = planRegionEdit({
      descriptor,
      family,
      structureVersion,
      annotations,
      declarations,
      actor,
      lamport,
    });
    const built = constructV16RegionEvent(plan, {
      owningScope: context.owningScope,
      entity: context.entity ?? '',
      field: context.field ?? '',
      documentId: plan.descriptor.id,
      actionId,
    });
    return Object.freeze({
      outcome: 'applied',
      plan,
      event: built.event,
      eventDataText: built.eventDataText,
      capability: built.capability,
      contribution: plan.contribution,
    });
  } catch (error) {
    const message = (error as Error).message ?? '';
    if (typeof message === 'string' && (
      message.includes('affected closure digest') || message.includes('covered text digest')
      || message.includes('family basis is stale') || message === REGION_POSTIMAGE_DISAGREES
      || message.includes('range is outside the live document'))) {
      return noop('target-moved', `target region is no longer safely compensable: ${message}`);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Pipeline-facing move helper: read the root/target receipts inside the move
// transaction and plan the whole-compound outcome.
// ---------------------------------------------------------------------------

export interface MoveCompensationTarget {
  envelope: CompoundContributionEnvelope;
  event: CanonicalRegionEdit | null;
  contribution: import('./annotated-text-delete-history.ts').DeleteFact | null;
  originApplication: Readonly<{ before: unknown; after: unknown }> | null;
}

/**
 * Read the target receipt's compound envelope + operated event and the root
 * origin envelope inside the move transaction.
 */
export function readMoveCompensationTarget(
  db: DbHandle,
  { scope, entity, field, rootActionId, targetActionId }: { scope: string; entity: string; field: string; rootActionId: string; targetActionId: string },
): MoveCompensationTarget {
  const receipt = db.prepare(
    'SELECT committedAt FROM _ActionReceipt WHERE scope = :scope AND actionId = :actionId',
  ).get({ scope, actionId: targetActionId }) as { committedAt: string } | undefined;
  if (!receipt) throw new TypeError('history move target receipt is missing');
  const envelope = privateFactFromReceipt(db, { scope, actionId: targetActionId, committedAt: receipt.committedAt }) as unknown as CompoundContributionEnvelope;
  const kind = envelope.kind;
  if (kind !== 'workbench.compound-origin' && kind !== 'workbench.compound-compensation') {
    throw new TypeError('history move target is not a compound contribution envelope');
  }

  const originReceipt = db.prepare(
    'SELECT committedAt FROM _ActionReceipt WHERE scope = :scope AND actionId = :actionId',
  ).get({ scope, actionId: rootActionId }) as { committedAt: string } | undefined;
  const originEnvelope = originReceipt
    ? privateFactFromReceipt(db, { scope, actionId: rootActionId, committedAt: originReceipt.committedAt })
    : null;

  const row = db.prepare(
    'SELECT scope, seq, eventType, eventData, actionId, committedAt FROM _Log WHERE scope = :scope AND actionId = :actionId AND eventType = :eventType ORDER BY seq LIMIT 1',
  ).get({ scope, actionId: targetActionId, eventType: `${entity}.${field}.operated` }) as LogRowLike | undefined;

  let event: CanonicalRegionEdit | null = null;
  if (row) {
    const decoded = decodeLogRowData(row);
    if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)
        && (decoded as { wireVersion?: unknown }).wireVersion === 16) event = decoded as CanonicalRegionEdit;
  }

  const contribution = (envelope.contributions[0] as import('./annotated-text-delete-history.ts').DeleteFact | undefined) ?? null;
  const originApplication = originEnvelope ? parseCompoundApplicationTransition(originEnvelope.application, 'history origin application') : null;
  return Object.freeze({ envelope, event, contribution, originApplication });
}

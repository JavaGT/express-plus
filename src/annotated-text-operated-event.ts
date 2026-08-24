// Sole durable operated-envelope grammar (scope#992 W1 / Finding 1).
// normalizeOperatedEvent is the only version gate. Reducers consume the
// canonical form and do not branch on a wire version for kind dispatch.
// Envelope construction lives only in this module.

import type { RegionEditTransition } from './annotated-text-region-descriptor.ts';
import type { RegionPlan, RegionTextOperations } from './annotated-text-region-plan.ts';
import {
  REGION_AFFECTED_ANNOTATION_MAX,
  REGION_DESCRIPTOR_MAX_UTF8_BYTES,
  REGION_MEMBERSHIP_MAX,
  REGION_PREREQUISITE_MAX,
  REGION_PROTECTED_EDGE_MAX,
  REGION_REPLACEMENT_MAX_UTF8_BYTES,
  REGION_TRANSITION_MAX,
  SHA256_HEX,
  regionLimitError,
  utf8ByteLength,
} from './annotated-text-region-limits.ts';

export const OPERATED_FACT_KEYS = [
  'actorId',
  'annotation',
  'emptiedAnnotations',
  'family',
  'lifecycle',
  'measurements',
  'ranges',
  'removedAnnotationIds',
  'result',
  'selectedRange',
] as const;

export const OPERATED_ENVELOPE_KEYS = ['after', 'before', 'facts', 'id', 'operation', 'version'] as const;

const V15_PROOF_KEYS = ['affectedIds', 'afterDigest', 'beforeDigest'] as const;

export type FamilyProof =
  | Readonly<{ kind: 'checkpoint'; checkpoint: unknown }>
  | Readonly<{ kind: 'derive-and-check-frontier' }>;

export type OperatedFacts = Readonly<{
  actorId: string | null;
  annotation: Record<string, unknown> | null;
  emptiedAnnotations: readonly unknown[];
  family: unknown;
  lifecycle: unknown;
  measurements: readonly unknown[];
  ranges: readonly unknown[];
  removedAnnotationIds: readonly unknown[];
  result: unknown;
  selectedRange: Record<string, unknown> | null;
}>;

export type TextRevision = Readonly<{
  structuralRevision: number;
  frontier: unknown[];
}>;

export type CanonicalTextApply = Readonly<{
  kind: 'text.apply';
  id: string;
  before: TextRevision;
  after: TextRevision;
  operation: unknown[];
  facts: OperatedFacts;
  familyProof: FamilyProof;
  wireVersion: 13 | 14;
}>;

export type CanonicalTextReplace = Readonly<{
  kind: 'text.replace';
  id: string;
  before: TextRevision;
  after: TextRevision;
  operations: readonly unknown[];
  facts: OperatedFacts;
  familyProof: FamilyProof;
  wireVersion: 13 | 14;
}>;

export type CanonicalAnnotationApplyRange = Readonly<{
  kind: 'annotation.apply-range';
  id: string;
  before: TextRevision;
  after: TextRevision;
  annotation: unknown;
  selection: unknown;
  facts: OperatedFacts;
  familyProof: FamilyProof;
  wireVersion: 13 | 14;
}>;

export type CanonicalAnnotationRemove = Readonly<{
  kind: 'annotation.remove';
  id: string;
  before: TextRevision;
  after: TextRevision;
  annotationId: string;
  facts: OperatedFacts;
  familyProof: FamilyProof;
  wireVersion: 13 | 14;
}>;

export type CanonicalRegionEdit = Readonly<{
  kind: 'region.edit';
  id: string;
  before: TextRevision;
  after: TextRevision;
  from: number;
  to: number;
  text: RegionTextOperations;
  transitions: readonly RegionEditTransition[];
  beforeDigest: string;
  afterDigest: string;
  affectedIds: readonly string[];
  facts: OperatedFacts;
  familyProof: FamilyProof;
  wireVersion: 15;
}>;

export type CanonicalOperatedEvent =
  | CanonicalTextApply
  | CanonicalTextReplace
  | CanonicalAnnotationApplyRange
  | CanonicalAnnotationRemove
  | CanonicalRegionEdit;

export type OperatedWireEnvelope = Readonly<{
  version: 13 | 14 | 15;
  id: string;
  before: TextRevision;
  after: TextRevision;
  operation: Record<string, unknown>;
  facts: OperatedFacts;
}>;

export function packOperatedFacts(data: Record<string, unknown> | { [key: string]: unknown }): OperatedFacts {
  const arrays = (value: unknown) => Object.freeze(value ?? []);
  return Object.freeze({
    family: data.family ?? null,
    annotation: data.annotation ?? null,
    ranges: arrays(data.ranges),
    measurements: arrays(data.measurements),
    lifecycle: data.lifecycle ?? null,
    result: data.result ?? null,
    emptiedAnnotations: arrays(data.emptiedAnnotations),
    actorId: data.actorId ?? null,
    selectedRange: data.selectedRange ?? null,
    removedAnnotationIds: arrays(data.removedAnnotationIds),
  }) as OperatedFacts;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function invalidEnvelope(entity: string, field: string, version: unknown): never {
  throw new Error(`${entity}.${field}.operated v${version} event has invalid envelope`);
}

function isTextRevision(value: unknown): value is TextRevision {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value as object).sort().join() === 'frontier,structuralRevision'
    && Number.isSafeInteger((value as TextRevision).structuralRevision)
    && (value as TextRevision).structuralRevision >= 1
    && Array.isArray((value as TextRevision).frontier);
}

function parseFacts(facts: unknown, entity: string, field: string, version: unknown): OperatedFacts {
  if (!isPlainObject(facts) || !exactKeys(facts, OPERATED_FACT_KEYS)) invalidEnvelope(entity, field, version);
  const f = facts as Record<string, unknown>;
  if (!Array.isArray(f.ranges) || !Array.isArray(f.measurements) || !Array.isArray(f.emptiedAnnotations) || !Array.isArray(f.removedAnnotationIds)
    || (f.family !== null && (!f.family || typeof f.family !== 'object'))
    || (f.annotation !== null && (!f.annotation || typeof f.annotation !== 'object'))
    || (f.lifecycle !== null && (!f.lifecycle || typeof f.lifecycle !== 'object'))
    || (f.result !== null && (!f.result || typeof f.result !== 'object'))
    || (f.actorId !== null && (typeof f.actorId !== 'string' || !f.actorId))
    || (f.selectedRange !== null && (!f.selectedRange || typeof f.selectedRange !== 'object'))) {
    invalidEnvelope(entity, field, version);
  }
  for (const key of V15_PROOF_KEYS) {
    if (Object.hasOwn(f, key)) invalidEnvelope(entity, field, version);
  }
  return packOperatedFacts(f);
}

function familyProofFor(version: 13 | 14 | 15, family: unknown, entity: string, field: string): FamilyProof {
  if (version === 13) {
    if (!family || typeof family !== 'object' || Array.isArray(family)) invalidEnvelope(entity, field, version);
    return Object.freeze({ kind: 'checkpoint', checkpoint: family });
  }
  if (family !== null) invalidEnvelope(entity, field, version);
  return Object.freeze({ kind: 'derive-and-check-frontier' });
}

function assertNoV15Proof(operation: Record<string, unknown>, entity: string, field: string, version: unknown): void {
  for (const key of V15_PROOF_KEYS) {
    if (Object.hasOwn(operation, key)) invalidEnvelope(entity, field, version);
  }
}

function serializedUtf8Bytes(value: unknown, label: string): number {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw regionLimitError(`${label} must be JSON-serializable`);
  }
  return utf8ByteLength(serialized);
}

function preflightV15Payload(raw: Record<string, unknown>, operation: Record<string, unknown>, entity: string, field: string): void {
  const label = `${entity}.${field}.operated v15`;
  if (serializedUtf8Bytes(operation, `${label} operation`) > REGION_DESCRIPTOR_MAX_UTF8_BYTES) {
    throw regionLimitError(`${label} operation exceeds ${REGION_DESCRIPTOR_MAX_UTF8_BYTES} UTF-8 bytes`);
  }
  if (serializedUtf8Bytes(raw, `${label} payload`) > REGION_DESCRIPTOR_MAX_UTF8_BYTES) {
    throw regionLimitError(`${label} payload exceeds ${REGION_DESCRIPTOR_MAX_UTF8_BYTES} UTF-8 bytes`);
  }

  let memberships = 0;
  let protectedEdges = 0;
  let prerequisites = 0;
  const visit = (value: unknown, key = '', underText = false): void => {
    if (typeof value === 'string') {
      if (underText && utf8ByteLength(value) > REGION_REPLACEMENT_MAX_UTF8_BYTES) {
        throw regionLimitError(`${label} text operation exceeds ${REGION_REPLACEMENT_MAX_UTF8_BYTES} UTF-8 bytes`);
      }
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      if (key === 'ranges' || key === 'memberships') memberships += value.length;
      if (key === 'protectedTargetIds') protectedEdges += value.length;
      if (key === 'prerequisites') prerequisites += value.length;
      for (const child of value) visit(child, '', underText);
      return;
    }
    for (const [name, child] of Object.entries(value)) visit(child, name, underText || name === 'text');
  };
  visit(raw);
  if (memberships > REGION_MEMBERSHIP_MAX) throw regionLimitError(`${label} memberships exceed ${REGION_MEMBERSHIP_MAX}`);
  if (protectedEdges > REGION_PROTECTED_EDGE_MAX) throw regionLimitError(`${label} protected edges exceed ${REGION_PROTECTED_EDGE_MAX}`);
  if (prerequisites > REGION_PREREQUISITE_MAX) throw regionLimitError(`${label} prerequisites exceed ${REGION_PREREQUISITE_MAX}`);
}

function parseRegionText(value: unknown, entity: string, field: string): RegionTextOperations {
  if (!isPlainObject(value) || typeof value.kind !== 'string') invalidEnvelope(entity, field, 15);
  if (value.kind === 'none' && exactKeys(value, ['kind'])) return Object.freeze({ kind: 'none' });
  if (value.kind === 'delete' && exactKeys(value, ['kind', 'operation']) && Array.isArray(value.operation)) {
    return Object.freeze({ kind: 'delete', operation: value.operation });
  }
  if (value.kind === 'insert' && exactKeys(value, ['kind', 'operation']) && Array.isArray(value.operation)) {
    return Object.freeze({ kind: 'insert', operation: value.operation });
  }
  if (value.kind === 'replace' && exactKeys(value, ['kind', 'operations']) && Array.isArray(value.operations) && value.operations.length === 2) {
    return Object.freeze({ kind: 'replace', operations: Object.freeze([...value.operations]) as readonly [unknown, unknown] });
  }
  invalidEnvelope(entity, field, 15);
}

const RANGE_KEYS = ['end', 'start'] as const;
const RANGE_SET_KEYS = ['annotationId', 'kind', 'ranges'] as const;
const REMOVE_KEYS = ['annotationId', 'kind'] as const;
const CREATE_KEYS = ['annotation', 'kind', 'ranges'] as const;
const CREATE_ANNOTATION_KEYS = ['family', 'fields', 'id', 'protectedTargetIds'] as const;

function parseV15Range(value: unknown, entity: string, field: string): Readonly<{ start: number; end: number }> {
  if (!isPlainObject(value) || !exactKeys(value, RANGE_KEYS)) invalidEnvelope(entity, field, 15);
  const { start, end } = value as { start: unknown; end: unknown };
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || (end as number) <= (start as number)) {
    invalidEnvelope(entity, field, 15);
  }
  return Object.freeze({ start: start as number, end: end as number });
}

function parseV15Ranges(value: unknown, entity: string, field: string): readonly Readonly<{ start: number; end: number }>[] {
  if (!Array.isArray(value)) invalidEnvelope(entity, field, 15);
  return Object.freeze(value.map((entry) => parseV15Range(entry, entity, field)));
}

function parseV15CreateAnnotation(value: unknown, entity: string, field: string): RegionEditTransition extends { kind: 'create' } ? RegionEditTransition['annotation'] : never {
  if (!isPlainObject(value) || !exactKeys(value, CREATE_ANNOTATION_KEYS)) invalidEnvelope(entity, field, 15);
  const { id, family, fields, protectedTargetIds } = value as {
    id: unknown; family: unknown; fields: unknown; protectedTargetIds: unknown;
  };
  if (typeof id !== 'string' || id.length === 0 || typeof family !== 'string' || family.length === 0) {
    invalidEnvelope(entity, field, 15);
  }
  if (!isPlainObject(fields)) invalidEnvelope(entity, field, 15);
  const fieldNames = Object.keys(fields);
  if (fieldNames.some((name, index) => index > 0 && fieldNames[index - 1] >= name)) invalidEnvelope(entity, field, 15);
  if (!Array.isArray(protectedTargetIds) || protectedTargetIds.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    invalidEnvelope(entity, field, 15);
  }
  const targets = protectedTargetIds as string[];
  if (targets.some((id2, index) => index > 0 && targets[index - 1] >= id2)) invalidEnvelope(entity, field, 15);
  return Object.freeze({
    id,
    family,
    fields: Object.freeze({ ...fields }),
    protectedTargetIds: Object.freeze([...targets]),
  }) as never as RegionEditTransition extends { kind: 'create' } ? RegionEditTransition['annotation'] : never;
}

// Every wire transition is validated through the same closed grammar as
// planning's descriptor parser (region-descriptor.ts) before the reducer sees
// it. A forged range.set naming a missing/unknown annotation, a malformed
// create payload, or an unknown kind is rejected below with the canonical
// `<entity>.<field>.operated v15 event has invalid envelope` signature, so the
// reducer can never silently drop a transition while text still commits.
function parseV15Transition(value: unknown, entity: string, field: string, seenIds: Set<string>): RegionEditTransition {
  if (!isPlainObject(value) || typeof value.kind !== 'string') invalidEnvelope(entity, field, 15);
  const kind = value.kind;
  if (kind === 'range.set') {
    if (!exactKeys(value, RANGE_SET_KEYS)) invalidEnvelope(entity, field, 15);
    const annotationId = value.annotationId;
    if (typeof annotationId !== 'string' || annotationId.length === 0) invalidEnvelope(entity, field, 15);
    if (seenIds.has(annotationId)) invalidEnvelope(entity, field, 15);
    seenIds.add(annotationId);
    return Object.freeze({ kind: 'range.set', annotationId, ranges: parseV15Ranges(value.ranges, entity, field) });
  }
  if (kind === 'remove') {
    if (!exactKeys(value, REMOVE_KEYS)) invalidEnvelope(entity, field, 15);
    const annotationId = value.annotationId;
    if (typeof annotationId !== 'string' || annotationId.length === 0) invalidEnvelope(entity, field, 15);
    if (seenIds.has(annotationId)) invalidEnvelope(entity, field, 15);
    seenIds.add(annotationId);
    return Object.freeze({ kind: 'remove', annotationId });
  }
  if (kind === 'create') {
    if (!exactKeys(value, CREATE_KEYS)) invalidEnvelope(entity, field, 15);
    const annotation = parseV15CreateAnnotation(value.annotation, entity, field);
    if (seenIds.has(annotation.id)) invalidEnvelope(entity, field, 15);
    seenIds.add(annotation.id);
    return Object.freeze({ kind: 'create', annotation, ranges: parseV15Ranges(value.ranges, entity, field) });
  }
  invalidEnvelope(entity, field, 15);
}

function parseV15Operation(operation: Record<string, unknown>, entity: string, field: string): Omit<CanonicalRegionEdit, 'id' | 'before' | 'after' | 'facts' | 'familyProof' | 'wireVersion'> {
  const keys = ['affectedIds', 'afterDigest', 'beforeDigest', 'from', 'kind', 'text', 'to', 'transitions'];
  if (!exactKeys(operation, keys) || operation.kind !== 'region.edit') invalidEnvelope(entity, field, 15);
  if (!Number.isSafeInteger(operation.from) || !Number.isSafeInteger(operation.to) || (operation.to as number) < (operation.from as number)) {
    invalidEnvelope(entity, field, 15);
  }
  if (typeof operation.beforeDigest !== 'string' || !SHA256_HEX.test(operation.beforeDigest)) {
    throw regionLimitError(`${entity}.${field}.operated v15 beforeDigest is not a SHA-256 digest`);
  }
  if (typeof operation.afterDigest !== 'string' || !SHA256_HEX.test(operation.afterDigest)) {
    throw regionLimitError(`${entity}.${field}.operated v15 afterDigest is not a SHA-256 digest`);
  }
  if (!Array.isArray(operation.affectedIds) || operation.affectedIds.some((id) => typeof id !== 'string' || id.length === 0)) {
    invalidEnvelope(entity, field, 15);
  }
  if (operation.affectedIds.length > REGION_AFFECTED_ANNOTATION_MAX) {
    throw regionLimitError(`${entity}.${field}.operated v15 affectedIds exceed ${REGION_AFFECTED_ANNOTATION_MAX}`);
  }
  const ids = operation.affectedIds as string[];
  if (ids.some((id, index) => index > 0 && ids[index - 1] >= id)) invalidEnvelope(entity, field, 15);
  if (!Array.isArray(operation.transitions) || operation.transitions.length > REGION_TRANSITION_MAX) {
    if (Array.isArray(operation.transitions) && operation.transitions.length > REGION_TRANSITION_MAX) {
      throw regionLimitError(`${entity}.${field}.operated v15 transitions exceed ${REGION_TRANSITION_MAX}`);
    }
    invalidEnvelope(entity, field, 15);
  }
  const seenIds = new Set<string>();
  const transitions = Object.freeze(
    (operation.transitions as readonly unknown[]).map((entry) => parseV15Transition(entry, entity, field, seenIds)),
  );
  return Object.freeze({
    kind: 'region.edit',
    from: operation.from as number,
    to: operation.to as number,
    text: parseRegionText(operation.text, entity, field),
    transitions,
    beforeDigest: operation.beforeDigest,
    afterDigest: operation.afterDigest,
    affectedIds: Object.freeze([...ids]),
  });
}

export function normalizeOperatedEvent(raw: unknown, context: { entity: string; field: string }): CanonicalOperatedEvent {
  const { entity, field } = context;
  const version = isPlainObject(raw) ? raw.version : undefined;
  if (version !== 13 && version !== 14 && version !== 15) {
    throw new Error(`${entity}.${field}.operated event version ${version} is not supported: only operated versions 13, 14, and 15 are replayable; pre-13 lattice rows were retired (issue #23)`);
  }
  if (!isPlainObject(raw) || !exactKeys(raw, OPERATED_ENVELOPE_KEYS)) {
    invalidEnvelope(entity, field, version);
  }
  if (typeof raw.id !== 'string' || raw.id.length === 0 || !isTextRevision(raw.before) || !isTextRevision(raw.after)
    || !isPlainObject(raw.operation)) {
    invalidEnvelope(entity, field, version);
  }
  if (version === 15) preflightV15Payload(raw, raw.operation, entity, field);
  const facts = parseFacts(raw.facts, entity, field, version);
  const familyProof = familyProofFor(version, facts.family, entity, field);
  const operation = raw.operation;
  if (version === 15) {
    const region = parseV15Operation(operation, entity, field);
    return Object.freeze({
      ...region,
      id: raw.id,
      before: raw.before,
      after: raw.after,
      facts,
      familyProof,
      wireVersion: 15,
    });
  }
  assertNoV15Proof(operation, entity, field, version);
  const kind = operation.kind;
  if (kind === 'text.apply' && exactKeys(operation, ['kind', 'operation']) && Array.isArray(operation.operation)) {
    return Object.freeze({
      kind: 'text.apply',
      id: raw.id,
      before: raw.before,
      after: raw.after,
      operation: operation.operation,
      facts,
      familyProof,
      wireVersion: version,
    });
  }
  if (kind === 'text.replace' && exactKeys(operation, ['kind', 'operations']) && Array.isArray(operation.operations) && operation.operations.length === 2) {
    return Object.freeze({
      kind: 'text.replace',
      id: raw.id,
      before: raw.before,
      after: raw.after,
      operations: Object.freeze([...operation.operations]),
      facts,
      familyProof,
      wireVersion: version,
    });
  }
  if (kind === 'annotation.apply-range' && exactKeys(operation, ['annotation', 'kind', 'selection'])) {
    return Object.freeze({
      kind: 'annotation.apply-range',
      id: raw.id,
      before: raw.before,
      after: raw.after,
      annotation: operation.annotation,
      selection: operation.selection,
      facts,
      familyProof,
      wireVersion: version,
    });
  }
  if (kind === 'annotation.remove' && exactKeys(operation, ['annotationId', 'kind']) && typeof operation.annotationId === 'string' && operation.annotationId) {
    return Object.freeze({
      kind: 'annotation.remove',
      id: raw.id,
      before: raw.before,
      after: raw.after,
      annotationId: operation.annotationId,
      facts,
      familyProof,
      wireVersion: version,
    });
  }
  invalidEnvelope(entity, field, version);
}

export function constructV13OperatedEvent(data: {
  id: string;
  before: TextRevision;
  after: TextRevision;
  operation: Record<string, unknown>;
  family: unknown;
  annotation?: unknown;
  ranges?: unknown;
  measurements?: unknown;
  lifecycle?: unknown;
  result?: unknown;
  emptiedAnnotations?: unknown;
  actorId?: unknown;
  selectedRange?: unknown;
  removedAnnotationIds?: unknown;
}): OperatedWireEnvelope {
  return Object.freeze({
    version: 13,
    id: data.id,
    before: data.before,
    after: data.after,
    operation: data.operation,
    facts: packOperatedFacts({ ...data, family: data.family }),
  });
}

export function constructV14OperatedEvent(data: {
  id: string;
  before: TextRevision;
  after: TextRevision;
  operation: Record<string, unknown>;
  annotation?: unknown;
  ranges?: unknown;
  measurements?: unknown;
  lifecycle?: unknown;
  result?: unknown;
  emptiedAnnotations?: unknown;
  actorId?: unknown;
  selectedRange?: unknown;
  removedAnnotationIds?: unknown;
}): OperatedWireEnvelope {
  return Object.freeze({
    version: 14,
    id: data.id,
    before: data.before,
    after: data.after,
    operation: data.operation,
    facts: packOperatedFacts({ ...data, family: null }),
  });
}

export function constructV15RegionEvent(plan: RegionPlan): OperatedWireEnvelope {
  return Object.freeze({
    version: 15,
    id: plan.descriptor.id,
    before: plan.before,
    after: plan.after,
    operation: Object.freeze({
      kind: 'region.edit',
      from: plan.descriptor.from,
      to: plan.descriptor.to,
      text: plan.textOperations,
      transitions: plan.descriptor.transitions,
      beforeDigest: plan.postimage.beforeDigest,
      afterDigest: plan.postimage.afterDigest,
      affectedIds: plan.postimage.affectedIds,
    }),
    facts: packOperatedFacts({
      family: null,
      emptiedAnnotations: plan.postimage.emptied,
      removedAnnotationIds: plan.postimage.emptied
        .filter((entry) => entry.disposition.kind === 'deleted')
        .map((entry) => entry.annotationId),
    }),
  });
}

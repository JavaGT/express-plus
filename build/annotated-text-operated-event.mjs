// Sole durable operated-envelope grammar (scope#992 W1 / Finding 1).
// normalizeOperatedEvent is the only version gate. Reducers consume the
// canonical form and do not branch on a wire version for kind dispatch.
// Envelope construction lives only in this module.



import {
  REGION_AFFECTED_ANNOTATION_MAX,
  REGION_TRANSITION_MAX,
  SHA256_HEX,
  regionLimitError,
} from './annotated-text-region-limits.mjs';

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
]         ;

export const OPERATED_ENVELOPE_KEYS = ['after', 'before', 'facts', 'id', 'operation', 'version']         ;

const V15_PROOF_KEYS = ['affectedIds', 'afterDigest', 'beforeDigest']         ;





































































































export function packOperatedFacts(data                                                      )                {
  const arrays = (value         ) => Object.freeze(value ?? []);
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
  })                 ;
}

function isPlainObject(value         )                                   {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value        , keys                   )          {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function invalidEnvelope(entity        , field        , version         )        {
  throw new Error(`${entity}.${field}.operated v${version} event has invalid envelope`);
}

function isTextRevision(value         )                        {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value          ).sort().join() === 'frontier,structuralRevision'
    && Number.isSafeInteger((value                ).structuralRevision)
    && (value                ).structuralRevision >= 1
    && Array.isArray((value                ).frontier);
}

function parseFacts(facts         , entity        , field        , version         )                {
  if (!isPlainObject(facts) || !exactKeys(facts, OPERATED_FACT_KEYS)) invalidEnvelope(entity, field, version);
  const f = facts                           ;
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

function familyProofFor(version              , family         , entity        , field        )              {
  if (version === 13) {
    if (!family || typeof family !== 'object' || Array.isArray(family)) invalidEnvelope(entity, field, version);
    return Object.freeze({ kind: 'checkpoint', checkpoint: family });
  }
  if (family !== null) invalidEnvelope(entity, field, version);
  return Object.freeze({ kind: 'derive-and-check-frontier' });
}

function assertNoV15Proof(operation                         , entity        , field        , version         )       {
  for (const key of V15_PROOF_KEYS) {
    if (Object.hasOwn(operation, key)) invalidEnvelope(entity, field, version);
  }
}

function parseRegionText(value         , entity        , field        )                       {
  if (!isPlainObject(value) || typeof value.kind !== 'string') invalidEnvelope(entity, field, 15);
  if (value.kind === 'none' && exactKeys(value, ['kind'])) return Object.freeze({ kind: 'none' });
  if (value.kind === 'delete' && exactKeys(value, ['kind', 'operation']) && Array.isArray(value.operation)) {
    return Object.freeze({ kind: 'delete', operation: value.operation });
  }
  if (value.kind === 'insert' && exactKeys(value, ['kind', 'operation']) && Array.isArray(value.operation)) {
    return Object.freeze({ kind: 'insert', operation: value.operation });
  }
  if (value.kind === 'replace' && exactKeys(value, ['kind', 'operations']) && Array.isArray(value.operations) && value.operations.length === 2) {
    return Object.freeze({ kind: 'replace', operations: Object.freeze([...value.operations])                                });
  }
  invalidEnvelope(entity, field, 15);
}

function parseV15Operation(operation                         , entity        , field        )                                                                                                 {
  const keys = ['affectedIds', 'afterDigest', 'beforeDigest', 'from', 'kind', 'text', 'to', 'transitions'];
  if (!exactKeys(operation, keys) || operation.kind !== 'region.edit') invalidEnvelope(entity, field, 15);
  if (!Number.isSafeInteger(operation.from) || !Number.isSafeInteger(operation.to) || (operation.to          ) < (operation.from          )) {
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
  const ids = operation.affectedIds            ;
  if (ids.some((id, index) => index > 0 && ids[index - 1] >= id)) invalidEnvelope(entity, field, 15);
  if (!Array.isArray(operation.transitions) || operation.transitions.length > REGION_TRANSITION_MAX) {
    if (Array.isArray(operation.transitions) && operation.transitions.length > REGION_TRANSITION_MAX) {
      throw regionLimitError(`${entity}.${field}.operated v15 transitions exceed ${REGION_TRANSITION_MAX}`);
    }
    invalidEnvelope(entity, field, 15);
  }
  return Object.freeze({
    kind: 'region.edit',
    from: operation.from          ,
    to: operation.to          ,
    text: parseRegionText(operation.text, entity, field),
    transitions: Object.freeze([...(operation.transitions                          )]),
    beforeDigest: operation.beforeDigest,
    afterDigest: operation.afterDigest,
    affectedIds: Object.freeze([...ids]),
  });
}

export function normalizeOperatedEvent(raw         , context                                   )                         {
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

export function constructV13OperatedEvent(data














 )                       {
  return Object.freeze({
    version: 13,
    id: data.id,
    before: data.before,
    after: data.after,
    operation: data.operation,
    facts: packOperatedFacts({ ...data, family: data.family }),
  });
}

export function constructV14OperatedEvent(data













 )                       {
  return Object.freeze({
    version: 14,
    id: data.id,
    before: data.before,
    after: data.after,
    operation: data.operation,
    facts: packOperatedFacts({ ...data, family: null }),
  });
}

export function constructV15RegionEvent(plan            )                       {
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

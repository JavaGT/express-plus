import { getAnnotatedTextCompiledMetadata } from './annotated-text-field.mjs';

/** Closed public envelope for a declaration-derived related-entity action. */
export function annotatedTextAnnotationAction(entity     , field     , actionHandle     , input     )                                 {
  if (!entity || typeof entity.name !== 'string' || !entity.field || !field || typeof field.fieldName !== 'string'
    || field.entityName !== entity.name) throw new TypeError('annotatedTextAnnotationAction requires compiled entity and field handles');
  if (!actionHandle || actionHandle.kind !== 'annotationEntityAction' || typeof actionHandle.actionName !== 'string') throw new TypeError('annotatedTextAnnotationAction requires a compiled entity-action handle');
  const descriptor = entity.fields?.[field.fieldName];
  const metadata = getAnnotatedTextCompiledMetadata(descriptor);
  const expected = metadata?.annotationHandles?.[actionHandle.family]?.actions?.[actionHandle.actionName];
  if (!expected || expected !== actionHandle || expected.entityName !== entity.name || expected.fieldName !== field.fieldName) {
    throw new TypeError('annotatedTextAnnotationAction handles must come from the same compiled declaration');
  }
  if (!input || typeof input !== 'object' || Array.isArray(input) || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) throw new TypeError('annotatedTextAnnotationAction input must be a plain object');
  const keys = Object.keys(input);
  if (Reflect.ownKeys(input).some((key) => typeof key !== 'string' || !['id', 'basis', 'mutationId', 'from', 'to', 'values'].includes(key))) throw new TypeError('annotatedTextAnnotationAction input has unknown keys');
  if (keys.length !== 6 || typeof input.id !== 'string' || !input.id || typeof input.basis !== 'string' || !input.basis) throw new TypeError('annotatedTextAnnotationAction requires document id and basis');
  if (typeof input.mutationId !== 'string' || !input.mutationId) throw new TypeError('annotatedTextAnnotationAction requires mutationId');
  if (!Number.isSafeInteger(input.from) || !Number.isSafeInteger(input.to)) throw new TypeError('annotatedTextAnnotationAction requires integer range');
  if (!input.values || typeof input.values !== 'object' || Array.isArray(input.values) || (Object.getPrototypeOf(input.values) !== Object.prototype && Object.getPrototypeOf(input.values) !== null) || Reflect.ownKeys(input.values).some((key) => typeof key !== 'string')) throw new TypeError('annotatedTextAnnotationAction values must be a plain object');
  const valueNames = Object.keys(input.values);
  const expectedNames = Object.keys(actionHandle.input ?? {});
  if (valueNames.some((key) => !expectedNames.includes(key)) || valueNames.length !== expectedNames.length) throw new TypeError('annotatedTextAnnotationAction values has unknown or missing fields');
  return Object.freeze({
    type: `${entity.name}.${field.fieldName}.${actionHandle.actionName}`,
    payload: Object.freeze({ version: 1, id: input.id, basis: input.basis, mutationId: input.mutationId, from: input.from, to: input.to, values: Object.freeze({ ...input.values }) }),
  });
}

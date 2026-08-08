import { ValidationError } from './field-strategy.mjs';
import { splitBlock, materializeBlock } from './annotated-text-family.mjs';
                                                             
import { assertUtf16Offset } from './annotated-text.mjs';

function deepFreeze   (value   )              {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) return value;
  for (const v of Object.values(value)) deepFreeze(v);
  return Object.freeze(value);
}

export function assertR4AnnotationApplyPayload(name        , fieldName        , payload     ) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      Object.keys(payload).length !== 4 ||
      !Object.hasOwn(payload, 'version') || !Object.hasOwn(payload, 'id') ||
      !Object.hasOwn(payload, 'expected') || !Object.hasOwn(payload, 'operation')) {
    throw new ValidationError(`${name}.${fieldName}.operation requires exactly { version, id, expected, operation }`);
  }
  if (payload.version !== 4 || typeof payload.id !== 'string' || payload.id.length === 0) {
    throw new ValidationError(`${name}.${fieldName}.operation requires version 4 and a non-empty id`);
  }
  const expected = payload.expected;
  if (!expected || typeof expected !== 'object' || Array.isArray(expected) ||
      Object.keys(expected).length !== 2 || !Object.hasOwn(expected, 'structuralRevision') || !Object.hasOwn(expected, 'frontier') ||
      !Number.isSafeInteger(expected.structuralRevision) || expected.structuralRevision < 1 || !Array.isArray(expected.frontier)) {
    throw new ValidationError(`${name}.${fieldName}.operation expected requires structuralRevision and frontier`);
  }
  const operation = payload.operation;
  if (!operation || typeof operation !== 'object' || Array.isArray(operation) ||
      Object.keys(operation).length !== 3 || operation.kind !== 'annotation.apply' ||
      !operation.annotation || typeof operation.annotation !== 'object' || Array.isArray(operation.annotation) ||
      (Object.keys(operation.annotation).length !== 3 && Object.keys(operation.annotation).length !== 4) ||
      !Object.hasOwn(operation.annotation, 'id') || !Object.hasOwn(operation.annotation, 'family') || !Object.hasOwn(operation.annotation, 'fields') ||
      typeof operation.annotation.id !== 'string' || operation.annotation.id.length === 0 ||
      typeof operation.annotation.family !== 'string' || operation.annotation.family.length === 0 ||
      !operation.annotation.fields || typeof operation.annotation.fields !== 'object' || Array.isArray(operation.annotation.fields) ||
      (Object.hasOwn(operation.annotation, 'protectedTargetIds') &&
        (!Array.isArray(operation.annotation.protectedTargetIds) ||
          operation.annotation.protectedTargetIds.some((id        , index        , values          ) => typeof id !== 'string' || id.length === 0 || (index > 0 && values[index - 1] >= id))))) {
    throw new ValidationError(`${name}.${fieldName}.operation requires annotation.apply with annotation { id, family, fields, protectedTargetIds? }`);
  }
  if (!operation.selection || typeof operation.selection !== 'object' || Array.isArray(operation.selection) ||
      Object.keys(operation.selection).length !== 3 ||
      !Object.hasOwn(operation.selection, 'blockId') || !Object.hasOwn(operation.selection, 'startUtf16Offset') || !Object.hasOwn(operation.selection, 'endUtf16Offset') ||
      typeof operation.selection.blockId !== 'string' || operation.selection.blockId.length === 0 ||
      !Number.isSafeInteger(operation.selection.startUtf16Offset) || operation.selection.startUtf16Offset < 0 ||
      !Number.isSafeInteger(operation.selection.endUtf16Offset) || operation.selection.endUtf16Offset < 0) {
    throw new ValidationError(`${name}.${fieldName}.operation requires annotation.apply with selection { blockId, startUtf16Offset, endUtf16Offset }`);
  }
  return Object.freeze({
    version: 4,
    id: payload.id,
    expected: Object.freeze({ structuralRevision: expected.structuralRevision, frontier: expected.frontier }),
    operation: Object.freeze({
      kind: 'annotation.apply',
      annotation: Object.freeze({
        id: operation.annotation.id,
        family: operation.annotation.family,
        fields: Object.freeze(operation.annotation.fields),
        ...(Object.hasOwn(operation.annotation, 'protectedTargetIds')
          ? { protectedTargetIds: Object.freeze([...operation.annotation.protectedTargetIds]) }
          : {}),
      }),
      selection: Object.freeze({
        blockId: operation.selection.blockId,
        startUtf16Offset: operation.selection.startUtf16Offset,
        endUtf16Offset: operation.selection.endUtf16Offset,
      }),
    }),
  });
}

/**
 * Given a family, a source block, a visible UTF-16 range [start,end), and
 * server-provided candidate split IDs, perform 0/1/2 splitBlock calls to
 * isolate the range as one whole block. Returns the canonical family plus
 * source/selected block IDs and the IDs actually used for splits.
 *
 * Topology (no prior splits on the source block):
 *   boundary full-block [0,len)  → 0 splits, selected = source
 *   prefix [0,end)               → 1 split at end, selected = source
 *   suffix [start,len)           → 1 split at start, selected = new block
 *   interior [start,end)         → 2 splits (start then end), selected = mid block
 */
export function isolateAnnotationSelection(family            , blockId        , startUtf16Offset        , endUtf16Offset        , splitBlockIds          ) {
  const sourceText = materializeBlock(family, blockId);
  if (!Number.isSafeInteger(startUtf16Offset) || !Number.isSafeInteger(endUtf16Offset) ||
      startUtf16Offset < 0 || endUtf16Offset > sourceText.length || startUtf16Offset >= endUtf16Offset) {
    throw new Error('annotation selection must be a non-empty range inside its source block');
  }
  assertUtf16Offset(sourceText, startUtf16Offset);
  assertUtf16Offset(sourceText, endUtf16Offset);

  const requiredSplits = (startUtf16Offset > 0 ? 1 : 0) + (endUtf16Offset < sourceText.length ? 1 : 0);
  if (!Array.isArray(splitBlockIds) || splitBlockIds.length !== requiredSplits ||
      splitBlockIds.some((id) => typeof id !== 'string' || id.length === 0) ||
      new Set(splitBlockIds).size !== splitBlockIds.length) {
    throw new Error(`annotation selection requires exactly ${requiredSplits} unique split block IDs`);
  }

  let next = family;
  let selectedBlockId = blockId;
  const actualSplitIds           = [];
  let splitIndex = 0;

  if (startUtf16Offset > 0) {
    const rightBlockId = splitBlockIds[splitIndex++];
    const result = splitBlock(next, blockId, rightBlockId, startUtf16Offset);
    if (result.type !== 'split') throw new Error('annotation selection start did not produce a structural split');
    next = result.family;
    selectedBlockId = rightBlockId;
    actualSplitIds.push(rightBlockId);
  }

  const selectedLength = endUtf16Offset - startUtf16Offset;
  if (endUtf16Offset < sourceText.length) {
    const rightBlockId = splitBlockIds[splitIndex++];
    const result = splitBlock(next, selectedBlockId, rightBlockId, selectedLength);
    if (result.type !== 'split') throw new Error('annotation selection end did not produce a structural split');
    next = result.family;
    actualSplitIds.push(rightBlockId);
  }

  return deepFreeze({
    family: next,
    sourceBlockId: blockId,
    selectedBlockId,
    splitBlockIds: actualSplitIds,
  });
}

export { isolateAnnotationSelection as deriveSelectionBlock };

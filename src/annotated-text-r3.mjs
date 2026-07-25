import { ValidationError } from './field-strategy.mjs';
import { frozenJsonSnapshot } from './annotated-text-r2.mjs';

export function assertR3BlockMergePayload(name, fieldName, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      Object.keys(payload).length !== 4 ||
      !Object.hasOwn(payload, 'version') || !Object.hasOwn(payload, 'id') ||
      !Object.hasOwn(payload, 'expected') || !Object.hasOwn(payload, 'operation')) {
    throw new ValidationError(`${name}.${fieldName}.operation requires exactly { version, id, expected, operation }`);
  }
  if (payload.version !== 3 || typeof payload.id !== 'string' || payload.id.length === 0) {
    throw new ValidationError(`${name}.${fieldName}.operation requires version 3 and a non-empty id`);
  }
  const expected = payload.expected;
  if (!expected || typeof expected !== 'object' || Array.isArray(expected) ||
      Object.keys(expected).length !== 2 || !Object.hasOwn(expected, 'structuralRevision') || !Object.hasOwn(expected, 'frontier') ||
      !Number.isSafeInteger(expected.structuralRevision) || expected.structuralRevision < 1 || !Array.isArray(expected.frontier)) {
    throw new ValidationError(`${name}.${fieldName}.operation expected requires structuralRevision and frontier`);
  }
  const operation = payload.operation;
  if (!operation || typeof operation !== 'object' || Array.isArray(operation) ||
      Object.keys(operation).length !== 3 || operation.kind !== 'block.merge' ||
      typeof operation.leftBlockId !== 'string' || operation.leftBlockId.length === 0 ||
      typeof operation.rightBlockId !== 'string' || operation.rightBlockId.length === 0) {
    throw new ValidationError(`${name}.${fieldName}.operation requires a block.merge operation with leftBlockId and rightBlockId`);
  }
  return Object.freeze({
    version: 3,
    id: payload.id,
    expected: Object.freeze({ structuralRevision: expected.structuralRevision, frontier: expected.frontier }),
    operation: Object.freeze({ kind: 'block.merge', leftBlockId: operation.leftBlockId, rightBlockId: operation.rightBlockId }),
  });
}

export function canonicalJsonEqual(a, b) {
  function canonical(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(canonical);
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonical(value[key]);
    }
    return sorted;
  }
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
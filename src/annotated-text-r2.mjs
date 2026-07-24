import { ValidationError } from './field-strategy.mjs';

function freezeJson(value, seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('JSON number must be finite');
    return value;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) throw new Error('value is not JSON');
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (!Object.hasOwn(value, i)) throw new Error('JSON array cannot be sparse');
      freezeJson(value[i], seen);
    }
    return Object.freeze(value);
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) throw new Error('JSON object must be plain');
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'undefined') throw new Error(`JSON object property '${key}' is undefined`);
    freezeJson(item, seen);
  }
  return Object.freeze(value);
}

export function frozenJsonSnapshot(value) {
  let snapshot;
  try {
    snapshot = JSON.parse(JSON.stringify(value));
  } catch {
    throw new Error('value is not JSON');
  }
  return freezeJson(snapshot);
}

export function assertR2BlockSplitPayload(name, fieldName, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      Object.keys(payload).length !== 4 ||
      !Object.hasOwn(payload, 'version') || !Object.hasOwn(payload, 'id') ||
      !Object.hasOwn(payload, 'expected') || !Object.hasOwn(payload, 'operation')) {
    throw new ValidationError(`${name}.${fieldName}.operation requires exactly { version, id, expected, operation }`);
  }
  if (payload.version !== 2 || typeof payload.id !== 'string' || payload.id.length === 0) {
    throw new ValidationError(`${name}.${fieldName}.operation requires version 2 and a non-empty id`);
  }
  const expected = payload.expected;
  if (!expected || typeof expected !== 'object' || Array.isArray(expected) ||
      Object.keys(expected).length !== 2 || !Object.hasOwn(expected, 'structuralRevision') || !Object.hasOwn(expected, 'frontier') ||
      !Number.isSafeInteger(expected.structuralRevision) || expected.structuralRevision < 1 || !Array.isArray(expected.frontier)) {
    throw new ValidationError(`${name}.${fieldName}.operation expected requires structuralRevision and frontier`);
  }
  const operation = payload.operation;
  if (!operation || typeof operation !== 'object' || Array.isArray(operation) ||
      Object.keys(operation).length !== 3 || operation.kind !== 'block.split' ||
      typeof operation.blockId !== 'string' || operation.blockId.length === 0 ||
      !Number.isInteger(operation.utf16Offset) || operation.utf16Offset < 0) {
    throw new ValidationError(`${name}.${fieldName}.operation requires a block.split operation with blockId and utf16Offset`);
  }
  return Object.freeze({
    version: 2,
    id: payload.id,
    expected: Object.freeze({ structuralRevision: expected.structuralRevision, frontier: expected.frontier }),
    operation: Object.freeze({ kind: 'block.split', blockId: operation.blockId, utf16Offset: operation.utf16Offset }),
  });
}

export function deriveBlockPosition(index) {
  return index.toString(36).toLowerCase().padStart(13, '0');
}

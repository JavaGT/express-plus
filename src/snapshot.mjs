// Declared relational recipient snapshots. The grammar carries entities and
// field handles, so callers cannot smuggle SQL, tables, or callbacks into live
// delivery.
import { isSnapshotFieldHandle } from './scope-sql.mjs';

function node(kind, value = {}) { return Object.freeze({ kind, ...value }); }

function entityOf(value) {
  if (!value || typeof value !== 'object' || typeof value.name !== 'string' || !value.fields) {
    throw new TypeError('snapshot relation requires a declared entity');
  }
  return value;
}

function fieldsOf(handles) {
  if (!Array.isArray(handles) || handles.length === 0) throw new TypeError('select requires one or more field handles');
  const fields = handles.map((handle) => handle?.fieldName);
  if (fields.some((field) => typeof field !== 'string')) throw new TypeError('select accepts only field handles');
  return Object.freeze(fields);
}

function refOf(handle, label = 'via') {
  if (!handle || typeof handle.fieldName !== 'string') throw new TypeError(`${label} requires a ref field handle`);
  return handle.fieldName;
}

function declareSnapshot(anchor, { output, tombstones: visibility } = {}) {
  return node('snapshot', { anchor: entityOf(anchor), output, tombstones: visibility });
}

export function object(shape) {
  if (!shape || typeof shape !== 'object' || Array.isArray(shape)) throw new TypeError('object requires an output object');
  return node('object', { shape: Object.freeze({ ...shape }) });
}

export function one(entity, { via, ...options } = {}) { return node('one', { entity: entityOf(entity), via: refOf(via), ...options }); }
export function many(entity, { via, ...options } = {}) { return node('many', { entity: entityOf(entity), via: refOf(via), ...options }); }
export function keyed(entity, { via, ...options } = {}) { return node('keyed', { entity: entityOf(entity), via: refOf(via), ...options }); }
export function select(...handles) { return node('select', { fields: fieldsOf(handles) }); }
export function include(shape) { return object(shape); }
export function orderBy(handle, direction = 'asc') {
  if (!handle || typeof handle.fieldName !== 'string') throw new TypeError('orderBy accepts a field handle');
  if (direction !== 'asc' && direction !== 'desc') throw new TypeError("orderBy direction must be 'asc' or 'desc'");
  return node('orderBy', { field: handle.fieldName, direction });
}
export function count(entity, { via, ...options } = {}) { return node('count', { entity: entityOf(entity), via: refOf(via), ...options }); }
// A required related row is a closed candidate filter, never a projected join.
export function related(childRef, { via } = {}) {
  if (!isSnapshotFieldHandle(childRef) || !isSnapshotFieldHandle(via)) {
    throw new TypeError('related requires declared field handles');
  }
  return node('related', {
    childRef: refOf(childRef, 'related childRef'), via: refOf(via, 'related via'),
    childEntity: childRef?.entityName, parentEntity: via?.entityName,
  });
}
export function user({ via } = {}) { return node('user', { via: refOf(via) }); }

// This is intentionally a closed visibility declaration: no callbacks, SQL, or
// arbitrary checks can influence which recipient rows are hidden.
export function tombstones(target, { entity, entityId, scopeId, terminalScope, kind, state, kindValue, hidden } = {}) {
  if (typeof kindValue !== 'string' || kindValue.length === 0) throw new TypeError('tombstones requires a literal kindValue');
  if (!Array.isArray(hidden) || hidden.length === 0 || hidden.some((value) => typeof value !== 'string' || value.length === 0)) {
    throw new TypeError('tombstones requires one or more literal hidden states');
  }
  return node('tombstones', {
    target: entityOf(target), entity: entityOf(entity), entityId: refOf(entityId, 'tombstones entityId'),
    scopeId: scopeId === undefined ? undefined : refOf(scopeId, 'tombstones scopeId'),
    terminalScope: terminalScope === undefined ? undefined : entityOf(terminalScope),
    kindField: refOf(kind, 'tombstones kind'), state: refOf(state, 'tombstones state'), kindValue,
    hidden: Object.freeze([...hidden]),
  });
}

export const snapshot = Object.freeze(Object.assign(declareSnapshot, {
  object, one, keyed, many, select, include, orderBy, count, related, user, tombstones,
}));

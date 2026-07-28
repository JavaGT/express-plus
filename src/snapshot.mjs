// Declared relational recipient snapshots. The grammar carries entities and
// field handles, so callers cannot smuggle SQL, tables, or callbacks into live
// delivery.

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

function declareSnapshot(anchor, { output } = {}) {
  return node('snapshot', { anchor: entityOf(anchor), output });
}

export function object(shape) {
  if (!shape || typeof shape !== 'object' || Array.isArray(shape)) throw new TypeError('object requires an output object');
  return node('object', { shape: Object.freeze({ ...shape }) });
}

export function one(entity, options = {}) { return node('one', { entity: entityOf(entity), ...options }); }
export function many(entity, options = {}) { return node('many', { entity: entityOf(entity), ...options }); }
export function keyed(entity, options = {}) { return node('keyed', { entity: entityOf(entity), ...options }); }
export function select(...handles) { return node('select', { fields: fieldsOf(handles) }); }
export function include(shape) { return object(shape); }
export function orderBy(handle, direction = 'asc') {
  if (!handle || typeof handle.fieldName !== 'string') throw new TypeError('orderBy accepts a field handle');
  if (direction !== 'asc' && direction !== 'desc') throw new TypeError("orderBy direction must be 'asc' or 'desc'");
  return node('orderBy', { field: handle.fieldName, direction });
}
export function count(entity) { return node('count', { entity: entityOf(entity) }); }

export const snapshot = Object.freeze(Object.assign(declareSnapshot, {
  object, one, keyed, many, select, include, orderBy, count,
}));

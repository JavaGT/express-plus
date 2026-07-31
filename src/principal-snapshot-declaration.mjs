const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

const _sourceBrand = new WeakSet();
const _sourceFieldBrand = new WeakSet();
const _selectBrand = new WeakSet();
const _orderBrand = new WeakSet();
const _manyBrand = new WeakSet();
const _objectBrand = new WeakSet();

function assertSqlIdentifier(label, value) {
  if (typeof value !== 'string' || !SQL_IDENTIFIER.test(value)) {
    throw new Error(`${label} "${value}" is not a valid SQL identifier`);
  }
}

function assertBrand(label, value, brand, noun) {
  if (!value || typeof value !== 'object' || !brand.has(value)) {
    throw new Error(`${label} requires a valid ${noun}`);
  }
}

function fieldHandleFor(source, column) {
  assertSqlIdentifier(`projectionSource field`, column);
  const handle = Object.freeze({
    kind: 'sourceField',
    source,
    column,
    entityName: source.table,
    fieldName: column,
  });
  _sourceFieldBrand.add(handle);
  return handle;
}

export function projectionSource(schema, table) {
  if (schema === null || schema === undefined || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error('projectionSource requires an object schema');
  }
  if (!Object.isFrozen(schema)) {
    throw new Error('projectionSource requires an immutable schema');
  }
  if (typeof table !== 'string' || table.length === 0) {
    throw new Error('projectionSource requires a non-empty table name');
  }
  assertSqlIdentifier('projectionSource table', table);
  const source = {
    kind: 'projectionSource',
    schema,
    table,
  };
  const field = new Proxy({}, {
    get(_, column) {
      if (typeof column !== 'string') return undefined;
      return fieldHandleFor(source, column);
    },
  });
  const result = Object.freeze(Object.assign(source, { field }));
  _sourceBrand.add(result);
  return result;
}

function validateSource(label, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${label} must come from the same projection source`);
  }
}

function validateSourceFields(label, source, handles) {
  for (const handle of handles) {
    assertBrand(label, handle, _sourceFieldBrand, 'source field handle');
    validateSource(label, handle.source, source);
  }
}

export function principalSnapshot(name, { principalType, output }) {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(name)) {
    throw new Error(`principalSnapshot name must match /^[a-z][a-z0-9-]{0,63}$/, got '${name}'`);
  }
  if (!['user', 'link', 'system', 'apiKey'].includes(principalType)) {
    throw new Error(`principalSnapshot principalType must be one of user, link, system, apiKey, got '${principalType}'`);
  }
  assertBrand('principalSnapshot', output, _objectBrand, 'output object');
  const fields = {};
  for (const [key, rel] of Object.entries(output.shape)) {
    assertBrand(`principalSnapshot output field '${key}'`, rel, _manyBrand, 'many collection');
    if (rel.source === undefined) {
      throw new Error(`principalSnapshot output field '${key}' many collection has no source`);
    }
    fields[key] = rel;
  }
  return Object.freeze({
    kind: 'principalSnapshot',
    name,
    principalType,
    output,
    fields: Object.freeze(fields),
  });
}

principalSnapshot.object = function object(shape) {
  if (!shape || typeof shape !== 'object' || Array.isArray(shape)) {
    throw new Error('principalSnapshot.object requires an output object shape');
  }
  const resolved = {};
  for (const [key, value] of Object.entries(shape)) {
    assertBrand(`principalSnapshot.object field '${key}'`, value, _manyBrand, 'many collection');
    resolved[key] = value;
  }
  const result = Object.freeze({ kind: 'object', shape: Object.freeze(resolved) });
  _objectBrand.add(result);
  return result;
};

principalSnapshot.many = function many(source, { via, key, select, orderBy } = {}) {
  assertBrand('principalSnapshot.many source', source, _sourceBrand, 'projectionSource');
  assertBrand('principalSnapshot.many via', via, _sourceFieldBrand, 'source field handle');
  validateSource('principalSnapshot.many via', via.source, source);
  assertBrand('principalSnapshot.many key', key, _sourceFieldBrand, 'source field handle');
  validateSource('principalSnapshot.many key', key.source, source);
  if (!select || !Array.isArray(select) || select.length === 0) {
    throw new Error('principalSnapshot.many requires one or more select field handles');
  }
  assertBrand('principalSnapshot.many select', select, _selectBrand, 'select array');
  validateSourceFields('principalSnapshot.many select', source, select);
  if (orderBy !== undefined) {
    if (!Array.isArray(orderBy) || orderBy.length === 0) {
      throw new Error('principalSnapshot.many orderBy requires one or more orderBy field handles');
    }
    for (const order of orderBy) {
      assertBrand('principalSnapshot.many orderBy', order, _orderBrand, 'orderBy field handle');
      validateSource('principalSnapshot.many orderBy', order.source, source);
    }
  }
  const result = Object.freeze({
    kind: 'many',
    source,
    via,
    key,
    select: Object.freeze([...select]),
    orderBy: orderBy === undefined ? undefined : Object.freeze([...orderBy]),
  });
  _manyBrand.add(result);
  return result;
};

principalSnapshot.select = function select(...handles) {
  if (handles.length === 0) {
    throw new Error('principalSnapshot.select requires one or more field handles');
  }
  const source = handles[0]?.source;
  assertBrand('principalSnapshot.select source', source, _sourceBrand, 'projectionSource');
  validateSourceFields('principalSnapshot.select', source, handles);
  const result = Object.freeze([...handles]);
  _selectBrand.add(result);
  return result;
};

principalSnapshot.orderBy = function orderBy(handle, direction = 'asc') {
  assertBrand('principalSnapshot.orderBy', handle, _sourceFieldBrand, 'source field handle');
  if (direction !== 'asc' && direction !== 'desc') {
    throw new Error("principalSnapshot.orderBy direction must be 'asc' or 'desc'");
  }
  const result = Object.freeze({ kind: 'sourceField', source: handle.source, column: handle.column, entityName: handle.entityName, fieldName: handle.fieldName, direction });
  _orderBrand.add(result);
  return result;
};

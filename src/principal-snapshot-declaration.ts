const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

const _sourceBrand = new WeakSet<object>();
const _sourceFieldBrand = new WeakSet<object>();
const _selectBrand = new WeakSet<object>();
const _orderBrand = new WeakSet<object>();
const _manyBrand = new WeakSet<object>();
const _objectBrand = new WeakSet<object>();
const _declarationBrand = new WeakSet<object>();

function assertSqlIdentifier(label: string, value: unknown): void {
  if (typeof value !== 'string' || !SQL_IDENTIFIER.test(value)) {
    throw new Error(`${label} "${value}" is not a valid SQL identifier`);
  }
}

function assertBrand(label: string, value: unknown, brand: WeakSet<object>, noun: string): void {
  if (!value || typeof value !== 'object' || !brand.has(value)) {
    throw new Error(`${label} requires a valid ${noun}`);
  }
}

export interface ProjectionSource {
  kind: 'projectionSource';
  schema: unknown;
  table: string;
  field: Record<string, SourceFieldHandle>;
}

export interface SourceFieldHandle {
  kind: 'sourceField';
  source: ProjectionSource;
  column: string;
  entityName: string;
  fieldName: string;
  direction?: 'asc' | 'desc';
}

export interface ManyCollection {
  kind: 'many';
  source?: ProjectionSource;
  via?: SourceFieldHandle;
  key?: SourceFieldHandle;
  select?: SourceFieldHandle[];
  orderBy?: SourceFieldHandle[];
}

export interface OutputObject {
  kind: 'object';
  shape: Record<string, ManyCollection>;
}

export interface PrincipalSnapshotDeclaration {
  kind: 'principalSnapshot';
  name: string;
  principalType: unknown;
  output: OutputObject;
  fields: Record<string, ManyCollection>;
}

function fieldHandleFor(source: ProjectionSource, column: string): SourceFieldHandle {
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

export function projectionSource(schema: unknown, table: string): ProjectionSource {
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
  const source: ProjectionSource = {
    kind: 'projectionSource',
    schema,
    table,
    field: new Proxy({}, {
      get(_, column) {
        if (typeof column !== 'string') return undefined;
        return fieldHandleFor(source, column);
      },
    }),
  };
  const result = Object.freeze(source);
  _sourceBrand.add(result);
  return result;
}

function validateSource(label: string, actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`${label} must come from the same projection source`);
  }
}

function validateSourceFields(label: string, source: unknown, handles: SourceFieldHandle[]): void {
  for (const handle of handles) {
    assertBrand(label, handle, _sourceFieldBrand, 'source field handle');
    validateSource(label, handle.source, source);
  }
}

interface PrincipalSnapshotOptions {
  principalType: unknown;
  output: OutputObject;
}

export function principalSnapshot(name: string, { principalType, output }: PrincipalSnapshotOptions): PrincipalSnapshotDeclaration {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(name)) {
    throw new Error(`principalSnapshot name must match /^[a-z][a-z0-9-]{0,63}$/, got '${name}'`);
  }
  if (!['user', 'link', 'system', 'apiKey'].includes(principalType as string)) {
    throw new Error(`principalSnapshot principalType must be one of user, link, system, apiKey, got '${principalType}'`);
  }
  assertBrand('principalSnapshot', output, _objectBrand, 'output object');
  const fields: Record<string, ManyCollection> = {};
  for (const [key, rel] of Object.entries(output.shape)) {
    assertBrand(`principalSnapshot output field '${key}'`, rel, _manyBrand, 'many collection');
    if (rel.source === undefined) {
      throw new Error(`principalSnapshot output field '${key}' many collection has no source`);
    }
    fields[key] = rel;
  }
  const result = Object.freeze({
    kind: 'principalSnapshot',
    name,
    principalType,
    output,
    fields: Object.freeze(fields),
  });
  _declarationBrand.add(result);
  return result as PrincipalSnapshotDeclaration;
}

export interface principalSnapshot {
  object(shape: Record<string, ManyCollection>): OutputObject;
  many(source: ProjectionSource, options?: ManyOptions): ManyCollection;
  select(...handles: SourceFieldHandle[]): SourceFieldHandle[];
  orderBy(handle: SourceFieldHandle, direction?: 'asc' | 'desc'): SourceFieldHandle;
}

principalSnapshot.object = function object(shape: Record<string, ManyCollection>): OutputObject {
  if (!shape || typeof shape !== 'object' || Array.isArray(shape)) {
    throw new Error('principalSnapshot.object requires an output object shape');
  }
  const resolved: Record<string, ManyCollection> = {};
  for (const [key, value] of Object.entries(shape)) {
    assertBrand(`principalSnapshot.object field '${key}'`, value, _manyBrand, 'many collection');
    resolved[key] = value;
  }
  const result = Object.freeze({ kind: 'object', shape: Object.freeze(resolved) });
  _objectBrand.add(result);
  return result;
};

interface ManyOptions {
  via?: SourceFieldHandle;
  key?: SourceFieldHandle;
  select?: SourceFieldHandle[];
  orderBy?: SourceFieldHandle[];
}

principalSnapshot.many = function many(source: ProjectionSource, { via, key, select, orderBy }: ManyOptions = {}): ManyCollection {
  assertBrand('principalSnapshot.many source', source, _sourceBrand, 'projectionSource');
  assertBrand('principalSnapshot.many via', via, _sourceFieldBrand, 'source field handle');
  validateSource('principalSnapshot.many via', via!.source, source);
  assertBrand('principalSnapshot.many key', key, _sourceFieldBrand, 'source field handle');
  validateSource('principalSnapshot.many key', key!.source, source);
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
  return result as ManyCollection;
};

principalSnapshot.select = function select(...handles: SourceFieldHandle[]): SourceFieldHandle[] {
  if (handles.length === 0) {
    throw new Error('principalSnapshot.select requires one or more field handles');
  }
  const source = handles[0]?.source;
  assertBrand('principalSnapshot.select source', source, _sourceBrand, 'projectionSource');
  validateSourceFields('principalSnapshot.select', source, handles);
  const result = Object.freeze([...handles]);
  _selectBrand.add(result);
  return result as SourceFieldHandle[];
};

principalSnapshot.orderBy = function orderBy(handle: SourceFieldHandle, direction: 'asc' | 'desc' = 'asc'): SourceFieldHandle {
  assertBrand('principalSnapshot.orderBy', handle, _orderBrand, 'source field handle');
  if (direction !== 'asc' && direction !== 'desc') {
    throw new Error("principalSnapshot.orderBy direction must be 'asc' or 'desc'");
  }
  const result = Object.freeze({ kind: 'sourceField', source: handle.source, column: handle.column, entityName: handle.entityName, fieldName: handle.fieldName, direction });
  _orderBrand.add(result);
  return result;
};

export function isPrincipalSnapshotDeclaration(value: unknown): boolean {
  return value !== null && typeof value === 'object' && _declarationBrand.has(value);
}

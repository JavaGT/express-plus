import { test } from 'node:test';
import assert from 'node:assert/strict';

import { principalSnapshot, projectionSource } from '../build/principal-snapshot-declaration.mjs';
import { entity } from '../build/entity/compile.mjs';

const schema = Object.freeze({ tables: [] });

function declaration() {
  const projects = projectionSource(schema, 'UserHubProject');
  return principalSnapshot('user-hub', {
    principalType: 'user',
    output: principalSnapshot.object({
      projects: principalSnapshot.many(projects, {
        via: projects.field.recipientId,
        key: projects.field.projectId,
        select: principalSnapshot.select(projects.field.projectId, projects.field.name, projects.field.role),
        orderBy: [principalSnapshot.orderBy(projects.field.name), principalSnapshot.orderBy(projects.field.projectId)],
      }),
    }),
  });
}

test('principal snapshot declares a frozen flat recipient projection', () => {
  const result = declaration();
  assert.equal(result.kind, 'principalSnapshot');
  assert.equal(result.principalType, 'user');
  assert.equal(result.output.shape.projects.source.table, 'UserHubProject');
  assert.equal(result.output.shape.projects.orderBy.length, 2);
  assert.ok(Object.isFrozen(result));
});

test('projection sources retain their schema identity and reject unsafe tables', () => {
  const source = projectionSource(schema, 'UserHubNotification');
  assert.equal(source.schema, schema);
  assert.throws(() => projectionSource(null, 'UserHubNotification'), /object schema/);
  assert.throws(() => projectionSource({ tables: [] }, 'UserHubNotification'), /immutable schema/);
  assert.throws(() => projectionSource(schema, 'bad-table'), /SQL identifier/);
});

test('principal snapshots reject invalid names, principal types, and non-many output', () => {
  assert.throws(() => principalSnapshot('UserHub', { principalType: 'user', output: principalSnapshot.object({}) }), /name must match/);
  assert.throws(() => principalSnapshot('user-hub', { output: principalSnapshot.object({}) }), /principalType/);
  assert.throws(() => principalSnapshot('user-hub', { principalType: 'anonymous', output: principalSnapshot.object({}) }), /principalType/);
  assert.throws(() => principalSnapshot('user-hub', { principalType: 'user', output: principalSnapshot.object({ nested: {} }) }), /many collection/);
});

test('principal snapshot grammar rejects cross-source, empty, and arbitrary collection inputs', () => {
  const projects = projectionSource(schema, 'UserHubProject');
  const invitations = projectionSource(schema, 'UserHubInvitation');
  assert.throws(() => principalSnapshot.select(), /one or more/);
  assert.throws(() => principalSnapshot.select(projects.field.id, invitations.field.id), /same projection source/);
  assert.throws(() => principalSnapshot.many(projects, {
    via: invitations.field.recipientId,
    key: projects.field.projectId,
    select: principalSnapshot.select(projects.field.projectId),
  }), /same projection source/);
  assert.throws(() => principalSnapshot.many(projects, {
    via: projects.field.recipientId,
    key: projects.field.projectId,
    select: [],
  }), /one or more/);
  assert.throws(() => principalSnapshot.many(projects, {
    via: projects.field.recipientId,
    key: projects.field.projectId,
    select: principalSnapshot.select(projects.field.projectId),
    orderBy: projects.field.projectId,
  }), /one or more orderBy/);
  assert.throws(() => principalSnapshot.many(projects, {
    via: projects.field.recipientId,
    key: projects.field.projectId,
    select: principalSnapshot.select(projects.field.projectId),
    orderBy: [{ sql: 'name DESC' }],
  }), /orderBy field handle/);
});

test('PrincipalSnapshot remains unavailable as a mutable entity name', () => {
  assert.throws(() => entity('PrincipalSnapshot', {}), /reserved framework name/);
});

test('forged root object rejected by principalSnapshot', () => {
  const projects = projectionSource(schema, 'T');
  assert.throws(() => principalSnapshot('x', {
    principalType: 'user',
    output: { kind: 'object', shape: { p: principalSnapshot.many(projects, { via: projects.field.id, key: projects.field.id, select: principalSnapshot.select(projects.field.id) }) } },
  }), /output object/);
});

test('forged many rejected by principalSnapshot.object', () => {
  assert.throws(() => principalSnapshot.object({ p: { kind: 'many', source: null, via: null, key: null, select: [] } }), /many collection/);
});

test('forged source field rejected by many via/key', () => {
  const projects = projectionSource(schema, 'T');
  const forged = { kind: 'sourceField', source: projects, column: 'x', entityName: 'T', fieldName: 'x' };
  assert.throws(() => principalSnapshot.many(projects, { via: forged, key: projects.field.id, select: principalSnapshot.select(projects.field.id) }), /source field handle/);
  assert.throws(() => principalSnapshot.many(projects, { via: projects.field.id, key: forged, select: principalSnapshot.select(projects.field.id) }), /source field handle/);
});

test('forged source rejected by many', () => {
  const forged = { kind: 'projectionSource', schema: {}, table: 'X' };
  assert.throws(() => principalSnapshot.many(forged, { via: null, key: null, select: [null] }), /projectionSource/);
});

test('forged select rejected by many', () => {
  const projects = projectionSource(schema, 'T');
  const forgedSelect = Object.freeze([{ kind: 'sourceField', source: projects, column: 'x', entityName: 'T', fieldName: 'x' }]);
  assert.throws(() => principalSnapshot.many(projects, { via: projects.field.id, key: projects.field.id, select: forgedSelect }), /select array/);
});

test('forged orderBy rejected by many', () => {
  const projects = projectionSource(schema, 'T');
  const forgedOrder = Object.freeze([{ kind: 'sourceField', source: projects, column: 'x', entityName: 'T', fieldName: 'x', direction: 'asc' }]);
  assert.throws(() => principalSnapshot.many(projects, { via: projects.field.id, key: projects.field.id, select: principalSnapshot.select(projects.field.id), orderBy: forgedOrder }), /orderBy field handle/);
});

test('forged select handle rejected by select', () => {
  const projects = projectionSource(schema, 'T');
  const forged = { kind: 'sourceField', source: projects, column: 'x', entityName: 'T', fieldName: 'x' };
  assert.throws(() => principalSnapshot.select(forged), /source field handle/);
});

test('forged orderBy handle rejected by orderBy', () => {
  const forged = { kind: 'sourceField', source: null, column: 'x', entityName: 'T', fieldName: 'x' };
  assert.throws(() => principalSnapshot.orderBy(forged), /source field handle/);
});

test('mutation after construction cannot alter source metadata', () => {
  const schema = Object.freeze({ tables: [] });
  const source = projectionSource(schema, 'MyTable');
  assert.throws(() => { source.table = 'Hacked'; }, TypeError);
  assert.throws(() => { source.schema = { hacked: true }; }, TypeError);
  assert.throws(() => { delete source.kind; }, TypeError);
});

test('source schema cannot mutate an accepted declaration graph', () => {
  const schema = Object.freeze({ tables: Object.freeze([]) });
  const source = projectionSource(schema, 'MyTable');
  const output = principalSnapshot.object({
    rows: principalSnapshot.many(source, {
      via: source.field.recipientId,
      key: source.field.id,
      select: principalSnapshot.select(source.field.id),
    }),
  });
  const declaration = principalSnapshot('immutable-source', { principalType: 'user', output });
  assert.throws(() => { schema.tables = ['Hacked']; }, TypeError);
  assert.equal(declaration.output.shape.rows.source.schema, schema);
});

test('mutation after construction cannot alter declaration fields', () => {
  const decl = declaration();
  assert.throws(() => { decl.output = null; }, TypeError);
  assert.throws(() => { decl.fields = {}; }, TypeError);
  assert.throws(() => { delete decl.kind; }, TypeError);
});

test('mutation after construction cannot alter output shape', () => {
  const decl = declaration();
  assert.throws(() => { decl.output.shape = {}; }, TypeError);
  assert.throws(() => { decl.output.shape.projects = null; }, TypeError);
});

test('mutation after construction cannot alter select array', () => {
  const projects = projectionSource(schema, 'T');
  const sel = principalSnapshot.select(projects.field.id);
  assert.throws(() => { sel.push(projects.field.name); }, TypeError);
  assert.throws(() => { sel[0] = null; }, TypeError);
});

test('mutation after construction cannot alter orderBy array', () => {
  const projects = projectionSource(schema, 'T');
  const many = principalSnapshot.many(projects, { via: projects.field.id, key: projects.field.id, select: principalSnapshot.select(projects.field.id), orderBy: [principalSnapshot.orderBy(projects.field.id)] });
  assert.throws(() => { many.orderBy.push(principalSnapshot.orderBy(projects.field.id, 'desc')); }, TypeError);
});

test('mutation after construction cannot alter source field properties', () => {
  const projects = projectionSource(schema, 'T');
  const fh = projects.field.id;
  assert.throws(() => { fh.column = 'hacked'; }, TypeError);
  assert.throws(() => { fh.source = null; }, TypeError);
  assert.throws(() => { delete fh.kind; }, TypeError);
});

test('valid construction still passes', () => {
  const s = projectionSource(Object.freeze({}), 'MyTable');
  assert.equal(s.kind, 'projectionSource');
  assert.equal(s.table, 'MyTable');
  assert.ok(Object.isFrozen(s));

  const fh = s.field.myCol;
  assert.equal(fh.kind, 'sourceField');
  assert.equal(fh.column, 'myCol');
  assert.equal(fh.source, s);
  assert.ok(Object.isFrozen(fh));

  const sel = principalSnapshot.select(s.field.a, s.field.b);
  assert.equal(sel.length, 2);
  assert.ok(Object.isFrozen(sel));

  const ob = principalSnapshot.orderBy(s.field.a, 'desc');
  assert.equal(ob.direction, 'desc');
  assert.ok(Object.isFrozen(ob));

  const many = principalSnapshot.many(s, { via: s.field.a, key: s.field.b, select: sel, orderBy: [ob] });
  assert.equal(many.kind, 'many');
  assert.ok(Object.isFrozen(many));
  assert.ok(Object.isFrozen(many.select));
  assert.ok(Array.isArray(many.orderBy));
  assert.ok(Object.isFrozen(many.orderBy));

  const obj = principalSnapshot.object({ x: many });
  assert.equal(obj.kind, 'object');
  assert.ok(Object.isFrozen(obj));
  assert.ok(Object.isFrozen(obj.shape));

  const decl = principalSnapshot('test-decl', { principalType: 'user', output: obj });
  assert.equal(decl.kind, 'principalSnapshot');
  assert.ok(Object.isFrozen(decl));
  assert.ok(Object.isFrozen(decl.fields));
});

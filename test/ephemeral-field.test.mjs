import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entity, ephemeral, presence, scope, everyone, grant, read, generateDDL } from '../src/index.mjs';

// `ephemeral(cells)` — the general NON-PERSISTING field kind (DECISIONLOG #51).
// Accepts an author-declared cell shape (richer than boolean toggles — e.g. a
// drawing canvas can hold a 60Hz in-progress stroke). Its ephemerality is
// EMERGENT: it engages no persistence seam (no strategy entry, so it never
// serializes) — the absent seam IS the ephemerality. A side-table MAY hold per-
// connection cells (that is NOT the "persistence seam" — that's STRATEGIES/_Log).

test('ephemeral() returns a frozen ephemeral-kind descriptor', () => {
  const field = ephemeral({ stroke: 'object', x: 'number' });
  assert.equal(field.kind, 'ephemeral');
  assert.equal(field.type, 'ephemeral');
  assert.ok(Object.isFrozen(field));
});

test('ephemeral carries its declared live sub-cells shape', () => {
  const field = ephemeral({ stroke: 'object', x: 'number' });
  assert.deepEqual(field.cells, { stroke: 'object', x: 'number' });
  assert.ok(Object.isFrozen(field.cells));
});

test('ephemeral carries NO persistence opinion as a flag', () => {
  // ephemerality is emergent from the absent seam, not a `persisted: false`
  // label on the descriptor.
  const field = ephemeral({ cursor: true });
  assert.equal(field.persisted, undefined);
});

test('.can(fn) returns a new frozen ephemeral descriptor carrying the access fn', () => {
  const fn = async () => true;
  const field = ephemeral({ cursor: true }).can(fn);
  assert.equal(field.access, fn);
  assert.equal(field.kind, 'ephemeral');
  assert.equal(field.type, 'ephemeral');
  assert.ok(Object.isFrozen(field));
});

test('presence(cells) is a retired wrapper — identical to ephemeral(cells)', () => {
  // presence RETIRED into ephemeral: ONE non-persisting kind. presence(cells)
  // must produce the same kind/type/cells as ephemeral(cells) — not run a
  // parallel kind beside it. (deepEqual chokes on the `can` method, so compare
  // fields.)
  const field = presence({ cursor: true, selection: true });
  assert.equal(field.kind, 'ephemeral');
  assert.equal(field.type, 'ephemeral');
  assert.deepEqual(field.cells, { cursor: true, selection: true });
  assert.ok(Object.isFrozen(field.cells));
  assert.ok(Object.isFrozen(field));
  const direct = ephemeral({ cursor: true, selection: true });
  assert.equal(field.kind, direct.kind);
  assert.equal(field.type, direct.type);
  assert.deepEqual(field.cells, direct.cells);
});

test('ephemeral field compiles into an entity at import', () => {
  const Canvas = entity('CanvasWithEphemeral', {
    grant: scope(() => everyone()).can(() => grant(read)),
    fields: {
      drawing: ephemeral({ stroke: 'object', x: 'number', y: 'number' }),
    },
  });
  assert.ok(Canvas);
});

test('ephemeral field generates side-table DDL (no main-table column)', () => {
  const Canvas = entity('CanvasDDL', {
    grant: scope(() => everyone()).can(() => grant(read)),
    fields: {
      cursor: ephemeral({ x: 'number', y: 'number' }),
    },
  });
  const ddl = generateDDL(Canvas);
  // Should have main table + one side-table
  assert.equal(ddl.length, 2);
  // Main table should NOT have a 'cursor' column
  assert.ok(ddl[0].includes('CREATE TABLE IF NOT EXISTS CanvasDDL'));
  assert.ok(!ddl[0].includes('cursor'));
  // Side-table should exist with client_id
  assert.ok(ddl[1].includes('CREATE TABLE IF NOT EXISTS CanvasDDL_cursor'));
  assert.ok(ddl[1].includes('client_id TEXT NOT NULL'));
  assert.ok(ddl[1].includes('CanvasDDL_id TEXT NOT NULL'));
});

test('presence field still generates side-table DDL (unchanged behavior)', () => {
  const Room = entity('RoomPresenceDDL', {
    grant: scope(() => everyone()).can(() => grant(read)),
    fields: {
      cursors: presence({ cursor: true, selection: true }),
    },
  });
  const ddl = generateDDL(Room);
  assert.equal(ddl.length, 2);
  assert.ok(!ddl[0].includes('cursors'));
  assert.ok(ddl[1].includes('CREATE TABLE IF NOT EXISTS RoomPresenceDDL_cursors'));
  assert.ok(ddl[1].includes('client_id TEXT NOT NULL'));
});

test('ephemeral field accepts a real grant scope(()=>everyone()).can(()=>grant(read))', () => {
  const Canvas = entity('CanvasWithGrant', {
    grant: scope(() => everyone()).can(() => grant(read)),
    fields: {
      stroke: ephemeral({ x: 'number', y: 'number' }).can(async () => true),
    },
  });
  assert.ok(Canvas);
  assert.ok(Canvas.fields.stroke.access);
});

test('ephemeral handle cannot be compared in scope (fail closed)', () => {
  const Canvas = entity('CanvasScopeGuard', {
    grant: scope(() => everyone()).can(() => grant(read)),
    fields: {
      cursor: ephemeral({ x: 'number' }),
    },
  });
  assert.throws(
    () => Canvas.cursor.is('x'),
    /ephemeral field and cannot be compared/,
  );
});

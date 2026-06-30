// P6e-1a: the ephemeral event pathway. An `ephemeral(cells)` field was previously
// WRITE-IMMUNE (no handle, no handler, no event, no projection — the descriptor was
// a dead value on the hydrated row). This slice builds the missing foundation:
// `makeEphemeralHandle` (hydrate loop) → `.set(cells)` re-enters dispatch as
// `<Entity>.<field>.set` → handler emits `<Entity>.<field>.set` → projection upserts
// the per-connection side-table row (keyed {Entity}_id, client_id, latest cells).
// P6e-1b's pace/coalescer will RETIRE this raw verbatim delivery into the paced
// pipeline — one mechanism, not a parallel permanent path (AGENTS: the general
// mechanism retires the special-case in the same change).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  entity, text, ephemeral, scope, everyone, grant, read, write, subscribe, generateDDL,
  createServer, executeFrameworkDDL, principal as makePrincipal,
} from '../src/index.mjs';
import { setActiveDb } from '../src/db.mjs';

const Canvas = entity('Canvas', {
  fields: {
    title: text(),
    activeStroke: ephemeral({ points: true, color: true }),
  },
  grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
});

function setup() {
  const db = new DatabaseSync(':memory:');
  setActiveDb(db);
  executeFrameworkDDL(db);
  for (const sql of generateDDL(Canvas)) db.exec(sql);
  db.prepare('INSERT INTO Canvas (id, title) VALUES (?, ?)').run('c1', 'Drawing 1');
  return db;
}

async function makeServer(db) {
  return createServer({
    db,
    handlers: Canvas.crudHandlers,
    projections: [Canvas.projection],
    authorize: async () => true,
    postHandlerAuthorize: async () => true,
  });
}

test('ephemeral() still produces its descriptor (sanity, unchanged)', () => {
  const f = ephemeral({ points: true });
  assert.equal(f.kind, 'ephemeral');
  assert.equal(f.type, 'ephemeral');
  assert.deepEqual(f.cells, { points: true });
  assert.ok(Object.isFrozen(f));
});

test('an ephemeral field compiles + hydrate gives a .set handle (not the dead descriptor)', async () => {
  const db = setup();
  const server = await makeServer(db);
  const row = Canvas.hydrate({ id: 'c1' }, makePrincipal({ type: 'user', id: 'alice' }), server.dispatch);
  assert.equal(typeof row.activeStroke.set, 'function', 'hydrate attached a .set handle');
  assert.equal(typeof row.activeStroke.get, 'function');
});

test('.set(cells) under a write-granted principal is admitted + projects the per-connection row', async () => {
  const db = setup();
  const server = await makeServer(db);
  const row = Canvas.hydrate({ id: 'c1' }, makePrincipal({ type: 'user', id: 'alice' }), server.dispatch);
  await row.activeStroke.set({ points: [{ x: 1, y: 2 }], color: 'red' });

  const stored = db
    .prepare('SELECT cells FROM Canvas_activeStroke WHERE Canvas_id = :owner AND client_id = :client')
    .get({ owner: 'c1', client: 'alice' });
  assert.ok(stored, 'the projection wrote a per-connection row');
  assert.deepEqual(JSON.parse(stored.cells), { points: [{ x: 1, y: 2 }], color: 'red' });

  // .get reads back the latest snapshot for the calling client.
  assert.deepEqual(row.activeStroke.get(), { points: [{ x: 1, y: 2 }], color: 'red' });
});

test('.set then .set again replaces (latest snapshot wins — one row, latest cells)', async () => {
  const db = setup();
  const server = await makeServer(db);
  const row = Canvas.hydrate({ id: 'c1' }, makePrincipal({ type: 'user', id: 'alice' }), server.dispatch);
  await row.activeStroke.set({ points: [{ x: 1 }], color: 'red' });
  await row.activeStroke.set({ points: [{ x: 1 }, { x: 2 }], color: 'blue' });

  const rows = db
    .prepare('SELECT cells FROM Canvas_activeStroke WHERE Canvas_id = :owner AND client_id = :client')
    .all({ owner: 'c1', client: 'alice' });
  assert.equal(rows.length, 1, 'INSERT OR REPLACE kept a single row (latest wins)');
  assert.deepEqual(JSON.parse(rows[0].cells), { points: [{ x: 1 }, { x: 2 }], color: 'blue' });
});

test('two principals write to distinct per-connection rows (client_id isolation)', async () => {
  const db = setup();
  const server = await makeServer(db);
  const aliceRow = Canvas.hydrate({ id: 'c1' }, makePrincipal({ type: 'user', id: 'alice' }), server.dispatch);
  const bobRow = Canvas.hydrate({ id: 'c1' }, makePrincipal({ type: 'user', id: 'bob' }), server.dispatch);
  await aliceRow.activeStroke.set({ color: 'red' });
  await bobRow.activeStroke.set({ color: 'blue' });

  const all = db
    .prepare('SELECT client_id, cells FROM Canvas_activeStroke WHERE Canvas_id = :owner ORDER BY client_id')
    .all({ owner: 'c1' });
  assert.equal(all.length, 2, 'two distinct per-connection rows');
  assert.equal(all[0].client_id, 'alice');
  assert.equal(all[1].client_id, 'bob');
  assert.deepEqual(JSON.parse(all[0].cells), { color: 'red' });
  assert.deepEqual(JSON.parse(all[1].cells), { color: 'blue' });
});

test('the committed event appends to _Log (the verbatim fan-out pathway fires)', async () => {
  const db = setup();
  const server = await makeServer(db);
  const row = Canvas.hydrate({ id: 'c1' }, makePrincipal({ type: 'user', id: 'alice' }), server.dispatch);
  await row.activeStroke.set({ color: 'red' });

  const logs = db
    .prepare("SELECT eventType, scope, eventData FROM _Log WHERE scope = 'Canvas:c1'")
    .all();
  const setEvents = logs.filter((l) => l.eventType === 'Canvas.activeStroke.set');
  assert.equal(setEvents.length, 1, 'the .set event was appended to _Log');
  assert.deepEqual(JSON.parse(setEvents[0].eventData), { owner: 'c1', client: 'alice', cells: { color: 'red' } });
});

test('a handle hydrated without dispatch throws on .set (fail-closed, no direct-SQL fallback)', async () => {
  const db = setup();
  // dispatch = null (the trusted query API path)
  const row = Canvas.hydrate({ id: 'c1' }, makePrincipal({ type: 'user', id: 'alice' }), null);
  await assert.rejects(
    () => row.activeStroke.set({ color: 'red' }),
    /cannot mutate Canvas\.activeStroke without a dispatch ref/,
  );
  // nothing was written
  const stored = db
    .prepare('SELECT cells FROM Canvas_activeStroke WHERE Canvas_id = :owner AND client_id = :client')
    .get({ owner: 'c1', client: 'alice' });
  assert.equal(stored, undefined, 'no side-table write on the thrown path');
});

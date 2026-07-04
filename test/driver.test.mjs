// driver.mjs — the db driver contract (seam-review §2.1, priority #7).
//
// These tests pin the contract shape AND prove a hand-rolled fake driver
// (wrapping a real :memory: DatabaseSync with pass-through prepare/exec) still
// serves entity CRUD end-to-end when handed to workbench({db}). wrapDriver
// attaches the SQLite-default txn/upsert helpers to the fake; the PRAGMA
// bootstrap runs through the pass-through exec (harmless on :memory:); and the
// pipeline + migrations + upsert call sites route through the dispatchers, so a
// custom driver object honors the contract without the framework ever issuing
// a raw BEGIN/COMMIT/ROLLBACK or hand-rolled upsert SQL of its own.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { txn, begin, commit, rollback, upsert, wrapDriver } from '../src/driver.mjs';
import { text, ref, scope, grant, read, write, subscribe, everyone, principal } from '../src/index.mjs';
import workbench, { entity } from '../src/internal.mjs';

// A fresh in-memory db with the framework + driver helpers attached (the same
// treatment app.db gets from workbench). Used by the unit tests below.
function freshDb() {
  const db = new DatabaseSync(':memory:');
  return wrapDriver(db);
}

test('txn commits the callback work and leaves it persisted', async () => {
  const db = freshDb();
  db.exec('CREATE TABLE T (id INTEGER PRIMARY KEY, v TEXT)');
  await txn(db, async () => {
    db.prepare('INSERT INTO T (id, v) VALUES (?, ?)').run(1, 'a');
  });
  assert.equal(db.prepare('SELECT v FROM T WHERE id = ?').get(1).v, 'a');
});

test('txn rolls back when the callback throws (no row persists)', async () => {
  const db = freshDb();
  db.exec('CREATE TABLE T (id INTEGER PRIMARY KEY, v TEXT)');
  await assert.rejects(
    txn(db, async () => {
      db.prepare('INSERT INTO T (id, v) VALUES (?, ?)').run(1, 'a');
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.equal(db.prepare('SELECT v FROM T WHERE id = ?').get(1), undefined);
});

test('begin/commit/rollback are synchronous primitives that bracket a txn manually', () => {
  const db = freshDb();
  db.exec('CREATE TABLE T (id INTEGER PRIMARY KEY, v TEXT)');
  // commit path
  begin(db);
  db.prepare('INSERT INTO T (id, v) VALUES (?, ?)').run(1, 'a');
  commit(db);
  assert.equal(db.prepare('SELECT v FROM T WHERE id = ?').get(1).v, 'a');
  // rollback path
  begin(db);
  db.prepare('INSERT INTO T (id, v) VALUES (?, ?)').run(2, 'b');
  rollback(db);
  assert.equal(db.prepare('SELECT v FROM T WHERE id = ?').get(2), undefined);
});

test('upsert inserts on first call and updates in place on conflict', () => {
  const db = freshDb();
  db.exec('CREATE TABLE U (k TEXT, scope TEXT, lastSeq INTEGER, PRIMARY KEY (k, scope))');
  upsert(db, { table: 'U', keyColumns: ['k', 'scope'], columns: ['lastSeq'], values: { k: 'c', scope: 's', lastSeq: 1 } });
  assert.equal(db.prepare('SELECT lastSeq FROM U WHERE k = ? AND scope = ?').get('c', 's').lastSeq, 1);
  // same key, different value → in-place update, not a second row
  upsert(db, { table: 'U', keyColumns: ['k', 'scope'], columns: ['lastSeq'], values: { k: 'c', scope: 's', lastSeq: 42 } });
  assert.equal(db.prepare('SELECT lastSeq FROM U WHERE k = ? AND scope = ?').get('c', 's').lastSeq, 42);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM U').get().n, 1);
});

test('upsert with a dynamic column name (the side-table ownerCol shape) works', () => {
  // The ephemeral side-table owner column is dynamic (e.g. `Canvas_id`). The
  // upsert helper must accept a keyColumns entry that is an arbitrary string
  // and bind it as a named param key.
  const db = freshDb();
  const ownerCol = 'Canvas_id';
  db.exec(`CREATE TABLE S (${ownerCol} TEXT NOT NULL, client_id TEXT NOT NULL, cells TEXT, PRIMARY KEY (${ownerCol}, client_id))`);
  upsert(db, {
    table: 'S',
    keyColumns: [ownerCol, 'client_id'],
    columns: ['cells'],
    values: { [ownerCol]: 'o1', client_id: 'c1', cells: '{}' },
  });
  assert.equal(db.prepare(`SELECT cells FROM S WHERE ${ownerCol} = ? AND client_id = ?`).get('o1', 'c1').cells, '{}');
});

test('a conforming custom driver (already providing txn+upsert) is passed through untouched', () => {
  let upsertCalls = 0;
  const driver = {
    prepare: (sql) => ({ run() {}, get() { return undefined; }, all() { return []; } }),
    exec() {},
    txn: async (fn) => fn(),
    begin() {},
    commit() {},
    rollback() {},
    upsert() { upsertCalls++; },
  };
  const out = wrapDriver(driver);
  assert.equal(out, driver, 'the same object is returned (no wrapping/proxy)');
  out.upsert({});
  assert.equal(upsertCalls, 1, 'the driver owns its upsert — not the SQLite fallback');
});

// A hand-rolled fake driver: wraps a real :memory: DatabaseSync with pass-through
// prepare/exec but provides NONE of the contract helpers itself. wrapDriver must
// attach the SQLite defaults so the pipeline/migrations/upsert call sites work,
// and the app must still serve entity CRUD over HTTP.
function fakeDriver() {
  const real = new DatabaseSync(':memory:');
  return {
    prepare: (...a) => real.prepare(...a),
    exec: (...a) => real.exec(...a),
  };
}

// An owner-scoped Note for the end-to-end CRUD test.
function ownedNote() {
  return entity('Note', {
    body: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: () => [
      scope(() => everyone()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read),
      ),
    ],
  });
}

test('a fake driver wrapping a real :memory: db serves entity CRUD end-to-end', async (t) => {
  const fd = fakeDriver();
  const alice = principal({ type: 'user', id: 'alice' });
  const app = workbench({ db: fd });
  app.mount('/notes', ownedNote());
  app.listen(0, { principalOf: () => alice });
  await app.ready;
  t.after(() => app.httpServer.close());

  const { port } = app.httpServer.address();
  const origin = `http://127.0.0.1:${port}`;

  // create
  const created = await fetch(`${origin}/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'hello' }),
  });
  assert.equal(created.status, 201);
  const row = await created.json();
  assert.equal(row.body, 'hello');
  assert.equal(row.owner, 'alice');

  // list (public read scope) sees the row
  const listed = await fetch(`${origin}/notes`);
  assert.equal(listed.status, 200);
  const rows = await listed.json();
  assert.ok(rows.some((r) => r.body === 'hello'));

  // read it back
  const got = await fetch(`${origin}/notes/${encodeURIComponent(row.id)}`);
  assert.equal(got.status, 200);
  assert.equal((await got.json()).body, 'hello');
});

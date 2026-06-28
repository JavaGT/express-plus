// Phase 2, slice 2 — DB-backed CRUD dispatch over the real HTTP transport.
//
// Slice 1 opened a socket, matched a route, ran the route GATE, and returned a
// stub. This slice replaces the stub with real per-verb dispatch against a
// node:sqlite DatabaseSync handle the app owns (expressPlus({ db })). Both
// default-on auth layers now run end to end:
//   - the route GATE admits the request (slice 1);
//   - the row GRANT's SQL scope filters which rows are VISIBLE (list/read), and
//     its .can capability decides write/remove (the row-grant runtime, slice 2).
//
// The DB handle is an app-level resource read by the transport (DECISIONLOG: the
// SQLite handle is supplied at expressPlus({ db }), shared by every transport).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import expressPlus, {
  entity, text, ref, scope, grant, deny, read, write, subscribe, everyone,
} from '../src/index.mjs';
import { principal } from '../src/principal.mjs';

// An owner-scoped Note: only the owner may SEE a row (SQL scope is.owner()), and
// the owner may read+write+subscribe.
function ownedNote() {
  return entity('Note', {
    fields: {
      body: text(),
      owner: ref('User', { role: 'owner', readonly: true }),
    },
    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read),
      ),
    ],
  });
}

// A public-read Post: everyone may SEE every row (SQL scope everyone()), but only
// the owner may write/remove (the .can capability axis, distinct from visibility).
function publicPost() {
  return entity('Post', {
    fields: {
      title: text(),
      owner: ref('User', { role: 'owner', readonly: true }),
    },
    grant: () => [
      scope(() => everyone()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read),
      ),
    ],
  });
}

// Seed a DB with the given CREATE + INSERTs and return the handle.
function seed(ddl, rows = []) {
  const db = new DatabaseSync(':memory:');
  db.exec(ddl);
  for (const { sql, params } of rows) db.prepare(sql).run(...params);
  return db;
}

// Mount an app over a DB, drive it with a fixed test principal (header-free —
// the principal is supplied directly until session hydration lands), open an
// ephemeral socket, and return { origin }. The socket + DB are torn down via the
// test's `after` hook so an assertion failure never leaks an open handle (which
// would hang node:test).
async function serve(t, db, Entity, base, who) {
  const app = expressPlus({ db });
  app.mount(base, Entity);
  app.listen(0, { principalOf: () => who });
  await new Promise((resolve) => app.httpServer.once('listening', resolve));
  t.after(() => {
    app.httpServer.close();
    db.close();
  });
  const { port } = app.httpServer.address();
  return { origin: `http://127.0.0.1:${port}` };
}

const alice = principal({ type: 'user', id: 'alice' });
const bob = principal({ type: 'user', id: 'bob' });

test('list returns only the rows the principal may SEE (SQL scope)', async (t) => {
  const db = seed(
    'CREATE TABLE Note (id INTEGER PRIMARY KEY, body TEXT, owner TEXT)',
    [
      { sql: 'INSERT INTO Note (id, body, owner) VALUES (?, ?, ?)', params: [1, 'a', 'alice'] },
      { sql: 'INSERT INTO Note (id, body, owner) VALUES (?, ?, ?)', params: [2, 'b', 'bob'] },
    ],
  );
  const a = await serve(t, db, ownedNote(), '/notes', alice);
  const res = await fetch(`${a.origin}/notes`);
  assert.equal(res.status, 200);
  const rows = await res.json();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].owner, 'alice');
});

test('read of an unowned (invisible) row is 404 under owner scope', async (t) => {
  const db = seed(
    'CREATE TABLE Note (id INTEGER PRIMARY KEY, body TEXT, owner TEXT)',
    [{ sql: 'INSERT INTO Note (id, body, owner) VALUES (?, ?, ?)', params: [1, 'a', 'alice'] }],
  );
  const b = await serve(t, db, ownedNote(), '/notes', bob);
  const res = await fetch(`${b.origin}/notes/1`);
  assert.equal(res.status, 404);
});

test('create inserts a row owned by the principal and 201s', async (t) => {
  const db = seed('CREATE TABLE Note (id INTEGER PRIMARY KEY, body TEXT, owner TEXT)');
  const a = await serve(t, db, ownedNote(), '/notes', alice);
  const res = await fetch(`${a.origin}/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'hello' }),
  });
  assert.equal(res.status, 201);
  const created = await res.json();
  assert.equal(created.body, 'hello');
  assert.equal(created.owner, 'alice');
  const stored = db.prepare('SELECT owner FROM Note WHERE id = ?').get(created.id);
  assert.equal(stored.owner, 'alice');
});

test('create rejects a readonly field set by the client (400)', async (t) => {
  const db = seed('CREATE TABLE Note (id INTEGER PRIMARY KEY, body TEXT, owner TEXT)');
  const a = await serve(t, db, ownedNote(), '/notes', alice);
  const res = await fetch(`${a.origin}/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'x', owner: 'bob' }),
  });
  assert.equal(res.status, 400);
});

test('public-read row is VISIBLE to a non-owner but not WRITABLE (capability axis)', async (t) => {
  const db = seed(
    'CREATE TABLE Post (id INTEGER PRIMARY KEY, title TEXT, owner TEXT)',
    [{ sql: 'INSERT INTO Post (id, title, owner) VALUES (?, ?, ?)', params: [1, 't', 'alice'] }],
  );
  const b = await serve(t, db, publicPost(), '/posts', bob);

  // bob SEES the public row (read scope = everyone)
  const read1 = await fetch(`${b.origin}/posts/1`);
  assert.equal(read1.status, 200);

  // but bob may NOT update it (the .can capability denies write to non-owner)
  const upd = await fetch(`${b.origin}/posts/1`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'hijack' }),
  });
  assert.equal(upd.status, 403);

  // and may not remove it
  const del = await fetch(`${b.origin}/posts/1`, { method: 'DELETE' });
  assert.equal(del.status, 403);
});

test('owner may update and remove a public-read row', async (t) => {
  const db = seed(
    'CREATE TABLE Post (id INTEGER PRIMARY KEY, title TEXT, owner TEXT)',
    [{ sql: 'INSERT INTO Post (id, title, owner) VALUES (?, ?, ?)', params: [1, 't', 'alice'] }],
  );
  const a = await serve(t, db, publicPost(), '/posts', alice);
  const upd = await fetch(`${a.origin}/posts/1`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'edited' }),
  });
  assert.equal(upd.status, 200);
  const after = db.prepare('SELECT title FROM Post WHERE id = ?').get(1);
  assert.equal(after.title, 'edited');

  const del = await fetch(`${a.origin}/posts/1`, { method: 'DELETE' });
  assert.equal(del.status, 204);
  const gone = db.prepare('SELECT * FROM Post WHERE id = ?').get(1);
  assert.equal(gone, undefined);
});

test('serving an entity CRUD route without a db fails closed', async (t) => {
  const app = expressPlus();
  app.mount('/notes', ownedNote());
  app.listen(0, { principalOf: () => alice });
  await new Promise((resolve) => app.httpServer.once('listening', resolve));
  t.after(() => app.httpServer.close());
  const { port } = app.httpServer.address();
  const res = await fetch(`http://127.0.0.1:${port}/notes`);
  assert.equal(res.status, 500);
});

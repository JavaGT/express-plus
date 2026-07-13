// findAll(predicate) — the chainable, awaitable query builder.
//
// The exemplar (doc.mjs feed) composes `Doc.findAll(Doc.owner.is(me))
// .sort(Doc.updatedAt, 'desc').limit(10)` inside a Promise.all. The builder
// lowers the predicate to a WHERE, composes ORDER BY + LIMIT, and executes one
// SELECT on await. The no-arg `findAll()` stays synchronous (a plain array +
// .select) — the two call shapes are distinct.

import { text, ref, number, date, grant, read } from '../src/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import workbench, { entity, generateDDL } from '../src/internal.mjs';

const Note = entity('Note', {
    body: text(),
  stars: number(),
  updatedAt: date(),
  owner: ref('User', { role: 'owner', readonly: true }),

  grant: () => grant(read),
});

function setup() {
  const db = new DatabaseSync(':memory:');
  for (const sql of generateDDL(Note)) db.exec(sql);
  // Three notes owned by u1 with different updatedAt, one by u2.
  db.prepare("INSERT INTO Note (id, body, stars, updatedAt, owner) VALUES (1, 'a', 1, 100, 'u1')").run();
  db.prepare("INSERT INTO Note (id, body, stars, updatedAt, owner) VALUES (2, 'b', 2, 300, 'u1')").run();
  db.prepare("INSERT INTO Note (id, body, stars, updatedAt, owner) VALUES (3, 'c', 3, 200, 'u1')").run();
  db.prepare("INSERT INTO Note (id, body, stars, updatedAt, owner) VALUES (4, 'd', 9, 999, 'u2')").run();
  return db;
}

function bindNote(db) {
  const app = workbench({ db, entities: [Note] });
  return app.entity(Note);
}

test('findAll(predicate) returns matching rows (awaited)', async () => {
  const db = setup();
  const Note_b = bindNote(db);
  const rows = await Note_b.findAll(Note_b.owner.is('u1'));
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.body).sort(), ['a', 'b', 'c']);
});

test('.sort(field, dir) orders the rows', async () => {
  const db = setup();
  const Note_b = bindNote(db);
  const asc = await Note_b.findAll(Note_b.owner.is('u1')).sort(Note_b.updatedAt, 'asc');
  assert.deepEqual(asc.map((r) => r.body), ['a', 'c', 'b']); // 100, 200, 300

  const desc = await Note_b.findAll(Note_b.owner.is('u1')).sort(Note_b.updatedAt, 'desc');
  assert.deepEqual(desc.map((r) => r.body), ['b', 'c', 'a']); // 300, 200, 100
});

test('.limit(n) caps the result count', async () => {
  const db = setup();
  const Note_b = bindNote(db);
  const rows = await Note_b.findAll(Note_b.owner.is('u1')).sort(Note_b.updatedAt, 'desc').limit(2);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.body), ['b', 'c']); // top-2 newest
});

test('findAll(predicate) works in Promise.all (the exemplar shape)', async () => {
  const db = setup();
  const Note_b = bindNote(db);
  const [owned, shared] = await Promise.all([
    Note_b.findAll(Note_b.owner.is('u1')).sort(Note_b.updatedAt, 'desc').limit(10),
    Note_b.findAll(Note_b.owner.is('u2')).sort(Note_b.updatedAt, 'desc').limit(10),
  ]);
  assert.equal(owned.length, 3);
  assert.equal(shared.length, 1);
  assert.equal(shared[0].body, 'd');
});

test('no-arg findAll() stays synchronous with .select()', () => {
  const db = setup();
  const Note_b = bindNote(db);
  const rows = Note_b.findAll();
  assert.equal(rows.length, 4);
  const projected = rows.select(Note_b.id, Note_b.body);
  assert.equal(projected.length, 4);
  assert.deepEqual(Object.keys(projected[0]).sort(), ['body', 'id']);
});

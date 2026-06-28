// Slice A2 piece 1 — the runtime query API on a compiled entity. A hand-written
// handler (the imperative-router surface from slice A) needs to read and write
// entities directly: User.findOne(User.username.is(name)), User.create(...),
// User.findAll().select(...), User.getOrFail(id), User.delete(id). This is the
// SERVER's own trusted data-access primitive (like Express + an ORM) — it runs
// UNSCOPED/PRIVILEGED, NOT through a principal's read-scope, because the login
// lookup is inherently pre-principal and the handler already passed its gate.
// It is not a request path, so it is not a second auth path (DECISIONLOG #41).
//
// The db handle is ambient: expressPlus({ db }) binds it via setActiveDb so a
// standalone entity (declared before any app) can run queries with no db arg.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import expressPlus, { entity, text, scope, grant, read, everyone } from '../src/index.mjs';
import { lowerToSql } from '../src/scope-sql.mjs';

// A trivial public-read entity (the query API is unscoped, so the grant's scope
// does not constrain it — see the unscoped test below).
function makeUser() {
  return entity('User', {
    fields: { username: text(), password: text() },
    grant: () => [scope(() => everyone()).can(() => grant(read))],
  });
}

// A real on-disk-shaped in-memory DB seeded with a User table.
function seedDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE User (id INTEGER PRIMARY KEY, username TEXT, password TEXT)');
  db.prepare('INSERT INTO User (username, password) VALUES (?, ?)').run('alice', 'pw-a');
  db.prepare('INSERT INTO User (username, password) VALUES (?, ?)').run('bob', 'pw-b');
  return db;
}

test('Entity.<field> is a typed handle whose .is(value) lowers to a value-eq WHERE', () => {
  const User = makeUser();
  const node = User.username.is('alice');
  const { sql, params } = lowerToSql(node);
  assert.match(sql, /t0\.username = :/);
  // the literal is bound as a param, not a principalId placeholder
  const [key] = Object.keys(params);
  assert.equal(params[key], 'alice');
});

test('Entity.findOne(predicate) returns the matching row, or null when absent', () => {
  const User = makeUser();
  expressPlus({ db: seedDb() });
  const found = User.findOne(User.username.is('alice'));
  assert.equal(found.username, 'alice');
  assert.equal(found.password, 'pw-a');
  assert.equal(User.findOne(User.username.is('nobody')), null);
});

test('Entity.findAll() returns every row', () => {
  const User = makeUser();
  expressPlus({ db: seedDb() });
  const rows = User.findAll();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.username).sort(), ['alice', 'bob']);
});

test('Entity.findAll().select(...handles) projects only the named columns', () => {
  const User = makeUser();
  expressPlus({ db: seedDb() });
  const rows = User.findAll().select(User.id, User.username);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ['id', 'username']);
    assert.equal(row.password, undefined);
  }
});

test('Entity.getOrFail(id) returns the row; a missing id throws a 404-status error', () => {
  const User = makeUser();
  expressPlus({ db: seedDb() });
  const row = User.getOrFail(1);
  assert.equal(row.username, 'alice');
  assert.throws(
    () => User.getOrFail(999),
    (err) => err.status === 404,
  );
});

test('Entity.create(payload) inserts and returns the new row with its id', () => {
  const User = makeUser();
  expressPlus({ db: seedDb() });
  const created = User.create({ username: 'carol', password: 'pw-c' });
  assert.ok(created.id);
  assert.equal(created.username, 'carol');
  // it is really persisted
  const found = User.findOne(User.username.is('carol'));
  assert.equal(found.id, created.id);
});

test('Entity.delete(id) removes the row', () => {
  const User = makeUser();
  expressPlus({ db: seedDb() });
  const target = User.findOne(User.username.is('bob'));
  User.delete(target.id);
  assert.equal(User.findOne(User.username.is('bob')), null);
});

test('the query API runs UNSCOPED — it bypasses the read-scope (trusted server code)', () => {
  // An entity whose grant scope hides EVERY row (never-readable) for any request
  // principal. The query API must still return rows, proving it does not thread
  // bindReadScope — it is the privileged server-side primitive, not a request.
  const Hidden = entity('User', {
    fields: { username: text(), password: text() },
    // owner-scoped with no owner field would be empty; use a scope that compiles
    // to a column comparison that no seeded row satisfies if it WERE applied.
    grant: () => [scope(({ fields }) => fields.username.is('___never___')).can(() => grant(read))],
  });
  expressPlus({ db: seedDb() });
  // unscoped: both seeded rows come back despite the restrictive scope
  assert.equal(Hidden.findAll().length, 2);
});

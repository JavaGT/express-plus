// Slice A2 piece 3 — the framework-provided User and Session entities.
//
// session.mjs (the binding exemplar) imports `User` and `Session` FROM the
// framework (not app-declared) and drives the auth boundary through them:
//   - login:  User.findOne(User.username.is(name)); User.create({username, password});
//             user.password.verify(pw); Session.create({ userId: user.id }) -> { token }
//   - link:   Session.create({ kind: 'link', token }) -> { token }
//   - logout: Session.delete(id)
//   - views:  User.findAll().select(User.id, User.username); User.getOrFail(id)
//
// User is an ordinary entity (username: text, password: hash) — the generic
// query API already serves it. Session is the contentious one: its STORED row is
// (token, principalType, principalId) — exactly what sessionPrincipalOf reads —
// but its create() is called in two shapes whose payload keys (userId, kind) are
// NOT stored columns and whose stored columns are all server-minted. So Session
// declares those three cells as readonly framework-owned fields and supplies a
// custom create() that accepts only the two known session intents and mints the
// canonical row. This is trusted framework code minting a session server-side —
// the same trust class as the unscoped query API, not a second auth path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import expressPlus, { User, Session } from '../src/index.mjs';
import { sessionPrincipalOf, SESSION_COOKIE } from '../src/session.mjs';

// Seed the two framework tables. The framework does not generate DDL in Phase 1;
// the app/test harness owns CREATE TABLE. The Session schema is exactly the shape
// sessionPrincipalOf queries.
function seed() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE User (id INTEGER PRIMARY KEY, username TEXT, password TEXT)');
  db.exec(
    'CREATE TABLE Session (id INTEGER PRIMARY KEY, token TEXT, principalType TEXT, principalId TEXT)',
  );
  return db;
}

// --- User: an ordinary entity over the generic query API ---

test('User is a compiled entity with username and a hash password', () => {
  assert.equal(User.name, 'User');
  assert.equal(User.fields.username.kind, 'value');
  assert.equal(User.fields.password.kind, 'hash');
});

test('User.create digests the password; user.password.verify checks it', () => {
  expressPlus({ db: seed() });
  const user = User.create({ username: 'alice', password: 'hunter2' });
  assert.ok(user.id);
  assert.equal(user.username, 'alice');
  // the stored cell is a digest, never the plaintext
  assert.notEqual(user.password, 'hunter2');
  assert.equal(user.password.verify('hunter2'), true);
  assert.equal(user.password.verify('wrong'), false);
});

test('User.findOne(User.username.is(name)) round-trips with a verifiable password', () => {
  expressPlus({ db: seed() });
  User.create({ username: 'bob', password: 'sekret' });
  const found = User.findOne(User.username.is('bob'));
  assert.equal(found.username, 'bob');
  assert.equal(found.password.verify('sekret'), true);
  assert.equal(User.findOne(User.username.is('nobody')), null);
});

test('User.findAll().select(User.id, User.username) projects without the password', () => {
  expressPlus({ db: seed() });
  User.create({ username: 'alice', password: 'a' });
  User.create({ username: 'bob', password: 'b' });
  const rows = User.findAll().select(User.id, User.username);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ['id', 'username']);
  }
});

// --- Session: the framework-minted capability record ---

test('Session declares its stored cells as readonly framework-owned fields', () => {
  assert.equal(Session.name, 'Session');
  assert.equal(Session.fields.token.readonly, true);
  assert.equal(Session.fields.principalType.readonly, true);
  assert.equal(Session.fields.principalId.readonly, true);
});

test('Session.create({ userId }) mints a token and a user principal row', () => {
  expressPlus({ db: seed() });
  const session = Session.create({ userId: 'alice' });
  assert.ok(session.token, 'a session token is minted');
  assert.equal(session.principalType, 'user');
  assert.equal(session.principalId, 'alice');
});

test('two Session.create calls mint distinct tokens', () => {
  expressPlus({ db: seed() });
  const a = Session.create({ userId: 'alice' });
  const b = Session.create({ userId: 'alice' });
  assert.notEqual(a.token, b.token);
});

test('Session.create({ kind: "link", token }) mints a link principal carrying the share token', () => {
  expressPlus({ db: seed() });
  const shareToken = 'share-abc';
  const session = Session.create({ kind: 'link', token: shareToken });
  assert.ok(session.token, 'a fresh session token is minted (distinct from the share token)');
  assert.notEqual(session.token, shareToken);
  assert.equal(session.principalType, 'link');
  // the link principal carries WHICH share granted it — the share token itself
  assert.equal(session.principalId, shareToken);
});

test('Session.create rejects an unknown intent (fail closed)', () => {
  expressPlus({ db: seed() });
  assert.throws(() => Session.create({ bogus: 1 }), /session/i);
});

test('a minted user session resolves through sessionPrincipalOf', () => {
  const db = seed();
  expressPlus({ db });
  const session = Session.create({ userId: 'alice' });
  const principalOf = sessionPrincipalOf(db);
  const req = { headers: { cookie: `${SESSION_COOKIE}=${session.token}` } };
  const who = principalOf(req);
  assert.equal(who.type, 'user');
  assert.equal(who.id, 'alice');
});

test('a minted link session resolves to a link principal through sessionPrincipalOf', () => {
  const db = seed();
  expressPlus({ db });
  const session = Session.create({ kind: 'link', token: 'share-xyz' });
  const principalOf = sessionPrincipalOf(db);
  const req = { headers: { cookie: `${SESSION_COOKIE}=${session.token}` } };
  const who = principalOf(req);
  assert.equal(who.type, 'link');
  assert.equal(who.id, 'share-xyz');
});

test('Session.delete(id) removes the session row', () => {
  expressPlus({ db: seed() });
  const session = Session.create({ userId: 'alice' });
  const row = Session.findOne(Session.token.is(session.token));
  assert.ok(row);
  Session.delete(row.id);
  assert.equal(Session.findOne(Session.token.is(session.token)), null);
});

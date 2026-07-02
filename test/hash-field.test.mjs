// Slice A2 piece 2 — the hash() password field strategy. A password is never
// stored in the clear and is never queryable by plaintext: it digests on write
// (salted, one-way) and a hydrated row exposes `user.password.verify(plaintext)`
// — the exemplar surface (session.mjs). The kind is `hash`, deliberately NOT
// `value`, so a scope predicate cannot compare it (fail closed: a plaintext
// password must never reach the SQL filter).

import { text, hash, scope, grant, read, everyone } from '../src/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import workbench, {
  entity } from '../src/internal.mjs';
import { serializeField } from '../src/field-strategy.mjs';
import { fieldHandle } from '../src/scope-sql.mjs';

function makeUser() {
  return entity('User', {
    fields: { username: text(), password: hash() },
    grant: () => [scope(() => everyone()).can(() => grant(read))],
  });
}

function seedDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY, username TEXT, password TEXT)');
  return db;
}

test('hash() produces a `hash`-kind descriptor (not a value field)', () => {
  const descriptor = hash();
  assert.equal(descriptor.kind, 'hash');
  assert.equal(descriptor.type, 'hash');
});

test('serialize digests the plaintext — the stored cell is neither the plaintext nor reversible', () => {
  const descriptor = hash();
  const stored = serializeField(descriptor, 'hunter2');
  assert.equal(typeof stored, 'string');
  assert.notEqual(stored, 'hunter2');
  assert.ok(!stored.includes('hunter2'));
});

test('the digest is salted — the same plaintext stores differently each time', () => {
  const descriptor = hash();
  const a = serializeField(descriptor, 'hunter2');
  const b = serializeField(descriptor, 'hunter2');
  assert.notEqual(a, b);
});

test('a hydrated row exposes password.verify(plaintext): true for the right one, false for a wrong one', () => {
  const User = makeUser();
  workbench({ db: seedDb() });
  const created = User.create({ username: 'alice', password: 'hunter2' });
  assert.equal(typeof created.password.verify, 'function');
  assert.equal(created.password.verify('hunter2'), true);
  assert.equal(created.password.verify('wrong'), false);
});

test('verify survives a round-trip through findOne (the stored digest hydrates on read)', () => {
  const User = makeUser();
  workbench({ db: seedDb() });
  User.create({ username: 'bob', password: 's3cret' });
  const found = User.findOne(User.username.is('bob'));
  assert.equal(found.password.verify('s3cret'), true);
  assert.equal(found.password.verify('nope'), false);
});

test('a hash field is NOT scope-comparable — building a predicate from it fails closed', () => {
  // fieldHandle refuses a non-value kind: a plaintext password must never reach
  // the SQL filter. Reaching .is on a hash handle throws (a declaration error
  // surfaced at predicate-build time), it does not silently compile.
  const handle = fieldHandle('password', hash());
  assert.throws(() => handle.is('hunter2'), /hash/);
});

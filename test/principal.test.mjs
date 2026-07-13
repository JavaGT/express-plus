// The principal model — a closed union { id, type, attributes } with
// `anonymous` first-class (SPEC §6.2; ADRs #11, #20), plus the request-time
// bridge that binds a principal's id into a compiled read-scope's principalId
// placeholder params.
//
// The union is CLOSED: user | link | system | anonymous. An unknown type is a
// construction-time error (fail-closed — authorization never admits a principal
// of a shape the framework does not understand). Domain identities (Patron,
// Reader, Player) are NOT new types here — they are sub-account entities owned
// by User via a typed FK (ADR #20), resolved through the scope JOIN, not minted
// as a fifth principal kind.
//
// Source of truth: SPEC §6.2, §13 Phase 1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { anonymous, entity, text, ref, scope, grant, deny, read, write, subscribe } from 'workbench';
import { DatabaseSync } from 'node:sqlite';

import { principal } from 'workbench';
import { UnknownPrincipalTypeError } from '../src/principal.mjs';
import { bindReadScope } from '../src/scope-sql.mjs';

const ownerCan = async ({ is }) =>
  (await is.owner()) ? grant(read, write, subscribe) : deny('not the owner');

test('principal() builds a frozen user principal with normalized attributes', () => {
  const p = principal({ type: 'user', id: 'u1' });
  assert.equal(p.type, 'user');
  assert.equal(p.id, 'u1');
  assert.deepEqual(p.attributes, {});
  assert.ok(Object.isFrozen(p));
  assert.ok(Object.isFrozen(p.attributes));
});

test('principal() carries attributes for a link principal', () => {
  const p = principal({ type: 'link', id: null, attributes: { token: 'tok-9' } });
  assert.equal(p.type, 'link');
  assert.equal(p.id, null);
  assert.equal(p.attributes.token, 'tok-9');
});

test('anonymous is the first-class { type: anonymous, id: null } principal', () => {
  assert.equal(anonymous.type, 'anonymous');
  assert.equal(anonymous.id, null);
  assert.ok(Object.isFrozen(anonymous));
});

test('an unknown principal type is a construction-time error (fail-closed)', () => {
  assert.throws(() => principal({ type: 'robot', id: 'r1' }), UnknownPrincipalTypeError);
});

test('an anonymous principal with a non-null id is a construction-time error', () => {
  assert.throws(
    () => principal({ type: 'anonymous', id: 'sneaky' }),
    UnknownPrincipalTypeError,
  );
});

test('bindReadScope fills the principalId placeholder with the principal id', () => {
  const Note = entity('Note', {
        body: text(), owner: ref('User', { role: 'owner' }),

    grant: () => [scope(({ is }) => is.owner()).can(ownerCan)],
  });
  const bound = bindReadScope(Note.readScope, principal({ type: 'user', id: 'user-1' }));
  // sql is unchanged; only the null placeholder is now a concrete id
  assert.equal(bound.sql, Note.readScope.sql);
  const values = Object.values(bound.params);
  assert.ok(values.includes('user-1'));
  assert.ok(!values.includes(null));
  // binding must not mutate the entity's stored template
  assert.ok(Object.values(Note.readScope.params).includes(null));
});

test('an anonymous principal binds the owner placeholder to null (matches no owned rows)', () => {
  const Note = entity('Note', {
        body: text(), owner: ref('User', { role: 'owner' }),

    grant: () => [scope(({ is }) => is.owner()).can(ownerCan)],
  });
  const bound = bindReadScope(Note.readScope, anonymous);
  assert.ok(Object.values(bound.params).every((v) => v === null));
});

test('the bound read-scope executes against node:sqlite and selects exactly the principal rows', () => {
  const Note = entity('Note', {
        body: text(), owner: ref('User', { role: 'owner' }),

    grant: () => [scope(({ is }) => is.owner()).can(ownerCan)],
  });
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, body TEXT, owner TEXT)');
  db.exec("INSERT INTO Note (id, body, owner) VALUES (1,'a','user-1'),(2,'b','user-2'),(3,'c','user-1')");

  const bound = bindReadScope(Note.readScope, principal({ type: 'user', id: 'user-1' }));
  const rows = db.prepare(`SELECT body FROM Note AS t0 WHERE ${bound.sql}`).all(bound.params);
  assert.deepEqual(rows.map((r) => r.body).sort(), ['a', 'c']);

  // the same compiled template, a different principal → that principal's rows
  const bound2 = bindReadScope(Note.readScope, principal({ type: 'user', id: 'user-2' }));
  const rows2 = db.prepare(`SELECT body FROM Note AS t0 WHERE ${bound2.sql}`).all(bound2.params);
  assert.deepEqual(rows2.map((r) => r.body).sort(), ['b']);

  // an anonymous principal (id null) matches no owned rows
  const boundAnon = bindReadScope(Note.readScope, anonymous);
  const rowsAnon = db.prepare(`SELECT body FROM Note AS t0 WHERE ${boundAnon.sql}`).all(boundAnon.params);
  assert.deepEqual(rowsAnon, []);
});

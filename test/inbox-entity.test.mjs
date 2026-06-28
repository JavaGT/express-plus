// Slice A2 — the framework-provided Inbox entity. doc.mjs declares an effect
// `effects: { [collaborators.onAdded]: { mutate: Inbox, with: { recipient:
// delta.member, doc: entity.id, kind: 'invite' } } }` — when a collaborator is
// added to a Doc, a row is projected into the recipient's Inbox. Inbox is the
// framework's concern (a uniform per-user notification store every app reuses),
// imported `from 'express-plus'`, never app-declared.
//
// This piece lands Inbox as a working entity: its declared shape, its
// recipient-scoped grant (a user reads ONLY their own inbox rows — fail-closed,
// default-on), and the generic query API over it. The effects-projection WIRING
// that actually RUNS `mutate: Inbox` is a later pipeline piece; the binding
// surface doc.mjs needs at import time is the `Inbox` symbol existing and being
// a valid, recipient-scoped entity.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import expressPlus, { Inbox, bindReadScope } from '../src/index.mjs';
import { principal } from '../src/principal.mjs';

// A real in-memory DB seeded with the Inbox table + two recipients' rows.
function seedDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE Inbox (id INTEGER PRIMARY KEY, recipient TEXT, doc TEXT, kind TEXT)',
  );
  db.prepare('INSERT INTO Inbox (recipient, doc, kind) VALUES (?, ?, ?)').run('alice', 'doc-1', 'invite');
  db.prepare('INSERT INTO Inbox (recipient, doc, kind) VALUES (?, ?, ?)').run('alice', 'doc-2', 'invite');
  db.prepare('INSERT INTO Inbox (recipient, doc, kind) VALUES (?, ?, ?)').run('bob', 'doc-3', 'invite');
  return db;
}

test('Inbox is a framework-exported entity with recipient / doc / kind fields', () => {
  assert.ok(Inbox, 'Inbox is exported from express-plus');
  assert.equal(Inbox.name, 'Inbox');
  // recipient is a User ref carrying the `recipient` role (the scope key);
  // doc is a Doc ref; kind is a plain text field.
  assert.equal(Inbox.fields.recipient.type, 'ref');
  assert.equal(Inbox.fields.recipient.target, 'User');
  assert.equal(Inbox.fields.recipient.role, 'recipient');
  assert.equal(Inbox.fields.doc.type, 'ref');
  assert.equal(Inbox.fields.doc.target, 'Doc');
  assert.equal(Inbox.fields.kind.type, 'text');
});

test('Inbox grant compiles to a recipient-scoped read filter (own rows only)', () => {
  // The compiled read-scope filters to the principal's own recipient column —
  // a user reads ONLY their own inbox, the recipient-scoped fail-closed default.
  assert.ok(Inbox.readScope && typeof Inbox.readScope.sql === 'string');
  assert.match(Inbox.readScope.sql, /t0\.recipient = :/);
});

test('the bound recipient scope selects only the principal\'s own inbox rows', () => {
  expressPlus({ db: seedDb() });
  const db = seedDb();
  for (const who of ['alice', 'bob']) {
    const bound = bindReadScope(Inbox.readScope, principal({ type: 'user', id: who }));
    const rows = db.prepare(`SELECT * FROM Inbox AS t0 WHERE ${bound.sql}`).all(bound.params);
    assert.ok(rows.length > 0, `${who} has inbox rows`);
    assert.ok(rows.every((r) => r.recipient === who), `${who} sees only their own rows`);
  }
});

test('Inbox.create + findOne round-trips through the generic query API', () => {
  expressPlus({ db: seedDb() });
  const created = Inbox.create({ recipient: 'carol', doc: 'doc-9', kind: 'invite' });
  assert.equal(created.recipient, 'carol');
  assert.equal(created.doc, 'doc-9');
  assert.equal(created.kind, 'invite');
  const found = Inbox.findOne(Inbox.recipient.is('carol'));
  assert.equal(found.doc, 'doc-9');
});

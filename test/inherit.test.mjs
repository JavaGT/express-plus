// Phase 1 — `inherit(Parent, { via })`: child grant inheritance through a typed
// FK, compiled to SQL (SPEC §6.1, §13; ADRs #4, #5; the comment.mjs exemplar).
//
// A child entity (Comment) declares `grant: inherit(Doc, { via: 'doc' })`. The
// child has NO read-scope of its own; its readability is exactly its parent's.
// The compiler lowers this to a correlated EXISTS subquery: a Comment row is
// readable iff the Doc it points at (through the `doc` FK) is readable under
// Doc's own compiled scope — re-lowered under the subquery's alias. The single
// `principalId` placeholder survives so bindReadScope fills it per request.
//
// DESIGN DECISION (this session): `inherit` takes the compiled parent ENTITY
// OBJECT, not a string name — `inherit(Doc, { via })`, never `inherit('Doc')`.
// No registry, no global namespace; the parent must be defined above the child.

import { text, ref, scope, grant, deny, read, write, subscribe, inherit } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  entity } from '../build/internal.mjs';

import { bindReadScope } from '../build/scope-sql.mjs';
import { principal, anonymous } from '../build/principal.mjs';

// A minimal owner grant whose .can half is always present.
const ownerCan = async ({ is }) => (await is.owner()) ? grant(read, write, subscribe) : deny('no');

const norm = (s) => s.replace(/\s+/g, ' ').trim();

// The canonical parent: a Doc readable only by its owner.
function makeDoc() {
  return entity('Doc', {
        title: text(), owner: ref('User', { role: 'owner' }),

    grant: () => [scope(({ is }) => is.owner()).can(ownerCan)],
  });
}

test('inherit(Parent, { via }) compiles the child read-scope to a correlated EXISTS through the FK', () => {
  const Doc = makeDoc();
  const Comment = entity('Comment', {
        doc: ref('Doc', { required: true }), body: text(),

    grant: inherit(Doc, { via: 'doc' }),
  });
  const s = norm(Comment.readScope.sql);
  // a child row is admitted iff a parent Doc exists that (a) the FK points at and
  // (b) satisfies Doc's own scope, re-aliased under the subquery.
  assert.match(s, /EXISTS \(/i);
  assert.match(s, /FROM Doc/i);
  // the join condition: the parent alias's id equals the child's `doc` FK column.
  assert.match(s, /\.id = t0\.doc/);
  // the parent's own scope flows through, still keyed to the principalId param.
  assert.match(s, /owner = :p\d+_principalId/);
});

test('the inherited child scope keeps exactly one principalId placeholder for bindReadScope', () => {
  const Doc = makeDoc();
  const Comment = entity('Comment', {
        doc: ref('Doc', { required: true }), body: text(),

    grant: inherit(Doc, { via: 'doc' }),
  });
  const keys = Object.keys(Comment.readScope.params).filter((k) => k.endsWith('_principalId'));
  assert.equal(keys.length, 1, 'exactly one principalId placeholder survives the join');
  // the template leaves it null until bound
  assert.equal(Comment.readScope.params[keys[0]], null);
});

test('the inherited scope executes against node:sqlite and selects exactly the child rows whose parent the principal owns', () => {
  const Doc = makeDoc();
  const Comment = entity('Comment', {
        doc: ref('Doc', { required: true }), body: text(),

    grant: inherit(Doc, { via: 'doc' }),
  });

  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE Doc (id TEXT PRIMARY KEY, title TEXT, owner TEXT)');
  db.exec('CREATE TABLE Comment (id TEXT PRIMARY KEY, doc INTEGER, body TEXT)');
  db.exec("INSERT INTO Doc (id, title, owner) VALUES (1,'d1','user-1'),(2,'d2','user-2')");
  db.exec("INSERT INTO Comment (id, doc, body) VALUES (1,1,'c-on-d1'),(2,2,'c-on-d2'),(3,1,'c2-on-d1')");

  const bound = bindReadScope(Comment.readScope, principal({ type: 'user', id: 'user-1' }));
  const rows = db
    .prepare(`SELECT body FROM Comment AS t0 WHERE ${bound.sql}`)
    .all(bound.params);
  assert.deepEqual(rows.map((r) => r.body).sort(), ['c-on-d1', 'c2-on-d1']);

  // user-2 owns only d2 → sees only the comment on d2
  const bound2 = bindReadScope(Comment.readScope, principal({ type: 'user', id: 'user-2' }));
  const rows2 = db.prepare(`SELECT body FROM Comment AS t0 WHERE ${bound2.sql}`).all(bound2.params);
  assert.deepEqual(rows2.map((r) => r.body), ['c-on-d2']);

  // anonymous owns nothing → sees no comment (fail-closed, no special case)
  const boundAnon = bindReadScope(Comment.readScope, anonymous);
  const rowsAnon = db.prepare(`SELECT body FROM Comment AS t0 WHERE ${boundAnon.sql}`).all(boundAnon.params);
  assert.deepEqual(rowsAnon, []);
});

test('the parent entity is unchanged by being inherited (its own scope still binds to t0)', () => {
  const Doc = makeDoc();
  entity('Comment', {
        doc: ref('Doc', { required: true }), body: text(),

    grant: inherit(Doc, { via: 'doc' }),
  });
  // Doc's own read-scope is still its own, aliased to its own base table.
  assert.match(norm(Doc.readScope.sql), /t0\.owner = :p\d+_principalId/);
});

// Phase 1 — the scope→SQL compiler (the grant's READ half lowered to SQL).
//
// A `scope(predicate)` declares read intent. The predicate is harvested ONCE at
// entity-load into a small closed-set AST, then lowered to a parameterized SQL
// WHERE fragment. It is never executed as JS per row. A predicate that cannot
// lower is a LOAD-TIME ERROR (SPEC §6.1, §11; ADR #2). never()→FALSE,
// everyone()→TRUE, is.<role>()→typed-FK comparison, inherit→JOIN.
//
// Source of truth: SPEC §6.1 (grant's two halves), §11 (predicate ops), §13
// (queryScope derived from grant). Design adopted from the architect consult.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  entity, text, ref, boolean, date, scope, grant, deny, read, write, subscribe,
  everyone, never, anyOf, NonCompilableError, bindReadScope,
} from '../src/index.mjs';
import { principal, anonymous } from '../src/principal.mjs';

// A minimal owner grant whose .can half is always present (the read half is
// what these tests exercise).
const ownerCan = async ({ is }) => (await is.owner()) ? grant(read, write, subscribe) : deny('no');

// normalize whitespace so assertions are robust to spacing choices
const sql = (entityRecord) => entityRecord.readScope.sql.replace(/\s+/g, ' ').trim();

test('is.owner() on a direct User ref lowers to a typed-FK equality', () => {
  const Note = entity('Note', {
    fields: { body: text(), owner: ref('User', { role: 'owner' }) },
    grant: () => [scope(({ is }) => is.owner()).can(ownerCan)],
  });
  assert.match(sql(Note), /owner = :p\d+_principalId/);
});

test('everyone() lowers to SQL TRUE, never() lowers to SQL FALSE', () => {
  const Public = entity('Public', {
    fields: { body: text(), owner: ref('User', { role: 'owner' }) },
    grant: () => [scope(() => everyone()).can(ownerCan)],
  });
  const Closed = entity('Closed', {
    fields: { body: text(), owner: ref('User', { role: 'owner' }) },
    grant: () => [scope(() => never()).can(ownerCan)],
  });
  assert.equal(sql(Public), '1 = 1');
  assert.equal(sql(Closed), '1 = 0');
});

test('.is(undefined) lowers to FALSE, distinct from .isNull() which is IS NULL', () => {
  const A = entity('A', {
    fields: { archivedAt: date(), owner: ref('User', { role: 'owner' }) },
    grant: () => [scope(({ fields }) => fields.archivedAt.is(undefined)).can(ownerCan)],
  });
  const B = entity('B', {
    fields: { archivedAt: date(), owner: ref('User', { role: 'owner' }) },
    grant: () => [scope(({ fields }) => fields.archivedAt.isNull()).can(ownerCan)],
  });
  assert.equal(sql(A), '1 = 0');
  assert.match(sql(B), /archivedAt IS NULL/);
});

test('field.in([...]) lowers to a parameterized IN with one param per value in order', () => {
  const Post = entity('Post', {
    fields: { status: text(), owner: ref('User', { role: 'owner' }) },
    grant: () => [scope(({ fields }) => fields.status.in(['draft', 'shared'])).can(ownerCan)],
  });
  assert.match(sql(Post), /status IN \(:p\d+_0, :p\d+_1\)/);
});

test('a.and(b) and a.not() compose', () => {
  const Post = entity('Post', {
    fields: { status: text(), owner: ref('User', { role: 'owner' }) },
    grant: () => [
      scope(({ is, fields }) => is.owner().and(fields.status.in(['published']))).can(ownerCan),
    ],
  });
  const s = sql(Post);
  assert.match(s, /owner = :p\d+_principalId/);
  assert.match(s, /AND/);
  assert.match(s, /status IN/);
});

test('anyOf(a,b,c) lowers via De Morgan into NOT(AND(NOT...)) using only and+not', () => {
  const Post = entity('Post', {
    fields: {
      body: text(),
      owner: ref('User', { role: 'owner' }),
      editor: ref('User', { role: 'editor' }),
    },
    grant: () => [scope(({ is }) => anyOf(is.owner(), is.editor())).can(ownerCan)],
  });
  const s = sql(Post);
  // De Morgan: NOT ((NOT owner-eq) AND (NOT editor-eq))
  assert.match(s, /NOT \(/);
  assert.match(s, /AND/);
  assert.match(s, /owner = :/);
  assert.match(s, /editor = :/);
});

test('a scope predicate that returns a non-AST value is a load-time error', () => {
  assert.throws(
    () => entity('Bad', {
      fields: { body: text(), owner: ref('User', { role: 'owner' }) },
      grant: () => [scope(() => true).can(ownerCan)],
    }),
    NonCompilableError,
  );
});

test('an undeclared role in scope is a load-time error', () => {
  assert.throws(
    () => entity('Bad', {
      fields: { body: text(), owner: ref('User', { role: 'owner' }) },
      grant: () => [scope(({ is }) => is.nonexistent()).can(ownerCan)],
    }),
    NonCompilableError,
  );
});

test('a value op on a non-compilable field kind (crdt) is a load-time error', () => {
  assert.throws(
    () => entity('Bad', {
      fields: { body: text.crdt(), owner: ref('User', { role: 'owner' }) },
      grant: () => [scope(({ fields }) => fields.body.is('x')).can(ownerCan)],
    }),
    NonCompilableError,
  );
});

test('the lowered SQL + params execute against node:sqlite and select exactly the principal rows', () => {
  const Note = entity('Note', {
    fields: { body: text(), owner: ref('User', { role: 'owner' }) },
    grant: () => [scope(({ is }) => is.owner()).can(ownerCan)],
  });
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, body TEXT, owner TEXT)');
  db.exec("INSERT INTO Note (id, body, owner) VALUES (1,'a','user-1'),(2,'b','user-2'),(3,'c','user-1')");

  // bind the logical principalId param to a concrete principal
  const paramKey = Object.keys(Note.readScope.params).find((k) => k.endsWith('principalId'));
  const where = Note.readScope.sql;
  // the base table alias the compiler used is part of readScope; the query layer
  // aliases the base table to that alias. For this kernel test the alias is t0.
  // params keys are stored bare (no leading colon); node:sqlite binds the bare
  // key to the matching `:name` token in the SQL.
  const rows = db.prepare(`SELECT body FROM Note AS t0 WHERE ${where}`).all({ [paramKey]: 'user-1' });
  assert.deepEqual(rows.map((r) => r.body).sort(), ['a', 'c']);
});

test('a boolean value literal (published.is(true)) binds to node:sqlite as 1 (not a JS boolean)', () => {
  // node:sqlite REFUSES to bind a JS boolean; a boolean field is stored as the
  // integer 1/0. The scope compiler must bake the literal in its SERIALIZED form
  // (via the value strategy's serialize) so the param is bindable. Anonymous
  // reads only published posts; the author reads all of theirs.
  const Post = entity('Post', {
    fields: {
      title: text(),
      published: boolean({ default: false }),
      author: ref('User', { role: 'author', readonly: true }),
    },
    grant: () => [
      scope(({ is, fields }) => anyOf(fields.published.is(true), is.author()))
        .can(async ({ is }) => (await is.author()) ? grant(read, write, subscribe) : grant(read)),
    ],
  });

  // the baked literal must already be the stored integer, never a JS boolean.
  const litKey = Object.keys(Post.readScope.params).find((k) => k.endsWith('_val'));
  assert.equal(Post.readScope.params[litKey], 1, 'boolean literal baked as integer 1');

  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE Post (id TEXT PRIMARY KEY, title TEXT, published INTEGER, author TEXT)');
  db.exec("INSERT INTO Post (id, title, published, author) VALUES (1,'hi',1,'alice'),(2,'draft',0,'alice'),(3,'bob-pub',1,'bob')");

  const readFor = (prin) => {
    const bound = bindReadScope(Post.readScope, prin);
    return db.prepare(`SELECT title FROM Post AS t0 WHERE ${bound.sql}`).all(bound.params)
      .map((r) => r.title).sort();
  };

  assert.deepEqual(readFor(anonymous), ['bob-pub', 'hi'], 'anonymous reads published only');
  assert.deepEqual(readFor(principal({ type: 'user', id: 'alice' })), ['bob-pub', 'draft', 'hi'], 'alice reads published + her draft');
});

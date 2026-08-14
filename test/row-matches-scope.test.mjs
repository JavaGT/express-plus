// The single-row scope evaluator (the authorization adapter's resource gate).
//
// rowMatchesScope re-verifies a materialized row against a compiled read-scope
// template in pure JS. Three properties are load-bearing and all fail CLOSED:
//   - an unevaluable predicate (membership/join/FTS, a SQL NULL comparison, a
//     caller-supplied row missing a field) must NEVER be flipped to TRUE by
//     `not` or `and` — a scope containing any unevaluable construct denies;
//   - `in` follows SQLite NULL semantics (NULL IN (NULL) is NULL, not satisfied);
//   - a missing row field is NOT SQL NULL, so it cannot satisfy isNull.

import { text, date, map, ref, scope, grant, read, write, subscribe, deny, inherit } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { entity, rowMatchesScope } from '../build/internal.mjs';
import { principal } from '../build/principal.mjs';

const ownerCan = async ({ is }) => (await is.owner()) ? grant(read, write, subscribe) : deny('no');
const alice = principal({ type: 'user', id: 'alice' });

// An entity record keeps the compiled SQL template ({ sql, params }) and the
// durable AST separately (`scopeAst`); rowMatchesScope wants the full template.
const scopeTemplate = (entityRecord) => ({ ...entityRecord.readScope, nearest: null, ast: entityRecord.scopeAst });

// A compiled scope over a membership map, exactly the shape the adapter's
// resource scope compiles to (`is.collaborator()` → existsMembership node).
function roomEntity() {
  return entity('Room', {
    title: text(),
    members: map(ref('User')),

    checks: {
      collaborator: ({ Room, principal: p }) => Room.members.has(p.id),
    },
    grant: () => [
      scope(({ is }) => is.collaborator()).can(ownerCan),
    ],
  });
}

function statusIn(values) {
  return entity('StatusFilter', {
    status: text(),
    grant: () => [scope(({ fields }) => fields.status.in(values)).can(ownerCan)],
  });
}

// --- BLOCKER: an unevaluable predicate must fail closed under not/and ---------

test('not(existsMembership) fails closed — negation cannot flip an unverifiable membership to true', () => {
  const template = scopeTemplate(roomEntity());
  assert.equal(template.ast.node, 'existsMembership');
  const negated = { ...template, ast: template.ast.not() };
  assert.equal(rowMatchesScope(negated, { id: 'r1' }, alice), false, 'not(membership) denies a row the SQL path could not admit');
});

test('not(join) fails closed — an inherited scope under negation still denies', () => {
  const Parent = entity('ParentDoc', {
    body: text(),
    owner: ref('User', { role: 'owner' }),
    grant: () => [scope(({ is }) => is.owner()).can(ownerCan)],
  });
  const Child = entity('ChildNote', {
    parent: ref('ParentDoc', { required: true }),
    body: text(),
    grant: inherit(Parent, { via: 'parent' }),
  });
  const template = scopeTemplate(Child);
  assert.equal(template.ast.node, 'join');
  const row = { id: 'c1', parent: 'p1', body: 'hi' };
  assert.equal(rowMatchesScope(template, row, alice), false, 'join alone fails closed');
  const negated = { ...template, ast: { node: 'not', operand: template.ast } };
  assert.equal(rowMatchesScope(negated, row, alice), false, 'not(join) fails closed');
});

test('and(eq, match) fails closed — a satisfiable eq cannot paper over an unverifiable FTS predicate', () => {
  const Article = entity('Article', {
    status: text(),
    body: text({ indexed: 'fts' }),
    grant: () => [
      scope(({ fields }) => fields.status.is('published').and(fields.body.matches('needle'))).can(ownerCan),
    ],
  });
  const template = scopeTemplate(Article);
  assert.equal(template.ast.node, 'and');
  const row = { id: 'a1', status: 'published', body: 'needle in the haystack' };
  assert.equal(rowMatchesScope(template, row, alice), false, 'and(eq, match) denies');
  const negated = { ...template, ast: template.ast.not() };
  assert.equal(
    rowMatchesScope(negated, row, alice),
    false,
    'not(and(eq, match)) denies — `and` cannot emit a boolean false that `not` flips to true',
  );
});

// --- SQL NULL semantics for `in` ---------------------------------------------

test('in-list NULLs follow SQLite semantics — NULL never satisfies an IN, a real match still admits', () => {
  // `x IN (v...)` is `x = v1 OR ...`: NULL = NULL is NULL, so `status IN (NULL)`
  // is never satisfied; `status IN ('published', NULL)` with a matching value is
  // TRUE (TRUE OR NULL = TRUE).
  const nullOnly = scopeTemplate(statusIn([null]));
  assert.equal(rowMatchesScope(nullOnly, { id: 'x', status: null }, alice), false, 'NULL IN (NULL) denies');
  assert.equal(rowMatchesScope(nullOnly, { id: 'x', status: 'draft' }, alice), false, 'no match + a NULL entry denies');
  assert.equal(rowMatchesScope(nullOnly, { id: 'x' }, alice), false, 'an absent status denies');

  const withNull = scopeTemplate(statusIn(['published', null]));
  assert.equal(rowMatchesScope(withNull, { id: 'x', status: 'published' }, alice), true, 'a real match admits (TRUE OR NULL = TRUE)');
  assert.equal(rowMatchesScope(withNull, { id: 'x', status: 'draft' }, alice), false, 'no match + a NULL entry denies');

  const plain = scopeTemplate(statusIn(['published', 'shared']));
  assert.equal(rowMatchesScope(plain, { id: 'x', status: 'shared' }, alice), true, 'a match admits');
  assert.equal(rowMatchesScope(plain, { id: 'x', status: 'draft' }, alice), false, 'no match, all non-null: denies');
});

// --- a missing field is not SQL NULL ------------------------------------------

test('a missing row field is not SQL NULL — it cannot satisfy isNull', () => {
  const Deleted = entity('Deleted', {
    deletedAt: date(),
    grant: () => [scope(({ fields }) => fields.deletedAt.isNull()).can(ownerCan)],
  });
  const template = scopeTemplate(Deleted);
  assert.equal(rowMatchesScope(template, { id: 'd1' }, alice), false, 'an absent deletedAt does not satisfy isNull');
  assert.equal(rowMatchesScope(template, { id: 'd1', deletedAt: null }, alice), true, 'a present NULL satisfies isNull');
  assert.equal(rowMatchesScope(template, { id: 'd1', deletedAt: '2026-01-01T00:00:00.000Z' }, alice), false, 'a present value does not satisfy isNull');
  const negated = { ...template, ast: template.ast.not() };
  assert.equal(rowMatchesScope(negated, { id: 'd1' }, alice), false, 'an absent field under negation still denies');
});

test('a NULL cell under eq negation fails closed (NOT (col = v) with col NULL is still NULL in SQL)', () => {
  const Owner = entity('OwnerRow', {
    owner: ref('User', { role: 'owner' }),
    grant: () => [scope(({ is }) => is.owner()).can(ownerCan)],
  });
  const template = scopeTemplate(Owner);
  assert.equal(rowMatchesScope(template, { id: 'o1', owner: 'alice' }, alice), true, 'eq admits its owner (positive control)');
  const negated = { ...template, ast: template.ast.not() };
  assert.equal(rowMatchesScope(negated, { id: 'o1', owner: null }, alice), false, 'not(eq) with a NULL cell denies');
  assert.equal(rowMatchesScope(negated, { id: 'o1', owner: 'bob' }, alice), true, 'not(eq) with a non-matching value admits');
});

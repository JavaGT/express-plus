// Phase 1 — the entity() constructor and its load-time validation.
//
// entity(name, { fields, grant, checks?, routes? }) compiles a declared entity
// into a frozen, validated entity record. The constructor is where fail-closed
// load-time guards live (SPEC §6.1, §13; ADRs #7, #16):
//
//  - An entity with NO grant is a LOAD-TIME ERROR (ADR #7) — there is no
//    zero-to-one default grant. The smoothest path must still be explicit.
//  - A ref field with `role: 'x'` auto-derives a check `is.x()` — the ONE thing
//    the FK derives (SPEC §6.2). The derived check is the single source of truth
//    for "who is the x of this row".
//  - Every `.can` / `scope` body is statically guarded (assertGuarded, Phase 0):
//    an `is.*(` not preceded by `await` is rejected at load (ADR #16).
//
// Source of truth: SPEC §5–§6, §13 Phase 1. Grounded against note.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  entity, text, ref, scope, grant, deny, read, write, subscribe,
} from '../src/index.mjs';

const ownerGrant = () => [
  scope(({ is }) => is.owner()).can(
    async ({ is }) => (await is.owner()) ? grant(read, write, subscribe) : deny('not the owner'),
  ),
];

test('entity() returns a frozen record carrying its name and fields', () => {
  const Note = entity('Note', {
    fields: { body: text.crdt(), owner: ref('User', { role: 'owner', readonly: true }) },
    grant: ownerGrant,
  });
  assert.equal(Note.name, 'Note');
  assert.ok(Note.fields.body);
  assert.ok(Note.fields.owner);
  assert.ok(Object.isFrozen(Note));
});

test('an entity with no grant is a load-time error (ADR #7, fail-closed)', () => {
  assert.throws(
    () => entity('Ungranted', { fields: { body: text() } }),
    /grant/i,
    'an entity declared without a grant must throw at load time',
  );
});

test('a ref field with role derives a check is.<role>() (the one thing the FK derives)', () => {
  const Note = entity('Note', {
    fields: { body: text.crdt(), owner: ref('User', { role: 'owner', readonly: true }) },
    grant: ownerGrant,
  });
  assert.equal(typeof Note.checks.owner, 'function');
});

test('the derived role check tests principal identity against the ref column', () => {
  const Note = entity('Note', {
    fields: { body: text.crdt(), owner: ref('User', { role: 'owner', readonly: true }) },
    grant: ownerGrant,
  });
  const row = { owner: 'user-1' };
  assert.equal(Note.checks.owner({ entity: row, principal: { id: 'user-1' } }), true);
  assert.equal(Note.checks.owner({ entity: row, principal: { id: 'user-2' } }), false);
});

test('a developer-declared check coexists with derived role checks', () => {
  const Comment = entity('Comment', {
    fields: { body: text(), author: ref('User', { role: 'author' }) },
    // the grant's scope must reference a role this entity declares (author),
    // since scope lowers to SQL at load — an undeclared role is a load error.
    grant: () => [
      scope(({ is }) => is.author()).can(
        async ({ is }) => (await is.author()) ? grant(read, write, subscribe) : deny('not the author'),
      ),
    ],
    checks: { author: ({ entity: row, principal }) => row.author === principal.id },
  });
  // an explicit check wins over the derived one when both name 'author'
  assert.equal(typeof Comment.checks.author, 'function');
});

test('a grant with two scope clauses is a load-time error (one read-scope per grant, fail-closed)', () => {
  // The row-filtering read-scope is derived from exactly ONE scope predicate.
  // A second scope().can() clause would have its predicate silently dropped from
  // the SQL filter — a latent fail-open if the developer meant it to RESTRICT
  // reads. There is no union/intersection-of-scopes semantics in Phase 1; a
  // second scope clause is rejected at load, never silently ignored. If additive
  // read scopes are ever needed they arrive as an explicit named construct, not
  // inferred from "more than one clause in the array".
  assert.throws(
    () => entity('TwoScopes', {
      fields: { body: text(), owner: ref('User', { role: 'owner' }), editor: ref('User', { role: 'editor' }) },
      grant: () => [
        scope(({ is }) => is.owner()).can(
          async ({ is }) => (await is.owner()) ? grant(read, write, subscribe) : deny('no'),
        ),
        scope(({ is }) => is.editor()).can(
          async ({ is }) => (await is.editor()) ? grant(read, write) : deny('no'),
        ),
      ],
    }),
    /one scope|single read-scope|one read-scope/i,
    'a grant declaring two scope clauses must throw at load time',
  );
});

test('a .can body with an unawaited is.* call is rejected at load (ADR #16 static guard)', () => {
  assert.throws(
    () => entity('Leaky', {
      fields: { body: text(), owner: ref('User', { role: 'owner' }) },
      // forgotten await: is.owner() is a pending promise, always truthy
      grant: () => [scope(({ is }) => is.owner()).can(({ is }) => is.owner() ? grant(write) : deny('no'))],
    }),
    /await/i,
    'an unawaited is.* in a .can body must be a load-time error',
  );
});

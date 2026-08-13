// Phase 1 — the entity() constructor and its load-time validation.
//
// entity(name, { <fields>, grant, checks?, routes?, gate?, ... }) compiles a
// declared entity into a frozen, validated entity record. Fields are declared
// as the non-reserved keys of the declaration (no `fields:` wrapper); the
// reserved slots are grant/checks/routes/create/effects/admitsEffects/schedule/
// gate/on. The constructor is where fail-closed load-time guards live (SPEC §6.1, §13; ADRs #7, #16):
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

import { text, ref, scope, grant, deny, read, write, subscribe, admin, owner } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  entity } from '../build/internal.mjs';
import { rowCapabilities } from '../build/row-grant.mjs';

const ownerGrant = () => [
  scope(({ is }) => is.owner()).can(
    async ({ is }) => (await is.owner()) ? grant(read, write, subscribe) : deny('not the owner'),
  ),
];

test('entity() returns a validated record carrying its name and fields', () => {
  const Note = entity('Note', {
        body: text.crdt(), owner: ref('User', { role: 'owner', readonly: true }),

    grant: ownerGrant,
  });
  assert.equal(Note.name, 'Note');
  assert.ok(Note.fields.body);
  assert.ok(Note.fields.owner);
  assert.ok(Object.isFrozen(Note.fields), 'fields are frozen');
});

test('immutable is create-only and cannot be combined with server-owned field modes', () => {
  for (const conflictingMode of [{ readonly: true }, { touch: true }]) {
    assert.throws(
      () => entity('ContradictoryField', {
        projectId: text({ immutable: true, ...conflictingMode }),
        grant: () => grant(read, write, subscribe),
      }),
      /immutable.*(?:readonly|touch)|(?:readonly|touch).*immutable/i,
    );
  }
});

test('an entity with no grant at compile time emits a warning (safe — membership() can set it later)', () => {
  // ADR #7 relaxed for membership support: entities without an explicit grant
  // compile with a warning and are safe (no grant = no capabilities granted).
  // The membership() call (or explicit grant declaration) sets the grant after.
  const Ungranted = entity('Ungranted', { body: text() });
  assert.ok(Ungranted, 'entity compiles without a grant');
});

test('a ref field with role derives a check is.<role>() (the one thing the FK derives)', () => {
  const Note = entity('Note', {
        body: text.crdt(), owner: ref('User', { role: 'owner', readonly: true }),

    grant: ownerGrant,
  });
  assert.equal(typeof Note.checks.owner, 'function');
});

test('owner() expands to the owner ref-role field descriptor', () => {
  const descriptor = owner();
  assert.equal(descriptor.kind, 'value');
  assert.equal(descriptor.type, 'ref');
  assert.equal(descriptor.target, 'User');
  assert.equal(descriptor.role, 'owner');
  assert.equal(descriptor.readonly, true);
  assert.ok(Object.isFrozen(descriptor));
});

test('owner.only() compiles like the explicit owner-only grant', async () => {
  const Manual = entity('ManualOwnerOnly', {
        body: text(), owner: ref('User', { role: 'owner', readonly: true }),

    grant: () => [
      scope(({ is }) => is.owner()).can(
        async ({ is }) => (await is.owner()) ? grant(read, write, subscribe, admin) : deny('not the owner'),
      ),
    ],
  });
  const Sugared = entity('SugaredOwnerOnly', { body: text(), owner: owner(), grant: owner.only, });

  assert.equal(Sugared.readScope.sql, Manual.readScope.sql.replaceAll('ManualOwnerOnly', 'SugaredOwnerOnly'));
  assert.deepEqual(Sugared.readScope.params, Manual.readScope.params);
  assert.deepEqual(
    { node: Sugared.scopeAst.node, field: Sugared.scopeAst.field, param: Sugared.scopeAst.param },
    { node: Manual.scopeAst.node, field: Manual.scopeAst.field, param: Manual.scopeAst.param },
  );
  assert.equal(typeof Sugared.checks.owner, 'function');

  const ownerDecision = await rowCapabilities(Sugared, { id: 'd1', owner: 'u1' }, { id: 'u1' });
  assert.equal(ownerDecision.granted, true);
  assert.deepEqual(ownerDecision.capabilities, [read, write, subscribe, admin]);

  const otherDecision = await rowCapabilities(Sugared, { id: 'd1', owner: 'u1' }, { id: 'u2' });
  assert.equal(otherDecision.granted, false);
  assert.deepEqual(otherDecision.capabilities, []);
});

test('the derived role check tests principal identity against the ref column', () => {
  const Note = entity('Note', {
        body: text.crdt(), owner: ref('User', { role: 'owner', readonly: true }),

    grant: ownerGrant,
  });
  const row = { owner: 'user-1' };
  assert.equal(Note.checks.owner({ entity: row, principal: { id: 'user-1' } }), true);
  assert.equal(Note.checks.owner({ entity: row, principal: { id: 'user-2' } }), false);
});

test('redeclaring a ref-role-derived check name in checks is a load-time error (one source of truth, fail-closed)', () => {
  // A ref field carrying `role: 'author'` IS the single source of truth for
  // is.author(): the framework derives BOTH the SQL filter face (FK equality)
  // and the runtime boolean face from the one field, so they cannot disagree.
  // A `checks` entry that redeclares that name would fuse two independent
  // definitions into one check — the split-brain (SQL says one thing, runtime
  // another) the unified registry exists to abolish. Redeclaration is rejected
  // at load; a developer who wants different behavior uses a different name.
  assert.throws(
    () => entity('Comment', {
            body: text(), author: ref('User', { role: 'author' }),

      grant: () => [
        scope(({ is }) => is.author()).can(
          async ({ is }) => (await is.author()) ? grant(read, write, subscribe) : deny('not the author'),
        ),
      ],
      checks: { author: ({ entity: row, principal }) => row.author === principal.id },
    }),
    /author.*cannot be redeclared|already derived/i,
    'a checks entry colliding with a ref-role name must throw at load time',
  );
});

test('a ref-role check resolves through ONE registry in both modes (scope SQL + runtime boolean)', () => {
  // With ONLY the ref-role declaration (no redeclaration), is.author() is
  // usable in BOTH faces, derived from the single field:
  //  - scope(is.author()) compiles to a SQL row-filter (the entity loads, which
  //    requires the harvest face to lower successfully);
  //  - the runtime face is a boolean identity check against the ref column.
  const Comment = entity('Comment', {
        body: text(), author: ref('User', { role: 'author' }),

    grant: () => [
      scope(({ is }) => is.author()).can(
        async ({ is }) => (await is.author()) ? grant(read, write, subscribe) : deny('not the author'),
      ),
    ],
  });
  // harvest face: the scope compiled to SQL referencing the author column.
  assert.match(Comment.readScope.sql, /author/);
  // run face: identity of principal against the author column.
  const row = { author: 'user-1' };
  assert.equal(Comment.checks.author({ entity: row, principal: { id: 'user-1' } }), true);
  assert.equal(Comment.checks.author({ entity: row, principal: { id: 'user-2' } }), false);
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
            body: text(), owner: ref('User', { role: 'owner' }), editor: ref('User', { role: 'editor' }),

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
            body: text(), owner: ref('User', { role: 'owner' }),

      // forgotten await: is.owner() is a pending promise, always truthy,
      grant: () => [scope(({ is }) => is.owner()).can(({ is }) => is.owner() ? grant(write) : deny('no'))],
    }),
    /await/i,
    'an unawaited is.* in a .can body must be a load-time error',
  );
});

test('an entity name that is not a valid SQL identifier is a load-time error (fail-closed)', () => {
  // The entity name is interpolated verbatim into `FROM ${name}` / CREATE TABLE.
  assert.throws(
    () => entity('Drop; DROP TABLE Note;--', { body: text(), grant: ownerGrant }),
    /valid SQL identifier/i,
    'a non-identifier entity name must throw at load time',
  );
  assert.throws(
    () => entity('123bad', { body: text(), grant: ownerGrant }),
    /valid SQL identifier/i,
    'a name starting with a digit must throw',
  );
});

test('a field name that is not a valid SQL identifier is a load-time error (fail-closed)', () => {
  // A field name becomes a column, interpolated into SQL.
  assert.throws(
    () => entity('Note', { 'bad-col': text(), grant: ownerGrant }),
    /valid SQL identifier/i,
    'a non-identifier field name must throw at load time',
  );
});

test('a valid identifier entity/field name compiles (the guard does not reject legal names)', () => {
  const Note = entity('Note_2', {
        body_text: text(), _internal: text(), owner: ref('User', { role: 'owner' }),

    grant: ownerGrant,
  });
  assert.equal(Note.name, 'Note_2');
  assert.ok(Note.fields.body_text);
  assert.ok(Note.fields._internal);
});

test('a `fields:` wrapper is a load-time error (fields-less declaration only)', () => {
  assert.throws(
    () => entity('Note', { fields: { body: text() }, grant: ownerGrant }),
    /fields\s*wrapper|fields-less/i,
    'a `fields:` wrapper must be rejected now that fields are declared as top-level keys',
  );
});

test('a reserved declaration slot used as a field name is a load-time error', () => {
  assert.throws(
    () => entity('Note', { schedule: text(), grant: ownerGrant }),
    /reserved/i,
    'a reserved slot name must not be treated as a field',
  );
});

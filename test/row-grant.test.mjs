// Phase 2, slice 2 — the row grant's RUNTIME half (the second default-on auth
// layer's capability decision), run against a materialized row.
//
// Phase 1 proved the row grant's SQL-scope half (bindReadScope filters which
// rows a principal may SEE). The `.can` capability half — given a visible row,
// what may the principal DO (read/write/subscribe)? — was declared and
// statically guarded at load but NEVER run against a real row. This module is
// that runtime: it builds the per-entity `is` checks bound to { row, principal },
// runs the grant clause's `.can` body through the await-backstop, and yields the
// conferred capability set. The HTTP dispatcher consults it on every admitted
// verb so route admission (gate) and row capability (grant) are BOTH enforced.

import { text, ref, scope, grant, deny, read, write, subscribe } from '../src/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  entity } from '../src/internal.mjs';
import { rowCapabilities, mayVerb } from '../src/row-grant.mjs';
import { principal, anonymous } from '../src/principal.mjs';

// An owned Note: the owner may read+write+subscribe; everyone else read-only.
function makeNote() {
  return entity('Note', {
        body: text(),
    owner: ref('User', { role: 'owner', readonly: true }),

    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read),
      ),
    ],
  });
}

const alice = principal({ type: 'user', id: 'alice' });
const bob = principal({ type: 'user', id: 'bob' });

test('rowCapabilities runs the .can body against a materialized row + principal', async () => {
  const Note = makeNote();
  const row = { id: 1, body: 'hi', owner: 'alice' };

  const aliceCaps = await rowCapabilities(Note, row, alice);
  assert.equal(aliceCaps.granted, true);
  assert.ok(aliceCaps.capabilities.includes(read));
  assert.ok(aliceCaps.capabilities.includes(write));
  assert.ok(aliceCaps.capabilities.includes(subscribe));

  // bob is not the owner of this row → read only
  const bobCaps = await rowCapabilities(Note, row, bob);
  assert.equal(bobCaps.granted, true);
  assert.ok(bobCaps.capabilities.includes(read));
  assert.ok(!bobCaps.capabilities.includes(write));
});

test('mayVerb maps a CRUD verb to the capability it requires and checks the grant', async () => {
  const Note = makeNote();
  const row = { id: 1, body: 'hi', owner: 'alice' };

  // read/list require `read`; both principals can read this (visible) row.
  assert.equal(await mayVerb(Note, 'read', row, alice), true);
  assert.equal(await mayVerb(Note, 'read', row, bob), true);

  // update/remove require `write`; only the owner has it.
  assert.equal(await mayVerb(Note, 'update', row, alice), true);
  assert.equal(await mayVerb(Note, 'update', row, bob), false);
  assert.equal(await mayVerb(Note, 'remove', row, alice), true);
  assert.equal(await mayVerb(Note, 'remove', row, bob), false);
});

test('a deny() decision confers no capabilities (fail closed)', async () => {
  const Locked = entity('Locked', {
        body: text(), owner: ref('User', { role: 'owner', readonly: true }),

    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write) : deny('not the owner'),
      ),
    ],
  });
  const row = { id: 1, body: 'x', owner: 'alice' };
  const denied = await rowCapabilities(Locked, row, bob);
  assert.equal(denied.granted, false);
  assert.equal(await mayVerb(Locked, 'read', row, bob), false);
});

test('an anonymous principal owns no row → no write capability', async () => {
  const Note = makeNote();
  const row = { id: 1, body: 'hi', owner: 'alice' };
  assert.equal(await mayVerb(Note, 'update', row, anonymous), false);
});

test('a stable grant thunk is resolved once and refreshes when its declaration changes', async () => {
  let calls = 0;
  const clauses = [
    scope(() => undefined).can(async ({ is }) =>
      (await is.owner()) ? grant(read, write) : deny('not the owner')),
  ];
  const grantThunk = () => {
    calls += 1;
    return clauses;
  };
  const entityRecord = {
    name: 'CachedGrant',
    grant: grantThunk,
    registry: Object.freeze({
      owner: { run: ({ entity: row, principal }) => row.owner === principal.id },
    }),
  };
  const row = { id: 'd1', owner: 'alice' };

  assert.equal(await mayVerb(entityRecord, 'read', row, alice), true);
  assert.equal(await mayVerb(entityRecord, 'update', row, alice), true);
  assert.equal(calls, 1, 'the immutable declaration is evaluated once per entity');

  entityRecord.grant = () => {
    calls += 1;
    return clauses;
  };
  assert.equal(await mayVerb(entityRecord, 'read', row, alice), true);
  assert.equal(calls, 2, 'replacing the declaration invalidates the cached clauses');
});

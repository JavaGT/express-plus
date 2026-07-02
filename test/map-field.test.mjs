// map() — the `store` kind's owned-collection instance (Phase A2 'continue all').
//
// Import-surface scope only: map() must return a valid frozen field descriptor
// the entity compiler accepts at import, carrying its per-member value descriptor
// and its declared roles. The membership-mutation behavior (collaborators.set,
// native map event handles, the viewer/editor role-derived checks) is DEFERRED
// to later behavior pieces.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { map, ref, entity, scope, grant, read, never, native } from '../src/index.mjs';

test('map(ref(...), options) returns a frozen store-kind descriptor', () => {
  const descriptor = map(ref('User'), { role: ['viewer', 'editor'], default: {} });
  assert.equal(descriptor.kind, 'store');
  assert.equal(descriptor.type, 'map');
  assert.ok(Object.isFrozen(descriptor));
});

test('map carries its per-member value descriptor as `of`', () => {
  const member = ref('User');
  const descriptor = map(member, { role: ['viewer', 'editor'] });
  assert.equal(descriptor.of.type, 'ref');
  assert.equal(descriptor.of.target, 'User');
});

test('map carries its declared roles as a frozen list (not a per-row column)', () => {
  const descriptor = map(ref('User'), { role: ['viewer', 'editor'], default: {} });
  assert.deepEqual(descriptor.roles, ['viewer', 'editor']);
  assert.ok(Object.isFrozen(descriptor.roles));
});

test('map exposes .can returning a new frozen descriptor carrying access', () => {
  const accessFn = () => grant(read);
  const descriptor = map(ref('User'), { role: ['viewer'] }).can(accessFn);
  assert.equal(descriptor.access, accessFn);
  assert.ok(Object.isFrozen(descriptor));
});

test('a map field compiles into an entity at import (does not throw at load)', () => {
  assert.doesNotThrow(() => {
    entity('Doc', {
      fields: { collaborators: map(ref('User'), { role: ['viewer', 'editor'], default: {} }) },
      grant: () => [scope(() => never()).can(() => grant(read))],
    });
  });
});

test('map does not expose generic collection trigger aliases', () => {
  const d = map(ref('User'), { role: ['viewer'], default: {} });
  assert.equal(d.onAdded, undefined);
  assert.equal(d.onRemoved, undefined);
});

test('native map event handles are frozen stable computed keys', () => {
  const added = native('Doc', 'collaborators', 'added');
  assert.ok(Object.isFrozen(added));
  assert.equal(String(added), 'Doc.collaborators.added');
  assert.equal(({ [added]: 1 })['Doc.collaborators.added'], 1);
});

test('a map field is not whole-value comparable in scope (fail closed)', () => {
  const Doc = entity('Doc', {
    fields: { collaborators: map(ref('User'), { role: ['viewer'] }) },
    grant: () => [scope(() => never()).can(() => grant(read))],
  });
  assert.throws(() => Doc.collaborators.is('x'), /store field and cannot be compared/);
});

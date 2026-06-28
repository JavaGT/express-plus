import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entity, presence, scope, everyone, grant, read } from '../src/index.mjs';

// `presence({ cursor, selection })` — the framework's first NON-PERSISTING field.
// It is its own KIND (`presence`), a namespace of named live sub-cells. Its
// ephemerality is EMERGENT: it engages no persistence seam (no strategy entry,
// so it never serializes), per SPEC §7.2 — never a flag the descriptor carries.
// Import-surface scope: deliver the descriptor the entity compiler accepts; the
// per-connection live broadcast/coalescing is deferred live behavior.

test('presence() returns a frozen presence-kind descriptor', () => {
  const field = presence({ cursor: true, selection: true });
  assert.equal(field.kind, 'presence');
  assert.equal(field.type, 'presence');
  assert.ok(Object.isFrozen(field));
});

test('presence carries its declared live sub-cells', () => {
  const field = presence({ cursor: true, selection: true });
  assert.deepEqual(field.cells, { cursor: true, selection: true });
  assert.ok(Object.isFrozen(field.cells));
});

test('presence carries NO persistence opinion as a flag', () => {
  // ephemerality is emergent from the absent seam, not a `persisted: false`
  // label on the descriptor.
  const field = presence({ cursor: true });
  assert.equal(field.persisted, undefined);
});

test('.can(fn) returns a new frozen presence descriptor carrying the access fn', () => {
  const fn = async () => true;
  const field = presence({ cursor: true }).can(fn);
  assert.equal(field.access, fn);
  assert.equal(field.kind, 'presence');
  assert.equal(field.type, 'presence');
  assert.ok(Object.isFrozen(field));
});

test('a presence field compiles into an entity at import', () => {
  const Room = entity('RoomWithPresence', {
    grant: scope(() => everyone()).can(() => grant(read)),
    fields: {
      cursors: presence({ cursor: true, selection: true }),
    },
  });
  assert.ok(Room);
});

test('a presence handle cannot be compared in scope (fail closed)', () => {
  const Room = entity('RoomScopeGuard', {
    grant: scope(() => everyone()).can(() => grant(read)),
    fields: {
      cursors: presence({ cursor: true }),
    },
  });
  assert.throws(
    () => Room.cursors.is('x'),
    /presence field and cannot be compared/,
  );
});

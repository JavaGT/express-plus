import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entity, presence, ephemeral, scope, everyone, grant, read } from '../src/index.mjs';

// `presence({ cursor, selection })` — the framework's first NON-PERSISTING field.
// RETIRED to a thin wrapper over `ephemeral` (one non-persisting kind), per the
// "a new general mechanism retires the special-case it generalizes" rule. Its
// ephemerality is EMERGENT: it engages no persistence seam (no strategy entry,
// so it never serializes), per SPEC §7.2 — never a flag the descriptor carries.
// Import-surface scope: deliver the descriptor the entity compiler accepts; the
// per-connection live broadcast/coalescing is deferred live behavior.

test('presence() returns a frozen ephemeral-kind descriptor (retired wrapper)', () => {
  const field = presence({ cursor: true, selection: true });
  // presence RETIRED into ephemeral — one non-persisting kind (AGENTS rule).
  assert.equal(field.kind, 'ephemeral');
  assert.equal(field.type, 'ephemeral');
  assert.ok(Object.isFrozen(field));
  // presence is a true thin wrapper: same kind/type/cells as ephemeral directly.
  // (deepEqual chokes on the `can` method descriptor attaches, so compare fields.)
  const direct = ephemeral({ cursor: true, selection: true });
  assert.equal(field.kind, direct.kind);
  assert.equal(field.type, direct.type);
  assert.deepEqual(field.cells, direct.cells);
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

test('.can(fn) returns a new frozen ephemeral descriptor carrying the access fn', () => {
  const fn = async () => true;
  const field = presence({ cursor: true }).can(fn);
  assert.equal(field.access, fn);
  assert.equal(field.kind, 'ephemeral');
  assert.equal(field.type, 'ephemeral');
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
    /ephemeral field and cannot be compared/,
  );
});

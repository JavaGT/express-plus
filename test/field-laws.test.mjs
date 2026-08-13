import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveStrategy } from '../build/field-strategy.mjs';

test('value kind is invertible and coalescible', () => {
  const s = resolveStrategy('value');
  assert.equal(s.laws.invertible, true, 'whole-value replace is its own inverse');
  assert.equal(s.laws.coalescible, true, 'set(a);set(b) coalesces to set(b)');
  assert.equal(s.laws.idempotent, false, 'set(x);set(x) != set(x)');
});

test('hash kind is not invertible', () => {
  const s = resolveStrategy('hash');
  assert.equal(s.laws.invertible, false, 'cannot recover plaintext from digest');
  assert.equal(s.laws.coalescible, false);
});

test('crdt text kind requires authored compensation and is commutative', () => {
  const s = resolveStrategy('crdt');
  assert.equal(s.laws.invertible, false, 'generic history cannot construct a compensating immutable text operation');
  assert.equal(s.laws.coalescible, true, 'insert+delete at same position cancel');
  assert.equal(s.laws.commutativeMerge, true, 'CRDT ops commute by definition');
});

test('store map kind is invertible and idempotent', () => {
  const s = resolveStrategy('store');
  assert.equal(s.laws.invertible, true, 'added/removed are inverses');
  assert.equal(s.laws.coalescible, true, 'add then remove = no-op');
  assert.equal(s.laws.idempotent, true, 're-adding same member is a no-op');
});

test('ordered kind is invertible but not coalescible', () => {
  const s = resolveStrategy('ordered');
  assert.equal(s.laws.invertible, true, 'insertAt/remove are inverses per-op');
  assert.equal(s.laws.coalescible, false, 'ops are per-identity, not whole-state');
  assert.equal(s.laws.commutativeMerge, false);
});

test('computed and projected are not invertible', () => {
  const c = resolveStrategy('computed');
  assert.equal(c.laws.invertible, false, 'derived field cannot be inverted');
  assert.equal(c.laws.coalescible, true, 'latest computed value wins');

  const p = resolveStrategy('projected');
  assert.equal(p.laws.invertible, false, 'derived field cannot be inverted');
  assert.equal(p.laws.coalescible, true, 'latest projected value wins');
});

test('struct kind is invertible (per-sub-cell) and coalescible', () => {
  const s = resolveStrategy('struct');
  assert.equal(s.laws.invertible, true, 'per-sub-cell, set(old) undoes set(new)');
  assert.equal(s.laws.coalescible, true, 'per sub-cell, latest wins');
});

test('state kind is invertible and coalescible', () => {
  const s = resolveStrategy('state');
  assert.equal(s.laws.invertible, true, 'transition from→to, inverse is to→from');
  assert.equal(s.laws.coalescible, true, 'from→to; to→next coalesces to from→next');
  assert.equal(s.laws.idempotent, true, 're-setting same state is idempotent');
});

test('unknown kind throws (fail-closed)', () => {
  assert.throws(
    () => resolveStrategy('imaginary'),
    /unknown field kind/,
  );
});

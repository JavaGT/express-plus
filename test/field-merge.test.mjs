// Priority 6 — field merge strategies (eng-review test plan 728-735, consult #18/#20).
//
// The four named-whole kinds (crdt/store/ordered/struct) validate structurally in
// Phase 1 but their apply/diff FAIL CLOSED with a loud Phase-2 throw. P6 retires
// the throw with real per-element diffs: a change is described as an ELEMENT-level
// delta (insert / added / moved / per-sub-cell), NOT a whole-value `{ set }`.
//
// These are STRATEGY-unit tests: they call resolveStrategy(kind).diff directly
// over value representations. They do NOT exercise handles, side-tables, or the
// pipeline (those land in list-field / log-field / store-event E2E). The single-
// writer dispatch stores `next` (apply = replace); the per-element DELTA (diff) is
// the broadcast artifact — the "merge machinery" consult #18 names. Concurrent-
// merge toolkit is deferred (#33), not this.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveStrategy } from '../src/field-strategy.mjs';

const crdt = resolveStrategy('crdt');
const store = resolveStrategy('store');
const ordered = resolveStrategy('ordered');
const struct = resolveStrategy('struct');

// A struct descriptor's `cells` map mirrors the link field shape (field.mjs struct).
const structDescriptor = { cells: { token: { kind: 'value', type: 'text' }, tier: { kind: 'value', type: 'text' } } };

test('crdt diff: a pure append yields an {insert} delta, not a whole-value {set}', () => {
  const delta = crdt.diff('hello', 'hello!');
  assert.deepEqual(delta, { insert: { at: 5, text: '!' } });
  assert.ok(!delta || !('set' in delta), 'crdt diff is per-element, not a whole-value set');
});

test('crdt diff: an interior insert yields the inserted span only', () => {
  const delta = crdt.diff('hello world', 'hello big world');
  assert.deepEqual(delta, { insert: { at: 6, text: 'big ' } });
});

test('crdt diff: unchanged text yields null', () => {
  assert.equal(crdt.diff('same', 'same'), null);
});

test('crdt apply: stores the resolved next value (single-writer dispatch)', () => {
  assert.equal(crdt.apply('hello', 'hello!'), 'hello!');
});

test('store (map) diff: a member add yields an {added} delta', () => {
  const delta = store.diff({ u1: 'viewer' }, { u1: 'viewer', u2: 'editor' });
  assert.deepEqual(delta, { added: [{ member: 'u2', role: 'editor' }], removed: [], changed: [] });
});

test('store (map) diff: a role change is {changed}, NOT {added} (idempotent re-share, DECISIONLOG #57)', () => {
  const delta = store.diff({ u1: 'viewer' }, { u1: 'editor' });
  assert.deepEqual(delta, { added: [], removed: [], changed: [{ member: 'u1', role: 'editor' }] });
});

test('store (map) diff: a member remove yields {removed}', () => {
  const delta = store.diff({ u1: 'viewer', u2: 'editor' }, { u2: 'editor' });
  assert.deepEqual(delta, { added: [], removed: ['u1'], changed: [] });
});

test('ordered diff: an insertAt yields {added} and leaves sibling keys untouched (no renumber)', () => {
  const prev = [{ key: 'a', id: 1 }, { key: 'c', id: 3 }];
  const next = [{ key: 'a', id: 1 }, { key: 'b', id: 2 }, { key: 'c', id: 3 }];
  const delta = ordered.diff(prev, next);
  assert.deepEqual(delta, { added: [{ at: 1, key: 'b', item: { id: 2 } }], removed: [], moved: [] });
});

test('ordered diff: a move reorders by key without re-keying siblings', () => {
  const prev = [{ key: 'b', id: 2 }, { key: 'a', id: 1 }, { key: 'c', id: 3 }];
  const next = [{ key: 'a', id: 1 }, { key: 'b', id: 2 }, { key: 'c', id: 3 }];
  const delta = ordered.diff(prev, next);
  // 'a' moved 1->0 and 'b' shifted 0->1; 'c' stable. Keys unchanged — no renumber.
  assert.deepEqual(delta.moved, [
    { key: 'a', from: 1, to: 0 },
    { key: 'b', from: 0, to: 1 },
  ]);
  assert.deepEqual(delta.added, []);
  assert.deepEqual(delta.removed, []);
  // no sibling keys were re-keyed (a/b/c all present, unchanged)
  assert.deepEqual(next.map((e) => e.key), ['a', 'b', 'c']);
});

test('structured diff: a single sub-cell change yields a per-sub-cell {cells} delta', () => {
  const prev = { token: 'x', tier: 'free' };
  const next = { token: 'x', tier: 'pro' };
  const delta = struct.diff(prev, next, structDescriptor);
  assert.deepEqual(delta, { cells: { tier: { set: 'pro' } } });
  assert.ok(!('token' in delta.cells), 'an unchanged sub-cell is absent from the delta');
});

test('structured diff: unchanged struct yields null', () => {
  assert.equal(struct.diff({ token: 'x', tier: 'free' }, { token: 'x', tier: 'free' }, structDescriptor), null);
});

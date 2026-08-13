// Priority 6 — field merge strategies (eng-review test plan 728-735, consult #18/#20).
//
// The four named-whole kinds (crdt/store/ordered/struct) validate structurally in
// Phase 1 but their apply/diff FAIL CLOSED with a loud Phase-2 throw. Text CRDT
// now reduces native annotated-text operations; store/struct retain their own
// field strategy contracts.
//
// These are STRATEGY-unit tests: they call resolveStrategy(kind).diff directly
// over value representations. They do NOT exercise handles, side-tables, or the
// pipeline (those land in list-field / log-field / store-event E2E). The single-
// writer dispatch stores `next` (apply = replace); the per-element DELTA (diff) is
// the broadcast artifact — the "merge machinery" consult #18 names. Concurrent-
// merge toolkit is deferred (#33), not this.
//
// NOTE: `ordered` has NO `strategy.diff` (DECISIONLOG #74 — VESTIGIAL, deleted
// orderedListDiff). Ordered's delta contract is the native identity-keyed per-op
// EVENTS from orderedMutateHandlers (`.inserted`/`.moved`/`.reordered`/`.removed`),
// exercised in list-field.test.mjs + live-delta-native.test.mjs — not a snapshot
// diff over `{key,...}` objects. So there are no ordered strategy.diff unit tests
// here; crdt/store/struct diffs are the snapshot-diff-bearing kinds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveStrategy } from '../build/field-strategy.mjs';

const crdt = resolveStrategy('crdt');
const store = resolveStrategy('store');
const struct = resolveStrategy('struct');

// A struct descriptor's `cells` map mirrors the link field shape (field.mjs struct).
const structDescriptor = { cells: { token: { kind: 'value', type: 'text' }, tier: { kind: 'value', type: 'text' } } };

test('text crdt rejects the retired whole-string diff path', () => {
  assert.throws(() => crdt.diff('hello', 'hello!'), /field\.apply/);
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

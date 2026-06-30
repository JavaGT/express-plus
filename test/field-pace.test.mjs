// Phase 1 — the field-kind pace registry: per-subscriber PACE/COALESCING is
// ORTHOGONAL to persistence (DECISIONLOG #61). Ephemeral fields have no
// STRATEGIES entry (the absent seam IS the ephemerality) but DO have a
// PACE_STRATEGIES entry. Other kinds (value, text) have no pace entry — they
// can only deliver verbatim (synthetic pass-through).
//
// SPEC §... P6e-1b: per-subscriber pace/coalescing for ephemeral fields.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PACE_STRATEGIES,
  resolvePace,
  validatePaceSelection,
} from '../src/field-pace.mjs';
import { resolveStrategy } from '../src/field-strategy.mjs';

// --- the pace registry is keyed by field-kind, framework-owned ---

test('PACE_STRATEGIES is frozen and has an ephemeral entry with all 4 slots', () => {
  assert.equal(Object.isFrozen(PACE_STRATEGIES), true);
  const entry = PACE_STRATEGIES.ephemeral;
  assert.ok(entry, 'ephemeral entry exists');
  assert.equal(Object.isFrozen(entry), true);
  assert.equal(typeof entry.coalescers, 'object');
  assert.equal(typeof entry.reduceSpan, 'function');
  assert.equal(typeof entry.profiles, 'object');
  assert.equal(typeof entry.bounds, 'object');
  assert.equal(Object.isFrozen(entry.coalescers), true);
  assert.equal(Object.isFrozen(entry.profiles), true);
  assert.equal(Object.isFrozen(entry.bounds), true);
});

test('PACE_STRATEGIES has no value/text/crdt/store/ordered/struct/hash/state entry', () => {
  for (const kind of ['value', 'crdt', 'store', 'ordered', 'struct', 'hash', 'state']) {
    assert.equal(PACE_STRATEGIES[kind], undefined);
  }
});

// --- resolvePace ---

test('resolvePace("ephemeral") returns the PACE_STRATEGIES ephemeral entry', () => {
  const pace = resolvePace('ephemeral');
  assert.equal(pace, PACE_STRATEGIES.ephemeral);
});

test('resolvePace("value") returns a synthetic pass-through (no coalescers lawful)', () => {
  const pace = resolvePace('value');
  assert.equal(Object.isFrozen(pace), true);
  assert.deepEqual(pace.coalescers, {});
  assert.equal(pace.reduceSpan, null);
  assert.deepEqual(pace.profiles, { 'pass-through': Object.freeze({ window: 0, by: null }) });
  assert.deepEqual(pace.bounds, Object.freeze({ allowedBy: [], maxWindow: 0 }));
});

test('resolvePace returns synthetic pass-through for any kind without a pace entry', () => {
  for (const kind of ['crdt', 'store', 'ordered', 'struct', 'hash', 'state']) {
    const pace = resolvePace(kind);
    assert.deepEqual(pace.profiles, { 'pass-through': Object.freeze({ window: 0, by: null }) });
    assert.deepEqual(pace.bounds, Object.freeze({ allowedBy: [], maxWindow: 0 }));
  }
});

// --- validatePaceSelection ---

test('validatePaceSelection("ephemeral", {profile:"15fps"}) returns {window:66, by:"latest-wins"}', () => {
  const result = validatePaceSelection('ephemeral', { profile: '15fps' });
  assert.deepEqual(result, { window: 66, by: 'latest-wins' });
});

test('validatePaceSelection("ephemeral", {profile:"pass-through"}) returns {window:0, by:null}', () => {
  const result = validatePaceSelection('ephemeral', { profile: 'pass-through' });
  assert.deepEqual(result, { window: 0, by: null });
});

test('validatePaceSelection("ephemeral", {coalesce:{window:50, by:"latest-wins"}}) returns effective', () => {
  const result = validatePaceSelection('ephemeral', { coalesce: { window: 50, by: 'latest-wins' } });
  assert.deepEqual(result, { window: 50, by: 'latest-wins' });
});

test('validatePaceSelection("ephemeral", {coalesce:{window:50, by:"sum"}}) throws (sum not in allowedBy)', () => {
  assert.throws(
    () => validatePaceSelection('ephemeral', { coalesce: { window: 50, by: 'sum' } }),
    (err) => {
      assert.match(err.message, /sum/);
      assert.match(err.message, /not lawful/);
      assert.equal(err.status, 400);
      return true;
    },
  );
});

test('validatePaceSelection("ephemeral", {coalesce:{window:2000, by:"latest-wins"}}) throws (exceeds maxWindow)', () => {
  assert.throws(
    () => validatePaceSelection('ephemeral', { coalesce: { window: 2000, by: 'latest-wins' } }),
    (err) => {
      assert.equal(err.status, 400);
      return true;
    },
  );
});

test('validatePaceSelection("ephemeral", {coalesce:{window:0, by:"latest-wins"}}) throws (window must be positive)', () => {
  assert.throws(
    () => validatePaceSelection('ephemeral', { coalesce: { window: 0, by: 'latest-wins' } }),
    (err) => {
      assert.equal(err.status, 400);
      return true;
    },
  );
});

test('validatePaceSelection("ephemeral", {coalesce:{window:-1, by:"latest-wins"}}) throws (window must be positive)', () => {
  assert.throws(
    () => validatePaceSelection('ephemeral', { coalesce: { window: -1, by: 'latest-wins' } }),
    (err) => {
      assert.equal(err.status, 400);
      return true;
    },
  );
});

test('validatePaceSelection("ephemeral", {profile:"bogus"}) throws (unknown profile)', () => {
  assert.throws(
    () => validatePaceSelection('ephemeral', { profile: 'bogus' }),
    (err) => {
      assert.match(err.message, /unknown pace profile/);
      assert.match(err.message, /bogus/);
      return true;
    },
  );
});

test('validatePaceSelection("value", {coalesce:{window:50, by:"latest-wins"}}) throws (value has no pace entry)', () => {
  assert.throws(
    () => validatePaceSelection('value', { coalesce: { window: 50, by: 'latest-wins' } }),
    (err) => {
      assert.equal(err.status, 400);
      return true;
    },
  );
});

test('validatePaceSelection("value", {profile:"pass-through"}) returns {window:0, by:null} (ok for any kind)', () => {
  const result = validatePaceSelection('value', { profile: 'pass-through' });
  assert.deepEqual(result, { window: 0, by: null });
});

test('validatePaceSelection("value", null) returns {window:0, by:null} (pass-through ok for any kind)', () => {
  const result = validatePaceSelection('value', null);
  assert.deepEqual(result, { window: 0, by: null });
});

test('validatePaceSelection("ephemeral", undefined) returns {window:0, by:null}', () => {
  const result = validatePaceSelection('ephemeral', undefined);
  assert.deepEqual(result, { window: 0, by: null });
});

test('validatePaceSelection("ephemeral", ()=>{}) throws "data, not a closure"', () => {
  assert.throws(
    () => validatePaceSelection('ephemeral', () => {}),
    (err) => {
      assert.match(err.message, /data, not a closure/);
      assert.equal(err.status, 400);
      return true;
    },
  );
});

test('validatePaceSelection rejects closures in sub-values', () => {
  assert.throws(
    () => validatePaceSelection('ephemeral', { profile: '15fps', coalesce: () => {} }),
    (err) => {
      assert.match(err.message, /data, not a closure/);
      return true;
    },
  );
  assert.throws(
    () => validatePaceSelection('ephemeral', { coalesce: { window: 50, by: () => {} } }),
    (err) => {
      assert.match(err.message, /data, not a closure/);
      return true;
    },
  );
});

// --- reduceSpan ---

test('ephemeral reduceSpan of a 3-event window returns {seq:last, seqSpan:[first,last]}', () => {
  const { reduceSpan } = PACE_STRATEGIES.ephemeral;
  const events = [
    { seq: 10, value: 'a' },
    { seq: 11, value: 'b' },
    { seq: 12, value: 'c' },
  ];
  const result = reduceSpan(events);
  assert.deepEqual(result, { seq: 12, seqSpan: [10, 12] });
});

test('ephemeral reduceSpan of a single event returns seq===first===last', () => {
  const { reduceSpan } = PACE_STRATEGIES.ephemeral;
  const events = [{ seq: 42, value: 'x' }];
  const result = reduceSpan(events);
  assert.deepEqual(result, { seq: 42, seqSpan: [42, 42] });
});

// --- coalescers ---

test('ephemeral latest-wins coalescer returns the latest event', () => {
  const { coalescers } = PACE_STRATEGIES.ephemeral;
  const reducer = coalescers['latest-wins'];
  const ev1 = { seq: 1, cells: { x: 1 } };
  const ev2 = { seq: 2, cells: { x: 2 } };
  assert.equal(reducer(null, ev1), ev1);
  assert.equal(reducer(ev1, ev2), ev2);
});

// --- field-strategy reconcile: resolveStrategy("ephemeral") ---

test('resolveStrategy("ephemeral") throws a specific "do not persist" error', () => {
  assert.throws(
    () => resolveStrategy('ephemeral'),
    (err) => {
      assert.match(err.message, /do not persist/i);
      assert.match(err.message, /pace seam/i);
      return true;
    },
  );
});

test('resolveStrategy("nonsense") throws an "unknown field kind" error that does NOT list ephemeral', () => {
  assert.throws(
    () => resolveStrategy('nonsense'),
    (err) => {
      assert.match(err.message, /unknown field kind/);
      assert.doesNotMatch(err.message, /ephemeral/);
      // still lists the real persistence kinds
      assert.match(err.message, /value/);
      return true;
    },
  );
});

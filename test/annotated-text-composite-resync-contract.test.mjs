import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  evaluateW1aRetainedGate, evaluateW1aRetainedGrowth, evaluateW1aScaling,
  W1A_LATENCY_GATES,
} from '../benchmark/annotated-text-composite-resync-contract.mjs';

test('W1a split latency gates preserve the ratified thresholds', () => {
  assert.deepEqual(W1A_LATENCY_GATES, {
    initialBootstrapP95Ms: 1_000,
    forcedFallbackCycleP95Ms: 1_750,
    interactiveFoldP95Ms: 100,
  });
});

test('W1a retained-growth regression rejects a late leak hidden by total divided by recipients', () => {
  const lateLeak = [...Array(24).fill(0), 3];
  assert.ok(3 / lateLeak.length < 2, 'the retired total/recipient metric would pass');
  const result = evaluateW1aRetainedGrowth(lateLeak);
  assert.ok(result.fittedSlopeMiBPerRecipient < 2);
  assert.equal(result.trailingPassed, false);
  assert.ok(result.trailingSlopeMiBPerRecipient > result.trailingSlopeLimitMiBPerRecipient);

  const linear = evaluateW1aRetainedGrowth(Array.from({ length: 25 }, (_, index) => index));
  assert.equal(linear.trailingPassed, true);
});

test('W1a synthetic-leak fixture: flat 20 recipients then +5 MiB/recipient leaks', () => {
  // Cumulative post-GC retained deltas: 20 clean recipients, then five that
  // each retain 5 MiB more than the last. The retired metric (final total
  // divided by recipients) sees only 1 MiB/recipient and 25 MiB total — both
  // inside its gates — so it accepts this document as leak-free.
  const syntheticLeak = [...Array(20).fill(0), 5, 10, 15, 20, 25];
  const retiredTotalMiB = syntheticLeak.at(-1);
  assert.ok(retiredTotalMiB / syntheticLeak.length < 2, 'retired averaged slope would pass');
  assert.ok(retiredTotalMiB < 64, 'retired total check would pass');

  const rejected = evaluateW1aRetainedGate(syntheticLeak);
  assert.equal(rejected.passed, false, 'composite retained gate must reject the synthetic leak');
  assert.equal(rejected.trailingPassed, false);
  assert.ok(rejected.fittedSlopeMiBPerRecipient < 2);
  assert.ok(rejected.totalRetainedMiB < 64);
  assert.ok(rejected.trailingSlopeMiBPerRecipient > rejected.trailingSlopeLimitMiBPerRecipient);

  // Uniform retention (no late acceleration) passes every composite clause.
  const uniform = evaluateW1aRetainedGate(Array.from({ length: 25 }, () => 1.5));
  assert.equal(uniform.passed, true);
});

test('W1a scaling requires at least a 40% p95 reduction for each halving', () => {
  assert.equal(evaluateW1aScaling(new Map([[9_000, 240], [18_000, 400], [36_000, 800]])).passed, true);
  const failed = evaluateW1aScaling(new Map([[9_000, 260], [18_000, 400], [36_000, 600]]));
  assert.equal(failed.passed, false);
  assert.deepEqual(failed.comparisons.map(({ passed }) => passed), [false, false]);
  assert.equal(evaluateW1aScaling(new Map([[9_000, 240.00016], [18_000, 400], [36_000, 800]])).passed, false);
});

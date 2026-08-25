import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  evaluateW1aScaling, W1A_LATENCY_GATES,
} from '../benchmark/annotated-text-composite-resync-contract.mjs';

test('W1a split latency gates preserve the ratified thresholds', () => {
  assert.deepEqual(W1A_LATENCY_GATES, {
    initialBootstrapP95Ms: 1_000,
    forcedFallbackCycleP95Ms: 1_500,
    interactiveFoldP95Ms: 100,
  });
});

test('W1a scaling requires at least a 40% p95 reduction for each halving', () => {
  assert.equal(evaluateW1aScaling(new Map([[9_000, 240], [18_000, 400], [36_000, 800]])).passed, true);
  const failed = evaluateW1aScaling(new Map([[9_000, 260], [18_000, 400], [36_000, 600]]));
  assert.equal(failed.passed, false);
  assert.deepEqual(failed.comparisons.map(({ passed }) => passed), [false, false]);
});

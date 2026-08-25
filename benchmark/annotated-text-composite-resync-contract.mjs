export const W1A_LATENCY_GATES = Object.freeze({
  initialBootstrapP95Ms: 1_000,
  forcedFallbackCycleP95Ms: 1_750,
  interactiveFoldP95Ms: 100,
});

export const W1A_SCALING_WORDS = Object.freeze([9_000, 18_000, 36_000]);
export const W1A_MIN_HALVING_REDUCTION = 0.4;
export const W1A_RETAINED_TRAILING_WINDOW = 5;
export const W1A_RETAINED_TRAILING_MULTIPLIER = 3;
export const W1A_RETAINED_TOTAL_LIMIT_MIB = 64;
export const W1A_RETAINED_SLOPE_LIMIT_MIB = 2;

function leastSquaresSlope(values) {
  if (!Array.isArray(values) || values.length < 2 || values.some((value) => !Number.isFinite(value))) {
    throw new Error('retained-growth regression requires at least two finite samples');
  }
  const xMean = (values.length + 1) / 2;
  const yMean = values.reduce((sum, value) => sum + value, 0) / values.length;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < values.length; index += 1) {
    const xDelta = index + 1 - xMean;
    numerator += xDelta * (values[index] - yMean);
    denominator += xDelta * xDelta;
  }
  return numerator / denominator;
}

export function evaluateW1aRetainedGrowth(heapDeltasMiB) {
  if (heapDeltasMiB.length < W1A_RETAINED_TRAILING_WINDOW) {
    throw new Error(`retained-growth regression requires at least ${W1A_RETAINED_TRAILING_WINDOW} samples`);
  }
  const fittedSlope = leastSquaresSlope(heapDeltasMiB);
  const trailingSlope = leastSquaresSlope(heapDeltasMiB.slice(-W1A_RETAINED_TRAILING_WINDOW));
  const trailingSlopeLimit = Math.max(0, fittedSlope) * W1A_RETAINED_TRAILING_MULTIPLIER;
  return {
    fittedSlopeMiBPerRecipient: fittedSlope,
    trailingSlopeMiBPerRecipient: trailingSlope,
    trailingSlopeLimitMiBPerRecipient: trailingSlopeLimit,
    trailingWindowRecipients: W1A_RETAINED_TRAILING_WINDOW,
    trailingMultiplier: W1A_RETAINED_TRAILING_MULTIPLIER,
    trailingPassed: trailingSlope <= trailingSlopeLimit,
  };
}

/**
 * Composite retained-growth acceptance gate: fitted slope, total retained
 * memory, and the late-leak trailing window must all pass together. The total
 * defaults to the largest post-GC heap delta but callers measuring additional
 * components (external/RSS) may supply the authoritative figure.
 */
export function evaluateW1aRetainedGate(heapDeltasMiB, totalRetainedMiB = Math.max(0, ...heapDeltasMiB)) {
  const regression = evaluateW1aRetainedGrowth(heapDeltasMiB);
  return {
    ...regression,
    totalRetainedMiB: totalRetainedMiB,
    slopePassed: regression.fittedSlopeMiBPerRecipient < W1A_RETAINED_SLOPE_LIMIT_MIB,
    totalPassed: totalRetainedMiB < W1A_RETAINED_TOTAL_LIMIT_MIB,
    passed: regression.trailingPassed
      && regression.fittedSlopeMiBPerRecipient < W1A_RETAINED_SLOPE_LIMIT_MIB
      && totalRetainedMiB < W1A_RETAINED_TOTAL_LIMIT_MIB,
  };
}

export function evaluateW1aScaling(samples) {
  const ordered = W1A_SCALING_WORDS.map((words) => {
    const p95Ms = samples.get(words);
    if (!Number.isFinite(p95Ms) || p95Ms <= 0) throw new Error(`missing scaling p95 for ${words} words`);
    return { words, p95Ms };
  });
  const comparisons = ordered.slice(0, -1).map((smaller, index) => {
    const larger = ordered[index + 1];
    const exactReduction = 1 - smaller.p95Ms / larger.p95Ms;
    return {
      smallerWords: smaller.words,
      largerWords: larger.words,
      smallerP95Ms: smaller.p95Ms,
      largerP95Ms: larger.p95Ms,
      reduction: Number(exactReduction.toFixed(6)),
      passed: exactReduction >= W1A_MIN_HALVING_REDUCTION,
    };
  });
  return {
    metric: 'initial bootstrap end-to-end p95',
    minimumHalvingReduction: W1A_MIN_HALVING_REDUCTION,
    samples: ordered,
    comparisons,
    passed: comparisons.every((comparison) => comparison.passed),
  };
}

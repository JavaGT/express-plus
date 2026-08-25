export const W1A_LATENCY_GATES = Object.freeze({
  initialBootstrapP95Ms: 1_000,
  forcedFallbackCycleP95Ms: 1_500,
  interactiveFoldP95Ms: 100,
});

export const W1A_SCALING_WORDS = Object.freeze([9_000, 18_000, 36_000]);
export const W1A_MIN_HALVING_REDUCTION = 0.4;

export function evaluateW1aScaling(samples) {
  const ordered = W1A_SCALING_WORDS.map((words) => {
    const p95Ms = samples.get(words);
    if (!Number.isFinite(p95Ms) || p95Ms <= 0) throw new Error(`missing scaling p95 for ${words} words`);
    return { words, p95Ms };
  });
  const comparisons = ordered.slice(0, -1).map((smaller, index) => {
    const larger = ordered[index + 1];
    const reduction = 1 - smaller.p95Ms / larger.p95Ms;
    return {
      smallerWords: smaller.words,
      largerWords: larger.words,
      smallerP95Ms: smaller.p95Ms,
      largerP95Ms: larger.p95Ms,
      reduction: Number(reduction.toFixed(6)),
      passed: reduction >= W1A_MIN_HALVING_REDUCTION,
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

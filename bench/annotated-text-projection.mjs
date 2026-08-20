// Representative browser-path projection benchmark (Sol step 0).
//
// Reproduces the editor's optimistic projection that runs on every keystroke:
//   bufferEdit -> paintDisplay -> applyOffsetTextEdit(family, from, to, text)
// on a ~40k-element transcript-family, starting each key from the same base
// family (as session.family in the browser editor). This isolates the CRDT
// re-materialization + reducer cost that shows up as ~143ms per key in the
// Chrome profile — the target for the incremental-projection redesign.
//
// Run: node bench/annotated-text-projection.mjs

import {
  applyOffsetTextEdit,
  importTextToFamily,
  materializeText,
} from '../public/workbench-annotated-text-continuous.mjs';

function buildBase(size) {
  // Seed with a high, non-colliding actor id so it never collides with the
  // module's internal offset-edit actor sequence (~0000...001, ...002).
  return importTextToFamily('d1', 'f'.repeat(32), 'x'.repeat(size));
}

function bench(name, fn, count) {
  const t0 = performance.now();
  fn();
  const totalMs = performance.now() - t0;
  const perOpMs = totalMs / count;
  console.log(`${name}: total=${totalMs.toFixed(1)}ms  per-key=${perOpMs.toFixed(3)}ms (${count} keys, ops/s=${(1000 / perOpMs).toFixed(0)})`);
  return perOpMs;
}

const ITERATIONS = Number(process.env.ITERATIONS || 50);
const BASE = buildBase(20_000); // ~20k elements (7-min transcripts are ~40k+; keep seed fast here)
const docLen = materializeText(BASE).length;

console.log(`elements(approx)=${docLen + ITERATIONS}  baseLen=${docLen}  keystrokes=${ITERATIONS}`);

// Warm up (also exercises the derived cache paths once).
applyOffsetTextEdit(BASE, docLen, docLen, 'a');

// Per-keystroke optimistic single-char insert. Each key applies a fresh edit to
// the CURRENT draft family (mirrors bufferEdit's retained draft on the hot path),
// which still re-materializes the whole ~document per apply — the cost to cut.
let family;
let len = docLen;
bench('applyOffsetTextEdit (reducer+materialize+freeze)', () => {
  for (let i = 0; i < ITERATIONS; i += 1) {
    family = applyOffsetTextEdit(family ?? BASE, len, len, `a${i % 10}`);
    len += 1;
  }
}, ITERATIONS);

// Cost of just reading the projected text of the final family.
bench('materializeText(final family)', () => {
  let s;
  for (let i = 0; i < ITERATIONS; i += 1) s = materializeText(family);
  void s;
}, ITERATIONS);

void family;

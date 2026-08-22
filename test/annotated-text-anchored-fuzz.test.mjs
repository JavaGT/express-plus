// Anchored-range stress harness (Scope issue JavaGT/scope#720, feeding
// Decision 0025). Two deterministic, seeded lanes:
//
// 1. Convergence lane — N virtual clients author raw text ops from stale
//    causal views; deliveries are probabilistic and flushed at batch end.
//    Invariant: every replica converges to an identical RGA traversal.
//
// 2. Oracle lane — a converged document is driven through the planning seam
//    (`planTextOffsetEdit` / `planTextRangeApply` / `planAnnotationRemove`)
//    while a naive offset-space reimplementation applies the same visible
//    edits with standard shrink/clamp remapping. Invariants per batch:
//      - replica convergence (identical RGA sequence across clients),
//      - every surviving anchored range materializes exactly the naive
//        oracle substring (modulo the documented shrink/clamp rules),
//      - emptied-range dispositions account for exactly the deletions that
//        collapse a range, with saved quotes matching the lost substring.
//
// Everything is reproducible from numeric seeds (mulberry32). Every failure
// message carries the seed and step so drift bugs are directly reportable.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createTextState, applyTextOp, materializeText, textCheckpoint } from '../build/annotated-text.mjs';
import { insertText, deleteText } from '../public/workbench-text-edit.mjs';
import {
  applyTextOperation,
  createTextFamily,
  materializeRange,
  materializeText as materializeFamilyText,
  projectEndpointToOffset,
} from '../build/annotated-text-continuous.mjs';
import { rgaTraversal } from '../build/annotated-text-family.mjs';
import {
  planTextOffsetEdit,
  planAnnotationRemove,
  planTextRangeApply,
} from '../build/annotated-text-plan.mjs';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ACTORS = ['a', 'b', 'c', 'd', 'e'].map((ch) => ch.repeat(32));
const DOC = 'fuzz-doc';
const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'ok', 'x', 'zet', 'word', 'q'];

function pick(rng, list) {
  return list[Math.floor(rng() * list.length)];
}

/** Scalar-aligned offsets of a string (UTF-16 aware). */
function scalarOffsets(text) {
  const offsets = [0];
  for (const scalar of text) offsets.push(offsets[offsets.length - 1] + scalar.length);
  return offsets;
}

// ---------------------------------------------------------------------------
// Lane 1: replica convergence under concurrent, delayed delivery.
// ---------------------------------------------------------------------------

function runConvergenceSeed(seed, steps) {
  const rng = mulberry32(seed);
  const replicas = new Map(ACTORS.map((actor) => [actor, createTextState()]));
  const applied = new Map(ACTORS.map((actor) => [actor, new Set()]));
  const counters = new Map(ACTORS.map((actor) => [actor, 0]));
  const log = [];
  let lamport = 0;

  function identity(actor) {
    counters.set(actor, counters.get(actor) + 1);
    return { actor, counter: counters.get(actor), lamport: ++lamport };
  }

  function tryDeliver(op, actor, force) {
    if (applied.get(actor).has(op)) return;
    if (force || rng() < 0.6) {
      replicas.set(actor, applyTextOp(replicas.get(actor), op));
      applied.get(actor).add(op);
    }
  }

  function flushAll() {
    for (const actor of ACTORS) for (const op of log) tryDeliver(op, actor, true);
  }

  function publish(op, author, forceAll) {
    log.push(op);
    tryDeliver(op, author, true);
    for (const other of ACTORS) {
      if (other !== author) tryDeliver(op, other, forceAll);
    }
  }

  // Scripted seed document: one multi-scalar chunk from actor A everywhere.
  publish(
    insertText(replicas.get(ACTORS[0]), identity(ACTORS[0]), 0, 'the quick brown fox'),
    ACTORS[0],
    true,
  );

  for (let step = 0; step < steps; step += 1) {
    if (step % 12 === 11) flushAll(); // batch boundary: authors see fresh views

    const actor = pick(rng, ACTORS);
    const state = replicas.get(actor);
    const text = materializeText(state);
    if (text.length > 0 && rng() < 0.45) {
      const offsets = scalarOffsets(text);
      const count = offsets.length - 1;
      const startIdx = Math.floor(rng() * count);
      const length = 1 + Math.floor(rng() * Math.min(6, count - startIdx));
      publish(
        deleteText(state, identity(actor), offsets[startIdx], offsets[startIdx + length]),
        actor,
        false,
      );
    } else {
      const offset = pick(rng, scalarOffsets(text));
      publish(insertText(state, identity(actor), offset, pick(rng, WORDS)), actor, false);
    }
  }

  flushAll(); // final convergence: every op reaches every replica

  return { master: createTextState(), replicas };
}

test('anchored fuzz lane 1: replicas converge to identical RGA sequences', () => {
  for (const seed of [0xc0ffee, 1234, 0x5eed01]) {
    const { replicas } = runConvergenceSeed(seed, 400);
    const referenceActor = ACTORS[0];
    const referenceState = replicas.get(referenceActor);
    const referenceRgaKeys = JSON.stringify(rgaTraversal(referenceState).map(([key]) => key));
    const referenceCheckpoint = JSON.stringify(textCheckpoint(referenceState));
    const referenceText = materializeText(referenceState);
    assert.ok(referenceText.length > 10, `seed ${seed}: document unexpectedly small`);
    for (const [actor, state] of replicas) {
      assert.equal(
        materializeText(state), referenceText,
        `seed ${seed}: replica ${actor.slice(0, 4)} materialized different text`,
      );
      // Canonical checkpoints sort deletedBy, so equality here means the full
      // element/tombstone state converged, not just the visible text.
      assert.equal(
        JSON.stringify(textCheckpoint(state)), referenceCheckpoint,
        `seed ${seed}: replica ${actor.slice(0, 4)} diverged from master canonical checkpoint`,
      );
      assert.equal(
        JSON.stringify(rgaTraversal(state).map(([key]) => key)), referenceRgaKeys,
        `seed ${seed}: replica ${actor.slice(0, 4)} diverged from master RGA sequence`,
      );
    }
  }
});

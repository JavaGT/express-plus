// Deterministic seeded convergence and family-invariant coverage for the
// annotated-text reducer. Everything here is reproducible: numeric seeds drive
// a pure mulberry32 PRNG, operation generation simulates per-actor causal
// views, and deliveries are shuffled topological orders of the encoded causes.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyTextOp, canonicalTextOp, createTextState, materializeText,
  restoreTextCheckpoint, textCheckpoint,
} from '../build/annotated-text.mjs';
import { insertText, deleteText } from '../public/workbench-text-edit.mjs';

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const C = 'c'.repeat(32);

const EMOJI = '😀';
const COMBINING = 'e\u0301';
const COMBINING_MARK = '\u0301';

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

function scalarOffsets(text) {
  const offsets = [0];
  for (const scalar of text) offsets.push(offsets[offsets.length - 1] + scalar.length);
  return offsets;
}

// Simulate three actors with independent causal views. Each generated op's
// dependencies are the producing actor's own frontier, so ops can be genuinely
// concurrent with one another. The master replica applies everything in
// generation order and is the convergence reference.
function generateHistory({ seed, steps }) {
  const rng = mulberry32(seed);
  const actors = [A, B, C];
  const replicas = new Map(actors.map((actor) => [actor, createTextState()]));
  const counts = new Map(actors.map((actor) => [actor, 0]));
  const ops = [];
  const pool = ['aa', 'b', 'cde', EMOJI, COMBINING, 'x', 'zq', `w${EMOJI}`];
  let lamport = 0;
  let master = createTextState();

  function publish(op, actor, forceAll) {
    master = applyTextOp(master, op);
    replicas.set(actor, applyTextOp(replicas.get(actor), op));
    for (const other of actors) {
      if (other === actor) continue;
      if (forceAll || rng() < 0.55) replicas.set(other, applyTextOp(replicas.get(other), op));
    }
  }

  function identity(actor) {
    counts.set(actor, counts.get(actor) + 1);
    return { actor, counter: counts.get(actor), lamport: ++lamport };
  }

  function produceInsert(actor, chunk) {
    const state = replicas.get(actor);
    const offsets = scalarOffsets(materializeText(state));
    const offset = offsets[Math.floor(rng() * offsets.length)];
    const op = insertText(state, identity(actor), offset, chunk);
    ops.push(op);
    return op;
  }

  function produceDelete(actor, startIdx, length) {
    const state = replicas.get(actor);
    const offsets = scalarOffsets(materializeText(state));
    const op = deleteText(state, identity(actor), offsets[startIdx], offsets[startIdx + length]);
    ops.push(op);
    return op;
  }

  // Scripted phase: guaranteed emoji and combining-mark insert + delete ops
  // from distinct actors, delivered to every replica.
  const opEmoji = insertText(replicas.get(A), identity(A), 0, EMOJI);
  ops.push(opEmoji);
  publish(opEmoji, A, true);

  const opComb = insertText(replicas.get(B), identity(B), 0, COMBINING);
  ops.push(opComb);
  publish(opComb, B, true);

  // All replicas now materialize 'e\u0301😀'; C deletes the emoji (2 UTF-16).
  const opDelEmoji = deleteText(replicas.get(C), identity(C), 2, 4);
  ops.push(opDelEmoji);
  publish(opDelEmoji, C, true);

  // A deletes the combining-mark run (2 UTF-16).
  const opDelComb = deleteText(replicas.get(A), identity(A), 0, 2);
  ops.push(opDelComb);
  publish(opDelComb, A, true);

  for (let i = 4; i < steps; i += 1) {
    const actor = actors[Math.floor(rng() * actors.length)];
    const text = materializeText(replicas.get(actor));
    let op;
    if (text.length > 0 && rng() < 0.45) {
      const offsets = scalarOffsets(text);
      const count = offsets.length - 1;
      const startIdx = Math.floor(rng() * count);
      const length = 1 + Math.floor(rng() * Math.min(4, count - startIdx));
      op = produceDelete(actor, startIdx, length);
    } else {
      op = produceInsert(actor, pool[Math.floor(rng() * pool.length)]);
    }
    publish(op, actor, false);
  }

  return { ops, master };
}

// Encode the causal DAG: op j depends on op i when j's dependency frontier
// already covers i's operation id.
function buildDependencies(ops) {
  const n = ops.length;
  const deps = new Array(n);
  for (let j = 0; j < n; j += 1) {
    const set = new Set();
    for (const [actor, counter] of ops[j][4]) {
      for (let i = 0; i < j; i += 1) {
        if (ops[i][2][0] === actor && ops[i][2][1] <= counter) set.add(i);
      }
    }
    deps[j] = [...set];
  }
  return deps;
}

function topologicalDelivery(ops, deps, seed) {
  const rng = mulberry32(seed);
  const n = ops.length;
  const indeg = deps.map((entry) => entry.length);
  const dependents = Array.from({ length: n }, () => []);
  deps.forEach((ds, j) => { for (const i of ds) dependents[i].push(j); });
  const order = [];
  const ready = [];
  for (let i = 0; i < n; i += 1) if (indeg[i] === 0) ready.push(i);
  while (ready.length > 0) {
    const i = ready.splice(Math.floor(rng() * ready.length), 1)[0];
    order.push(i);
    for (const j of dependents[i]) {
      indeg[j] -= 1;
      if (indeg[j] === 0) ready.push(j);
    }
  }
  assert.equal(order.length, n, 'topological order must cover every operation');
  return order.map((i) => ops[i]);
}

function deliverOrder(order) {
  return order.reduce(applyTextOp, createTextState());
}

test('seeded generation yields valid multi-actor ops covering emoji and combining-mark insert/delete', () => {
  for (const seed of [42, 7, 2024]) {
    const { ops, master } = generateHistory({ seed, steps: 60 });
    for (const op of ops) canonicalTextOp(op);

    const producers = new Set(ops.map((op) => op[2][0]));
    assert.ok(producers.size >= 3, `expected all three actors to produce ops`);

    const emojiInserts = ops.filter((op) => op[5][0] === 'insert' && op[5][2].includes(EMOJI));
    const combInserts = ops.filter((op) => op[5][0] === 'insert' && op[5][2].includes(COMBINING_MARK));
    assert.ok(emojiInserts.length >= 1, 'history must insert an emoji');
    assert.ok(combInserts.length >= 1, 'history must insert a combining mark');
    assert.notEqual(
      emojiInserts[0][2][0], combInserts[0][2][0],
      'emoji and combining inserts should come from different actors',
    );

    const elements = textCheckpoint(master).elements;
    const emojiDeleted = Object.values(elements).some((el) => el.scalar === EMOJI && el.deletedBy.length > 0);
    const combDeleted = Object.values(elements).some((el) => el.scalar === COMBINING_MARK && el.deletedBy.length > 0);
    assert.equal(emojiDeleted, true, 'history must delete an emoji scalar');
    assert.equal(combDeleted, true, 'history must delete a combining-mark scalar');
    assert.ok(ops.some((op) => op[5][0] === 'delete'), 'history must include delete operations');
  }
});

test('replicas converge on identical canonical checkpoints and text across shuffled topological deliveries', () => {
  for (const seed of [42, 7, 2024, 1337]) {
    const { ops, master } = generateHistory({ seed, steps: 60 });
    const expectedText = materializeText(master);
    const expectedCheckpoint = JSON.stringify(textCheckpoint(master));
    const deps = buildDependencies(ops);
    const orders = [];
    for (const shuffleSeed of [101, 202, 303, 404]) {
      const order = topologicalDelivery(ops, deps, shuffleSeed);
      const replica = deliverOrder(order);
      orders.push(order.map((op) => op[2].join(':')).join(','));
      assert.equal(materializeText(replica), expectedText, `seed ${seed} text mismatch`);
      assert.equal(JSON.stringify(textCheckpoint(replica)), expectedCheckpoint, `seed ${seed} checkpoint mismatch`);
    }
    assert.ok(new Set(orders).size >= 2, 'shuffle seeds should produce distinct topological orders');
  }
});

test('intermediate checkpoint cuts restore exact canonical state and converge to the same final checkpoint', () => {
  const { ops, master } = generateHistory({ seed: 42, steps: 60 });
  const deps = buildDependencies(ops);
  const n = ops.length;
  const rng = mulberry32(999);
  const cuts = [];
  while (cuts.length < 4) {
    const cut = 1 + Math.floor(rng() * (n - 2));
    if (!cuts.includes(cut)) cuts.push(cut);
  }

  for (const cut of cuts) {
    const directPrefix = ops.slice(0, cut).reduce(applyTextOp, createTextState());
    const prefixCheckpoint = textCheckpoint(directPrefix);
    const restored = restoreTextCheckpoint(prefixCheckpoint);
    assert.equal(JSON.stringify(textCheckpoint(restored)), JSON.stringify(prefixCheckpoint), 'restore must not change the prefix');
    assert.equal(materializeText(restored), materializeText(directPrefix));

    const finalized = ops.slice(cut).reduce(applyTextOp, restored);
    assert.equal(materializeText(finalized), materializeText(master), 'restored prefix must finish equal');
    assert.equal(JSON.stringify(textCheckpoint(finalized)), JSON.stringify(textCheckpoint(master)));

    // This is a different, but still valid, causal delivery order. The already
    // restored prefix is safely re-delivered as duplicates along the way.
    const shuffled = topologicalDelivery(ops, deps, cut + 1);
    const reordered = shuffled.reduce(applyTextOp, restored);
    assert.equal(JSON.stringify(textCheckpoint(reordered)), JSON.stringify(textCheckpoint(master)));
  }
});

test('duplicate delivery is idempotent and never disturbs the canonical convergent state', () => {
  const { ops, master } = generateHistory({ seed: 7, steps: 60 });
  const deps = buildDependencies(ops);
  const order = topologicalDelivery(ops, deps, 555);

  // A repeated dependent operation stays one pending entry before its causes
  // arrive, then resolves normally when the complete valid history is delivered.
  const dependent = ops.find((op) => op[4].length > 0);
  let pendingReplica = applyTextOp(createTextState(), dependent);
  const pendingOnce = JSON.stringify(textCheckpoint(pendingReplica));
  pendingReplica = applyTextOp(pendingReplica, dependent);
  assert.equal(JSON.stringify(textCheckpoint(pendingReplica)), pendingOnce, 'duplicate pending op must be idempotent');
  pendingReplica = order.reduce(applyTextOp, pendingReplica);
  assert.equal(JSON.stringify(textCheckpoint(pendingReplica)), JSON.stringify(textCheckpoint(master)));

  let replica = deliverOrder(order);
  const once = JSON.stringify(textCheckpoint(replica));
  for (const op of ops) replica = applyTextOp(replica, op);
  assert.equal(JSON.stringify(textCheckpoint(replica)), once, 're-delivering ops must be idempotent');
  assert.equal(materializeText(replica), materializeText(master));

  const reordered = topologicalDelivery(ops, deps, 777);
  for (const op of reordered) replica = applyTextOp(replica, op);
  assert.equal(JSON.stringify(textCheckpoint(replica)), once);
});


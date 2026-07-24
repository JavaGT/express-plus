import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyTextOp, assertAnchor, assertFrontier, assertOpId, assertStructuralPoint,
  assertTextOp, assertUtf16Offset, assertUtf16Range, assertWellFormedText,
  canonicalTextOp, compareInsertOrder, compareOpId, frontierDominates,
} from '../src/annotated-text.mjs';

const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ROOT = ['root'];
const frontier = [[A, 1]];
const insert = (op = [A, 2], lamport = 2, text = 'x') => ['workbench.text', 1, op, lamport, frontier, ['insert', ROOT, text]];

test('operation identity is fixed-width, positive, and canonically ordered', () => {
  assert.deepEqual(assertOpId([A, 1]), [A, 1]);
  assert.throws(() => assertOpId(['A', 1]), /32 lowercase/);
  assert.throws(() => assertOpId([A, 0]), /positive/);
  assert.ok(compareOpId([A, 2], [B, 1]) < 0);
});

test('frontiers are sorted, unique contiguous-counter summaries', () => {
  assert.deepEqual(assertFrontier([[A, 1], [B, 4]]), [[A, 1], [B, 4]]);
  assert.throws(() => assertFrontier([[B, 1], [A, 1]]), /sorted/);
  assert.throws(() => assertFrontier([[A, 0]]), /positive/);
  assert.equal(frontierDominates([[A, 2], [B, 1]], [[A, 1]]), true);
  assert.equal(frontierDominates([[A, 1]], [[A, 1], [B, 1]]), false);
});

test('UTF-16 accepts scalar edges and rejects only a surrogate-pair interior', () => {
  const text = 'a😀b';
  assert.equal(assertUtf16Offset(text, 0), 0);
  assert.equal(assertUtf16Offset(text, 1), 1);
  assert.throws(() => assertUtf16Offset(text, 2), /splits/);
  assert.equal(assertUtf16Offset(text, 3), 3);
  assert.deepEqual(assertUtf16Range(text, 1, 3), [1, 3]);
  assert.throws(() => assertWellFormedText('a\uD800'), /unpaired/);
  assert.throws(() => assertUtf16Range('abc', 2, 1), /reversed/);
});

test('anchors name immutable scalar identities, not numeric positions', () => {
  assert.deepEqual(assertAnchor(ROOT), ROOT);
  assert.deepEqual(assertAnchor(['element', [[A, 1], 0]]), ['element', [[A, 1], 0]]);
  assert.throws(() => assertAnchor(['element', [[A, 0], 0]]), /positive/);
});

test('insert operation grammar validates identity, local causality, and text', () => {
  assert.deepEqual(assertTextOp(insert()), insert());
  assert.throws(() => assertTextOp(['workbench.text', 1, [A, 2], 2, [], ['insert', ROOT, 'x']]), /previous local counter/);
  assert.throws(() => assertTextOp(insert([A, 2], 2, '')), /cannot be empty/);
  assert.throws(() => assertTextOp(insert([A, 2], 2, '\uD800')), /unpaired/);
});

test('delete spans are exact, sorted observed targets and cannot overlap', () => {
  const observed = [[A, 2]];
  const op = ['workbench.text', 1, [B, 1], 1, observed, ['delete', [[[A, 1], 0, 2], [[A, 2], 0, 1]]]];
  assert.deepEqual(assertTextOp(op), op);
  const overlap = ['workbench.text', 1, [B, 1], 1, observed, ['delete', [[[A, 1], 0, 2], [[A, 1], 1, 1]]]];
  assert.throws(() => assertTextOp(overlap), /sorted, disjoint/);
  const unseen = ['workbench.text', 1, [B, 1], 1, [], ['delete', [[[A, 1], 0, 1]]]];
  assert.throws(() => assertTextOp(unseen), /not observed/);
});

test('insert anchor must be an observed element and never its own new element', () => {
  const unseen = ['workbench.text', 1, [B, 1], 1, [], ['insert', ['element', [[A, 1], 0]], 'x']];
  assert.throws(() => assertTextOp(unseen), /not observed/);
  const self = ['workbench.text', 1, [A, 2], 2, frontier, ['insert', ['element', [[A, 2], 0]], 'x']];
  assert.throws(() => assertTextOp(self), /not observed/);
});

test('canonical operation encoding rejects permissive representations', () => {
  assert.deepEqual(canonicalTextOp(insert()), insert());
  const unsorted = ['workbench.text', 1, [A, 2], 2, [[B, 1], [A, 1]], ['insert', ROOT, 'x']];
  assert.throws(() => canonicalTextOp(unsorted), /sorted/);
  const extra = insert();
  extra.extra = true;
  assert.throws(() => canonicalTextOp(extra), /extra property/);
  const root = ['root'];
  root.extra = true;
  assert.throws(() => assertAnchor(root), /extra property/);
});

test('concurrent child order is deterministic: Lamport then operation identity', () => {
  const left = insert([A, 2], 2, 'x');
  const later = insert([B, 1], 3, 'y');
  const tie = insert([B, 1], 2, 'z');
  assert.ok(compareInsertOrder(later, left) < 0);
  assert.ok(compareInsertOrder(tie, left) < 0);
});

test('structural points retain a stable anchor and affinity', () => {
  assert.deepEqual(assertStructuralPoint(['point', ROOT, 'left']), ['point', ROOT, 'left']);
  assert.throws(() => assertStructuralPoint(['point', ROOT, 'middle']), /affinity/);
});

test('T1 does not silently start T2 reduction', () => {
  assert.throws(() => applyTextOp(), /not implemented: T2/);
});

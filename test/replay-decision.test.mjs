import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decideReplay, normalizeSeqSpan } from '../src/replay-decision.mjs';

test('normalizeSeqSpan treats a single seq as a one-wide span', () => {
  assert.deepEqual(normalizeSeqSpan(5), [5, 5]);
  assert.deepEqual(normalizeSeqSpan([3, 7]), [3, 7]);
});

test('decideReplay: next advances cursor to span hi', () => {
  assert.deepEqual(decideReplay(0, 1), { kind: 'next', cursor: 1 });
  assert.deepEqual(decideReplay(0, [1, 1]), { kind: 'next', cursor: 1 });
  assert.deepEqual(decideReplay(4, [5, 8]), { kind: 'next', cursor: 8 });
  // Overlapping span that covers expected still advances to hi
  assert.deepEqual(decideReplay(4, [3, 6]), { kind: 'next', cursor: 6 });
});

test('decideReplay: duplicate when span ends before expected', () => {
  assert.deepEqual(decideReplay(5, 3), { kind: 'duplicate' });
  assert.deepEqual(decideReplay(5, [1, 5]), { kind: 'duplicate' });
  assert.deepEqual(decideReplay(0, 0), { kind: 'duplicate' });
});

test('decideReplay: gap when span starts after expected', () => {
  assert.deepEqual(decideReplay(0, 2), { kind: 'gap' });
  assert.deepEqual(decideReplay(5, [7, 9]), { kind: 'gap' });
});

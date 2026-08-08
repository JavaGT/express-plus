import { test } from 'node:test';
import assert from 'node:assert/strict';

import { canUndoField, undoableFieldKinds } from '../src/field-laws.mjs';

test('canUndoField returns true for invertible kinds', () => {
  assert.equal(canUndoField('value'), true);
  assert.equal(canUndoField('crdt'), false, 'text CRDT compensation needs a newly authored operation');
  assert.equal(canUndoField('store'), true);
  assert.equal(canUndoField('ordered'), true);
  assert.equal(canUndoField('struct'), true);
  assert.equal(canUndoField('state'), true);
});

test('canUndoField returns false for non-invertible kinds', () => {
  assert.equal(canUndoField('hash'), false, 'hash cannot be inverted back to plaintext');
  assert.equal(canUndoField('crdt'), false, 'generic history cannot invert immutable text operations');
  assert.equal(canUndoField('computed'), false, 'derived field has no undo');
  assert.equal(canUndoField('projected'), false, 'derived field has no undo');
});

test('undoableFieldKinds lists only invertible kinds', () => {
  const kinds = undoableFieldKinds();
  assert.ok(kinds.includes('value'));
  assert.ok(!kinds.includes('crdt'), 'crdt is not invertible, so generic undo is unavailable');
  assert.ok(kinds.includes('store'));
  assert.ok(kinds.includes('ordered'));
  assert.ok(kinds.includes('struct'));
  assert.ok(kinds.includes('state'));
  assert.ok(!kinds.includes('hash'));
  assert.ok(!kinds.includes('computed'));
  assert.ok(!kinds.includes('projected'));
});

test('canUndoField throws for unknown kind (fail-closed)', () => {
  assert.throws(
    () => canUndoField('imaginary'),
    /unknown field kind/,
  );
});

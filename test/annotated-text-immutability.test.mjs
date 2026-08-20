// Immutability contract for the reducer after the copy-on-write refactor.
//
// applyTextOp now shallow-copies the registries and SHARES deeply-immutable
// element objects across states (cloneState). These tests pin the invariants
// that make that sharing sound:
//  - applying never mutates (aliases) the prior state or anything reachable;
//  - produced elements/op/deletedBy and registry entries are frozen;
//  - a delete copy-on-writes rather than pushing into a shared deletedBy array.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyTextOp, createTextState, materializeText } from '../build/annotated-text.mjs';

const A = 'a'.repeat(32);
const ROOT = ['root'];

test('applyTextOp preserves the prior state on insert (no aliasing)', () => {
  const base = applyTextOp(createTextState(), ['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'ab']]);
  const baseText = materializeText(base);
  const next = applyTextOp(base, ['workbench.text', 1, [A, 2], 3, [[A, 1]], ['insert', ['element', [[A, 1], 0]], 'x']]);
  assert.equal(materializeText(base), baseText, 'prior state text changed after applying to a successor');
  assert.equal(materializeText(next), 'axb');
});

test('produced elements, op arrays, deletedBy arrays, and registry entries are frozen', () => {
  const state = applyTextOp(createTextState(), ['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'ab']]);
  assert.equal(Object.isFrozen(state), true);
  for (const [key, element] of Object.entries(state.elements)) {
    assert.equal(Object.isFrozen(element), true, `element ${key} not frozen`);
    assert.equal(Object.isFrozen(element.op), true, `element ${key} op not frozen`);
    assert.equal(Object.isFrozen(element.deletedBy), true, `element ${key} deletedBy not frozen`);
  }
  for (const entry of Object.values(state.operations)) {
    assert.equal(Object.isFrozen(entry), true, 'operation registry entry not frozen');
  }
});

test('a delete copies-on-write instead of mutating the shared element', () => {
  const first = ['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'ab']];
  const remove = ['workbench.text', 1, [A, 2], 3, [[A, 1]], ['delete', [[[A, 1], 0, 1]]]];
  const base = applyTextOp(createTextState(), first);
  const key = `${A}:1:0`;
  const baseElement = base.elements[key];
  const next = applyTextOp(base, remove);
  // The prior state keeps the SAME untouched frozen element.
  assert.equal(base.elements[key], baseElement, 'prior element was replaced/aliased');
  assert.deepEqual(baseElement.deletedBy, [], 'prior element deletedBy mutated');
  // The successor points at a NEW frozen element carrying the delete tag.
  assert.notEqual(next.elements[key], baseElement, 'delete did not copy-on-write');
  assert.deepEqual(next.elements[key].deletedBy, [`${A}:2`]);
  // Prior text is unaffected by the delete applied only to the successor.
  assert.equal(materializeText(base), 'ab');
  assert.equal(materializeText(next), 'b');
});

test('stacked pending deletes accumulate on the draft element, not the shared one', () => {
  const first = ['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abcdef']];
  const base = applyTextOp(createTextState(), first);
  // Two delete ops arriving as pending (different actors) then drained
  // together must each replace the draft element, reading the latest copy.
  const del1 = ['workbench.text', 1, [A, 2], 4, [[A, 1]], ['delete', [[[A, 1], 0, 1]]]];
  const del2 = ['workbench.text', 1, [A, 3], 5, [[A, 2]], ['delete', [[[A, 1], 0, 1]]]];
  const s1 = applyTextOp(base, del1);
  const s2 = applyTextOp(s1, del2);
  const key = `${A}:1:0`;
  assert.deepEqual(s2.elements[key].deletedBy, [`${A}:2`, `${A}:3`]);
  assert.deepEqual(base.elements[key].deletedBy, [], 'prior element mutated by stacked deletes');
  assert.equal(materializeText(base), 'abcdef');
});

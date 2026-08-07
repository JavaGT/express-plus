import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createTextState, textCheckpoint } from '../src/annotated-text.mjs';
import {
  createTextFamily,
  materializeText,
  resolveOffsetToEndpoint,
  textOperationForOffsetEdit,
  applyTextOperation,
  projectEndpointToOffset,
} from '../src/annotated-text-continuous.mjs';
import {
  assertAnnotationRange,
  projectRangeToOffsets,
  rangeText,
  rangeWidth,
  rangeIsEmpty,
  rangeContainsOffset,
  rangesIntersect,
  emptyPolicy,
  protectorIsActive,
} from '../src/annotated-text-ranges.mjs';
import { assertAnnotation } from '../src/annotated-text-membership.mjs';

function actorFor(index) {
  return (index + 1).toString(16).padStart(32, '0');
}

function seed(family, text) {
  for (let i = 0; i < text.length; i += 1) {
    const op = textOperationForOffsetEdit(family, { kind: 'text.insert', at: { offset: i, affinity: 'right' }, text: text[i] }, actorFor(i), 1);
    family = applyTextOperation(family, op);
  }
  return family;
}

let editCounter = 1000;
function editActor() {
  return actorFor(editCounter++);
}

function familyWith(text) {
  return seed(createTextFamily('d1', textCheckpoint(createTextState())), text);
}

function rangeAt(family, from, to, annotationId = 'a1') {
  const start = resolveOffsetToEndpoint(family, from, family.checkpoint.frontier, 'right');
  const end = resolveOffsetToEndpoint(family, to, family.checkpoint.frontier, 'right');
  return assertAnnotationRange(family, { annotationId, start, end });
}

const COMMENT = assertAnnotation({ id: 'a1', family: 'comment', empty: 'orphan' });
const SENSITIVE = assertAnnotation({ id: 'a2', family: 'sensitive', empty: 'delete' });

test('ranges project to absolute offsets and materialize their text', () => {
  const family = familyWith('hello brave world');
  const range = rangeAt(family, 6, 11, 'a1');
  assert.deepEqual(projectRangeToOffsets(family, range), { start: 6, end: 11 });
  assert.equal(rangeText(family, range), 'brave');
  assert.equal(rangeWidth(family, range), 5);
});

test('ranges survive surrounding edits via historical endpoints', () => {
  let family = familyWith('hello brave world');
  const range = rangeAt(family, 6, 11, 'a1');
  const insert = textOperationForOffsetEdit(family, { kind: 'text.insert', at: { offset: 0, affinity: 'right' }, text: '^' }, editActor(), 2);
  family = applyTextOperation(family, insert);
  assert.equal(materializeText(family), '^hello brave world');
  assert.deepEqual(projectRangeToOffsets(family, range), { start: 7, end: 12 });
  assert.equal(rangeText(family, range), 'brave');
});

test('rangeIsEmpty detects a range emptied by deletion', () => {
  let family = familyWith('hello brave world');
  const range = rangeAt(family, 6, 11, 'a1');
  assert.equal(rangeIsEmpty(family, range), false);
  const del = textOperationForOffsetEdit(family, { kind: 'text.delete', from: { offset: 6, affinity: 'left' }, to: { offset: 11, affinity: 'right' } }, editActor(), 2);
  family = applyTextOperation(family, del);
  assert.equal(rangeIsEmpty(family, range), true);
});

test('emptyPolicy follows the annotation declaration', () => {
  assert.equal(emptyPolicy(COMMENT), 'orphan');
  assert.equal(emptyPolicy(SENSITIVE), 'delete');
});

test('rangeContainsOffset answers absolute-offset membership', () => {
  const family = familyWith('hello brave world');
  const range = rangeAt(family, 6, 11, 'a1');
  assert.equal(rangeContainsOffset(family, range, 6), true);
  assert.equal(rangeContainsOffset(family, range, 10), true);
  assert.equal(rangeContainsOffset(family, range, 11), false);
  assert.equal(rangeContainsOffset(family, range, 5), false);
});

test('rangesIntersect detects overlap (protector activation)', () => {
  const family = familyWith('abcdefghijkl');
  const left = rangeAt(family, 2, 6, 'protector');
  const overlapping = rangeAt(family, 4, 8, 'target');
  const disjoint = rangeAt(family, 8, 12, 'other');
  assert.equal(rangesIntersect(family, left, overlapping), true);
  assert.equal(rangesIntersect(family, left, disjoint), false);
});

test('protectorIsActive requires an intersection with a protected target range', () => {
  const family = familyWith('abcdefghijkl');
  const protector = rangeAt(family, 2, 6, 'protector');
  const targetOverlap = rangeAt(family, 4, 8, 'target1');
  const targetDisjoint = rangeAt(family, 8, 12, 'target2');
  assert.equal(protectorIsActive(family, protector, [targetOverlap]), true);
  assert.equal(protectorIsActive(family, protector, [targetDisjoint]), false);
  assert.equal(protectorIsActive(family, protector, [targetOverlap, targetDisjoint]), true);
});

test('protectorIsActive treats a whole-document range as covering everything', () => {
  const family = familyWith('hello');
  const whole = rangeAt(family, 0, 5, 'protector');
  const target = rangeAt(family, 1, 2, 'target');
  assert.equal(protectorIsActive(family, whole, [target]), true);
});

test('assertAnnotationRange rejects start after end and unknown keys', () => {
  const family = familyWith('hello');
  const start = resolveOffsetToEndpoint(family, 2, family.checkpoint.frontier, 'right');
  const end = resolveOffsetToEndpoint(family, 1, family.checkpoint.frontier, 'right');
  assert.throws(() => assertAnnotationRange(family, { annotationId: 'a', start, end }), /start must not be after end/);
  assert.throws(() => assertAnnotationRange(family, { annotationId: 'a', start, end, extra: 1 }), /unknown key/);
});

test('a zero-width range is accepted and reported empty', () => {
  const family = familyWith('hello');
  const point = resolveOffsetToEndpoint(family, 3, family.checkpoint.frontier, 'right');
  const range = assertAnnotationRange(family, { annotationId: 'a', start: point, end: point });
  assert.equal(rangeWidth(family, range), 0);
  assert.equal(rangeIsEmpty(family, range), true);
});

test('a zero-width orphan range stays zero-width when text is re-inserted at its exact boundary', () => {
  let family = familyWith('hello world');
  const range = rangeAt(family, 5, 11, 'a1'); // ' world'
  const del = textOperationForOffsetEdit(family, { kind: 'text.delete', from: { offset: 5, affinity: 'left' }, to: { offset: 11, affinity: 'right' } }, editActor(), 2);
  family = applyTextOperation(family, del);
  assert.equal(rangeIsEmpty(family, range), true);
  // Re-insert at the orphan's position. With historical-basis endpoints the new
  // elements are not part of the orphan's basis, so they do NOT join the range.
  // OPEN QUESTION (issue #33): affinity-aware boundary inclusion is required for
  // the 'orphan' policy to actually re-open at an exact boundary; until then the
  // conservative behavior (range stays zero-width) is the safe default.
  const insert = textOperationForOffsetEdit(family, { kind: 'text.insert', at: { offset: 5, affinity: 'right' }, text: 'XY' }, editActor(), 3);
  family = applyTextOperation(family, insert);
  assert.equal(materializeText(family), 'helloXY');
  assert.equal(rangeText(family, range), '');
  assert.equal(rangeIsEmpty(family, range), true);
  void projectEndpointToOffset;
});

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
  rangeText,
  projectRangeToOffsets,
} from '../src/annotated-text-ranges.mjs';

function actorFor(index) {
  return (index + 1).toString(16).padStart(32, '0');
}

function seed(family, text) {
  let offset = 0;
  for (const char of text) {
    const op = textOperationForOffsetEdit(family, { kind: 'text.insert', at: { offset, affinity: 'right' }, text: char }, actorFor(offset), 1);
    family = applyTextOperation(family, op);
    offset += char.length;
  }
  return family;
}

let editCounter = 1000;
function editActor() {
  return actorFor(editCounter++);
}

test('astral characters keep UTF-16 offset semantics: A😀B', () => {
  // '😀' is a surrogate pair (2 UTF-16 code units): A(0) 😀(1-2) B(3).
  const family = seed(createTextFamily('d1', textCheckpoint(createTextState())), 'A😀B');
  assert.equal(materializeText(family), 'A😀B');

  const s0 = resolveOffsetToEndpoint(family, 0, family.checkpoint.frontier, 'right');
  const s1 = resolveOffsetToEndpoint(family, 1, family.checkpoint.frontier, 'right');
  const s3 = resolveOffsetToEndpoint(family, 3, family.checkpoint.frontier, 'right');
  const s4 = resolveOffsetToEndpoint(family, 4, family.checkpoint.frontier, 'right');
  assert.equal(projectEndpointToOffset(family, s0), 0);
  assert.equal(projectEndpointToOffset(family, s1), 1);
  assert.equal(projectEndpointToOffset(family, s3), 3);
  assert.equal(projectEndpointToOffset(family, s4), 4);
});

test('a range covering exactly one astral scalar materializes it', () => {
  const family = seed(createTextFamily('d1', textCheckpoint(createTextState())), 'A😀B');
  const start = resolveOffsetToEndpoint(family, 1, family.checkpoint.frontier, 'right');
  const end = resolveOffsetToEndpoint(family, 3, family.checkpoint.frontier, 'right');
  const range = assertAnnotationRange(family, { annotationId: 'a', start, end });
  assert.equal(rangeText(family, range), '😀');
  assert.deepEqual(projectRangeToOffsets(family, range), { start: 1, end: 3 });
});

test('insert before and after an astral scalar lands on the right side', () => {
  let family = seed(createTextFamily('d1', textCheckpoint(createTextState())), 'A😀B');
  // Insert 'X' at offset 1 (before 😀, which occupies 1..2).
  const before = textOperationForOffsetEdit(family, { kind: 'text.insert', at: { offset: 1, affinity: 'right' }, text: 'X' }, editActor(), 2);
  family = applyTextOperation(family, before);
  assert.equal(materializeText(family), 'AX😀B');
  // Insert 'Y' at offset 4 (after 😀, before B) — in 'AX😀B', 😀 occupies 2..3.
  const after = textOperationForOffsetEdit(family, { kind: 'text.insert', at: { offset: 4, affinity: 'right' }, text: 'Y' }, editActor(), 3);
  family = applyTextOperation(family, after);
  assert.equal(materializeText(family), 'AX😀YB');
});

test('delete the astral scalar and a BMP neighbor resolves correctly', () => {
  let family = seed(createTextFamily('d1', textCheckpoint(createTextState())), 'A😀B');
  // Delete 😀 (offsets 1..3).
  const del = textOperationForOffsetEdit(family, { kind: 'text.delete', from: { offset: 1, affinity: 'left' }, to: { offset: 3, affinity: 'right' } }, editActor(), 2);
  family = applyTextOperation(family, del);
  assert.equal(materializeText(family), 'AB');
});

test('a range whose astral content is tombstoned reports empty and stays projectable', () => {
  let family = seed(createTextFamily('d1', textCheckpoint(createTextState())), 'A😀B');
  const range = assertAnnotationRange(family, {
    annotationId: 'a',
    start: resolveOffsetToEndpoint(family, 1, family.checkpoint.frontier, 'right'),
    end: resolveOffsetToEndpoint(family, 3, family.checkpoint.frontier, 'right'),
  });
  const del = textOperationForOffsetEdit(family, { kind: 'text.delete', from: { offset: 1, affinity: 'left' }, to: { offset: 3, affinity: 'right' } }, editActor(), 2);
  family = applyTextOperation(family, del);
  assert.equal(materializeText(family), 'AB');
  assert.equal(rangeText(family, range), '');
  assert.deepEqual(projectRangeToOffsets(family, range), { start: 1, end: 1 });
});

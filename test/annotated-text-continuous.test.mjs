import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createTextState,
  applyTextOp,
  textCheckpoint,
} from '../src/annotated-text.mjs';
import {
  createTextFamily,
  materializeText,
  resolveOffsetToEndpoint,
  projectEndpointToOffset,
  textOperationForOffsetEdit,
  applyTextOperation,
  materializeRange,
  compareStructuralEndpoints,
  textFamilyCheckpoint,
} from '../src/annotated-text-continuous.mjs';

function actorFor(index) {
  return (index + 1).toString(16).padStart(32, '0');
}

function seedViaPlanner(family, text) {
  for (let i = 0; i < text.length; i += 1) {
    const op = textOperationForOffsetEdit(family, { kind: 'text.insert', at: { offset: i, affinity: 'right' }, text: text[i] }, actorFor(i), 1);
    family = applyTextOperation(family, op);
  }
  return family;
}

// The real flow mints a UNIQUE actor per offset edit ([actor, 1]). Mirrors that.
let editCounter = 1000;
function editActor() {
  return actorFor(editCounter++);
}

test('blockless family materializes one continuous document text', () => {
  const family = seedViaPlanner(createTextFamily('d1', textCheckpoint(createTextState())), 'hello world');
  assert.equal(materializeText(family), 'hello world');
  assert.deepEqual(textFamilyCheckpoint(family).checkpoint.frontier, family.checkpoint.frontier);
});

test('absolute-offset insert and delete plan + apply against the whole document', () => {
  let family = seedViaPlanner(createTextFamily('d1', textCheckpoint(createTextState())), 'hello world');
  const insert = textOperationForOffsetEdit(family, { kind: 'text.insert', at: { offset: 5, affinity: 'right' }, text: 'X' }, editActor(), 2);
  family = applyTextOperation(family, insert);
  assert.equal(materializeText(family), 'helloX world');

  const del = textOperationForOffsetEdit(family, { kind: 'text.delete', from: { offset: 5, affinity: 'left' }, to: { offset: 6, affinity: 'right' } }, editActor(), 2);
  family = applyTextOperation(family, del);
  assert.equal(materializeText(family), 'hello world');
});

test('stored endpoint stays valid when the current frontier dominates its basis (historical-basis projection)', () => {
  let family = seedViaPlanner(createTextFamily('d1', textCheckpoint(createTextState())), 'hello world');
  // Capture an endpoint at the current frontier: position 5 (' ').
  const endpoint = resolveOffsetToEndpoint(family, 5, family.checkpoint.frontier, 'right');

  // Insert LATER in the document — the new frontier dominates the endpoint's basis.
  const lateInsert = textOperationForOffsetEdit(family, { kind: 'text.insert', at: { offset: 11, affinity: 'right' }, text: '!!' }, editActor(), 2);
  family = applyTextOperation(family, lateInsert);
  assert.equal(materializeText(family), 'hello world!!');
  // The old endpoint must still project to the same offset (insert was after it).
  assert.equal(projectEndpointToOffset(family, endpoint), 5);

  // Insert BEFORE the endpoint — it must now project one char later.
  const earlyInsert = textOperationForOffsetEdit(family, { kind: 'text.insert', at: { offset: 0, affinity: 'right' }, text: '^' }, editActor(), 2);
  family = applyTextOperation(family, earlyInsert);
  assert.equal(materializeText(family), '^hello world!!');
  assert.equal(projectEndpointToOffset(family, endpoint), 6);
});

test('an endpoint whose anchor is tombstoned still projects (tombstoned anchors stay addressable)', () => {
  let family = seedViaPlanner(createTextFamily('d1', textCheckpoint(createTextState())), 'hello world');
  const endpoint = resolveOffsetToEndpoint(family, 5, family.checkpoint.frontier, 'right');
  // Delete the whole document up to the endpoint: the anchor element is tombstoned.
  const del = textOperationForOffsetEdit(family, { kind: 'text.delete', from: { offset: 0, affinity: 'left' }, to: { offset: 5, affinity: 'left' } }, editActor(), 2);
  family = applyTextOperation(family, del);
  assert.equal(materializeText(family), ' world');
  // The endpoint's anchor is now a tombstone but must still resolve.
  assert.equal(projectEndpointToOffset(family, endpoint), 0);
});

test('range stability: materializeRange follows the endpoint across surrounding edits', () => {
  let family = seedViaPlanner(createTextFamily('d1', textCheckpoint(createTextState())), 'hello brave world');
  const start = resolveOffsetToEndpoint(family, 6, family.checkpoint.frontier, 'right'); // 'b'
  const end = resolveOffsetToEndpoint(family, 11, family.checkpoint.frontier, 'right'); // after 'brave'
  assert.equal(materializeRange(family, start, end), 'brave');

  // Insert inside the range.
  const inside = textOperationForOffsetEdit(family, { kind: 'text.insert', at: { offset: 8, affinity: 'right' }, text: 'X' }, editActor(), 2);
  family = applyTextOperation(family, inside);
  assert.equal(materializeRange(family, start, end), 'brXave');

  // Delete a prefix; the range shifts but stays intact.
  const prefixDel = textOperationForOffsetEdit(family, { kind: 'text.delete', from: { offset: 0, affinity: 'left' }, to: { offset: 2, affinity: 'left' } }, editActor(), 2);
  family = applyTextOperation(family, prefixDel);
  assert.equal(materializeText(family), 'llo brXave world');
  assert.equal(materializeRange(family, start, end), 'brXave');
});

test('boundary affinity decides whether a later insertion joins the range', () => {
  let family = seedViaPlanner(createTextFamily('d1', textCheckpoint(createTextState())), 'hello world');
  const start = resolveOffsetToEndpoint(family, 5, family.checkpoint.frontier, 'right');
  const end = resolveOffsetToEndpoint(family, 11, family.checkpoint.frontier, 'right');
  assert.equal(materializeRange(family, start, end), ' world');

  // A later insert at the boundary anchors as a sibling ordered before the
  // range's known elements. The range is defined over its HISTORICAL basis, so
  // the insert does NOT join it — the range does not silently grow. (Conservative:
  // extending the annotation is an explicit user action, not a boundary-typed char.)
  const rightInsert = textOperationForOffsetEdit(family, { kind: 'text.insert', at: { offset: 5, affinity: 'right' }, text: '[' }, editActor(), 2);
  family = applyTextOperation(family, rightInsert);
  assert.equal(materializeText(family), 'hello[ world');
  assert.equal(materializeRange(family, start, end), ' world');

  // An insert INSIDE the range (mid-range offset, not a boundary) does join it.
  const inside = textOperationForOffsetEdit(family, { kind: 'text.insert', at: { offset: 7, affinity: 'right' }, text: 'X' }, editActor(), 3);
  family = applyTextOperation(family, inside);
  assert.equal(materializeRange(family, start, end), ' Xworld');
});

test('full-range deletion yields a zero-width range (empty lifecycle)', () => {
  let family = seedViaPlanner(createTextFamily('d1', textCheckpoint(createTextState())), 'hello world');
  const start = resolveOffsetToEndpoint(family, 6, family.checkpoint.frontier, 'right');
  const end = resolveOffsetToEndpoint(family, 11, family.checkpoint.frontier, 'right');
  const del = textOperationForOffsetEdit(family, { kind: 'text.delete', from: { offset: 6, affinity: 'left' }, to: { offset: 11, affinity: 'right' } }, editActor(), 2);
  family = applyTextOperation(family, del);
  assert.equal(materializeText(family), 'hello ');
  assert.equal(materializeRange(family, start, end), '');
  // compareStructuralEndpoints tolerates a zero-width range (start === end is allowed).
  assert.ok(compareStructuralEndpoints(family, start, end) <= 0);
});

test('document start and end resolve to root / last-visible anchors', () => {
  const family = seedViaPlanner(createTextFamily('d1', textCheckpoint(createTextState())), 'abc');
  const start = resolveOffsetToEndpoint(family, 0, family.checkpoint.frontier, 'right');
  const end = resolveOffsetToEndpoint(family, 3, family.checkpoint.frontier, 'right');
  assert.equal(projectEndpointToOffset(family, start), 0);
  assert.equal(projectEndpointToOffset(family, end), 3);
  assert.equal(materializeRange(family, start, end), 'abc');
});

test('empty document: offset 0 resolves and materializes as empty', () => {
  const family = createTextFamily('d1', textCheckpoint(createTextState()));
  assert.equal(materializeText(family), '');
  const start = resolveOffsetToEndpoint(family, 0, family.checkpoint.frontier, 'left');
  const end = resolveOffsetToEndpoint(family, 0, family.checkpoint.frontier, 'right');
  assert.equal(materializeRange(family, start, end), '');
});

test('inserting into an empty document uses the root anchor', () => {
  const family = createTextFamily('d1', textCheckpoint(createTextState()));
  const op = textOperationForOffsetEdit(family, { kind: 'text.insert', at: { offset: 0, affinity: 'right' }, text: 'hi' }, editActor(), 2);
  const next = applyTextOperation(family, op);
  assert.equal(materializeText(next), 'hi');
  assert.ok(op[5][1][0] === 'root', 'empty-document insert anchors at root');
});

test('an endpoint whose frontier is NOT dominated by the current family fails closed', () => {
  const family = seedViaPlanner(createTextFamily('d1', textCheckpoint(createTextState())), 'abc');
  // A later edit by another actor that the current frontier does NOT dominate.
  let divergent = createTextState();
  divergent = applyTextOp(divergent, ['workbench.text', 1, [editActor(), 1], 1, divergent.frontier, ['insert', ['root'], 'z']]);
  const endpoint = resolveOffsetToEndpoint(family, 1, family.checkpoint.frontier, 'right');
  const divergentFamily = createTextFamily('d1', textCheckpoint(divergent));
  assert.throws(() => projectEndpointToOffset(divergentFamily, endpoint), /does not dominate/);
});

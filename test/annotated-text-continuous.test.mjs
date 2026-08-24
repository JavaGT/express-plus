import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createTextState,
  applyTextOp,
  textCheckpoint,
} from '../build/annotated-text.mjs';
import {
  createTextFamily,
  materializeText,
  resolveOffsetToEndpoint,
  insertAnchorForOffset,
  projectEndpointToOffset,
  textOperationForOffsetEdit,
  applyTextOperation,
  materializeRange,
  compareStructuralEndpoints,
  compactTextFamilyCheckpoint,
  restoreTextFamily,
  restoreTextFamilySerialized,
  serializeCompactTextFamilyCheckpoint,
  textFamilyCheckpoint,
  textFamilyVisibleLength,
} from '../build/annotated-text-continuous.mjs';

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

test('compact durable family checkpoint derives identical state without persisting element topology', () => {
  const text = 'A moderately sized transcript. '.repeat(100);
  const insert = ['workbench.text', 1, [actorFor(9000), 1], 1, [], ['insert', ['root'], text]];
  const family = createTextFamily('d1', textCheckpoint(applyTextOp(createTextState(), insert)));
  const compact = compactTextFamilyCheckpoint(family);

  assert.equal(compact.checkpoint.version, 2);
  assert.equal(Object.hasOwn(compact.checkpoint, 'elements'), false);
  assert.equal(materializeText(restoreTextFamily(compact)), text);
  assert.deepEqual(restoreTextFamily(compact).checkpoint.frontier, family.checkpoint.frontier);
  assert.ok(JSON.stringify(compact).length < JSON.stringify(textFamilyCheckpoint(family)).length / 10);
});

test('serialized restore caches only exact validated bytes and exported reducers reject untrusted lookalikes', () => {
  const family = seedViaPlanner(createTextFamily('trusted', textCheckpoint(createTextState())), 'abc');
  const serialized = JSON.stringify(compactTextFamilyCheckpoint(family));
  const first = restoreTextFamilySerialized(serialized);
  const second = restoreTextFamilySerialized(serialized);
  assert.equal(second, first, 'identical durable bytes reuse one immutable validated family');
  assert.notEqual(restoreTextFamilySerialized(JSON.stringify({ ...JSON.parse(serialized), id: 'other' })), first);
  assert.equal(
    restoreTextFamilySerialized(serializeCompactTextFamilyCheckpoint(family)),
    family,
    'persisting a trusted next state seeds the exact-byte cache without replay',
  );

  const lookalike = structuredClone(textFamilyCheckpoint(family));
  assert.throws(() => materializeText(lookalike), /family must be created or restored by this module/);
  assert.throws(() => applyTextOperation(lookalike, null), /family must be created or restored by this module/);
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

test('cached visible length stays equal to materialized text across edits', () => {
  let family = seedViaPlanner(createTextFamily('lengths', textCheckpoint(createTextState())), 'abcdef');
  const assertLength = () => assert.equal(textFamilyVisibleLength(family), materializeText(family).length);
  assertLength();

  family = applyTextOperation(family, textOperationForOffsetEdit(
    family, { kind: 'text.insert', at: { offset: 3, affinity: 'right' }, text: 'XYZ' }, editActor(), 2,
  ));
  assertLength();
  family = applyTextOperation(family, textOperationForOffsetEdit(
    family, { kind: 'text.delete', from: { offset: 1, affinity: 'left' }, to: { offset: 3, affinity: 'right' } }, editActor(), 2,
  ));
  assertLength();
  family = applyTextOperation(family, textOperationForOffsetEdit(
    family, { kind: 'text.insert', at: { offset: 2, affinity: 'right' }, text: 'splice' }, editActor(), 2,
  ));
  assertLength();
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

  // A later insert at the start boundary (right affinity) becomes the anchor's
  // child ordered right after it, and the boundary `[o, right]` is defined as
  // AFTER the anchor's own scalar (before its children), so the insert JOINS
  // the range — matching the block-era boundary-grow behavior.
  const rightInsert = textOperationForOffsetEdit(family, { kind: 'text.insert', at: { offset: 5, affinity: 'right' }, text: '[' }, editActor(), 2);
  family = applyTextOperation(family, rightInsert);
  assert.equal(materializeText(family), 'hello[ world');
  assert.equal(materializeRange(family, start, end), '[ world');

  // An insert INSIDE the range joins it too ('hello[ world' -> X before 'world').
  const inside = textOperationForOffsetEdit(family, { kind: 'text.insert', at: { offset: 7, affinity: 'right' }, text: 'X' }, editActor(), 3);
  family = applyTextOperation(family, inside);
  assert.equal(materializeText(family), 'hello[ Xworld');
  assert.equal(materializeRange(family, start, end), '[ Xworld');
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

// ---------------------------------------------------------------------------
// resolveOffsetToEndpoint basis-frontier equality (#125). The check must accept
// any frontier structurally equal to the checkpoint's (same actors, counters,
// order-independent entry identity) and reject every unequal one — without
// depending on serialization or reference identity.
// ---------------------------------------------------------------------------

function cloneFrontierEntry([actor, counter]) {
  return [actor, counter];
}

test('resolve accepts a structurally equal but distinct basis frontier', () => {
  const family = seedViaPlanner(createTextFamily('d1', textCheckpoint(createTextState())), 'abcdef');
  // Fresh inner/outer arrays in sorted order: structurally identical to the
  // checkpoint frontier while sharing no reference, so the equality check
  // cannot lean on identity or serialization.
  const copy = family.checkpoint.frontier.map(cloneFrontierEntry);
  assert.notEqual(copy, family.checkpoint.frontier);
  for (const affinity of ['left', 'right']) {
    const fromCopy = resolveOffsetToEndpoint(family, 2, copy, affinity);
    const fromSame = resolveOffsetToEndpoint(family, 2, family.checkpoint.frontier, affinity);
    assert.deepEqual(fromCopy, fromSame);
  }
});

test('resolve rejects frontiers that differ in any actor counter, membership, or length', () => {
  const family = seedViaPlanner(createTextFamily('d1', textCheckpoint(createTextState())), 'abcdef');
  const frontier = family.checkpoint.frontier;
  assert.ok(frontier.length >= 1, 'seeded frontier is non-empty');

  const bumped = frontier.map(cloneFrontierEntry);
  bumped[0] = [bumped[0][0], bumped[0][1] + 1];
  assert.throws(() => resolveOffsetToEndpoint(family, 1, bumped, 'right'), /basisFrontier equal to family checkpoint frontier/, 'counter mismatch fails');

  const missingActor = frontier.slice(0, -1);
  if (missingActor.length > 0) {
    assert.throws(() => resolveOffsetToEndpoint(family, 1, missingActor, 'right'), /basisFrontier equal/, 'missing actor fails');
  }

  const extraActor = [...frontier.map(cloneFrontierEntry), [actorFor(7777), 1]].sort(([a], [b]) => (a < b ? -1 : 1));
  assert.throws(() => resolveOffsetToEndpoint(family, 1, extraActor, 'right'), /basisFrontier equal/, 'extra actor fails');

  const swapped = frontier.map(cloneFrontierEntry);
  swapped[0] = [actorFor(8888), swapped[0][1]];
  assert.throws(() => resolveOffsetToEndpoint(family, 1, swapped, 'right'), /basisFrontier equal/, 'unknown actor fails');
});

// ---------------------------------------------------------------------------
// insertAnchorForOffset semantics (#127). The anchor is a pure function of the
// offset: the last visible element whose scalar ends at or contains it. These
// tests pin the boundary behavior the derived-index binary search must
// reproduce exactly — including across tombstone runs, where offsets jump but
// ownership does not move.
// ---------------------------------------------------------------------------

test('insert anchors at exact element boundaries resolve to the element BEFORE the boundary', () => {
  let family = seedViaPlanner(createTextFamily('anchors', textCheckpoint(createTextState())), 'abcdef');
  const anchorFor = (op) => textOperationForOffsetEdit(family, { kind: 'text.insert', at: { offset: op, affinity: 'right' }, text: 'X' }, editActor(), 2)[5][1];

  assert.deepEqual(anchorFor(0), ['root'], 'offset 0 inserts as a root child');
  for (let offset = 1; offset <= 'abcdef'.length; offset += 1) {
    const [kind, identity] = anchorFor(offset);
    assert.equal(kind, 'element', `boundary ${offset} anchors at an element`);
    assert.deepEqual(identity[0], [actorFor(offset - 1), 1], `boundary ${offset} is owned by element ${offset - 1}`);
    assert.equal(identity[1], 0);
  }
  // The end of the document anchors to its last element.
  const tailAnchor = textOperationForOffsetEdit(family, { kind: 'text.insert', at: { offset: 'abcdef'.length, affinity: 'right' }, text: '!' }, editActor(), 2);
  family = applyTextOperation(family, tailAnchor);
  assert.equal(materializeText(family), 'abcdef!');
});

test('insert anchors skip tombstone runs and stay stable across deletion', () => {
  let family = seedViaPlanner(createTextFamily('anchors', textCheckpoint(createTextState())), 'abcdefgh');
  // Delete "cde" (offsets 2..5) leaving tombstones between b and f.
  family = applyTextOperation(family, textOperationForOffsetEdit(
    family, { kind: 'text.delete', from: { offset: 2 }, to: { offset: 5 } }, editActor(), 2,
  ));
  assert.equal(materializeText(family), 'abfgh');

  // Offset 2 now names the boundary before 'f'. Ownership does not move onto
  // the tombstones: the visible element BEFORE the boundary (b) keeps it.
  const insertOp = textOperationForOffsetEdit(family, { kind: 'text.insert', at: { offset: 2, affinity: 'right' }, text: 'X' }, editActor(), 3);
  assert.deepEqual(insertOp[5][1], ['element', [[actorFor(1), 1], 0]], 'b, not a tombstone or f, owns the boundary');
  family = applyTextOperation(family, insertOp);
  assert.equal(materializeText(family), 'abXfgh', 'the anchored insert lands exactly at the requested offset');
});

test('insert anchors reject zero, past-the-end, and NaN offsets', () => {
  const family = seedViaPlanner(createTextFamily('anchors', textCheckpoint(createTextState())), 'abc');
  assert.throws(() => insertAnchorForOffset(family, 0), /failed to resolve insert anchor/);
  assert.throws(() => insertAnchorForOffset(family, 4), /failed to resolve insert anchor/, 'past the visible end fails');
  assert.throws(() => insertAnchorForOffset(family, Number.NaN), /failed to resolve insert anchor/);
});

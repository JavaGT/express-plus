import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyTextOp, createTextState, textCheckpoint,
} from '../src/annotated-text.mjs';
import {
  createTextFamily, materializeBlock, assertStructuralEndpoint,
  compareStructuralEndpoints, projectEndpointToBlockOffset,
  resolvePositionToEndpoint, assertMembershipRange, splitBlock,
} from '../src/annotated-text-family.mjs';

const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ROOT = ['root'];

const C = 'cccccccccccccccccccccccccccccccc';

function applyAll(state, ops) {
  return ops.reduce(applyTextOp, state);
}

function makeFamily(ops, blockId = 'block1') {
  const state = applyAll(createTextState(), ops);
  const cp = textCheckpoint(state);
  return createTextFamily('doc1', cp, blockId);
}

// =============================================
// Root semantics
// =============================================

test('root-left resolves to offset 0', () => {
  const family = makeFamily([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']]]);
  const ep = assertStructuralEndpoint({ point: ['point', ['root'], 'left'], basisFrontier: family.checkpoint.frontier });
  assert.equal(projectEndpointToBlockOffset(family, 'block1', ep), 0);
});

test('root-right also resolves to offset 0 (start cut, not end)', () => {
  const family = makeFamily([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']]]);
  const ep = assertStructuralEndpoint({ point: ['point', ['root'], 'right'], basisFrontier: family.checkpoint.frontier });
  assert.equal(projectEndpointToBlockOffset(family, 'block1', ep), 0);
});

test('root-left and root-right both project to zero', () => {
  const family = makeFamily([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']]]);
  const left = assertStructuralEndpoint({ point: ['point', ['root'], 'left'], basisFrontier: family.checkpoint.frontier });
  const right = assertStructuralEndpoint({ point: ['point', ['root'], 'right'], basisFrontier: family.checkpoint.frontier });
  assert.equal(projectEndpointToBlockOffset(family, 'block1', left), 0);
  assert.equal(projectEndpointToBlockOffset(family, 'block1', right), 0);
  assert.ok(compareStructuralEndpoints(family, left, right) < 0);
});

test('block end uses final owned scalar right-point, not root-right', () => {
  const family = makeFamily([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']]]);
  const ep = resolvePositionToEndpoint(family, 'block1', 3, family.checkpoint.frontier);
  assert.equal(projectEndpointToBlockOffset(family, 'block1', ep), 3);
  const anchor = ep.point[1];
  assert.equal(anchor[0], 'element');
  assert.equal(anchor[1][1], 2);
  assert.equal(ep.point[2], 'right');
});

// =============================================
// Marker semantics
// =============================================

test('left affinity stays before children', () => {
  const first = ['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'a']];
  const child = ['workbench.text', 1, [A, 2], 2, [[A, 1]], ['insert', ['element', [[A, 1], 0]], 'x']];
  const family = makeFamily([first, child]);
  const epLeft = assertStructuralEndpoint({
    point: ['point', ['element', [[A, 1], 0]], 'left'],
    basisFrontier: family.checkpoint.frontier,
  });
  const epRight = assertStructuralEndpoint({
    point: ['point', ['element', [[A, 1], 0]], 'right'],
    basisFrontier: family.checkpoint.frontier,
  });
  assert.equal(materializeBlock(family, 'block1'), 'ax');
  assert.equal(projectEndpointToBlockOffset(family, 'block1', epLeft), 1);
  assert.equal(projectEndpointToBlockOffset(family, 'block1', epRight), 1);
  assert.ok(compareStructuralEndpoints(family, epLeft, epRight) < 0);
});

test('left and right coincide when element has no basis-observed children', () => {
  const family = makeFamily([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'a']]]);
  const epLeft = assertStructuralEndpoint({
    point: ['point', ['element', [[A, 1], 0]], 'left'],
    basisFrontier: family.checkpoint.frontier,
  });
  const epRight = assertStructuralEndpoint({
    point: ['point', ['element', [[A, 1], 0]], 'right'],
    basisFrontier: family.checkpoint.frontier,
  });
  assert.equal(projectEndpointToBlockOffset(family, 'block1', epLeft), 1);
  assert.equal(projectEndpointToBlockOffset(family, 'block1', epRight), 1);
});

// =============================================
// Tombstone semantics
// =============================================

test('tombstoned element remains valid anchor', () => {
  const first = ['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']];
  const del = ['workbench.text', 1, [A, 2], 2, [[A, 1]], ['delete', [[[A, 1], 1, 1]]]];
  const family = makeFamily([first, del]);
  assertStructuralEndpoint({
    point: ['point', ['element', [[A, 1], 1]], 'left'],
    basisFrontier: family.checkpoint.frontier,
  });
  assert.equal(materializeBlock(family, 'block1'), 'ac');
});

test('tombstoned element maintains structural ordering', () => {
  const first = ['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']];
  const del = ['workbench.text', 1, [A, 2], 2, [[A, 1]], ['delete', [[[A, 1], 1, 1]]]];
  const family = makeFamily([first, del]);
  const bLeft = assertStructuralEndpoint({
    point: ['point', ['element', [[A, 1], 1]], 'left'],
    basisFrontier: family.checkpoint.frontier,
  });
  const cLeft = assertStructuralEndpoint({
    point: ['point', ['element', [[A, 1], 2]], 'left'],
    basisFrontier: family.checkpoint.frontier,
  });
  assert.ok(compareStructuralEndpoints(family, bLeft, cLeft) < 0);
  assert.equal(projectEndpointToBlockOffset(family, 'block1', bLeft), 1);
  assert.equal(projectEndpointToBlockOffset(family, 'block1', cLeft), 2);
});

test('block-end with trailing tombstone uses final owned scalar right marker, not root', () => {
  const first = ['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']];
  const del = ['workbench.text', 1, [A, 2], 2, [[A, 1]], ['delete', [[[A, 1], 2, 1]]]];
  const family = makeFamily([first, del]);
  const ep = resolvePositionToEndpoint(family, 'block1', 2, family.checkpoint.frontier);
  assert.equal(projectEndpointToBlockOffset(family, 'block1', ep), 2);
  assert.equal(ep.point[1][0], 'element');
  assert.equal(ep.point[2], 'right');
});

test('all-tombstone block offset 0 is ambiguous and rejected', () => {
  const first = ['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'a']];
  const del = ['workbench.text', 1, [A, 2], 2, [[A, 1]], ['delete', [[[A, 1], 0, 1]]]];
  const family = makeFamily([first, del]);
  assert.throws(() => {
    resolvePositionToEndpoint(family, 'block1', 0, family.checkpoint.frontier);
  }, /ambiguous/);
});

// =============================================
// Endpoint comparison and ordering
// =============================================

test('endpoints are structurally comparable and ordered', () => {
  const family = makeFamily([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']]]);
  const rootLeft = assertStructuralEndpoint({ point: ['point', ['root'], 'left'], basisFrontier: family.checkpoint.frontier });
  const rootRight = assertStructuralEndpoint({ point: ['point', ['root'], 'right'], basisFrontier: family.checkpoint.frontier });
  const aLeft = assertStructuralEndpoint({ point: ['point', ['element', [[A, 1], 0]], 'left'], basisFrontier: family.checkpoint.frontier });
  const bLeft = assertStructuralEndpoint({ point: ['point', ['element', [[A, 1], 1]], 'left'], basisFrontier: family.checkpoint.frontier });
  const cLeft = assertStructuralEndpoint({ point: ['point', ['element', [[A, 1], 2]], 'left'], basisFrontier: family.checkpoint.frontier });
  const cRight = assertStructuralEndpoint({ point: ['point', ['element', [[A, 1], 2]], 'right'], basisFrontier: family.checkpoint.frontier });
  assert.ok(compareStructuralEndpoints(family, rootLeft, rootRight) < 0);
  assert.ok(compareStructuralEndpoints(family, rootRight, aLeft) < 0);
  assert.ok(compareStructuralEndpoints(family, aLeft, bLeft) < 0);
  assert.ok(compareStructuralEndpoints(family, bLeft, cLeft) < 0);
  assert.ok(compareStructuralEndpoints(family, cLeft, cRight) < 0);
  assert.equal(compareStructuralEndpoints(family, aLeft, aLeft), 0);
});

test('equal endpoints compare as zero', () => {
  const family = makeFamily([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']]]);
  const ep1 = assertStructuralEndpoint({ point: ['point', ['root'], 'left'], basisFrontier: family.checkpoint.frontier });
  const ep2 = assertStructuralEndpoint({ point: ['point', ['root'], 'left'], basisFrontier: family.checkpoint.frontier });
  assert.equal(compareStructuralEndpoints(family, ep1, ep2), 0);
});

// =============================================
// Stale / foreign basis rejection
// =============================================

test('compareStructuralEndpoints rejects different basis frontiers', () => {
  const family = makeFamily([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']]]);
  const unknownFrontier = [['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 1]];
  assert.throws(() => {
    compareStructuralEndpoints(family,
      assertStructuralEndpoint({ point: ['point', ['root'], 'left'], basisFrontier: unknownFrontier }),
      assertStructuralEndpoint({ point: ['point', ['root'], 'left'], basisFrontier: family.checkpoint.frontier }),
    );
  }, /basis mismatch/);
});

test('compareStructuralEndpoints rejects stale basis even if dominated', () => {
  const first = ['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']];
  const second = ['workbench.text', 1, [B, 1], 2, [[A, 1]], ['insert', ROOT, 'xyz']];
  const family = makeFamily([first, second]);
  const staleFrontier = [[A, 1]];
  assert.throws(() => {
    compareStructuralEndpoints(family,
      assertStructuralEndpoint({ point: ['point', ['root'], 'left'], basisFrontier: staleFrontier }),
      assertStructuralEndpoint({ point: ['point', ['root'], 'left'], basisFrontier: staleFrontier }),
    );
  }, /basis mismatch/);
});

test('resolvePositionToEndpoint rejects stale basis even if text same', () => {
  const first = ['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']];
  const second = ['workbench.text', 1, [B, 1], 2, [[A, 1]], ['insert', ROOT, 'xyz']];
  const family = makeFamily([first, second]);
  const staleFrontier = [[A, 1]];
  assert.throws(() => {
    resolvePositionToEndpoint(family, 'block1', 0, staleFrontier);
  }, /equal to family checkpoint frontier/);
});

test('projectEndpointToBlockOffset rejects foreign endpoint', () => {
  const family = makeFamily([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']]]);
  const foreignEp = assertStructuralEndpoint({
    point: ['point', ['element', [[A, 1], 1]], 'left'],
    basisFrontier: family.checkpoint.frontier,
  });
  const cp2 = [['workbench.text', 1, [B, 1], 1, [], ['insert', ROOT, 'xyz']]];
  const state2 = applyAll(createTextState(), cp2);
  const checkpoint2 = textCheckpoint(state2);
  const family2 = createTextFamily('doc2', checkpoint2, 'block1');
  assert.throws(() => {
    projectEndpointToBlockOffset(family2, 'block1', foreignEp);
  }, /equal to family checkpoint frontier/);
});

// =============================================
// First/non-first boundary
// =============================================

test('root-left is valid start boundary for first block', () => {
  const family = makeFamily([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']]]);
  const start = assertStructuralEndpoint({ point: ['point', ['root'], 'left'], basisFrontier: family.checkpoint.frontier });
  const end = assertStructuralEndpoint({ point: ['point', ['element', [[A, 1], 2]], 'right'], basisFrontier: family.checkpoint.frontier });
  const range = assertMembershipRange(family, 'block1', start, end);
  assert.equal(range.blockId, 'block1');
  assert.deepEqual(range.start, start);
  assert.deepEqual(range.end, end);
});

test('second block start uses predecessor right-point, not root-left', () => {
  const cp = [['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abcdef']]];
  const state = applyAll(createTextState(), cp);
  const checkpoint = textCheckpoint(state);
  const family = createTextFamily('doc1', checkpoint, 'block1');
  const split = splitBlock(family, 'block1', 'block2', 3);
  const ep0 = resolvePositionToEndpoint(split, 'block2', 0, split.checkpoint.frontier);
  const anchor = ep0.point[1];
  assert.equal(anchor[0], 'element');
  assert.equal(ep0.point[2], 'right');
  assert.equal(projectEndpointToBlockOffset(split, 'block2', ep0), 0);
  assert.equal(materializeBlock(split, 'block2'), 'def');
});

test('start from prior adjacent block element is valid for membership', () => {
  const cp = [['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abcdef']]];
  const state = applyAll(createTextState(), cp);
  const checkpoint = textCheckpoint(state);
  const family = createTextFamily('doc1', checkpoint, 'block1');
  const split = splitBlock(family, 'block1', 'block2', 3);
  const start = assertStructuralEndpoint({
    point: ['point', ['element', [[A, 1], 2]], 'right'],
    basisFrontier: split.checkpoint.frontier,
  });
  const end = assertStructuralEndpoint({
    point: ['point', ['element', [[A, 1], 5]], 'right'],
    basisFrontier: split.checkpoint.frontier,
  });
  const range = assertMembershipRange(split, 'block2', start, end);
  assert.equal(range.blockId, 'block2');
  assert.equal(materializeBlock(split, 'block2'), 'def');
});

// =============================================
// Invalid membership rejection
// =============================================

test('cross-block range is rejected', () => {
  const cp = [['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abcdef']]];
  const state = applyAll(createTextState(), cp);
  const checkpoint = textCheckpoint(state);
  const family = createTextFamily('doc1', checkpoint, 'block1');
  const split = splitBlock(family, 'block1', 'block2', 3);
  const start = assertStructuralEndpoint({
    point: ['point', ['element', [[A, 1], 0]], 'left'],
    basisFrontier: split.checkpoint.frontier,
  });
  assert.throws(() => assertMembershipRange(split, 'block2', start, start), /end anchor must be owned/);
});

test('reversed range is rejected', () => {
  const family = makeFamily([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']]]);
  const start = assertStructuralEndpoint({ point: ['point', ['element', [[A, 1], 2]], 'right'], basisFrontier: family.checkpoint.frontier });
  const end = assertStructuralEndpoint({ point: ['point', ['element', [[A, 1], 0]], 'left'], basisFrontier: family.checkpoint.frontier });
  assert.throws(() => assertMembershipRange(family, 'block1', start, end), /canonical block end/);
});

test('zero-width range is rejected', () => {
  const family = makeFamily([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']]]);
  const ep = assertStructuralEndpoint({ point: ['point', ['element', [[A, 1], 2]], 'right'], basisFrontier: family.checkpoint.frontier });
  assert.throws(() => assertMembershipRange(family, 'block1', ep, ep), /not the canonical lower boundary/);
});

test('tombstone-only range is rejected', () => {
  const first = ['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'a']];
  const del = ['workbench.text', 1, [A, 2], 2, [[A, 1]], ['delete', [[[A, 1], 0, 1]]]];
  const family = makeFamily([first, del]);
  const start = assertStructuralEndpoint({ point: ['point', ['root'], 'left'], basisFrontier: family.checkpoint.frontier });
  const end = assertStructuralEndpoint({ point: ['point', ['element', [[A, 1], 0]], 'right'], basisFrontier: family.checkpoint.frontier });
  assert.throws(() => assertMembershipRange(family, 'block1', start, end), /visible/);
});

test('end anchor must be owned by named block', () => {
  const cp = [['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abcdef']]];
  const state = applyAll(createTextState(), cp);
  const checkpoint = textCheckpoint(state);
  const family = createTextFamily('doc1', checkpoint, 'block1');
  const split = splitBlock(family, 'block1', 'block2', 3);
  const start = assertStructuralEndpoint({ point: ['point', ['root'], 'left'], basisFrontier: split.checkpoint.frontier });
  const end = assertStructuralEndpoint({
    point: ['point', ['element', [[A, 1], 0]], 'left'],
    basisFrontier: split.checkpoint.frontier,
  });
  assert.throws(() => assertMembershipRange(split, 'block2', start, end), /end anchor must be owned/);
});

test('root-right start is rejected as membership range start', () => {
  const family = makeFamily([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']]]);
  const start = assertStructuralEndpoint({ point: ['point', ['root'], 'right'], basisFrontier: family.checkpoint.frontier });
  const end = assertStructuralEndpoint({ point: ['point', ['element', [[A, 1], 2]], 'right'], basisFrontier: family.checkpoint.frontier });
  assert.throws(() => assertMembershipRange(family, 'block1', start, end), /root start must have left affinity/);
});

test('membership range requires same basisFrontier on both endpoints', () => {
  const family = makeFamily([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']]]);
  const start = assertStructuralEndpoint({ point: ['point', ['root'], 'left'], basisFrontier: family.checkpoint.frontier });
  const laterFrontier = [[A, 1], [B, 1]];
  const end = assertStructuralEndpoint({ point: ['point', ['element', [[A, 1], 2]], 'left'], basisFrontier: laterFrontier });
  assert.throws(() => assertMembershipRange(family, 'block1', start, end), /same basisFrontier/);
});

test('membership range requires basisFrontier equal to family checkpoint frontier', () => {
  const first = ['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']];
  const second = ['workbench.text', 1, [B, 1], 2, [[A, 1]], ['insert', ROOT, 'xyz']];
  const family = makeFamily([first, second]);
  const staleFrontier = [[A, 1]];
  const start = assertStructuralEndpoint({ point: ['point', ['root'], 'left'], basisFrontier: staleFrontier });
  const end = assertStructuralEndpoint({ point: ['point', ['element', [[A, 1], 2]], 'left'], basisFrontier: staleFrontier });
  assert.throws(() => assertMembershipRange(family, 'block1', start, end), /equal to family checkpoint frontier/);
});

// =============================================
// Unicode projection
// =============================================

test('Unicode scalars project to correct offsets', () => {
  const family = makeFamily([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'a😀b']]]);
  const rootLeft = assertStructuralEndpoint({ point: ['point', ['root'], 'left'], basisFrontier: family.checkpoint.frontier });
  assert.equal(projectEndpointToBlockOffset(family, 'block1', rootLeft), 0);
  const aLeft = assertStructuralEndpoint({
    point: ['point', ['element', [[A, 1], 0]], 'left'],
    basisFrontier: family.checkpoint.frontier,
  });
  assert.equal(projectEndpointToBlockOffset(family, 'block1', aLeft), 1);
  const emojiLeft = assertStructuralEndpoint({
    point: ['point', ['element', [[A, 1], 1]], 'left'],
    basisFrontier: family.checkpoint.frontier,
  });
  assert.equal(projectEndpointToBlockOffset(family, 'block1', emojiLeft), 3);
  const bLeft = assertStructuralEndpoint({
    point: ['point', ['element', [[A, 1], 2]], 'left'],
    basisFrontier: family.checkpoint.frontier,
  });
  assert.equal(projectEndpointToBlockOffset(family, 'block1', bLeft), 4);
});

test('resolvePositionToEndpoint handles Unicode UTF-16 offsets', () => {
  const family = makeFamily([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'a😀b']]]);
  const ep0 = resolvePositionToEndpoint(family, 'block1', 0, family.checkpoint.frontier);
  assert.equal(projectEndpointToBlockOffset(family, 'block1', ep0), 0);
  const ep1 = resolvePositionToEndpoint(family, 'block1', 1, family.checkpoint.frontier);
  assert.equal(projectEndpointToBlockOffset(family, 'block1', ep1), 1);
  const ep3 = resolvePositionToEndpoint(family, 'block1', 3, family.checkpoint.frontier);
  assert.equal(projectEndpointToBlockOffset(family, 'block1', ep3), 3);
  const ep4 = resolvePositionToEndpoint(family, 'block1', 4, family.checkpoint.frontier);
  assert.equal(projectEndpointToBlockOffset(family, 'block1', ep4), 4);
});

// =============================================
// Endpoint validation
// =============================================

test('assertStructuralEndpoint rejects unknown keys', () => {
  const frontier = [[A, 1]];
  assert.throws(() => assertStructuralEndpoint({ point: ['point', ['root'], 'left'], basisFrontier: frontier, extra: true }), /unknown endpoint key/);
});

test('assertStructuralEndpoint rejects invalid point', () => {
  const frontier = [[A, 1]];
  assert.throws(() => assertStructuralEndpoint({ point: ['point', ['root'], 'middle'], basisFrontier: frontier }), /affinity/);
});

test('assertStructuralEndpoint rejects invalid basisFrontier', () => {
  assert.throws(() => assertStructuralEndpoint({ point: ['point', ['root'], 'left'], basisFrontier: null }), /frontier/);
});

// =============================================
// Multiple block resolution
// =============================================

test('resolvePositionToEndpoint on multi-block family', () => {
  const cp = [['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abcdef']]];
  const state = applyAll(createTextState(), cp);
  const checkpoint = textCheckpoint(state);
  const family = createTextFamily('doc1', checkpoint, 'block1');
  const split = splitBlock(family, 'block1', 'block2', 3);
  const ep0 = resolvePositionToEndpoint(split, 'block2', 0, split.checkpoint.frontier);
  assert.equal(projectEndpointToBlockOffset(split, 'block2', ep0), 0);
  const epRight = resolvePositionToEndpoint(split, 'block2', 3, split.checkpoint.frontier);
  assert.equal(projectEndpointToBlockOffset(split, 'block2', epRight), 3);
});

// =============================================
// Endpoint immutability
// =============================================

test('assertStructuralEndpoint returns frozen endpoint', () => {
  const frontier = [[A, 1]];
  const ep = assertStructuralEndpoint({ point: ['point', ['root'], 'left'], basisFrontier: frontier });
  assert.ok(Object.isFrozen(ep));
  assert.ok(Object.isFrozen(ep.point));
  assert.ok(Object.isFrozen(ep.basisFrontier));
  assert.throws(() => { ep.point = null; }, /Cannot assign/);
});

// =============================================
// Membership coverage by traversal
// =============================================

test('membership range covers owned elements including tombstones', () => {
  const first = ['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']];
  const del = ['workbench.text', 1, [A, 2], 2, [[A, 1]], ['delete', [[[A, 1], 1, 1]]]];
  const family = makeFamily([first, del]);
  const start = assertStructuralEndpoint({ point: ['point', ['root'], 'left'], basisFrontier: family.checkpoint.frontier });
  const end = assertStructuralEndpoint({ point: ['point', ['element', [[A, 1], 2]], 'right'], basisFrontier: family.checkpoint.frontier });
  const range = assertMembershipRange(family, 'block1', start, end);
  assert.equal(range.blockId, 'block1');
  assert.equal(materializeBlock(family, 'block1'), 'ac');
});

// =============================================
// Positive and negative membership laws
// =============================================

test('partial final-left end is rejected', () => {
  const family = makeFamily([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']]]);
  const start = assertStructuralEndpoint({ point: ['point', ['root'], 'left'], basisFrontier: family.checkpoint.frontier });
  const end = assertStructuralEndpoint({ point: ['point', ['element', [[A, 1], 2]], 'left'], basisFrontier: family.checkpoint.frontier });
  assert.throws(() => assertMembershipRange(family, 'block1', start, end), /canonical block end/);
});

test('earlier prior anchor (non-final) rejected in projectEndpointToBlockOffset', () => {
  const cp = [['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abcdef']]];
  const state = applyAll(createTextState(), cp);
  const checkpoint = textCheckpoint(state);
  const family = createTextFamily('doc1', checkpoint, 'block1');
  const split = splitBlock(family, 'block1', 'block2', 3);
  const ep = assertStructuralEndpoint({
    point: ['point', ['element', [[A, 1], 0]], 'right'],
    basisFrontier: split.checkpoint.frontier,
  });
  assert.throws(() => projectEndpointToBlockOffset(split, 'block2', ep), /must be its final owned element/);
});

test('prior-left rejected in projectEndpointToBlockOffset', () => {
  const cp = [['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abcdef']]];
  const state = applyAll(createTextState(), cp);
  const checkpoint = textCheckpoint(state);
  const family = createTextFamily('doc1', checkpoint, 'block1');
  const split = splitBlock(family, 'block1', 'block2', 3);
  const ep = assertStructuralEndpoint({
    point: ['point', ['element', [[A, 1], 2]], 'left'],
    basisFrontier: split.checkpoint.frontier,
  });
  assert.throws(() => projectEndpointToBlockOffset(split, 'block2', ep), /must have right affinity/);
});

test('exact predecessor-right start accepted for second block membership', () => {
  const cp = [['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abcdef']]];
  const state = applyAll(createTextState(), cp);
  const checkpoint = textCheckpoint(state);
  const family = createTextFamily('doc1', checkpoint, 'block1');
  const split = splitBlock(family, 'block1', 'block2', 3);
  const start = assertStructuralEndpoint({
    point: ['point', ['element', [[A, 1], 2]], 'right'],
    basisFrontier: split.checkpoint.frontier,
  });
  const end = assertStructuralEndpoint({
    point: ['point', ['element', [[A, 1], 5]], 'right'],
    basisFrontier: split.checkpoint.frontier,
  });
  const range = assertMembershipRange(split, 'block2', start, end);
  assert.equal(range.blockId, 'block2');
  assert.equal(materializeBlock(split, 'block2'), 'def');
});

test('exact predecessor-right with trailing tombstone accepted', () => {
  const first = ['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']];
  const del = ['workbench.text', 1, [A, 2], 2, [[A, 1]], ['delete', [[[A, 1], 1, 1]]]];
  const state = applyAll(createTextState(), [first, del]);
  const checkpoint = textCheckpoint(state);
  const family = createTextFamily('doc1', checkpoint, 'block1');
  const split = splitBlock(family, 'block1', 'block2', 1);
  const start = assertStructuralEndpoint({
    point: ['point', ['element', [[A, 1], 1]], 'right'],
    basisFrontier: split.checkpoint.frontier,
  });
  const end = assertStructuralEndpoint({
    point: ['point', ['element', [[A, 1], 2]], 'right'],
    basisFrontier: split.checkpoint.frontier,
  });
  const range = assertMembershipRange(split, 'block2', start, end);
  assert.equal(range.blockId, 'block2');
  assert.equal(materializeBlock(split, 'block2'), 'c');
});

test('root-right start rejected for membership', () => {
  const family = makeFamily([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']]]);
  const start = assertStructuralEndpoint({ point: ['point', ['root'], 'right'], basisFrontier: family.checkpoint.frontier });
  const end = assertStructuralEndpoint({ point: ['point', ['element', [[A, 1], 2]], 'right'], basisFrontier: family.checkpoint.frontier });
  assert.throws(() => assertMembershipRange(family, 'block1', start, end), /root start must have left affinity/);
});

test('owned non-lower-boundary start rejected', () => {
  const family = makeFamily([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']]]);
  const start = assertStructuralEndpoint({ point: ['point', ['element', [[A, 1], 0]], 'left'], basisFrontier: family.checkpoint.frontier });
  const end = assertStructuralEndpoint({ point: ['point', ['element', [[A, 1], 2]], 'right'], basisFrontier: family.checkpoint.frontier });
  assert.throws(() => assertMembershipRange(family, 'block1', start, end), /start anchor owned by named block is not the canonical lower boundary/);
});

test('concurrent siblings ordered by Lamport then op ID', () => {
  const first = ['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'a']];
  const left = ['workbench.text', 1, [A, 2], 2, [[A, 1]], ['insert', ['element', [[A, 1], 0]], 'x']];
  const right = ['workbench.text', 1, [B, 1], 2, [[A, 1]], ['insert', ['element', [[A, 1], 0]], 'y']];
  const later = ['workbench.text', 1, [C, 1], 3, [[A, 2], [B, 1]], ['insert', ['element', [[A, 1], 0]], 'z']];
  const family = makeFamily([first, left, right, later]);
  assert.equal(materializeBlock(family, 'block1'), 'azyx');
  const zLeft = assertStructuralEndpoint({
    point: ['point', ['element', [[C, 1], 0]], 'left'],
    basisFrontier: family.checkpoint.frontier,
  });
  const yLeft = assertStructuralEndpoint({
    point: ['point', ['element', [[B, 1], 0]], 'left'],
    basisFrontier: family.checkpoint.frontier,
  });
  const xLeft = assertStructuralEndpoint({
    point: ['point', ['element', [[A, 2], 0]], 'left'],
    basisFrontier: family.checkpoint.frontier,
  });
  assert.ok(compareStructuralEndpoints(family, zLeft, yLeft) < 0);
  assert.ok(compareStructuralEndpoints(family, yLeft, xLeft) < 0);
});
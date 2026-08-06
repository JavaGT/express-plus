import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyTextOp, createTextState, textCheckpoint,
} from '../src/annotated-text.mjs';
import {
  createTextFamily, materializeBlock, splitBlock, mergeBlocks, assertMembershipRange, assertStructuralEndpoint,
  resolvePositionToEndpoint, projectEndpointToBlockOffset,
} from '../src/annotated-text-family.mjs';
import {
  assertAnnotation, assertMembership, addMembership, removeMembership,
  splitBlockMemberships, mergeBlocksMemberships,
} from '../src/annotated-text-membership.mjs';

const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ROOT = ['root'];

function applyAll(state, ops) {
  return ops.reduce(applyTextOp, state);
}

function makeFamily(ops, blockId = 'block1') {
  const state = applyAll(createTextState(), ops);
  const cp = textCheckpoint(state);
  return createTextFamily('doc1', cp, blockId);
}

function sampleAnnotation(overrides = {}) {
  return assertAnnotation({
    id: 'ann1',
    family: 'test_family',
    empty: 'delete',
    ...overrides,
  });
}

// =============================================
// assertAnnotation
// =============================================

test('assertAnnotation valid delete', () => {
  const ann = assertAnnotation({ id: 'ann1', family: 'test', empty: 'delete' });
  assert.equal(ann.id, 'ann1');
  assert.equal(ann.family, 'test');
  assert.equal(ann.empty, 'delete');
  assert.equal(ann.protectedTargetIds, undefined);
  assert.ok(Object.isFrozen(ann));
});

test('assertAnnotation valid orphan', () => {
  const ann = assertAnnotation({ id: 'ann2', family: 'other', empty: 'orphan' });
  assert.equal(ann.empty, 'orphan');
});

test('assertAnnotation with protectedTargetIds', () => {
  const ann = assertAnnotation({ id: 'ann1', family: 'test', empty: 'delete', protectedTargetIds: ['target1', 'target2'] });
  assert.deepEqual(ann.protectedTargetIds, ['target1', 'target2']);
  assert.ok(Object.isFrozen(ann.protectedTargetIds));
});

test('assertAnnotation rejects invalid empty', () => {
  assert.throws(() => assertAnnotation({ id: 'a', family: 't', empty: 'invalid' }), /must be delete or orphan/);
});

test('assertAnnotation rejects non-sorted protectedTargetIds', () => {
  assert.throws(() => assertAnnotation({ id: 'a', family: 't', empty: 'delete', protectedTargetIds: ['b', 'a'] }), /sorted and unique/);
});

test('assertAnnotation rejects duplicate protectedTargetIds', () => {
  assert.throws(() => assertAnnotation({ id: 'a', family: 't', empty: 'delete', protectedTargetIds: ['a', 'a'] }), /sorted and unique/);
});

test('assertAnnotation rejects unknown keys', () => {
  assert.throws(() => assertAnnotation({ id: 'a', family: 't', empty: 'delete', extra: 'x' }), /unknown annotation key/);
});

test('assertAnnotation is deeply immutable', () => {
  const ann = assertAnnotation({ id: 'a', family: 't', empty: 'delete' });
  assert.throws(() => { ann.id = 'x'; }, /Cannot assign/);
});

// =============================================
// assertMembership
// =============================================

test('assertMembership valid', () => {
  const family = makeFamily([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']]]);
  const frontier = family.checkpoint.frontier;
  const start = assertStructuralEndpoint({ point: ['point', ['root'], 'left'], basisFrontier: frontier });
  const end = resolvePositionToEndpoint(family, 'block1', 3, frontier);
  const m = assertMembership({ annotationId: 'ann1', blockId: 'block1', ordinal: 0, start, end });
  assert.equal(m.annotationId, 'ann1');
  assert.equal(m.blockId, 'block1');
  assert.equal(m.ordinal, 0);
  assert.ok(Object.isFrozen(m));
  assert.ok(Object.isFrozen(m.start));
  assert.ok(Object.isFrozen(m.end));
});

test('assertMembership rejects unknown keys', () => {
  const family = makeFamily([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']]]);
  const frontier = family.checkpoint.frontier;
  const start = assertStructuralEndpoint({ point: ['point', ['root'], 'left'], basisFrontier: frontier });
  const end = resolvePositionToEndpoint(family, 'block1', 3, frontier);
  assert.throws(() => assertMembership({ annotationId: 'a', blockId: 'b', ordinal: 0, start, end, extra: 'x' }), /unknown membership key/);
});

// =============================================
// addMembership
// =============================================

test('addMembership adds valid membership', () => {
  const family = makeFamily([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']]]);
  const ann = sampleAnnotation();
  const result = addMembership(family, [ann], [], 'ann1', 'block1',
    assertStructuralEndpoint({ point: ['point', ['root'], 'left'], basisFrontier: family.checkpoint.frontier }),
    resolvePositionToEndpoint(family, 'block1', 3, family.checkpoint.frontier),
  );
  assert.equal(result.memberships.length, 1);
  assert.equal(result.memberships[0].annotationId, 'ann1');
  assert.equal(result.memberships[0].blockId, 'block1');
  assert.equal(result.memberships[0].ordinal, 0);
  assert.equal(result.outcomes.length, 0);
  assert.deepEqual(result.annotations, [ann]);
});

test('addMembership rejects duplicate annotationId+blockId', () => {
  const family = makeFamily([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']]]);
  const ann = sampleAnnotation();
  const frontier = family.checkpoint.frontier;
  const start = assertStructuralEndpoint({ point: ['point', ['root'], 'left'], basisFrontier: frontier });
  const end = resolvePositionToEndpoint(family, 'block1', 3, frontier);
  const first = addMembership(family, [ann], [], 'ann1', 'block1', start, end);
  assert.throws(() => addMembership(family, [ann], first.memberships, 'ann1', 'block1', start, end), /duplicate membership/);
});

test('addMembership rejects unknown annotation', () => {
  const family = makeFamily([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']]]);
  const frontier = family.checkpoint.frontier;
  assert.throws(() => addMembership(family, [], [], 'ann1', 'block1',
    assertStructuralEndpoint({ point: ['point', ['root'], 'left'], basisFrontier: frontier }),
    resolvePositionToEndpoint(family, 'block1', 3, frontier),
  ), /annotation not found/);
});

test('addMembership rejects unknown block', () => {
  const family = makeFamily([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']]]);
  const ann = sampleAnnotation();
  const frontier = family.checkpoint.frontier;
  assert.throws(() => addMembership(family, [ann], [], 'ann1', 'nonexistent',
    assertStructuralEndpoint({ point: ['point', ['root'], 'left'], basisFrontier: frontier }),
    resolvePositionToEndpoint(family, 'block1', 3, frontier),
  ), /block not found/);
});

test('addMembership rejects fully tombstoned block', () => {
  const first = ['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'a']];
  const del = ['workbench.text', 1, [A, 2], 2, [[A, 1]], ['delete', [[[A, 1], 0, 1]]]];
  const family = makeFamily([first, del]);
  const ann = sampleAnnotation();
  const frontier = family.checkpoint.frontier;
  assert.throws(() => addMembership(family, [ann], [], 'ann1', 'block1',
    assertStructuralEndpoint({ point: ['point', ['root'], 'left'], basisFrontier: frontier }),
    assertStructuralEndpoint({ point: ['point', ['element', [[A, 1], 0]], 'right'], basisFrontier: frontier }),
  ), /tombstoned/);
});

test('addMembership accepts a partial (sub-block) structural range', () => {
  const family = makeFamily([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']]]);
  const ann = sampleAnnotation();
  const frontier = family.checkpoint.frontier;
  const result = addMembership(family, [ann], [], 'ann1', 'block1',
    assertStructuralEndpoint({ point: ['point', ['root'], 'left'], basisFrontier: frontier }),
    resolvePositionToEndpoint(family, 'block1', 2, frontier),
  );
  assert.equal(result.memberships.length, 1);
  assert.equal(result.memberships[0].start.point[1][0], 'root');
  assert.equal(projectEndpointToBlockOffset(family, 'block1', result.memberships[0].end), 2);
});

test('addMembership accepts a mid-block range (not touching either boundary)', () => {
  const family = makeFamily([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abcdef']]]);
  const ann = sampleAnnotation();
  const frontier = family.checkpoint.frontier;
  const start = resolvePositionToEndpoint(family, 'block1', 1, frontier);
  const end = resolvePositionToEndpoint(family, 'block1', 4, frontier);
  const result = addMembership(family, [ann], [], 'ann1', 'block1', start, end);
  assert.equal(result.memberships.length, 1);
  assert.equal(projectEndpointToBlockOffset(family, 'block1', result.memberships[0].start), 1);
  assert.equal(projectEndpointToBlockOffset(family, 'block1', result.memberships[0].end), 4);
});

test('addMembership assigns ordinal dense by document block order', () => {
  const cp = [['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abcdef']]];
  const state = applyAll(createTextState(), cp);
  const checkpoint = textCheckpoint(state);
  const family = createTextFamily('doc1', checkpoint, 'block1');
  const split = splitBlock(family, 'block1', 'block2', 3).family;
  const ann = sampleAnnotation();
  const frontier = split.checkpoint.frontier;
  const s1 = resolvePositionToEndpoint(split, 'block1', 0, frontier);
  const e1 = resolvePositionToEndpoint(split, 'block1', 3, frontier);
  const s2 = resolvePositionToEndpoint(split, 'block2', 0, frontier);
  const e2 = resolvePositionToEndpoint(split, 'block2', 3, frontier);
  const r1 = addMembership(split, [ann], [], 'ann1', 'block2', s2, e2);
  const r2 = addMembership(split, [ann], r1.memberships, 'ann1', 'block1', s1, e1);
  assert.equal(r2.memberships.length, 2);
  const m1 = r2.memberships.find(m => m.blockId === 'block1');
  const m2 = r2.memberships.find(m => m.blockId === 'block2');
  assert.equal(m1.ordinal, 0);
  assert.equal(m2.ordinal, 1);
});

// =============================================
// removeMembership — non-last normalize
// =============================================

test('removeMembership non-last normalizes without outcome', () => {
  const cp = [['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abcdef']]];
  const state = applyAll(createTextState(), cp);
  const checkpoint = textCheckpoint(state);
  const family = createTextFamily('doc1', checkpoint, 'block1');
  const split = splitBlock(family, 'block1', 'block2', 3).family;
  const ann = sampleAnnotation();
  const frontier = split.checkpoint.frontier;
  const s1 = resolvePositionToEndpoint(split, 'block1', 0, frontier);
  const e1 = resolvePositionToEndpoint(split, 'block1', 3, frontier);
  const s2 = resolvePositionToEndpoint(split, 'block2', 0, frontier);
  const e2 = resolvePositionToEndpoint(split, 'block2', 3, frontier);
  const r1 = addMembership(split, [ann], [], 'ann1', 'block1', s1, e1);
  const r2 = addMembership(split, [ann], r1.memberships, 'ann1', 'block2', s2, e2);
  const result = removeMembership(split, [ann], r2.memberships, 'ann1', 'block1');
  assert.equal(result.memberships.length, 1);
  assert.equal(result.memberships[0].blockId, 'block2');
  assert.equal(result.memberships[0].ordinal, 0);
  assert.equal(result.outcomes.length, 0);
  assert.deepEqual(result.annotations, [ann]);
});

// =============================================
// removeMembership — last empty:'delete' -> delete
// =============================================

test('removeMembership last delete from annotation with empty:delete produces delete outcome', () => {
  const family = makeFamily([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']]]);
  const ann = sampleAnnotation({ empty: 'delete' });
  const frontier = family.checkpoint.frontier;
  const start = assertStructuralEndpoint({ point: ['point', ['root'], 'left'], basisFrontier: frontier });
  const end = resolvePositionToEndpoint(family, 'block1', 3, frontier);
  const r1 = addMembership(family, [ann], [], 'ann1', 'block1', start, end);
  const result = removeMembership(family, [ann], r1.memberships, 'ann1', 'block1', { structuralRevision: 1 });
  assert.equal(result.memberships.length, 0);
  assert.equal(result.annotations.length, 0);
  assert.equal(result.outcomes.length, 1);
  assert.equal(result.outcomes[0].type, 'delete');
  assert.equal(result.outcomes[0].annotationId, 'ann1');
});

// =============================================
// removeMembership — last empty:'orphan' -> orphan
// =============================================

test('removeMembership last orphan from nonempty prestate produces orphan outcome with savedQuote and provenance', () => {
  const family = makeFamily([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']]]);
  const ann = sampleAnnotation({ empty: 'orphan' });
  const frontier = family.checkpoint.frontier;
  const start = assertStructuralEndpoint({ point: ['point', ['root'], 'left'], basisFrontier: frontier });
  const end = resolvePositionToEndpoint(family, 'block1', 3, frontier);
  const r1 = addMembership(family, [ann], [], 'ann1', 'block1', start, end);
  const result = removeMembership(family, [ann], r1.memberships, 'ann1', 'block1', { structuralRevision: 1 });
  assert.equal(result.memberships.length, 0);
  assert.equal(result.annotations.length, 1);
  assert.equal(result.annotations[0].id, 'ann1');
  assert.equal(result.annotations[0].empty, 'orphan');
  assert.equal(result.outcomes.length, 1);
  const outcome = result.outcomes[0];
  assert.equal(outcome.type, 'orphan');
  assert.equal(outcome.savedQuote, 'abc');
  assert.deepEqual(outcome.lastMemberships, [
    'workbench.annotation-last-memberships', 1, 1, [], [[
      0, 'block1', ['endpoint', start.basisFrontier, start.point], ['endpoint', end.basisFrontier, end.point],
    ]],
  ]);
});

test('removeMembership orphan retains annotation identity and preserves savedQuote with lastMemberships', () => {
  const family = makeFamily([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']]]);
  const ann = sampleAnnotation({ empty: 'orphan', protectedTargetIds: ['prot1'] });
  const frontier = family.checkpoint.frontier;
  const start = assertStructuralEndpoint({ point: ['point', ['root'], 'left'], basisFrontier: frontier });
  const end = resolvePositionToEndpoint(family, 'block1', 3, frontier);
  const r1 = addMembership(family, [ann], [], 'ann1', 'block1', start, end);
  const result = removeMembership(family, [ann], r1.memberships, 'ann1', 'block1', { structuralRevision: 1 });
  assert.equal(result.annotations.length, 1);
  assert.equal(result.annotations[0].id, 'ann1');
  assert.equal(result.annotations[0].family, 'test_family');
  assert.equal(result.annotations[0].empty, 'orphan');
  assert.deepEqual(result.annotations[0].protectedTargetIds, ['prot1']);
  assert.equal(result.memberships.length, 0);
  assert.equal(result.outcomes.length, 1);
  assert.equal(result.outcomes[0].type, 'orphan');
  assert.equal(result.outcomes[0].savedQuote, 'abc');
  assert.deepEqual(result.outcomes[0].lastMemberships, [
    'workbench.annotation-last-memberships', 1, 1, ['prot1'], [[
      0, 'block1', ['endpoint', start.basisFrontier, start.point], ['endpoint', end.basisFrontier, end.point],
    ]],
  ]);
});

test('removeMembership orphan includes protectedTargetIds', () => {
  const family = makeFamily([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']]]);
  const ann = sampleAnnotation({ empty: 'orphan', protectedTargetIds: ['prot1', 'prot2'] });
  const frontier = family.checkpoint.frontier;
  const start = assertStructuralEndpoint({ point: ['point', ['root'], 'left'], basisFrontier: frontier });
  const end = resolvePositionToEndpoint(family, 'block1', 3, frontier);
  const r1 = addMembership(family, [ann], [], 'ann1', 'block1', start, end);
  const result = removeMembership(family, [ann], r1.memberships, 'ann1', 'block1', { structuralRevision: 1 });
  assert.deepEqual(result.outcomes[0].lastMemberships[3], ['prot1', 'prot2']);
  assert.equal(result.annotations.length, 1);
  assert.equal(result.annotations[0].id, 'ann1');
});

test('removeMembership orphan savedQuote concatenates visible strings from all pre-action memberships', () => {
  const cp = [['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abcdef']]];
  const state = applyAll(createTextState(), cp);
  const checkpoint = textCheckpoint(state);
  const family = createTextFamily('doc1', checkpoint, 'block1');
  const split = splitBlock(family, 'block1', 'block2', 3).family;
  const ann = sampleAnnotation({ empty: 'orphan' });
  const frontier = split.checkpoint.frontier;
  const s1 = resolvePositionToEndpoint(split, 'block1', 0, frontier);
  const e1 = resolvePositionToEndpoint(split, 'block1', 3, frontier);
  const s2 = resolvePositionToEndpoint(split, 'block2', 0, frontier);
  const e2 = resolvePositionToEndpoint(split, 'block2', 3, frontier);
  const r1 = addMembership(split, [ann], [], 'ann1', 'block1', s1, e1);
  const r2 = addMembership(split, [ann], r1.memberships, 'ann1', 'block2', s2, e2);
  const r3 = removeMembership(split, [ann], r2.memberships, 'ann1', 'block1');
  const result = removeMembership(split, [ann], r3.memberships, 'ann1', 'block2', { structuralRevision: 1 });
  assert.equal(result.outcomes.length, 1);
  assert.equal(result.outcomes[0].type, 'orphan');
  assert.equal(result.outcomes[0].savedQuote, 'def');
});

// =============================================
// Protection — protector overlap
// =============================================

test('protection blocks transition from non-empty to empty/delete', () => {
  const family = makeFamily([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']]]);
  const target = sampleAnnotation({ id: 'target1', empty: 'delete' });
  const protector = sampleAnnotation({ id: 'protector1', family: 'protector', empty: 'delete', protectedTargetIds: ['target1'] });
  const frontier = family.checkpoint.frontier;
  const start = assertStructuralEndpoint({ point: ['point', ['root'], 'left'], basisFrontier: frontier });
  const end = resolvePositionToEndpoint(family, 'block1', 3, frontier);
  const r1 = addMembership(family, [target, protector], [], 'target1', 'block1', start, end);
  const r2 = addMembership(family, [target, protector], r1.memberships, 'protector1', 'block1', start, end);
  assert.throws(() => removeMembership(family, [target, protector], r2.memberships, 'target1', 'block1'), /protected/);
});

test('protection does not block non-last removal', () => {
  const cp = [['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abcdef']]];
  const state = applyAll(createTextState(), cp);
  const checkpoint = textCheckpoint(state);
  const family = createTextFamily('doc1', checkpoint, 'block1');
  const split = splitBlock(family, 'block1', 'block2', 3).family;
  const target = sampleAnnotation({ id: 'target1', empty: 'delete' });
  const protector = sampleAnnotation({ id: 'protector1', family: 'protector', empty: 'delete', protectedTargetIds: ['target1'] });
  const frontier = split.checkpoint.frontier;
  const s1 = resolvePositionToEndpoint(split, 'block1', 0, frontier);
  const e1 = resolvePositionToEndpoint(split, 'block1', 3, frontier);
  const s2 = resolvePositionToEndpoint(split, 'block2', 0, frontier);
  const e2 = resolvePositionToEndpoint(split, 'block2', 3, frontier);
  const r1 = addMembership(split, [target, protector], [], 'target1', 'block1', s1, e1);
  const r2 = addMembership(split, [target, protector], r1.memberships, 'target1', 'block2', s2, e2);
  const r3 = addMembership(split, [target, protector], r2.memberships, 'protector1', 'block1', s1, e1);
  const result = removeMembership(split, [target, protector], r3.memberships, 'target1', 'block1');
  assert.equal(result.memberships.length, 2);
  const targetBlock2 = result.memberships.find(m => m.annotationId === 'target1' && m.blockId === 'block2');
  const protectorBlock1 = result.memberships.find(m => m.annotationId === 'protector1' && m.blockId === 'block1');
  assert.ok(targetBlock2);
  assert.ok(protectorBlock1);
  assert.equal(result.outcomes.length, 0);
});

test('protection requires active overlap — protector on different block does not protect', () => {
  const cp = [['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abcdef']]];
  const state = applyAll(createTextState(), cp);
  const checkpoint = textCheckpoint(state);
  const family = createTextFamily('doc1', checkpoint, 'block1');
  const split = splitBlock(family, 'block1', 'block2', 3).family;
  const target = sampleAnnotation({ id: 'target1', empty: 'delete' });
  const protector = sampleAnnotation({ id: 'protector1', family: 'protector', empty: 'delete', protectedTargetIds: ['target1'] });
  const frontier = split.checkpoint.frontier;
  const s1 = resolvePositionToEndpoint(split, 'block1', 0, frontier);
  const e1 = resolvePositionToEndpoint(split, 'block1', 3, frontier);
  const s2 = resolvePositionToEndpoint(split, 'block2', 0, frontier);
  const e2 = resolvePositionToEndpoint(split, 'block2', 3, frontier);
  const r1 = addMembership(split, [target, protector], [], 'target1', 'block1', s1, e1);
  const r2 = addMembership(split, [target, protector], r1.memberships, 'protector1', 'block2', s2, e2);
  const result = removeMembership(split, [target, protector], r2.memberships, 'target1', 'block1');
  assert.equal(result.outcomes[0].type, 'delete');
  assert.equal(result.annotations.length, 1);
  assert.equal(result.annotations[0].id, 'protector1');
  assert.deepEqual(result.annotations[0].protectedTargetIds, []);
});

test('protection boundary touch does not protect', () => {
  const cp = [['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abcdef']]];
  const state = applyAll(createTextState(), cp);
  const checkpoint = textCheckpoint(state);
  const family = createTextFamily('doc1', checkpoint, 'block1');
  const split = splitBlock(family, 'block1', 'block2', 3).family;
  const target = sampleAnnotation({ id: 'target1', empty: 'delete' });
  const protector = sampleAnnotation({ id: 'protector1', family: 'protector', empty: 'delete', protectedTargetIds: ['target1'] });
  const frontier = split.checkpoint.frontier;
  const s1 = resolvePositionToEndpoint(split, 'block1', 0, frontier);
  const e1 = resolvePositionToEndpoint(split, 'block1', 3, frontier);
  const s2 = resolvePositionToEndpoint(split, 'block2', 0, frontier);
  const e2 = resolvePositionToEndpoint(split, 'block2', 3, frontier);
  const r1 = addMembership(split, [target, protector], [], 'protector1', 'block1', s1, e1);
  const r2 = addMembership(split, [target, protector], r1.memberships, 'target1', 'block2', s2, e2);
  const result = removeMembership(split, [target, protector], r2.memberships, 'target1', 'block2');
  assert.equal(result.outcomes.length, 1);
  assert.equal(result.outcomes[0].type, 'delete');
  assert.equal(result.memberships.length, 1);
  assert.equal(result.memberships[0].annotationId, 'protector1');
});

// =============================================
// splitBlockMemberships
// =============================================

test('splitBlockMemberships splits full membership into both children', () => {
  const cp = [['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abcdef']]];
  const state = applyAll(createTextState(), cp);
  const checkpoint = textCheckpoint(state);
  const family = createTextFamily('doc1', checkpoint, 'block1');
  const split = splitBlock(family, 'block1', 'block2', 3).family;
  const ann = sampleAnnotation();
  const frontier = split.checkpoint.frontier;
  const s1 = resolvePositionToEndpoint(split, 'block1', 0, frontier);
  const e1 = resolvePositionToEndpoint(split, 'block1', 3, frontier);
  const r1 = addMembership(split, [ann], [], 'ann1', 'block1', s1, e1);
  const result = splitBlockMemberships(split, [ann], r1.memberships, 'block1', 'block2');
  assert.equal(result.memberships.length, 2);
  const m1 = result.memberships.find(m => m.blockId === 'block1');
  const m2 = result.memberships.find(m => m.blockId === 'block2');
  assert.ok(m1);
  assert.ok(m2);
  assert.equal(m1.ordinal, 0);
  assert.equal(m2.ordinal, 1);
  assert.equal(result.outcomes.length, 0);
});

test('splitBlockMemberships preserves a partial span across the split', () => {
  const cp = [['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abcdef']]];
  const state = applyAll(createTextState(), cp);
  const family = createTextFamily('doc1', textCheckpoint(state), 'block1');
  const ann = sampleAnnotation();
  const frontier = family.checkpoint.frontier;
  const start = resolvePositionToEndpoint(family, 'block1', 1, frontier);
  const end = resolvePositionToEndpoint(family, 'block1', 5, frontier);
  const membership = addMembership(family, [ann], [], 'ann1', 'block1', start, end).memberships;
  const split = splitBlock(family, 'block1', 'block2', 3).family;
  const result = splitBlockMemberships(split, [ann], membership, 'block1', 'block2');
  assert.equal(result.memberships.length, 2);
  assert.deepEqual(result.memberships.map(m => [m.blockId, materializeBlock(split, m.blockId)]), [['block1', 'abc'], ['block2', 'def']]);
});

test('splitBlockMemberships keeps a span entirely on the right', () => {
  const cp = [['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abcdef']]];
  const state = applyAll(createTextState(), cp);
  const family = createTextFamily('doc1', textCheckpoint(state), 'block1');
  const ann = sampleAnnotation();
  const frontier = family.checkpoint.frontier;
  const start = resolvePositionToEndpoint(family, 'block1', 4, frontier);
  const end = resolvePositionToEndpoint(family, 'block1', 6, frontier);
  const membership = addMembership(family, [ann], [], 'ann1', 'block1', start, end).memberships;
  const split = splitBlock(family, 'block1', 'block2', 3).family;
  const result = splitBlockMemberships(split, [ann], membership, 'block1', 'block2');
  assert.deepEqual(result.memberships.map(m => m.blockId), ['block2']);
  // Retained offsets must be preserved, not expanded to the block edge.
  const m = result.memberships[0];
  assert.equal(projectEndpointToBlockOffset(split, m.blockId, m.start), 1);
  assert.equal(projectEndpointToBlockOffset(split, m.blockId, m.end), 3);
});

test('splitBlockMemberships preserves an entirely-left partial span offsets', () => {
  const cp = [['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abcdef']]];
  const state = applyAll(createTextState(), cp);
  const family = createTextFamily('doc1', textCheckpoint(state), 'block1');
  const ann = sampleAnnotation();
  const frontier = family.checkpoint.frontier;
  const start = resolvePositionToEndpoint(family, 'block1', 1, frontier);
  const end = resolvePositionToEndpoint(family, 'block1', 2, frontier);
  const membership = addMembership(family, [ann], [], 'ann1', 'block1', start, end).memberships;
  const split = splitBlock(family, 'block1', 'block2', 3).family;
  const result = splitBlockMemberships(split, [ann], membership, 'block1', 'block2');
  assert.deepEqual(result.memberships.map(m => m.blockId), ['block1']);
  const m = result.memberships[0];
  assert.equal(projectEndpointToBlockOffset(split, m.blockId, m.start), 1);
  assert.equal(projectEndpointToBlockOffset(split, m.blockId, m.end), 2);
});

test('edge split is unchanged and does not invoke membership redistribution', () => {
  const cp = [['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abcdef']]];
  const state = applyAll(createTextState(), cp);
  const checkpoint = textCheckpoint(state);
  const family = createTextFamily('doc1', checkpoint, 'block1');
  const ann = sampleAnnotation();
  const frontier = family.checkpoint.frontier;
  const s1 = resolvePositionToEndpoint(family, 'block1', 0, frontier);
  const e1 = resolvePositionToEndpoint(family, 'block1', 6, frontier);
  const r1 = addMembership(family, [ann], [], 'ann1', 'block1', s1, e1);
  const split = splitBlock(family, 'block1', 'block2', 0);
  assert.equal(split.type, 'unchanged');
  assert.equal(split.family, family);
  assert.deepEqual(r1.memberships.map((membership) => membership.blockId), ['block1']);
});

test('edge split at block end is unchanged', () => {
  const cp = [['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abcdef']]];
  const state = applyAll(createTextState(), cp);
  const checkpoint = textCheckpoint(state);
  const family = createTextFamily('doc1', checkpoint, 'block1');
  const split = splitBlock(family, 'block1', 'block2', 6);
  const ann = sampleAnnotation();
  assert.equal(split.type, 'unchanged');
  assert.equal(split.retainedBlockId, 'block1');
  assert.equal(ann.id, 'ann1');
});

test('split with no visible cut remains unchanged even when it would partition tombstones', () => {
  const first = ['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']];
  const del = ['workbench.text', 1, [A, 2], 2, [[A, 1]], ['delete', [[[A, 1], 1, 2]]]];
  const state = applyAll(createTextState(), [first, del]);
  const checkpoint = textCheckpoint(state);
  const family = createTextFamily('doc1', checkpoint, 'block1');
  const splitResult = splitBlock(family, 'block1', 'block2', 1);
  assert.equal(splitResult.type, 'unchanged');
  const split = splitResult.family;
  const ann = sampleAnnotation();
  assert.equal(split, family);
  assert.equal(ann.id, 'ann1');
});

// =============================================
// mergeBlocksMemberships
// =============================================

test('mergeBlocksMemberships merges equal membership sets', () => {
  const cp = [['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abcdef']]];
  const state = applyAll(createTextState(), cp);
  const checkpoint = textCheckpoint(state);
  const family = createTextFamily('doc1', checkpoint, 'block1');
  const split = splitBlock(family, 'block1', 'block2', 3).family;
  const ann = sampleAnnotation();
  const frontier = split.checkpoint.frontier;
  const s1 = resolvePositionToEndpoint(split, 'block1', 0, frontier);
  const e1 = resolvePositionToEndpoint(split, 'block1', 3, frontier);
  const s2 = resolvePositionToEndpoint(split, 'block2', 0, frontier);
  const e2 = resolvePositionToEndpoint(split, 'block2', 3, frontier);
  const r1 = addMembership(split, [ann], [], 'ann1', 'block1', s1, e1);
  const r2 = addMembership(split, [ann], r1.memberships, 'ann1', 'block2', s2, e2);
  const result = mergeBlocksMemberships(split, [ann], r2.memberships, 'block1', 'block2');
  assert.equal(result.memberships.length, 1);
  assert.equal(result.memberships[0].blockId, 'block1');
  assert.equal(result.memberships[0].ordinal, 0);
  assert.equal(result.outcomes.length, 0);
  const mergedFamily = mergeBlocks(split, 'block1', 'block2');
  assert.doesNotThrow(() => assertMembershipRange(
    mergedFamily, 'block1', result.memberships[0].start, result.memberships[0].end,
  ));
});

test('mergeBlocksMemberships preserves annotations present on only one side', () => {
  const cp = [['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abcdef']]];
  const state = applyAll(createTextState(), cp);
  const checkpoint = textCheckpoint(state);
  const family = createTextFamily('doc1', checkpoint, 'block1');
  const split = splitBlock(family, 'block1', 'block2', 3).family;
  const ann1 = sampleAnnotation({ id: 'ann1' });
  const ann2 = sampleAnnotation({ id: 'ann2' });
  const frontier = split.checkpoint.frontier;
  const s1 = resolvePositionToEndpoint(split, 'block1', 0, frontier);
  const e1 = resolvePositionToEndpoint(split, 'block1', 3, frontier);
  const s2 = resolvePositionToEndpoint(split, 'block2', 0, frontier);
  const e2 = resolvePositionToEndpoint(split, 'block2', 3, frontier);
  const r1 = addMembership(split, [ann1, ann2], [], 'ann1', 'block1', s1, e1);
  const r2 = addMembership(split, [ann1, ann2], r1.memberships, 'ann2', 'block2', s2, e2);
  const result = mergeBlocksMemberships(split, [ann1, ann2], r2.memberships, 'block1', 'block2');
  assert.deepEqual(result.memberships.map(m => m.annotationId).sort(), ['ann1', 'ann2']);
  assert.ok(result.memberships.every(m => m.blockId === 'block1'));
});

test('mergeBlocksMemberships rejects non-adjacent blocks', () => {
  const cp = [['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abcdef']]];
  const state = applyAll(createTextState(), cp);
  const checkpoint = textCheckpoint(state);
  const family = createTextFamily('doc1', checkpoint, 'block1');
  const split = splitBlock(family, 'block1', 'block2', 3).family;
  const s3 = splitBlock(split, 'block2', 'block3', 2).family;
  const ann = sampleAnnotation();
  const frontier = s3.checkpoint.frontier;
  const s1 = resolvePositionToEndpoint(s3, 'block1', 0, frontier);
  const e1 = resolvePositionToEndpoint(s3, 'block1', 3, frontier);
  const s2 = resolvePositionToEndpoint(s3, 'block2', 0, frontier);
  const e2 = resolvePositionToEndpoint(s3, 'block2', 2, frontier);
  const s3ep = resolvePositionToEndpoint(s3, 'block3', 0, frontier);
  const e3ep = resolvePositionToEndpoint(s3, 'block3', 1, frontier);
  const r1 = addMembership(s3, [ann], [], 'ann1', 'block1', s1, e1);
  const r2 = addMembership(s3, [ann], r1.memberships, 'ann1', 'block2', s2, e2);
  const r3 = addMembership(s3, [ann], r2.memberships, 'ann1', 'block3', s3ep, e3ep);
  assert.throws(() => mergeBlocksMemberships(s3, [ann], r3.memberships, 'block1', 'block3'), /adjacent/);
});

// =============================================
// Deep immutability
// =============================================

test('addMembership result is deeply immutable', () => {
  const family = makeFamily([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']]]);
  const ann = sampleAnnotation();
  const frontier = family.checkpoint.frontier;
  const start = assertStructuralEndpoint({ point: ['point', ['root'], 'left'], basisFrontier: frontier });
  const end = resolvePositionToEndpoint(family, 'block1', 3, frontier);
  const result = addMembership(family, [ann], [], 'ann1', 'block1', start, end);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.annotations));
  assert.ok(Object.isFrozen(result.annotations[0]));
  assert.ok(Object.isFrozen(result.memberships));
  assert.ok(Object.isFrozen(result.memberships[0]));
  assert.ok(Object.isFrozen(result.outcomes));
  assert.throws(() => { result.memberships.push(null); }, /Cannot add/);
  assert.throws(() => { result.annotations[0].id = 'x'; }, /Cannot assign/);
});

test('removeMembership result is deeply immutable', () => {
  const family = makeFamily([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']]]);
  const ann = sampleAnnotation({ empty: 'orphan' });
  const frontier = family.checkpoint.frontier;
  const start = assertStructuralEndpoint({ point: ['point', ['root'], 'left'], basisFrontier: frontier });
  const end = resolvePositionToEndpoint(family, 'block1', 3, frontier);
  const r1 = addMembership(family, [ann], [], 'ann1', 'block1', start, end);
  const result = removeMembership(family, [ann], r1.memberships, 'ann1', 'block1', { structuralRevision: 1 });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.outcomes));
  assert.ok(Object.isFrozen(result.outcomes[0]));
  assert.throws(() => { result.outcomes.push(null); }, /Cannot add/);
  assert.throws(() => { result.outcomes[0].annotationId = 'x'; }, /Cannot assign/);
});

// =============================================
// Replay fairness — deterministic from same inputs
// =============================================

test('same inputs produce same outputs', () => {
  const family = makeFamily([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']]]);
  const ann = sampleAnnotation();
  const frontier = family.checkpoint.frontier;
  const start = assertStructuralEndpoint({ point: ['point', ['root'], 'left'], basisFrontier: frontier });
  const end = resolvePositionToEndpoint(family, 'block1', 3, frontier);
  const r1 = addMembership(family, [ann], [], 'ann1', 'block1', start, end);
  const r2 = addMembership(family, [ann], [], 'ann1', 'block1', start, end);
  assert.equal(JSON.stringify(r1), JSON.stringify(r2));
});

// =============================================
// No input mutation
// =============================================

test('addMembership does not mutate inputs', () => {
  const family = makeFamily([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']]]);
  const ann = sampleAnnotation();
  const annotations = [ann];
  const memberships = [];
  const frontier = family.checkpoint.frontier;
  const start = assertStructuralEndpoint({ point: ['point', ['root'], 'left'], basisFrontier: frontier });
  const end = resolvePositionToEndpoint(family, 'block1', 3, frontier);
  const before = JSON.stringify(annotations);
  const beforeMs = JSON.stringify(memberships);
  addMembership(family, annotations, memberships, 'ann1', 'block1', start, end);
  assert.equal(JSON.stringify(annotations), before);
  assert.equal(JSON.stringify(memberships), beforeMs);
});

test('removeMembership does not mutate inputs', () => {
  const family = makeFamily([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']]]);
  const ann = sampleAnnotation({ empty: 'delete' });
  const frontier = family.checkpoint.frontier;
  const start = assertStructuralEndpoint({ point: ['point', ['root'], 'left'], basisFrontier: frontier });
  const end = resolvePositionToEndpoint(family, 'block1', 3, frontier);
  const r1 = addMembership(family, [ann], [], 'ann1', 'block1', start, end);
  const before = JSON.stringify(ann);
  const beforeMs = JSON.stringify(r1.memberships);
  removeMembership(family, [ann], r1.memberships, 'ann1', 'block1');
  assert.equal(JSON.stringify(ann), before);
  assert.equal(JSON.stringify(r1.memberships), beforeMs);
});

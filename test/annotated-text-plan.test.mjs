import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyTextOp, createTextState, textCheckpoint } from '../src/annotated-text.mjs';
import { createTextFamily, materializeBlock, resolvePositionToEndpoint, splitBlock } from '../src/annotated-text-family.mjs';
import { addMembership } from '../src/annotated-text-membership.mjs';
import { planTextOffsetEdit, planAnnotationApplyOffsets, planAnnotationRemove } from '../src/annotated-text-plan.mjs';

const ACTOR = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
function familyFromText(text, blockId = 'block1') {
  const op = ['workbench.text', 1, [ACTOR, 1], 1, [], ['insert', ['root'], text]];
  return createTextFamily('doc1', textCheckpoint(applyTextOp(createTextState(), op)), blockId);
}
function pos(family, blockId, offset, affinity = 'right') { return { blockId, offset, affinity, positionFamily: family }; }
const input = (family, edit, extra = {}) => planTextOffsetEdit({ documentId: 'doc1', structureVersion: 1, family, actor: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', lamport: 2, visibleBlockIds: family.blocks.map((b) => b.id), membershipBlockIds: [], sourceBlocks: {}, mintBlockId: () => 'new', edit, ...extra });

test('plans insert, delete, and replace as unified span-native operations', () => {
  const family = familyFromText('abc');
  const inserted = input(family, { kind: 'text.insert', text: 'x', at: pos(family, 'block1', 1) });
  assert.equal(inserted.version, 13); assert.equal(inserted.operation.kind, 'text.apply'); assert.equal(materializeBlock(inserted.facts.family, 'block1'), 'axbc');
  const deleted = input(family, { kind: 'text.delete', from: pos(family, 'block1', 1), to: pos(family, 'block1', 2) });
  assert.equal(deleted.version, 13);
  const replaced = input(family, { kind: 'text.replace', text: 'xy', from: pos(family, 'block1', 1), to: pos(family, 'block1', 2) });
  assert.equal(replaced.version, 13); assert.equal(replaced.operation.operations.length, 2);
});

test('routes a membership boundary to the adjacent visible unannotated block', () => {
  const split = splitBlock(familyFromText('abcd'), 'block1', 'block2', 2).family;
  const plan = input(split, { kind: 'text.insert', text: '!', at: pos(split, 'block1', 2) }, { membershipBlockIds: ['block1'] });
  assert.equal(plan.version, 13); assert.equal(plan.operation.blockId, 'block2');
});

test('uses insert-block at a boundary when no adjacent destination exists', () => {
  const family = familyFromText('abc');
  const plan = input(family, { kind: 'text.insert', text: '!', at: pos(family, 'block1', 3) }, { membershipBlockIds: ['block1'], sourceBlocks: { block1: { epoch: 1, fields: {} } } });
  assert.equal(plan.version, 13); assert.equal(plan.operation.kind, 'text.insert-block');
});

test('prunes empty unannotated blocks emptied by a delete', () => {
  const split = splitBlock(familyFromText('abcd'), 'block1', 'block2', 2).family;
  const plan = input(split, { kind: 'text.delete', from: pos(split, 'block2', 0), to: pos(split, 'block2', 2) }, { membershipBlockIds: ['block1'] });
  assert.equal(plan.version, 13);
  assert.deepEqual(plan.facts.prunedBlockIds, ['block2']);
  assert.deepEqual(plan.facts.emptiedAnnotations, []);
  assert.equal(plan.facts.family.blocks.length, 1);
  assert.equal(materializeBlock(plan.facts.family, 'block1'), 'ab');
});

test('prunes empty annotated blocks and applies empty-policy on delete', () => {
  const split = splitBlock(familyFromText('abcd'), 'block1', 'block2', 2).family;
  const annotation = { id: 'ann1', family: 'comment', empty: 'orphan', protectedTargetIds: [] };
  const membership = addMembership(split, [annotation], [], 'ann1', 'block2',
    resolvePositionToEndpoint(split, 'block2', 0, split.checkpoint.frontier, 'left'),
    resolvePositionToEndpoint(split, 'block2', 2, split.checkpoint.frontier, 'right'));
  const plan = input(split, { kind: 'text.delete', from: pos(split, 'block2', 0), to: pos(split, 'block2', 2) }, {
    membershipBlockIds: ['block2'],
    annotations: [annotation],
    memberships: membership.memberships,
  });
  assert.equal(plan.version, 13);
  assert.deepEqual(plan.facts.prunedBlockIds, ['block2']);
  assert.equal(plan.facts.emptiedAnnotations.length, 1);
  assert.equal(plan.facts.emptiedAnnotations[0].annotationId, 'ann1');
  assert.equal(plan.facts.emptiedAnnotations[0].disposition.kind, 'orphaned');
  assert.equal(plan.facts.emptiedAnnotations[0].disposition.savedQuote, 'cd');
  assert.equal(plan.facts.family.blocks.length, 1);
});

test('plans annotation offsets and rejects inverted ranges', () => {
  const family = familyFromText('abc');
  const result = planAnnotationApplyOffsets({ family, structureVersion: 1, from: pos(family, 'block1', 0), to: pos(family, 'block1', 1), visibleBlockIds: ['block1'] });
  assert.equal(result.crossBlock, false); assert.equal(result.selection.endUtf16Offset, 1);
  assert.throws(() => planAnnotationApplyOffsets({ family, structureVersion: 1, from: pos(family, 'block1', 2), to: pos(family, 'block1', 1), visibleBlockIds: ['block1'] }), /position-invalid|forward/);
});

test('redaction-aware offsets attach at visible edges and reject a spanning selection', () => {
  const family = familyFromText('preSECRETsuffix');
  const redactions = [{ visibleStart: 3, start: 3, end: 9 }];
  const left = input(family, { kind: 'text.insert', text: '!', at: { ...pos(family, 'block1', 3, 'left'), redactions } });
  assert.equal(materializeBlock(left.facts.family, 'block1'), 'pre!SECRETsuffix');
  const right = input(family, { kind: 'text.insert', text: '!', at: { ...pos(family, 'block1', 3, 'right'), redactions } });
  assert.equal(materializeBlock(right.facts.family, 'block1'), 'preSECRET!suffix');
  assert.throws(() => input(family, {
    kind: 'text.delete',
    from: { ...pos(family, 'block1', 3, 'left'), redactions },
    to: { ...pos(family, 'block1', 3, 'right'), redactions },
  }), /confidential redaction/);
});

test('removes a delete-empty annotation and freezes the v10 result', () => {
  const family = familyFromText('abc');
  const annotation = { id: 'ann1', family: 'comment', empty: 'delete', protectedTargetIds: [] };
  const start = pos(family, 'block1', 0); const end = pos(family, 'block1', 3);
  const membership = addMembership(family, [annotation], [], 'ann1', 'block1',
    resolvePositionToEndpoint(family, 'block1', start.offset, family.checkpoint.frontier, start.affinity),
    resolvePositionToEndpoint(family, 'block1', end.offset, family.checkpoint.frontier, end.affinity));
  const plan = planAnnotationRemove({ documentId: 'doc1', structureVersion: 1, family, annotationId: 'ann1', annotations: [annotation], memberships: membership.memberships, visibleBlockIds: ['block1'] });
  assert.equal(plan.version, 13); assert.equal(plan.facts.result.disposition.kind, 'deleted'); assert(Object.isFrozen(plan));
});

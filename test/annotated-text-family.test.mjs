import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyTextOp, createTextState, textCheckpoint, restoreTextCheckpoint,
  materializeText,
} from '../src/annotated-text.mjs';
import {
  createTextFamily, restoreTextFamilyCheckpoint, materializeBlock,
  splitBlock, mergeBlocks, textFamilyCheckpoint,
} from '../src/annotated-text-family.mjs';

const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const C = 'cccccccccccccccccccccccccccccccc';
const ROOT = ['root'];

function applyAll(state, ops) {
  return ops.reduce(applyTextOp, state);
}

function makeCheckpoint(ops) {
  const state = applyAll(createTextState(), ops);
  return textCheckpoint(state);
}

test('v1 canonical graph and replay are unchanged through family boundary', () => {
  const first = ['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'a😀b']];
  const left = ['workbench.text', 1, [A, 2], 2, [[A, 1]], ['insert', ['element', [[A, 1], 0]], 'x']];
  const right = ['workbench.text', 1, [B, 1], 2, [[A, 1]], ['insert', ['element', [[A, 1], 0]], 'y']];
  const cp = makeCheckpoint([first, left, right]);
  const family = createTextFamily('doc1', cp, 'block1');
  assert.equal(family.id, 'doc1');
  assert.equal(family.blocks.length, 1);
  assert.equal(family.blocks[0].id, 'block1');
  assert.equal(materializeText(restoreTextCheckpoint(family.checkpoint)), 'ayx😀b');
  assert.deepEqual(textCheckpoint(restoreTextCheckpoint(family.checkpoint)), family.checkpoint);
});

test('split at utf16 3 on abcdef gives abc and def with every scalar exactly once', () => {
  const cp = makeCheckpoint([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abcdef']]]);
  const family = createTextFamily('doc1', cp, 'block1');
  const split = splitBlock(family, 'block1', 'block2', 3);
  assert.equal(split.blocks.length, 2);
  assert.equal(materializeBlock(split, 'block1'), 'abc');
  assert.equal(materializeBlock(split, 'block2'), 'def');
  const allKeys = split.blocks.flatMap((b) => b.elementKeys);
  const seen = new Set();
  for (const key of allKeys) {
    if (seen.has(key)) assert.fail(`duplicate key: ${key}`);
    seen.add(key);
  }
  assert.equal(seen.size, Object.keys(split.checkpoint.elements).length);
});

test('right child contains no scalar that was copied from left', () => {
  const cp = makeCheckpoint([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abcdef']]]);
  const family = createTextFamily('doc1', cp, 'block1');
  const split = splitBlock(family, 'block1', 'block2', 3);
  const leftBlock = split.blocks[0];
  const rightBlock = split.blocks[1];
  for (const key of leftBlock.elementKeys) {
    assert.ok(!rightBlock.elementKeys.includes(key), 'right block contains a left element key');
  }
  const leftText = materializeBlock(split, 'block1');
  const rightText = materializeBlock(split, 'block2');
  assert.equal(leftText + rightText, 'abcdef');
});

test('split accepts Unicode scalar edge and rejects surrogate interior', () => {
  const cp = makeCheckpoint([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'a😀b']]]);
  const family = createTextFamily('doc1', cp, 'block1');
  const split = splitBlock(family, 'block1', 'block2', 1);
  assert.equal(materializeBlock(split, 'block1'), 'a');
  assert.equal(materializeBlock(split, 'block2'), '😀b');
  assert.throws(() => splitBlock(family, 'block1', 'block2', 2), /splits/);
});

test('split advances visibleCount by UTF-16 code units not scalar count', () => {
  const cp = makeCheckpoint([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'a😀b']]]);
  const family = createTextFamily('doc1', cp, 'block1');
  const split = splitBlock(family, 'block1', 'block2', 3);
  assert.equal(materializeBlock(split, 'block1'), 'a😀');
  assert.equal(materializeBlock(split, 'block2'), 'b');
  assert.throws(() => splitBlock(family, 'block1', 'block2', 2), /splits/);
});

test('split and merge restores canonical family checkpoint byte-for-byte', () => {
  const cp = makeCheckpoint([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abcdef']]]);
  const family = createTextFamily('doc1', cp, 'block1');
  const split = splitBlock(family, 'block1', 'block2', 3);
  const merged = mergeBlocks(split, 'block1', 'block2');
  assert.equal(merged.blocks.length, 1);
  assert.equal(merged.blocks[0].id, 'block1');
  assert.deepEqual(
    textFamilyCheckpoint(merged),
    textFamilyCheckpoint(family),
  );
  assert.equal(
    JSON.stringify(textFamilyCheckpoint(merged)),
    JSON.stringify(textFamilyCheckpoint(family)),
  );
});

test('recursive split produces multiple blocks preserving all scalars', () => {
  const cp = makeCheckpoint([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abcdef']]]);
  const family = createTextFamily('doc1', cp, 'block1');
  const s1 = splitBlock(family, 'block1', 'block2', 2);
  const s2 = splitBlock(s1, 'block2', 'block3', 2);
  assert.equal(s2.blocks.length, 3);
  assert.equal(materializeBlock(s2, 'block1'), 'ab');
  assert.equal(materializeBlock(s2, 'block2'), 'cd');
  assert.equal(materializeBlock(s2, 'block3'), 'ef');
  const allKeys = s2.blocks.flatMap((b) => b.elementKeys);
  const seen = new Set();
  for (const key of allKeys) {
    if (seen.has(key)) assert.fail(`duplicate key: ${key}`);
    seen.add(key);
  }
  assert.equal(seen.size, Object.keys(s2.checkpoint.elements).length);
});

test('malformed overlap or missing ownership is rejected', () => {
  const cp = makeCheckpoint([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']]]);
  const family = createTextFamily('doc1', cp, 'block1');
  assert.throws(() => restoreTextFamilyCheckpoint({
    id: 'doc1',
    checkpoint: cp,
    blocks: [{ id: 'b1', elementKeys: ['x'] }],
  }), /invalid element key/);
  assert.throws(() => restoreTextFamilyCheckpoint({
    id: 'doc1',
    checkpoint: cp,
    blocks: [{ id: 'b1', elementKeys: Object.keys(cp.elements).slice(0, 1) }],
  }), /missing element key/);
  assert.throws(() => splitBlock(family, 'nonexistent', 'b2', 1), /block not found/);
  assert.throws(() => mergeBlocks(family, 'block1', 'nonexistent'), /block not found/);
});

test('materialization preserves concurrent RGA descendant ordering', () => {
  const first = ['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'a']];
  const left = ['workbench.text', 1, [A, 2], 2, [[A, 1]], ['insert', ['element', [[A, 1], 0]], 'x']];
  const right = ['workbench.text', 1, [B, 1], 2, [[A, 1]], ['insert', ['element', [[A, 1], 0]], 'y']];
  const later = ['workbench.text', 1, [C, 1], 3, [[A, 2], [B, 1]], ['insert', ['element', [[A, 1], 0]], 'z']];
  const cp = makeCheckpoint([first, left, right, later]);
  const family = createTextFamily('doc1', cp, 'block1');
  const text = materializeBlock(family, 'block1');
  assert.equal(text, 'azyx');
  assert.equal(materializeText(restoreTextCheckpoint(cp)), text);
});

test('non-adjacent merge is rejected', () => {
  const cp = makeCheckpoint([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abcdef']]]);
  const family = createTextFamily('doc1', cp, 'block1');
  const s1 = splitBlock(family, 'block1', 'block2', 2);
  const s2 = splitBlock(s1, 'block2', 'block3', 2);
  assert.throws(() => mergeBlocks(s2, 'block1', 'block3'), /adjacent/);
  assert.throws(() => mergeBlocks(s2, 'block3', 'block1'), /adjacent/);
});

test('same new block ID is rejected', () => {
  const cp = makeCheckpoint([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']]]);
  const family = createTextFamily('doc1', cp, 'block1');
  assert.throws(() => splitBlock(family, 'block1', 'block1', 1), /duplicate block id/);
});

test('family checkpoint serialization round-trips', () => {
  const cp = makeCheckpoint([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'hello']]]);
  const family = createTextFamily('doc1', cp, 'block1');
  const restored = restoreTextFamilyCheckpoint(textFamilyCheckpoint(family));
  assert.deepEqual(restored, family);
  assert.equal(JSON.stringify(restored), JSON.stringify(family));
});

test('unknown extra fields in family checkpoint are rejected', () => {
  const cp = makeCheckpoint([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'a']]]);
  assert.throws(() => restoreTextFamilyCheckpoint({
    id: 'doc1', checkpoint: cp, blocks: [{ id: 'b1', elementKeys: Object.keys(cp.elements) }], extra: true,
  }), /unknown family checkpoint key/);
});

test('empty blocks array is rejected', () => {
  const cp = makeCheckpoint([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'a']]]);
  assert.throws(() => restoreTextFamilyCheckpoint({
    id: 'doc1', checkpoint: cp, blocks: [],
  }), /at least one block/);
});

test('tombstoned elements are included in split traversal and ownership', () => {
  const first = ['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']];
  const del = ['workbench.text', 1, [A, 2], 2, [[A, 1]], ['delete', [[[A, 1], 1, 1]]]];
  const cp = makeCheckpoint([first, del]);
  const family = createTextFamily('doc1', cp, 'block1');
  const split = splitBlock(family, 'block1', 'block2', 1);
  assert.equal(materializeBlock(split, 'block1'), 'a');
  assert.equal(materializeBlock(split, 'block2'), 'c');
  const allKeys = split.blocks.flatMap((b) => b.elementKeys);
  const seen = new Set();
  for (const key of allKeys) {
    if (seen.has(key)) assert.fail(`duplicate key: ${key}`);
    seen.add(key);
  }
  assert.equal(seen.size, Object.keys(split.checkpoint.elements).length);
  assert.ok(seen.has(`${A}:1:1`), 'tombstoned element must still be owned by a block');
});

test('family checkpoint is deeply immutable after creation', () => {
  const cp = makeCheckpoint([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']]]);
  const family = createTextFamily('doc1', cp, 'block1');
  const fcp = textFamilyCheckpoint(family);
  assert.ok(Object.isFrozen(fcp));
  assert.ok(Object.isFrozen(fcp.blocks));
  assert.ok(Object.isFrozen(fcp.blocks[0]));
  assert.ok(Object.isFrozen(fcp.blocks[0].elementKeys));
  assert.ok(Object.isFrozen(fcp.checkpoint));
  assert.ok(Object.isFrozen(fcp.checkpoint.elements));
  assert.ok(Object.isFrozen(fcp.checkpoint.elements[Object.keys(fcp.checkpoint.elements)[0]]));
  assert.ok(Object.isFrozen(fcp.checkpoint.frontier));
  assert.ok(Object.isFrozen(fcp.checkpoint.operations));
  assert.ok(Object.isFrozen(fcp.checkpoint.pending));
  const fcp2 = textFamilyCheckpoint(family);
  assert.equal(JSON.stringify(fcp), JSON.stringify(fcp2));
  assert.throws(() => { fcp.id = 'changed'; }, /Cannot assign/);
  assert.throws(() => { fcp.blocks.push(null); }, /Cannot add/);
  assert.throws(() => { fcp.blocks[0].elementKeys.push('x'); }, /Cannot add/);
  assert.throws(() => { fcp.checkpoint.elements['new'] = 'x'; }, /Cannot add/);
});

test('family checkpoint is deeply immutable after restore', () => {
  const cp = makeCheckpoint([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']]]);
  const family = createTextFamily('doc1', cp, 'block1');
  const fcp = textFamilyCheckpoint(family);
  const restored = restoreTextFamilyCheckpoint(fcp);
  assert.ok(Object.isFrozen(restored));
  assert.ok(Object.isFrozen(restored.blocks));
  assert.ok(Object.isFrozen(restored.blocks[0]));
  assert.ok(Object.isFrozen(restored.blocks[0].elementKeys));
  assert.ok(Object.isFrozen(restored.checkpoint));
  assert.ok(Object.isFrozen(restored.checkpoint.elements));
  assert.ok(Object.isFrozen(restored.checkpoint.elements[Object.keys(restored.checkpoint.elements)[0]]));
  assert.ok(Object.isFrozen(restored.checkpoint.frontier));
  assert.ok(Object.isFrozen(restored.checkpoint.operations));
  assert.ok(Object.isFrozen(restored.checkpoint.pending));
  assert.throws(() => { restored.id = 'changed'; }, /Cannot assign/);
  assert.throws(() => { restored.blocks.push(null); }, /Cannot add/);
  assert.throws(() => { restored.blocks[0].elementKeys.push('x'); }, /Cannot add/);
  assert.throws(() => { restored.checkpoint.elements['new'] = 'x'; }, /Cannot add/);
});

test('assertBlockOwnerships rejects non-contiguous blocks in rgaTraversal order', () => {
  const cp = makeCheckpoint([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abcdef']]]);
  const keys = Object.keys(cp.elements).sort();
  const aKeys = keys.slice(0, 1).concat(keys.slice(2, 3));
  const bKeys = keys.slice(1, 2).concat(keys.slice(3));
  assert.throws(() => restoreTextFamilyCheckpoint({
    id: 'doc1', checkpoint: cp, blocks: [
      { id: 'a', elementKeys: aKeys },
      { id: 'b', elementKeys: bKeys },
    ],
  }), /contiguous segments/);
  const reversed = [...keys].reverse();
  assert.throws(() => restoreTextFamilyCheckpoint({
    id: 'doc1', checkpoint: cp, blocks: [
      { id: 'a', elementKeys: reversed.slice(0, 3) },
      { id: 'b', elementKeys: reversed.slice(3) },
    ],
  }), /contiguous segments/);
});

test('split operation produces deeply immutable result', () => {
  const cp = makeCheckpoint([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abcdef']]]);
  const family = createTextFamily('doc1', cp, 'block1');
  const split = splitBlock(family, 'block1', 'block2', 3);
  assert.ok(Object.isFrozen(split));
  assert.ok(Object.isFrozen(split.blocks));
  assert.ok(Object.isFrozen(split.blocks[0]));
  assert.ok(Object.isFrozen(split.blocks[0].elementKeys));
  assert.ok(Object.isFrozen(split.blocks[1]));
  assert.ok(Object.isFrozen(split.blocks[1].elementKeys));
  assert.throws(() => { split.blocks[0].elementKeys.push('x'); }, /Cannot add/);
});

test('merge operation produces deeply immutable result', () => {
  const cp = makeCheckpoint([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abcdef']]]);
  const family = createTextFamily('doc1', cp, 'block1');
  const split = splitBlock(family, 'block1', 'block2', 3);
  const merged = mergeBlocks(split, 'block1', 'block2');
  assert.ok(Object.isFrozen(merged));
  assert.ok(Object.isFrozen(merged.blocks));
  assert.ok(Object.isFrozen(merged.blocks[0]));
  assert.ok(Object.isFrozen(merged.blocks[0].elementKeys));
  assert.throws(() => { merged.blocks[0].elementKeys.push('x'); }, /Cannot add/);
});
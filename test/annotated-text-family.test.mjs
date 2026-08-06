import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyTextOp, createTextState, textCheckpoint, restoreTextCheckpoint,
  materializeText,
} from '../src/annotated-text.mjs';
import {
  createTextFamily, restoreTextFamilyCheckpoint, materializeBlock,
  splitBlock, mergeBlocks, textFamilyCheckpoint, applyTextOperationToBlock, rgaTraversal,
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
  const result = splitBlock(family, 'block1', 'block2', 3);
  assert.equal(result.type, 'split');
  const split = result.family;
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
  const result = splitBlock(family, 'block1', 'block2', 3);
  const split = result.family;
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
  const result = splitBlock(family, 'block1', 'block2', 1);
  assert.equal(result.type, 'split');
  const split = result.family;
  assert.equal(materializeBlock(split, 'block1'), 'a');
  assert.equal(materializeBlock(split, 'block2'), '😀b');
  assert.throws(() => splitBlock(family, 'block1', 'block2', 2), /splits/);
});

test('split advances visibleCount by UTF-16 code units not scalar count', () => {
  const cp = makeCheckpoint([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'a😀b']]]);
  const family = createTextFamily('doc1', cp, 'block1');
  const result = splitBlock(family, 'block1', 'block2', 3);
  assert.equal(result.type, 'split');
  const split = result.family;
  assert.equal(materializeBlock(split, 'block1'), 'a😀');
  assert.equal(materializeBlock(split, 'block2'), 'b');
  assert.throws(() => splitBlock(family, 'block1', 'block2', 2), /splits/);
});

test('split and merge restores canonical family checkpoint byte-for-byte', () => {
  const cp = makeCheckpoint([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abcdef']]]);
  const family = createTextFamily('doc1', cp, 'block1');
  const result = splitBlock(family, 'block1', 'block2', 3);
  const split = result.family;
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
  const r1 = splitBlock(family, 'block1', 'block2', 2);
  const s1 = r1.family;
  const r2 = splitBlock(s1, 'block2', 'block3', 2);
  const s2 = r2.family;
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

test('materializes a long linear RGA without consuming the call stack', () => {
  const text = 'x'.repeat(20_000);
  const cp = makeCheckpoint([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, text]]]);
  const family = createTextFamily('long-document', cp, 'block1');

  assert.equal(rgaTraversal(cp).length, text.length);
  assert.equal(materializeText(restoreTextCheckpoint(cp)), text);
  assert.equal(materializeBlock(family, 'block1'), text);
});

test('non-adjacent merge is rejected', () => {
  const cp = makeCheckpoint([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abcdef']]]);
  const family = createTextFamily('doc1', cp, 'block1');
  const r1 = splitBlock(family, 'block1', 'block2', 2);
  const s1 = r1.family;
  const r2 = splitBlock(s1, 'block2', 'block3', 2);
  const s2 = r2.family;
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
  const result = splitBlock(family, 'block1', 'block2', 1);
  assert.equal(result.type, 'split');
  const split = result.family;
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
  const result = splitBlock(family, 'block1', 'block2', 3);
  assert.equal(result.type, 'split');
  const split = result.family;
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
  const result = splitBlock(family, 'block1', 'block2', 3);
  const split = result.family;
  const merged = mergeBlocks(split, 'block1', 'block2');
  assert.ok(Object.isFrozen(merged));
  assert.ok(Object.isFrozen(merged.blocks));
  assert.ok(Object.isFrozen(merged.blocks[0]));
  assert.ok(Object.isFrozen(merged.blocks[0].elementKeys));
  assert.throws(() => { merged.blocks[0].elementKeys.push('x'); }, /Cannot add/);
});

function makeFamily(ops, blockId = 'block1') {
  const cp = makeCheckpoint(ops);
  return createTextFamily('doc1', cp, blockId);
}

test('applyTextOperationToBlock rejects family with pending entries', () => {
  const state = applyAll(createTextState(), [['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'a']]]);
  const unreadyOp = ['workbench.text', 1, [B, 1], 2, [[A, 2]], ['insert', ROOT, 'x']];
  const stateWithPending = applyTextOp(state, unreadyOp);
  const cpWithPending = textCheckpoint(stateWithPending);
  assert.ok(Object.keys(cpWithPending.pending).length > 0);
  assert.ok(!cpWithPending.rebootstrapRequired);
  const family = createTextFamily('doc1', cpWithPending, 'block1');
  assert.throws(
    () => applyTextOperationToBlock(family, 'block1', ['workbench.text', 1, [A, 2], 2, [[A, 1]], ['insert', ROOT, 'b']]),
    /pending/,
  );
});

test('applyTextOperationToBlock rejects family requiring rebootstrap', () => {
  const cp = makeCheckpoint([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'a']]]);
  const cpReboot = { ...cp, rebootstrapRequired: true };
  const family = createTextFamily('doc1', cpReboot, 'block1');
  assert.throws(
    () => applyTextOperationToBlock(family, 'block1', ['workbench.text', 1, [A, 2], 2, [[A, 1]], ['insert', ROOT, 'b']]),
    /rebootstrap/,
  );
});

test('applyTextOperationToBlock rejects nonexistent block', () => {
  const family = makeFamily([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'a']]]);
  assert.throws(
    () => applyTextOperationToBlock(family, 'nonexistent', ['workbench.text', 1, [A, 2], 2, [[A, 1]], ['insert', ROOT, 'b']]),
    /block not found/,
  );
});

test('applyTextOperationToBlock rejects causally unready insert', () => {
  const family = makeFamily([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'a']]]);
  const unreadyOp = ['workbench.text', 1, [B, 1], 2, [[A, 2]], ['insert', ROOT, 'b']];
  assert.throws(
    () => applyTextOperationToBlock(family, 'block1', unreadyOp),
    /causally ready/,
  );
});

test('applyTextOperationToBlock rejects causally unready delete', () => {
  const family = makeFamily([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']]]);
  const unreadyOp = ['workbench.text', 1, [B, 1], 2, [[A, 2]], ['delete', [[[A, 1], 0, 1]]]];
  assert.throws(
    () => applyTextOperationToBlock(family, 'block1', unreadyOp),
    /causally ready/,
  );
});

test('applyTextOperationToBlock rejects cross-block delete', () => {
  const cp = makeCheckpoint([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abcdef']]]);
  const family = createTextFamily('doc1', cp, 'block1');
  const r = splitBlock(family, 'block1', 'block2', 3);
  const split = r.family;
  assert.throws(
    () => applyTextOperationToBlock(split, 'block1', ['workbench.text', 1, [A, 2], 2, [[A, 1]], ['delete', [[[A, 1], 3, 1]]]]),
    /cannot delete elements not owned/,
  );
});

test('applyTextOperationToBlock valid same-block delete', () => {
  const cp = makeCheckpoint([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abcdef']]]);
  const family = createTextFamily('doc1', cp, 'block1');
  const result = applyTextOperationToBlock(family, 'block1', ['workbench.text', 1, [A, 2], 2, [[A, 1]], ['delete', [[[A, 1], 0, 1]]]]);
  const owned = new Set(result.blocks[0].elementKeys);
  assert.ok(owned.has(`${A}:1:0`));
  assert.ok(owned.has(`${A}:1:1`));
  assert.equal(result.blocks.length, 1);
  assert.equal(result.blocks[0].id, 'block1');
  assert.equal(materializeBlock(result, 'block1'), 'bcdef');
});

test('applyTextOperationToBlock valid same-block insert', () => {
  const family = makeFamily([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']]]);
  const result = applyTextOperationToBlock(family, 'block1', ['workbench.text', 1, [A, 2], 2, [[A, 1]], ['insert', ROOT, 'xy']]);
  const owned = new Set(result.blocks[0].elementKeys);
  assert.ok(owned.has(`${A}:2:0`));
  assert.ok(owned.has(`${A}:2:1`));
  assert.equal(result.blocks.length, 1);
  assert.equal(materializeBlock(result, 'block1'), 'xyabc');
});

test('applyTextOperationToBlock duplicate idempotence', () => {
  const family = makeFamily([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']]]);
  const op = ['workbench.text', 1, [A, 2], 2, [[A, 1]], ['insert', ROOT, 'x']];
  const r1 = applyTextOperationToBlock(family, 'block1', op);
  const r2 = applyTextOperationToBlock(r1, 'block1', op);
  assert.deepEqual(r2, r1);
  assert.equal(JSON.stringify(r2), JSON.stringify(r1));
});

test('applyTextOperationToBlock equivocation rejection', () => {
  const family = makeFamily([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']]]);
  const op = ['workbench.text', 1, [A, 2], 2, [[A, 1]], ['insert', ROOT, 'x']];
  const r1 = applyTextOperationToBlock(family, 'block1', op);
  const equivOp = ['workbench.text', 1, [A, 2], 2, [[A, 1]], ['insert', ROOT, 'y']];
  assert.throws(
    () => applyTextOperationToBlock(r1, 'block1', equivOp),
    /reused with different content/,
  );
});

test('applyTextOperationToBlock insert at element anchor within block', () => {
  const cp = makeCheckpoint([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']]]);
  const family = createTextFamily('doc1', cp, 'block1');
  const anchor = ['element', [[A, 1], 0]];
  const result = applyTextOperationToBlock(family, 'block1', ['workbench.text', 1, [A, 2], 2, [[A, 1]], ['insert', anchor, 'x']]);
  assert.equal(materializeBlock(result, 'block1'), 'axbc');
  const owned = new Set(result.blocks[0].elementKeys);
  assert.ok(owned.has(`${A}:2:0`));
});

test('applyTextOperationToBlock insert at root accepted when contiguity holds', () => {
  const cp = makeCheckpoint([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']]]);
  const family = createTextFamily('doc1', cp, 'block1');
  const r = splitBlock(family, 'block1', 'block2', 2);
  const split = r.family;
  const result = applyTextOperationToBlock(split, 'block1', ['workbench.text', 1, [A, 2], 2, [[A, 1]], ['insert', ROOT, 'x']]);
  assert.equal(materializeBlock(result, 'block1'), 'xab');
  assert.equal(materializeBlock(result, 'block2'), 'c');
  assert.ok(result.blocks[0].elementKeys.includes(`${A}:2:0`));
});

test('applyTextOperationToBlock insert breaking contiguity is rejected', () => {
  const family = makeFamily([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']]]);
  const r = splitBlock(family, 'block1', 'block2', 2);
  const split = r.family;
  const anchor = ['element', [[A, 1], 0]];
  assert.throws(
    () => applyTextOperationToBlock(split, 'block2', ['workbench.text', 1, [A, 2], 2, [[A, 1]], ['insert', anchor, 'x']]),
    /contiguous/,
  );
});

test('applyTextOperationToBlock full family serialization replays', () => {
  const family = makeFamily([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']]]);
  const r1 = applyTextOperationToBlock(family, 'block1', ['workbench.text', 1, [A, 2], 2, [[A, 1]], ['insert', ROOT, 'x']]);
  const serialized = textFamilyCheckpoint(r1);
  const restored = restoreTextFamilyCheckpoint(serialized);
  assert.deepEqual(restored, r1);
  assert.equal(JSON.stringify(restored), JSON.stringify(r1));
});

test('applyTextOperationToBlock deep-freezes result', () => {
  const family = makeFamily([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']]]);
  const result = applyTextOperationToBlock(family, 'block1', ['workbench.text', 1, [A, 2], 2, [[A, 1]], ['insert', ROOT, 'x']]);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.checkpoint));
  assert.ok(Object.isFrozen(result.blocks));
  assert.ok(Object.isFrozen(result.blocks[0]));
  assert.ok(Object.isFrozen(result.blocks[0].elementKeys));
});

test('applyTextOperationToBlock does not mutate input family', () => {
  const family = makeFamily([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']]]);
  const before = JSON.stringify(textFamilyCheckpoint(family));
  applyTextOperationToBlock(family, 'block1', ['workbench.text', 1, [A, 2], 2, [[A, 1]], ['insert', ROOT, 'x']]);
  assert.equal(JSON.stringify(textFamilyCheckpoint(family)), before);
});

test('applyTextOperationToBlock delete preserves all owner keys', () => {
  const cp = makeCheckpoint([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abcdef']]]);
  const family = createTextFamily('doc1', cp, 'block1');
  const result = applyTextOperationToBlock(family, 'block1', ['workbench.text', 1, [A, 2], 2, [[A, 1]], ['delete', [[[A, 1], 0, 2]]]]);
  const allKeys = Object.keys(result.checkpoint.elements).sort();
  const blockKeys = [...result.blocks[0].elementKeys].sort();
  assert.deepEqual(blockKeys, allKeys);
  assert.equal(materializeBlock(result, 'block1'), 'cdef');
});

test('applyTextOperationToBlock reject unready op with no pending mutation', () => {
  const family = makeFamily([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'a']]]);
  const cp = textCheckpoint(restoreTextCheckpoint(family.checkpoint));
  assert.equal(Object.keys(cp.pending).length, 0);
  assert.throws(
    () => applyTextOperationToBlock(family, 'block1', ['workbench.text', 1, [B, 1], 2, [[A, 2]], ['insert', ROOT, 'x']]),
    /causally ready/,
  );
});

// =============================================
// Sol final zero-ownership policy
// =============================================

test('empty checkpoint bootstrap block is accepted as single zero-owned block', () => {
  const emptyState = createTextState();
  const cp = textCheckpoint(emptyState);
  assert.equal(Object.keys(cp.elements).length, 0);
  const family = createTextFamily('bootstrap', cp, 'block1');
  assert.equal(family.blocks.length, 1);
  assert.equal(family.blocks[0].elementKeys.length, 0);
  assert.equal(family.id, 'bootstrap');
});

test('restore empty checkpoint family with single zero-owned block round-trips', () => {
  const emptyState = createTextState();
  const cp = textCheckpoint(emptyState);
  const family = createTextFamily('bootstrap', cp, 'block1');
  const restored = restoreTextFamilyCheckpoint(textFamilyCheckpoint(family));
  assert.deepEqual(restored, family);
});

test('restore nonempty checkpoint with zero-owned block rejected', () => {
  const cp = makeCheckpoint([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'a']]]);
  assert.throws(() => restoreTextFamilyCheckpoint({
    id: 'doc1', checkpoint: cp, blocks: [{ id: 'b1', elementKeys: [] }],
  }), /must own at least one structural element/);
  assert.throws(() => restoreTextFamilyCheckpoint({
    id: 'doc1', checkpoint: cp, blocks: [
      { id: 'b1', elementKeys: Object.keys(cp.elements) },
      { id: 'b2', elementKeys: [] },
    ],
  }), /must own at least one structural element/);
});

test('empty checkpoint with multiple blocks rejected', () => {
  const emptyState = createTextState();
  const cp = textCheckpoint(emptyState);
  assert.throws(() => restoreTextFamilyCheckpoint({
    id: 'doc1', checkpoint: cp, blocks: [{ id: 'b1', elementKeys: [] }, { id: 'b2', elementKeys: [] }],
  }), /exactly one block/);
});

test('split at utf16 0 on nonempty block returns unchanged empty-child', () => {
  const cp = makeCheckpoint([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abcdef']]]);
  const family = createTextFamily('doc1', cp, 'block1');
  const result = splitBlock(family, 'block1', 'block2', 0);
  assert.equal(result.type, 'unchanged');
  assert.equal(result.reason, 'empty-child');
  assert.equal(result.retainedBlockId, 'block1');
  assert.deepEqual(result.family, family);
});

test('split at visible offset 0 with leading tombstones returns unchanged', () => {
  const family = makeFamily([
    ['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abc']],
    ['workbench.text', 1, [A, 2], 2, [[A, 1]], ['delete', [[[A, 1], 0, 1]]]],
  ]);
  const result = splitBlock(family, 'block1', 'block2', 0);
  assert.deepEqual(result, {
    type: 'unchanged', reason: 'empty-child', family, retainedBlockId: 'block1',
  });
});

test('split at utf16 end on nonempty block returns unchanged empty-child', () => {
  const cp = makeCheckpoint([['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abcdef']]]);
  const family = createTextFamily('doc1', cp, 'block1');
  const result = splitBlock(family, 'block1', 'block2', 6);
  assert.equal(result.type, 'unchanged');
  assert.equal(result.reason, 'empty-child');
  assert.equal(result.retainedBlockId, 'block1');
  assert.deepEqual(result.family, family);
});

test('split bootstrap empty block is rejected', () => {
  const emptyState = createTextState();
  const cp = textCheckpoint(emptyState);
  const family = createTextFamily('bootstrap', cp, 'block1');
  assert.throws(() => splitBlock(family, 'block1', 'block2', 0), /cannot split an empty block/);
});

test('tombstone-owned split remains real split when both partitions nonempty', () => {
  const first = ['workbench.text', 1, [A, 1], 1, [], ['insert', ROOT, 'abcde']];
  const del = ['workbench.text', 1, [A, 2], 2, [[A, 1]], ['delete', [[[A, 1], 1, 3]]]];
  const cp = makeCheckpoint([first, del]);
  const family = createTextFamily('doc1', cp, 'block1');
  const result = splitBlock(family, 'block1', 'block2', 1);
  assert.equal(result.type, 'split');
  const split = result.family;
  assert.equal(split.blocks.length, 2);
  assert.equal(materializeBlock(split, 'block1'), 'a');
  assert.equal(materializeBlock(split, 'block2'), 'e');
  assert.ok(split.blocks[0].elementKeys.length > 0);
  assert.ok(split.blocks[1].elementKeys.length > 0);
});

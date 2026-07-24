import {
  assertUtf16Offset, compareOpId, restoreTextCheckpoint, textCheckpoint,
} from './annotated-text.mjs';

const ROOT_ID = 'root';

function fail(message) {
  throw new Error(`invalid annotated-text family: ${message}`);
}

function assertFamilyId(value) {
  if (typeof value !== 'string' || value.length === 0) fail('family id must be a non-empty string');
  return value;
}

function assertBlockId(value) {
  if (typeof value !== 'string' || value.length === 0) fail('block id must be a non-empty string');
  return value;
}

function assertElementKeysArray(value) {
  if (!Array.isArray(value)) fail('element keys must be an array');
  for (const key of value) {
    if (typeof key !== 'string' || !/^[0-9a-f]{32}:\d+:\d+$/.test(key)) fail(`invalid element key: ${key}`);
  }
  return value;
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) return value;
  for (const v of Object.values(value)) deepFreeze(v);
  return Object.freeze(value);
}

function buildChildren(checkpoint) {
  const children = new Map([[ROOT_ID, []]]);
  for (const [key, element] of Object.entries(checkpoint.elements)) {
    const list = children.get(element.parent) ?? [];
    list.push([key, element]);
    children.set(element.parent, list);
  }
  for (const list of children.values()) {
    list.sort(([, left], [, right]) => right.lamport - left.lamport || -compareOpId(left.op, right.op));
  }
  return children;
}

function rgaTraversal(checkpoint) {
  const children = buildChildren(checkpoint);
  const order = [];
  const visit = (parent) => {
    for (const [key, element] of children.get(parent) ?? []) {
      order.push([key, element]);
      visit(key);
    }
  };
  visit(ROOT_ID);
  return order;
}

function assertBlockOwnerships(checkpoint, blocks) {
  const allOwnedKeys = [];
  const blockIds = new Set();

  for (const block of blocks) {
    if (!block || typeof block !== 'object') fail('each block must be an object');
    const allowedBlockKeys = ['id', 'elementKeys'];
    for (const key of Object.keys(block)) {
      if (!allowedBlockKeys.includes(key)) fail(`unknown block key: ${key}`);
    }
    const id = assertBlockId(block.id);
    if (blockIds.has(id)) fail(`duplicate block id: ${id}`);
    blockIds.add(id);
    const keys = assertElementKeysArray(block.elementKeys);
    for (const key of keys) {
      if (!Object.hasOwn(checkpoint.elements, key)) fail(`unknown element key in block: ${key}`);
      allOwnedKeys.push(key);
    }
  }

  const seen = new Set();
  for (const key of allOwnedKeys) {
    if (seen.has(key)) fail(`duplicate element key across blocks: ${key}`);
    seen.add(key);
  }

  for (const key of Object.keys(checkpoint.elements)) {
    if (!seen.has(key)) fail(`missing element key in block ownership: ${key}`);
  }

  const traversal = rgaTraversal(checkpoint).map(([key]) => key);
  const blockSets = blocks.map((b) => new Set(b.elementKeys));
  let blockIdx = 0;
  for (const key of traversal) {
    while (blockIdx < blocks.length && blockSets[blockIdx].size === 0) blockIdx += 1;
    if (blockIdx >= blocks.length || !blockSets[blockIdx].has(key)) {
      fail('block element keys must be contiguous segments in rgaTraversal order');
    }
    blockSets[blockIdx].delete(key);
    if (blockSets[blockIdx].size === 0) blockIdx += 1;
  }
}

export function createTextFamily(id, checkpoint, blockId) {
  assertFamilyId(id);
  assertBlockId(blockId);
  const restored = restoreTextCheckpoint(checkpoint);
  const canonical = textCheckpoint(restored);
  const allKeys = Object.keys(canonical.elements).sort();
  return deepFreeze({
    id,
    checkpoint: canonical,
    blocks: [deepFreeze({ id: blockId, elementKeys: Object.freeze(allKeys) })],
  });
}

export function restoreTextFamilyCheckpoint(familyCheckpoint) {
  if (!familyCheckpoint || typeof familyCheckpoint !== 'object' || Array.isArray(familyCheckpoint)) {
    fail('family checkpoint must be a non-array object');
  }
  const allowedKeys = new Set(['id', 'checkpoint', 'blocks']);
  for (const key of Object.keys(familyCheckpoint)) {
    if (!allowedKeys.has(key)) fail(`unknown family checkpoint key: ${key}`);
  }
  assertFamilyId(familyCheckpoint.id);
  const restored = restoreTextCheckpoint(familyCheckpoint.checkpoint);
  const canonical = textCheckpoint(restored);
  if (!Array.isArray(familyCheckpoint.blocks) || familyCheckpoint.blocks.length === 0) {
    fail('family checkpoint must have at least one block');
  }
  assertBlockOwnerships(canonical, familyCheckpoint.blocks);
  const blocks = familyCheckpoint.blocks.map((block) =>
    Object.freeze({ id: block.id, elementKeys: Object.freeze([...block.elementKeys].sort()) }),
  );
  return deepFreeze({ id: familyCheckpoint.id, checkpoint: canonical, blocks });
}

export function materializeBlock(family, blockId) {
  const block = family.blocks.find((b) => b.id === blockId);
  if (!block) fail(`block not found: ${blockId}`);
  const ownedSet = new Set(block.elementKeys);
  const order = rgaTraversal(family.checkpoint);
  let text = '';
  for (const [key, element] of order) {
    if (ownedSet.has(key) && element.deletedBy.length === 0) text += element.scalar;
  }
  return text;
}

export function splitBlock(family, blockId, newBlockId, utf16Offset) {
  const blockIndex = family.blocks.findIndex((b) => b.id === blockId);
  if (blockIndex === -1) fail(`block not found: ${blockId}`);
  if (family.blocks.some((b) => b.id === newBlockId)) fail(`duplicate block id: ${newBlockId}`);
  assertBlockId(newBlockId);
  const block = family.blocks[blockIndex];
  const ownedSet = new Set(block.elementKeys);
  const blockText = materializeBlock(family, blockId);
  assertUtf16Offset(blockText, utf16Offset);
  const order = rgaTraversal(family.checkpoint);
  let visibleCount = 0;
  let splitIndex = -1;
  for (let i = 0; i < order.length; i++) {
    const [key, element] = order[i];
    if (ownedSet.has(key) && element.deletedBy.length === 0) {
      if (visibleCount === utf16Offset) { splitIndex = i; break; }
      visibleCount += element.scalar.length;
    }
  }
  if (splitIndex === -1) splitIndex = order.length;
  const leftKeys = order.slice(0, splitIndex).map(([key]) => key).filter((k) => ownedSet.has(k)).sort();
  const rightKeys = order.slice(splitIndex).map(([key]) => key).filter((k) => ownedSet.has(k)).sort();
  const combined = [...leftKeys, ...rightKeys].sort();
  const original = [...block.elementKeys].sort();
  if (JSON.stringify(combined) !== JSON.stringify(original)) {
    fail('split lost or duplicated an element key');
  }
  const newBlocks = [...family.blocks];
  newBlocks[blockIndex] = Object.freeze({ id: blockId, elementKeys: Object.freeze(leftKeys) });
  newBlocks.splice(blockIndex + 1, 0, Object.freeze({ id: newBlockId, elementKeys: Object.freeze(rightKeys) }));
  return deepFreeze({ id: family.id, checkpoint: family.checkpoint, blocks: newBlocks });
}

export function mergeBlocks(family, leftBlockId, rightBlockId) {
  const leftIndex = family.blocks.findIndex((b) => b.id === leftBlockId);
  if (leftIndex === -1) fail(`block not found: ${leftBlockId}`);
  const rightIndex = family.blocks.findIndex((b) => b.id === rightBlockId);
  if (rightIndex === -1) fail(`block not found: ${rightBlockId}`);
  if (rightIndex !== leftIndex + 1) fail('blocks must be adjacent');
  const leftBlock = family.blocks[leftIndex];
  const rightBlock = family.blocks[rightIndex];
  const mergedKeys = [...leftBlock.elementKeys, ...rightBlock.elementKeys].sort();
  const newBlocks = [...family.blocks];
  newBlocks[leftIndex] = Object.freeze({ id: leftBlockId, elementKeys: Object.freeze(mergedKeys) });
  newBlocks.splice(rightIndex, 1);
  return deepFreeze({ id: family.id, checkpoint: family.checkpoint, blocks: newBlocks });
}

export function textFamilyCheckpoint(family) {
  return deepFreeze({ id: family.id, checkpoint: family.checkpoint, blocks: family.blocks });
}
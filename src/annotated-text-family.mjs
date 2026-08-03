import {
  assertFrontier, assertStructuralPoint, assertUtf16Offset,
  compareOpId, frontierDominates, restoreTextCheckpoint,
  textCheckpoint, canonicalTextOp, applyTextOp,
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

export function rgaTraversal(checkpoint) {
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

  const elementCount = Object.keys(checkpoint.elements).length;
  if (elementCount > 0) {
    for (const block of blocks) {
      if (block.elementKeys.length === 0) fail('block must own at least one structural element on nonempty checkpoint');
    }
  } else {
    if (blocks.length !== 1) fail('empty checkpoint must have exactly one block');
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
  if (block.elementKeys.length === 0) fail('cannot split an empty block');
  const ownedSet = new Set(block.elementKeys);
  const blockText = materializeBlock(family, blockId);
  assertUtf16Offset(blockText, utf16Offset);
  if (utf16Offset === 0 || utf16Offset === blockText.length) {
    return { type: 'unchanged', reason: 'empty-child', family, retainedBlockId: blockId };
  }
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
  if (leftKeys.length === 0 || rightKeys.length === 0) {
    return { type: 'unchanged', reason: 'empty-child', family, retainedBlockId: blockId };
  }
  const newBlocks = [...family.blocks];
  newBlocks[blockIndex] = Object.freeze({ id: blockId, elementKeys: Object.freeze(leftKeys) });
  newBlocks.splice(blockIndex + 1, 0, Object.freeze({ id: newBlockId, elementKeys: Object.freeze(rightKeys) }));
  return {
    type: 'split',
    family: deepFreeze({ id: family.id, checkpoint: family.checkpoint, blocks: newBlocks }),
    leftBlockId: blockId,
    rightBlockId: newBlockId,
  };
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

function opKey(op) {
  return `${op[0]}:${op[1]}`;
}

function elementKey(op, ordinal) {
  return `${opKey(op)}:${ordinal}`;
}

function anchorKeyStr(anchor) {
  return anchor[0] === 'root' ? ROOT_ID : `${anchor[1][0][0]}:${anchor[1][0][1]}:${anchor[1][1]}`;
}

function isAncestor(checkpoint, ancestorKey, descendantKey) {
  if (ancestorKey === ROOT_ID) return true;
  if (ancestorKey === descendantKey) return false;
  let current = descendantKey;
  while (current !== ROOT_ID) {
    current = checkpoint.elements[current].parent;
    if (current === ancestorKey) return true;
  }
  return false;
}

function findLastOwnedKey(family, ownedSet) {
  const order = rgaTraversal(family.checkpoint);
  for (let i = order.length - 1; i >= 0; i--) {
    const [key] = order[i];
    if (ownedSet.has(key)) return key;
  }
  return null;
}

function isCanonicalBlockEnd(family, ownedSet, endpoint) {
  if (endpoint.point[2] !== 'right') return false;
  const lastKey = findLastOwnedKey(family, ownedSet);
  if (lastKey === null) return false;
  return anchorKeyStr(endpoint.point[1]) === lastKey;
}

function endpointVirtualPosition(family, endpoint) {
  const checkpoint = family.checkpoint;
  const order = rgaTraversal(checkpoint);
  const anchor = endpoint.point[1];
  const affinity = endpoint.point[2];
  const anchorKey = anchorKeyStr(anchor);

  if (anchorKey === ROOT_ID) {
    if (affinity === 'left') return 0;
    const basisFrontier = endpoint.basisFrontier;
    for (let i = 0; i < order.length; i++) {
      const [, element] = order[i];
      if (element.parent === ROOT_ID && frontierDominates(basisFrontier, [[...element.op]])) {
        return i;
      }
    }
    return order.length;
  }

  const anchorIdx = order.findIndex(([k]) => k === anchorKey);
  if (anchorIdx === -1) fail('anchor element not found in checkpoint');

  if (affinity === 'left') {
    return anchorIdx + 1;
  }

  const basisFrontier = endpoint.basisFrontier;
  for (let i = anchorIdx + 1; i < order.length; i++) {
    const [key, element] = order[i];
    if (element.parent === anchorKey && frontierDominates(basisFrontier, [[...element.op]])) {
      return i;
    }
    if (!isAncestor(checkpoint, anchorKey, key)) return i;
  }
  return order.length;
}

export function assertStructuralEndpoint(endpoint) {
  if (!endpoint || typeof endpoint !== 'object' || Array.isArray(endpoint)) {
    fail('endpoint must be a non-array object');
  }
  const allowedKeys = ['point', 'basisFrontier'];
  for (const key of Object.keys(endpoint)) {
    if (!allowedKeys.includes(key)) fail(`unknown endpoint key: ${key}`);
  }
  assertStructuralPoint(endpoint.point);
  assertFrontier(endpoint.basisFrontier);
  return deepFreeze({ point: endpoint.point, basisFrontier: endpoint.basisFrontier });
}

export function compareStructuralEndpoints(family, left, right) {
  if (JSON.stringify(left.basisFrontier) !== JSON.stringify(right.basisFrontier)) {
    fail('endpoint basis mismatch: compareStructuralEndpoints requires identical basisFrontier');
  }
  if (JSON.stringify(family.checkpoint.frontier) !== JSON.stringify(left.basisFrontier)) {
    fail('endpoint basis mismatch: compareStructuralEndpoints requires basisFrontier equal to family checkpoint frontier');
  }

  const leftAnchor = left.point[1];
  const rightAnchor = right.point[1];
  const leftAffinity = left.point[2];
  const rightAffinity = right.point[2];
  const leftKey = anchorKeyStr(leftAnchor);
  const rightKey = anchorKeyStr(rightAnchor);

  if (leftKey === rightKey) {
    if (leftAffinity === rightAffinity) return 0;
    return leftAffinity === 'left' ? -1 : 1;
  }

  const leftPos = endpointVirtualPosition(family, left);
  const rightPos = endpointVirtualPosition(family, right);
  if (leftPos !== rightPos) return leftPos - rightPos;

  return leftKey < rightKey ? -1 : 1;
}

export function projectEndpointToBlockOffset(family, blockId, endpoint) {
  const block = family.blocks.find((b) => b.id === blockId);
  if (!block) fail(`block not found: ${blockId}`);
  if (JSON.stringify(family.checkpoint.frontier) !== JSON.stringify(endpoint.basisFrontier)) {
    fail('projectEndpointToBlockOffset requires basisFrontier equal to family checkpoint frontier');
  }

  const ownedSet = new Set(block.elementKeys);
  const anchorKey = anchorKeyStr(endpoint.point[1]);
  const blockIndex = family.blocks.findIndex((b) => b.id === blockId);

  if (anchorKey === ROOT_ID) {
    if (blockIndex !== 0) fail('projectEndpointToBlockOffset: root anchor only valid for first block');
  } else if (!ownedSet.has(anchorKey)) {
    if (blockIndex === 0) fail('projectEndpointToBlockOffset: foreign anchor not valid for first block');
    const priorBlock = family.blocks[blockIndex - 1];
    const priorOwned = new Set(priorBlock.elementKeys);
    if (!priorOwned.has(anchorKey)) fail('projectEndpointToBlockOffset: anchor must be in named block or adjacent prior block');
    const lastPriorKey = findLastOwnedKey(family, priorOwned);
    if (anchorKey !== lastPriorKey) fail('projectEndpointToBlockOffset: prior block anchor must be its final owned element');
    if (endpoint.point[2] !== 'right') fail('projectEndpointToBlockOffset: prior block anchor must have right affinity');
  }

  const pos = endpointVirtualPosition(family, endpoint);
  const order = rgaTraversal(family.checkpoint);

  let offset = 0;
  for (let i = 0; i < pos; i++) {
    const [key, element] = order[i];
    if (ownedSet.has(key) && element.deletedBy.length === 0) offset += element.scalar.length;
  }
  return offset;
}

export function resolvePositionToEndpoint(family, blockId, utf16Offset, basisFrontier, affinity) {
  assertBlockId(blockId);
  const blockIndex = family.blocks.findIndex((b) => b.id === blockId);
  if (blockIndex === -1) fail(`block not found: ${blockId}`);
  const block = family.blocks[blockIndex];
  const ownedSet = new Set(block.elementKeys);
  const checkpoint = family.checkpoint;
  const order = rgaTraversal(checkpoint);

  if (JSON.stringify(family.checkpoint.frontier) !== JSON.stringify(basisFrontier)) {
    fail('resolvePositionToEndpoint requires basisFrontier equal to family checkpoint frontier');
  }

  const blockText = materializeBlock(family, blockId);
  assertUtf16Offset(blockText, utf16Offset);

  const hasVisibleScalar = [...ownedSet].some((k) => checkpoint.elements[k].deletedBy.length === 0);

  if (utf16Offset === 0) {
    if (!hasVisibleScalar) {
      if (affinity !== 'left' && affinity !== 'right') fail('fully tombstoned block offset 0 is ambiguous; provide explicit affinity');
      if (ownedSet.size === 0 && blockIndex === 0) {
        return assertStructuralEndpoint({ point: ['point', ['root'], 'left'], basisFrontier });
      }
      if (affinity === 'right') {
        const lastOwnedKey = findLastOwnedKey(family, ownedSet);
        if (lastOwnedKey === null) fail('block has no elements');
        const element = checkpoint.elements[lastOwnedKey];
        return assertStructuralEndpoint({
          point: ['point', ['element', [[...element.op], element.ordinal]], 'right'],
          basisFrontier,
        });
      }
      if (blockIndex === 0) return assertStructuralEndpoint({ point: ['point', ['root'], 'left'], basisFrontier });
    }
    if (blockIndex === 0) {
      return assertStructuralEndpoint({ point: ['point', ['root'], 'left'], basisFrontier });
    }
    for (let i = order.length - 1; i >= 0; i--) {
      const [key, element] = order[i];
      if (new Set(family.blocks[blockIndex - 1].elementKeys).has(key)) {
        return assertStructuralEndpoint({
          point: ['point', ['element', [[...element.op], element.ordinal]], 'right'],
          basisFrontier,
        });
      }
    }
    fail('cannot find predecessor block final element');
  }

  const totalVisible = blockText.length;
  if (utf16Offset === totalVisible) {
    let lastOwnedKey = null;
    for (let i = order.length - 1; i >= 0; i--) {
      const [key] = order[i];
      if (ownedSet.has(key)) { lastOwnedKey = key; break; }
    }
    if (lastOwnedKey === null) fail('block has no elements');
    const element = checkpoint.elements[lastOwnedKey];
    return assertStructuralEndpoint({
      point: ['point', ['element', [[...element.op], element.ordinal]], 'right'],
      basisFrontier,
    });
  }

  let accumulated = 0;
  for (const [key, element] of order) {
    const visible = ownedSet.has(key) && element.deletedBy.length === 0;
    const width = visible ? element.scalar.length : 0;
    const postScalar = accumulated + width;
    if (visible && accumulated < utf16Offset && utf16Offset <= postScalar) {
      if (utf16Offset === postScalar) {
        return assertStructuralEndpoint({
          point: ['point', ['element', [[...element.op], element.ordinal]], 'right'],
          basisFrontier,
        });
      }
      return assertStructuralEndpoint({
        point: ['point', ['element', [[...element.op], element.ordinal]], 'left'],
        basisFrontier,
      });
    }
    accumulated = postScalar;
  }
  fail('failed to resolve position to endpoint');
}

export function assertMembershipRange(family, blockId, startEndpoint, endEndpoint) {
  assertBlockId(blockId);
  const block = family.blocks.find((b) => b.id === blockId);
  if (!block) fail(`block not found: ${blockId}`);

  if (JSON.stringify(startEndpoint.basisFrontier) !== JSON.stringify(endEndpoint.basisFrontier)) {
    fail('membership range endpoints must have the same basisFrontier');
  }
  if (JSON.stringify(family.checkpoint.frontier) !== JSON.stringify(startEndpoint.basisFrontier)) {
    fail('membership range requires basisFrontier equal to family checkpoint frontier');
  }

  const ownedSet = new Set(block.elementKeys);
  const endKey = anchorKeyStr(endEndpoint.point[1]);
  const startKey = anchorKeyStr(startEndpoint.point[1]);

  if (endKey === ROOT_ID) fail('membership range end must not be a root anchor');
  if (!ownedSet.has(endKey)) fail('end anchor must be owned by named block');
  if (!isCanonicalBlockEnd(family, ownedSet, endEndpoint)) {
    fail('end must be canonical block end: final owned element with right affinity');
  }

  const blockIndex = family.blocks.findIndex((b) => b.id === blockId);

  if (startKey === ROOT_ID) {
    if (startEndpoint.point[2] !== 'left') fail('membership range root start must have left affinity');
    if (blockIndex !== 0) fail('root start only valid for first block');
  } else if (ownedSet.has(startKey)) {
    fail('start anchor owned by named block is not the canonical lower boundary');
  } else {
    if (blockIndex === 0) fail('non-root start anchor must be in named block for first block');

    let priorBlock = null;
    let priorOwned = null;
    for (let i = blockIndex - 1; i >= 0; i--) {
      const candidate = family.blocks[i];
      const candidateOwned = new Set(candidate.elementKeys);
      if (candidateOwned.size > 0) {
        priorBlock = candidate;
        priorOwned = candidateOwned;
        break;
      }
    }
    if (!priorBlock) fail('no non-empty predecessor block found for start anchor');
    if (!priorOwned.has(startKey)) fail('start anchor must be in a prior non-empty block');
    if (startEndpoint.point[2] !== 'right') fail('start from prior block must have right affinity');
    const lastPriorKey = findLastOwnedKey(family, priorOwned);
    if (startKey !== lastPriorKey) fail('start from prior block must be its final owned element');
  }

  if (compareStructuralEndpoints(family, startEndpoint, endEndpoint) >= 0) {
    fail('membership range start must be structurally before end');
  }

  const checkpoint = family.checkpoint;
  const order = rgaTraversal(checkpoint);
  const startPos = endpointVirtualPosition(family, startEndpoint);
  const endPos = endpointVirtualPosition(family, endEndpoint);

  let visibleWidth = 0;
  for (let i = startPos; i < endPos; i++) {
    const [key, element] = order[i];
    if (!ownedSet.has(key)) fail('range covers element not owned by named block');
    if (element.deletedBy.length === 0) visibleWidth += element.scalar.length;
  }

  if (visibleWidth <= 0) {
    fail('membership range must include positive visible UTF-16 width');
  }

  return deepFreeze({ start: startEndpoint, end: endEndpoint, blockId });
}

export function applyTextOperationToBlock(family, blockId, operation) {
  if (Object.keys(family.checkpoint.pending).length > 0) {
    fail('cannot apply operation to family with pending entries');
  }
  if (family.checkpoint.rebootstrapRequired) {
    fail('cannot apply operation to family requiring rebootstrap');
  }
  const blockIndex = family.blocks.findIndex((b) => b.id === blockId);
  if (blockIndex === -1) fail(`block not found: ${blockId}`);
  const targetBlock = family.blocks[blockIndex];
  const op = canonicalTextOp(operation);
  const frontier = family.checkpoint.frontier;
  const elements = family.checkpoint.elements;
  if (!frontierDominates(frontier, op[4])) {
    fail('operation is not causally ready');
  }
  const body = op[5];
  if (body[0] === 'insert' && body[1][0] === 'element') {
    const anchorElementKey = elementKey(body[1][1][0], body[1][1][1]);
    if (!Object.hasOwn(elements, anchorElementKey)) {
      fail('insert anchor element not found');
    }
  }
  if (body[0] === 'delete') {
    const ownedSet = new Set(targetBlock.elementKeys);
    for (const [target, first, count] of body[1]) {
      for (let ordinal = first; ordinal < first + count; ordinal += 1) {
        const key = elementKey(target, ordinal);
        if (!ownedSet.has(key)) {
          fail('cannot delete elements not owned by target block');
        }
      }
    }
  }
  const state = restoreTextCheckpoint(family.checkpoint);
  const newState = applyTextOp(state, op);
  if (newState.rebootstrapRequired) {
    fail('operation caused rebootstrap requirement');
  }
  if (Object.keys(newState.pending).length > 0) {
    fail('operation would have been buffered as pending');
  }
  const newCheckpoint = textCheckpoint(newState);
  const oldKeys = new Set(Object.keys(elements));
  const newKeys = Object.keys(newCheckpoint.elements).filter((k) => !oldKeys.has(k));
  let newBlocks;
  if (body[0] === 'delete' || newKeys.length === 0) {
    newBlocks = family.blocks;
  } else {
    newBlocks = family.blocks.map((b) => {
      if (b.id === blockId) {
        const merged = [...b.elementKeys, ...newKeys].sort();
        return deepFreeze({ id: b.id, elementKeys: Object.freeze(merged) });
      }
      return b;
    });
    assertBlockOwnerships(newCheckpoint, newBlocks);
  }
  return deepFreeze({
    id: family.id,
    checkpoint: newCheckpoint,
    blocks: newBlocks,
  });
}

export function textOperationForOffsetEdit(family, edit, actor, lamport) {
  const basis = family.checkpoint.frontier;
  const op = [actor, 1];
  if (edit.kind === 'text.insert') {
    const block = family.blocks.find((candidate) => candidate.id === edit.at.blockId);
    if (!block) fail(`block not found: ${edit.at.blockId}`);
    const text = materializeBlock(family, edit.at.blockId);
    assertUtf16Offset(text, edit.at.offset);
    const anchor = text.length === 0 && block.elementKeys.length === 0 && family.blocks[0].id === edit.at.blockId && edit.at.offset === 0
      ? ['root']
      : resolvePositionToEndpoint(family, edit.at.blockId, edit.at.offset, basis, edit.at.affinity).point[1];
    return canonicalTextOp(['workbench.text', 1, op, lamport, basis, ['insert', anchor, edit.text]]);
  }
  if (edit.kind !== 'text.delete' || edit.from.blockId !== edit.to.blockId) fail('delete endpoints must name the same block');
  const text = materializeBlock(family, edit.from.blockId);
  assertUtf16Offset(text, edit.from.offset);
  assertUtf16Offset(text, edit.to.offset);
  if (edit.from.offset >= edit.to.offset) fail('delete range must be non-empty and forward');
  const owned = new Set(family.blocks.find((block) => block.id === edit.from.blockId)?.elementKeys ?? []);
  const spans = [];
  let offset = 0;
  for (const [, element] of rgaTraversal(family.checkpoint)) {
    if (!owned.has(elementKey(element.op, element.ordinal)) || element.deletedBy.length) continue;
    const next = offset + element.scalar.length;
    if (offset >= edit.from.offset && next <= edit.to.offset) {
      const prior = spans.at(-1);
      if (prior && prior[0][0] === element.op[0] && prior[0][1] === element.op[1] && prior[1] + prior[2] === element.ordinal) prior[2] += 1;
      else spans.push([[...element.op], element.ordinal, 1]);
    }
    offset = next;
  }
  if (offset !== text.length || spans.length === 0) fail('delete range cannot be resolved');
  return canonicalTextOp(['workbench.text', 1, op, lamport, basis, ['delete', spans]]);
}

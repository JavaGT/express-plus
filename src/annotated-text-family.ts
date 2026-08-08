import {
  assertFrontier, assertStructuralPoint, assertUtf16Offset,
  compareOpId, createTextState, frontierDominates, restoreTextCheckpoint,
  textCheckpoint, canonicalTextOp, applyTextOp,
} from './annotated-text.ts';
import type {
  Anchor, Frontier, OpId, StructuralPoint, TextElement, TextOp, TextState,
} from './annotated-text.ts';

const ROOT_ID = 'root';

export interface StructuralEndpoint {
  point: StructuralPoint;
  basisFrontier: Frontier;
}

export interface TextBlock {
  id: string;
  elementKeys: readonly string[];
}

export interface TextFamily {
  id: string;
  checkpoint: TextState;
  blocks: readonly TextBlock[];
}

export interface StructuralMembershipRange {
  start: StructuralEndpoint;
  end: StructuralEndpoint;
  blockId: string;
}

type OffsetEdit =
  | { kind: 'text.insert'; at: { blockId: string; offset: number; affinity: 'left' | 'right' }; text: string }
  | { kind: 'text.delete'; from: { blockId: string; offset: number }; to: { blockId: string; offset: number } };

type SplitResult =
  | { type: 'unchanged'; reason: 'empty-child'; family: TextFamily; retainedBlockId: string }
  | { type: 'split'; family: TextFamily; leftBlockId: string; rightBlockId: string };

interface BlockLike {
  id: string;
  elementKeys: readonly string[];
}

function fail(message: string): never {
  throw new Error(`invalid annotated-text family: ${message}`);
}

function assertFamilyId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) fail('family id must be a non-empty string');
  return value;
}

function assertBlockId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) fail('block id must be a non-empty string');
  return value;
}

function assertElementKeysArray(value: unknown): string[] {
  if (!Array.isArray(value)) fail('element keys must be an array');
  for (const key of value) {
    if (typeof key !== 'string' || !/^[0-9a-f]{32}:\d+:\d+$/.test(key)) fail(`invalid element key: ${key}`);
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value) as T;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) return value;
  for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  return Object.freeze(value) as T;
}

function buildChildren(checkpoint: TextState): Map<string, Array<[string, TextElement]>> {
  const children = new Map<string, Array<[string, TextElement]>>([[ROOT_ID, []]]);
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

export function rgaTraversal(checkpoint: TextState): Array<[string, TextElement]> {
  const children = buildChildren(checkpoint);
  const order: Array<[string, TextElement]> = [];
  const stack: Array<[string, TextElement]> = [...(children.get(ROOT_ID) ?? [])].reverse();
  while (stack.length > 0) {
    const entry = stack.pop() as [string, TextElement];
    order.push(entry);
    const descendants = children.get(entry[0]);
    if (descendants) stack.push(...descendants.slice().reverse());
  }
  return order;
}

function assertBlockOwnerships(checkpoint: TextState, blocks: readonly BlockLike[]) {
  const allOwnedKeys: string[] = [];
  const blockIds = new Set<string>();

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

  const seen = new Set<string>();
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

export function createTextFamily(id: string, checkpoint: unknown, blockId: string): TextFamily {
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

/**
 * Deterministically rebuild the post-create text family for a create event's
 * source blocks: insert the concatenated text as one RGA operation, then split
 * at each block boundary. Used by the create projection reducer and by the
 * committed-log word-timing consumer to resolve word spans to immutable RGA
 * anchors without consulting later document state (Sol D2).
 */
export function importTextFamilyFromBlocks(documentId: string, actor: string, blocks: Array<{ id: string; text: string }>): TextFamily {
  if (typeof documentId !== 'string' || documentId.length === 0) fail('document id must be a non-empty string');
  if (typeof actor !== 'string' || !/^[0-9a-f]{32}$/.test(actor)) fail('import actor must be a 32-hex id');
  if (!Array.isArray(blocks) || blocks.length === 0) fail('import blocks must be non-empty');
  for (const block of blocks) {
    if (!block || typeof block !== 'object' || Array.isArray(block) || typeof block.id !== 'string' || block.id.length === 0 || typeof block.text !== 'string') {
      fail('import block must carry id and text');
    }
  }
  const fullText = blocks.map((block) => block.text).join('');
  let textState: TextState = createTextState();
  if (fullText.length > 0) {
    textState = applyTextOp(textState, ['workbench.text', 1, [actor, 1], 1, [], ['insert', ['root'], fullText]]);
  }
  let family = createTextFamily(documentId, textCheckpoint(textState), blocks[0].id);
  let currentBlockId = blocks[0].id;
  for (let index = 0; index < blocks.length - 1; index++) {
    const split = splitBlock(family, currentBlockId, blocks[index + 1].id, blocks[index].text.length);
    if (split.type !== 'split') fail('import block boundary did not produce a split');
    family = split.family;
    currentBlockId = blocks[index + 1].id;
  }
  return family;
}

export function restoreTextFamilyCheckpoint(familyCheckpoint: unknown): TextFamily {
  const raw = familyCheckpoint as Record<string, any>;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('family checkpoint must be a non-array object');
  }
  const allowedKeys = new Set(['id', 'checkpoint', 'blocks']);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) fail(`unknown family checkpoint key: ${key}`);
  }
  assertFamilyId(raw.id);
  const restored = restoreTextCheckpoint(raw.checkpoint);
  const canonical = textCheckpoint(restored);
  if (!Array.isArray(raw.blocks) || raw.blocks.length === 0) {
    fail('family checkpoint must have at least one block');
  }
  assertBlockOwnerships(canonical, raw.blocks);
  const blocks = raw.blocks.map((block: any) =>
    Object.freeze({ id: block.id, elementKeys: Object.freeze([...block.elementKeys].sort()) }),
  );
  return deepFreeze({ id: raw.id, checkpoint: canonical, blocks });
}

export function materializeBlock(family: TextFamily, blockId: string): string {
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

export function splitBlock(family: TextFamily, blockId: string, newBlockId: string, utf16Offset: number): SplitResult {
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

export function mergeBlocks(family: TextFamily, leftBlockId: string, rightBlockId: string): TextFamily {
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

// An empty block still owns tombstoned elements.  Move that ownership to an
// adjacent surviving block before removing its durable identity.
export function removeEmptyBlock(family: TextFamily, blockId: string): TextFamily {
  const blockIndex = family.blocks.findIndex((block) => block.id === blockId);
  if (blockIndex === -1) fail(`block not found: ${blockId}`);
  if (family.blocks.length === 1) fail('cannot remove the final block');
  if (materializeBlock(family, blockId).length !== 0) fail('cannot remove a non-empty block');
  const recipientIndex = blockIndex > 0 ? blockIndex - 1 : 1;
  const recipient = family.blocks[recipientIndex];
  const removed = family.blocks[blockIndex];
  const blocks = family.blocks
    .filter((block) => block.id !== blockId)
    .map((block) => block.id === recipient.id
      ? Object.freeze({ id: block.id, elementKeys: Object.freeze([...block.elementKeys, ...removed.elementKeys].sort()) })
      : block);
  return deepFreeze({ id: family.id, checkpoint: family.checkpoint, blocks });
}

export function textFamilyCheckpoint(family: TextFamily): TextFamily {
  return deepFreeze({ id: family.id, checkpoint: family.checkpoint, blocks: family.blocks });
}

function opKey(op: OpId | TextOp): string {
  return `${op[0]}:${op[1]}`;
}

function elementKey(op: OpId, ordinal: number): string {
  return `${opKey(op)}:${ordinal}`;
}

function anchorKeyStr(anchor: Anchor): string {
  return anchor[0] === 'root' ? ROOT_ID : `${anchor[1][0][0]}:${anchor[1][0][1]}:${anchor[1][1]}`;
}

function isAncestor(checkpoint: TextState, ancestorKey: string, descendantKey: string): boolean {
  if (ancestorKey === ROOT_ID) return true;
  if (ancestorKey === descendantKey) return false;
  let current = descendantKey;
  while (current !== ROOT_ID) {
    current = checkpoint.elements[current].parent;
    if (current === ancestorKey) return true;
  }
  return false;
}

function findLastOwnedKey(family: TextFamily, ownedSet: Set<string>): string | null {
  const order = rgaTraversal(family.checkpoint);
  for (let i = order.length - 1; i >= 0; i--) {
    const [key] = order[i];
    if (ownedSet.has(key)) return key;
  }
  return null;
}

function endpointVirtualPosition(family: TextFamily, endpoint: StructuralEndpoint): number {
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

export function assertStructuralEndpoint(endpoint: unknown): StructuralEndpoint {
  if (!endpoint || typeof endpoint !== 'object' || Array.isArray(endpoint)) {
    fail('endpoint must be a non-array object');
  }
  const raw = endpoint as Record<string, any>;
  const allowedKeys = ['point', 'basisFrontier'];
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.includes(key)) fail(`unknown endpoint key: ${key}`);
  }
  assertStructuralPoint(raw.point);
  assertFrontier(raw.basisFrontier);
  return deepFreeze({ point: raw.point, basisFrontier: raw.basisFrontier });
}

export function compareStructuralEndpoints(family: TextFamily, left: StructuralEndpoint, right: StructuralEndpoint): number {
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

export function projectEndpointToBlockOffset(family: TextFamily, blockId: string, endpoint: StructuralEndpoint): number {
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

export function resolvePositionToEndpoint(family: TextFamily, blockId: string, utf16Offset: number, basisFrontier: Frontier, affinity: 'left' | 'right'): StructuralEndpoint {
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
    let lastOwnedKey: string | null = null;
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

export function assertMembershipRange(family: TextFamily, blockId: string, startEndpoint: StructuralEndpoint, endEndpoint: StructuralEndpoint): StructuralMembershipRange {
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
  // Span-native model: an end is any owned right-affinity boundary within the
  // block (interior or block end), not only the canonical block end.
  if (endEndpoint.point[2] !== 'right') fail('membership range end must have right affinity');

  const blockIndex = family.blocks.findIndex((b) => b.id === blockId);

  if (startKey === ROOT_ID) {
    if (startEndpoint.point[2] !== 'left') fail('membership range root start must have left affinity');
    if (blockIndex !== 0) fail('root start only valid for first block');
  } else if (ownedSet.has(startKey)) {
    // Span-native model: an interior start anchored within the block is valid.
    if (startEndpoint.point[2] !== 'right') fail('interior start within named block must have right affinity');
  } else {
    if (blockIndex === 0) fail('non-root start anchor must be in named block for first block');

    let priorBlock: TextBlock | null = null;
    let priorOwned: Set<string> | null = null;
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
    if (!priorOwned!.has(startKey)) fail('start anchor must be in a prior non-empty block');
    if (startEndpoint.point[2] !== 'right') fail('start from prior block must have right affinity');
    const lastPriorKey = findLastOwnedKey(family, priorOwned!);
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

export function applyTextOperationToBlock(family: TextFamily, blockId: string, operation: unknown): TextFamily {
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
  let newBlocks: readonly TextBlock[];
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

// Apply an insertion whose destination block is created by the same structural
// operation.  Keeping this here (rather than manufacturing an empty block) is
// important: family checkpoints with live elements cannot contain empty blocks.
export function applyTextOperationToNewBlock(family: TextFamily, sourceBlockId: string, newBlockId: string, operation: unknown, side: 'before' | 'after'): TextFamily {
  if (side !== 'before' && side !== 'after') fail('new block side must be before or after');
  if (family.blocks.some((block) => block.id === newBlockId)) fail(`duplicate block id: ${newBlockId}`);
  if (Object.keys(family.checkpoint.pending).length > 0) fail('cannot apply operation to family with pending entries');
  if (family.checkpoint.rebootstrapRequired) fail('cannot apply operation to family requiring rebootstrap');
  const sourceIndex = family.blocks.findIndex((block) => block.id === sourceBlockId);
  if (sourceIndex < 0) fail(`block not found: ${sourceBlockId}`);
  const op = canonicalTextOp(operation);
  if (!frontierDominates(family.checkpoint.frontier, op[4])) fail('operation is not causally ready');
  if (op[5][0] === 'insert' && op[5][1][0] === 'element' && !Object.hasOwn(family.checkpoint.elements, elementKey(op[5][1][1][0], op[5][1][1][1]))) fail('insert anchor element not found');
  const state = restoreTextCheckpoint(family.checkpoint);
  const nextState = applyTextOp(state, op);
  if (nextState.rebootstrapRequired || Object.keys(nextState.pending).length > 0) fail('operation would not apply immediately');
  const nextCheckpoint = textCheckpoint(nextState);
  const oldKeys = new Set(Object.keys(family.checkpoint.elements));
  const newKeys = Object.keys(nextCheckpoint.elements).filter((key) => !oldKeys.has(key));
  if (newKeys.length === 0) fail('operation did not insert elements');
  const blocks = family.blocks.map((block) => ({ id: block.id, elementKeys: [...block.elementKeys] }));
  const newBlock = { id: newBlockId, elementKeys: newKeys.sort() };
  const index = side === 'before' ? sourceIndex : sourceIndex + 1;
  blocks.splice(index, 0, newBlock);
  // The operation's new elements are deliberately owned only by the new block.
  return restoreTextFamilyCheckpoint({ id: family.id, checkpoint: nextCheckpoint, blocks });
}

export function textOperationForOffsetEdit(family: TextFamily, edit: OffsetEdit, actor: string, lamport: number): TextOp {
  const basis = family.checkpoint.frontier;
  const op: OpId = [actor, 1];
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
  // Collect target scalars, then emit spans sorted by op id with consecutive
  // ordinals merged. Document order is NOT op-id order: each offset-edit uses a
  // unique actor (`[actor, 1]`), so multi-character deletes (select-all, etc.)
  // fail assertDeleteSpans unless spans are reordered like public deleteText().
  const byOp = new Map<string, number[]>();
  let offset = 0;
  for (const [, element] of rgaTraversal(family.checkpoint)) {
    if (!owned.has(elementKey(element.op, element.ordinal)) || element.deletedBy.length) continue;
    const next = offset + element.scalar.length;
    if (offset >= edit.from.offset && next <= edit.to.offset) {
      const key = `${element.op[0]}:${element.op[1]}`;
      const list = byOp.get(key);
      if (list) list.push(element.ordinal);
      else byOp.set(key, [element.ordinal]);
    }
    offset = next;
  }
  if (offset !== text.length || byOp.size === 0) fail('delete range cannot be resolved');
  const spans: Array<[OpId, number, number]> = [];
  const sortedKeys = [...byOp.keys()].sort((a, b) => {
    const [aActor, aCounter] = a.split(':');
    const [bActor, bCounter] = b.split(':');
    return compareOpId([aActor, Number(aCounter)], [bActor, Number(bCounter)]);
  });
  for (const key of sortedKeys) {
    const [spActor, spCounterS] = key.split(':');
    const spCounter = Number(spCounterS);
    const ordinals = byOp.get(key)!.sort((a, b) => a - b);
    let spanStart = ordinals[0];
    let spanCount = 1;
    for (let i = 1; i < ordinals.length; i++) {
      if (ordinals[i] === ordinals[i - 1] + 1) {
        spanCount += 1;
      } else {
        spans.push([[spActor, spCounter], spanStart, spanCount]);
        spanStart = ordinals[i];
        spanCount = 1;
      }
    }
    spans.push([[spActor, spCounter], spanStart, spanCount]);
  }
  return canonicalTextOp(['workbench.text', 1, op, lamport, basis, ['delete', spans]]);
}

// Blockless continuous annotated-text family (issue #33).
//
// The RGA checkpoint already holds the whole document text; blocks were a
// redundant partition imposed by elementKeys ownership. This module drops the
// block layer entirely: one continuous text stream per document, absolute
// UTF-16 offsets, and annotations as character ranges resolved to structural
// endpoints.
//
// Endpoint semantics (the load-bearing correction): stored endpoints keep their
// historical `basisFrontier` and are positioned against the CURRENT checkpoint
// as long as the current frontier DOMINATES the basis and the anchor element
// still exists (including as a tombstone). They are never rebased to the latest
// frontier — that would silently move boundary semantics after ordinary edits.

import {
  applyTextOp,
  assertFrontier,
  assertUtf16Offset,
  canonicalTextOp,
  compareOpId,
  compareOpIdValidated,
  createTextState,
  frontierDominatesValidated,
  restoreTextCheckpoint,
  textCheckpoint,
} from './workbench-annotated-text.mjs';

const ROOT_ID = 'root';
const trustedFamilies = new WeakSet();
const materializedTextCache = new WeakMap();
const derivedIndexCache = new WeakMap();

function fail(message) {
  throw new Error(`annotated-text continuous: ${message}`);
}

function trustFamily(family) {
  const trusted = deepFreeze(family);
  trustedFamilies.add(trusted);
  return trusted;
}

/** Max op lamport across a checkpoint — computed once per restore/import (cold path). */
function maxLamportOf(checkpoint) {
  let max = 0;
  for (const element of Object.values(checkpoint.elements)) {
    if (element.lamport > max) max = element.lamport;
  }
  return max;
}

// Family shell carries `maxLamport` so per-keystroke offsets don't rescan every
// element to find the next lamport (the editor's optimistic projection runs
// once per key and that scan was ~20% of its cost).
function familyOf(id, checkpoint, maxLamport) {
  return trustFamily({ id, checkpoint, maxLamport: maxLamport !== undefined ? maxLamport : maxLamportOf(checkpoint) });
}

function assertTrustedFamily(family) {
  if (!family || typeof family !== 'object' || !trustedFamilies.has(family)) {
    fail('family must be created or restored by this module');
  }
  return family;
}

/** A continuous family is the document id + the RGA checkpoint. No blocks. */
export function restoreTextFamily(familyCheckpoint) {
  if (!familyCheckpoint || typeof familyCheckpoint !== 'object' || Array.isArray(familyCheckpoint)) {
    fail('family checkpoint must be a non-array object');
  }
  const allowedKeys = new Set(['id', 'checkpoint', 'maxLamport']);
  for (const key of Object.keys(familyCheckpoint)) {
    if (!allowedKeys.has(key)) fail(`unknown family checkpoint key: ${key}`);
  }
  if (typeof familyCheckpoint.id !== 'string' || familyCheckpoint.id.length === 0) {
    fail('family checkpoint id must be a non-empty string');
  }
  const checkpoint = restoreTextCheckpoint(familyCheckpoint.checkpoint);
  return familyOf(familyCheckpoint.id, checkpoint, familyCheckpoint.maxLamport);
}

export function createTextFamily(id, checkpoint) {
  if (typeof id !== 'string' || id.length === 0) fail('document id must be a non-empty string');
  const restored = restoreTextCheckpoint(checkpoint);
  return familyOf(id, restored);
}

/**
 * Seed a continuous family from plain text (one root element; blocks are gone).
 * A single multi-scalar element is the canonical import shape — mid-element
 * offset edits resolve correctly (verified) — so import is O(1), not O(chars).
 */
export function importTextToFamily(documentId, actor, text) {
  if (typeof documentId !== 'string' || documentId.length === 0) fail('document id must be a non-empty string');
  if (typeof actor !== 'string' || !/^[0-9a-f]{32}$/.test(actor)) fail('import actor must be a 32-hex id');
  if (typeof text !== 'string') fail('import text must be a string');
  let state = createTextState();
  if (text.length > 0) {
    state = applyTextOp(state, ['workbench.text', 1, [actor, 1], 1, [], ['insert', ['root'], text]]);
  }
  return createTextFamily(documentId, textCheckpoint(state));
}

export function textFamilyCheckpoint(family) {
  assertTrustedFamily(family);
  return trustFamily({ id: family.id, checkpoint: family.checkpoint, maxLamport: family.maxLamport });
}

export function materializeText(family) {
  const trusted = assertTrustedFamily(family);
  const cached = materializedTextCache.get(trusted);
  if (cached !== undefined) return cached;
  const text = derivedIndex(trusted).text;
  materializedTextCache.set(trusted, text);
  return text;
}

function anchorKeyStr(anchor) {
  if (anchor[0] === 'root') return ROOT_ID;
  return `${anchor[1][0][0]}:${anchor[1][0][1]}:${anchor[1][1]}`;
}

function rgaTraversal(checkpoint) {
  const children = new Map([[ROOT_ID, []]]);
  for (const [key, element] of Object.entries(checkpoint.elements)) {
    const list = children.get(element.parent) ?? [];
    list.push([key, element]);
    children.set(element.parent, list);
  }
  for (const list of children.values()) {
    list.sort(([, left], [, right]) => right.lamport - left.lamport || -compareOpIdValidated(left.op, right.op));
  }
  const order = [];
  const stack = [...(children.get(ROOT_ID) ?? [])].reverse();
  while (stack.length > 0) {
    const entry = stack.pop();
    order.push(entry);
    const descendants = children.get(entry[0]);
    if (descendants) stack.push(...descendants.slice().reverse());
  }
  return order;
}

function derivedIndex(family) {
  const cached = derivedIndexCache.get(family);
  if (cached) return cached;
  const order = rgaTraversal(family.checkpoint);
  const positions = new Map();
  const visibleOffsets = [0];
  let visibleOffset = 0;
  let text = '';
  for (let index = 0; index < order.length; index += 1) {
    const [key, element] = order[index];
    positions.set(key, index);
    if (element.deletedBy.length === 0) {
      text += element.scalar;
      visibleOffset += element.scalar.length;
    }
    visibleOffsets.push(visibleOffset);
  }
  const derived = Object.freeze({ order, positions, visibleOffsets, text });
  derivedIndexCache.set(family, derived);
  return derived;
}

function endpointVirtualPosition(family, endpoint) {
  const { order, positions } = derivedIndex(family);
  const anchor = endpoint.point[1];
  const affinity = endpoint.point[2];
  const anchorKey = anchorKeyStr(anchor);
  const basis = endpoint.basisFrontier;
  if (anchorKey === ROOT_ID) {
    if (affinity === 'left') return 0;
    for (let i = 0; i < order.length; i += 1) {
      const [, element] = order[i];
      if (element.parent === ROOT_ID && frontierDominatesValidated(basis, [[...element.op]])) return i;
    }
    return order.length;
  }
  const anchorIdx = positions.get(anchorKey);
  if (anchorIdx === undefined) fail('anchor element not found in checkpoint');
  return affinity === 'left' ? anchorIdx : anchorIdx + 1;
}

function assertDominatingBasis(family, endpoint, label) {
  if (!frontierDominatesValidated(family.checkpoint.frontier, endpoint.basisFrontier)) {
    fail(`${label}: current frontier does not dominate endpoint basis — anchor is lost`);
  }
  const anchorKey = anchorKeyStr(endpoint.point[1]);
  if (anchorKey !== ROOT_ID && !Object.hasOwn(family.checkpoint.elements, anchorKey)) {
    fail(`${label}: endpoint anchor element no longer exists`);
  }
}

/**
 * Project a historical-basis endpoint to an absolute UTF-16 offset in the
 * current document. The current frontier must dominate the endpoint basis and
 * the anchor must still exist (including as a tombstone).
 */
export function projectEndpointToOffset(family, endpoint) {
  assertTrustedFamily(family);
  assertDominatingBasis(family, endpoint, 'projectEndpointToOffset');
  const { visibleOffsets } = derivedIndex(family);
  return visibleOffsets[endpointVirtualPosition(family, endpoint)];
}

/** The first visible element after a traversal index, or null when none follow. */
function nextVisibleAnchorAfter(order, index) {
  for (let cursor = index + 1; cursor < order.length; cursor += 1) {
    const [, element] = order[cursor];
    if (element.deletedBy.length === 0) {
      return ['element', [[...element.op], element.ordinal]];
    }
  }
  return null;
}

function endpointAfterLastVisible(_family, order, basisFrontier) {
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const [, element] = order[i];
    if (element.deletedBy.length === 0) {
      return Object.freeze({ point: ['point', ['element', [[...element.op], element.ordinal]], 'right'], basisFrontier });
    }
  }
  return Object.freeze({ point: ['point', ['root'], 'left'], basisFrontier });
}

/**
 * Value equality for frontiers that were already validated at their trust
 * boundaries (admission / assertStructuralEndpoint). Sorted, unique actor ids
 * make mutual domination + equal length exact: every entry of one frontier is
 * covered by the other and neither carries extra actors. This replaces a
 * double `JSON.stringify` per call — resolve runs once or twice per projected
 * annotation endpoint on every render/typing flush.
 */
function frontierEqualsValidated(left, right) {
  if (left === right) return true;
  return left.length === right.length
    && frontierDominatesValidated(left, right)
    && frontierDominatesValidated(right, left);
}

/**
 * Resolve an absolute UTF-16 offset to a structural endpoint against the
 * current family. Mirror of the server primitive so the browser pending
 * projector can anchor authoring positions without shipping offsets across
 * the recipient boundary. The endpoint keeps the family's current frontier as
 * its historical basis; once constructed it never rebases across later edits.
 */
export function resolveOffsetToEndpoint(family, utf16Offset, basisFrontier, affinity) {
  const trusted = assertTrustedFamily(family);
  // Validate the caller-supplied basis at this boundary so a malformed value
  // fails with the controlled frontier message instead of an incidental
  // TypeError inside the comparator below; the checkpoint side was validated
  // at admission/restoration.
  const trustedBasis = assertFrontier(basisFrontier);
  if (!frontierEqualsValidated(trusted.checkpoint.frontier, trustedBasis)) {
    fail('resolveOffsetToEndpoint requires basisFrontier equal to family checkpoint frontier');
  }
  const { order, text, visibleOffsets } = derivedIndex(trusted);
  assertUtf16Offset(text, utf16Offset);
  if (affinity !== 'left' && affinity !== 'right') fail('resolveOffsetToEndpoint requires an explicit affinity');

  if (utf16Offset === 0) {
    return Object.freeze({ point: ['point', ['root'], 'left'], basisFrontier });
  }
  if (utf16Offset === text.length) {
    return endpointAfterLastVisible(trusted, order, basisFrontier);
  }

  // First traversal position whose cumulative visible offset reaches the
  // request. `visibleOffsets[i]` is the visible offset after element i.
  let lo = 1;
  let hi = visibleOffsets.length - 1;
  while (lo < hi) {
    const mid = lo + ((hi - lo) >> 1);
    if (visibleOffsets[mid] >= utf16Offset) hi = mid;
    else lo = mid + 1;
  }

  const elementIndex = lo - 1;
  const element = order[elementIndex][1];
  const anchor = ['element', [[...element.op], element.ordinal]];
  if (utf16Offset === visibleOffsets[lo]) {
    if (affinity === 'left') {
      const nextAnchor = nextVisibleAnchorAfter(order, elementIndex);
      if (nextAnchor) {
        return Object.freeze({ point: ['point', nextAnchor, 'left'], basisFrontier });
      }
    }
    return Object.freeze({ point: ['point', anchor, 'right'], basisFrontier });
  }
  return Object.freeze({ point: ['point', anchor, 'left'], basisFrontier });
}

/**
 * The RGA anchor element for an insert AT an absolute offset: the last visible
 * element whose scalar ends at or contains the offset.
 *
 * Resolved through the cached `derivedIndex` with the same
 * first-position-that-reaches-the-offset binary search as endpoint projection:
 * `visibleOffsets[lo - 1] < offset <= visibleOffsets[lo]` names exactly the
 * visible element the raw walk used to land on (tombstone runs carry zero
 * width, so the search steps over them).
 */
export function insertAnchorForOffset(family, utf16Offset) {
  const { order, visibleOffsets } = derivedIndex(family);
  const textLength = visibleOffsets[visibleOffsets.length - 1];
  // Same acceptance domain as the former walk: positive offsets up to the
  // visible length resolve (fractional offsets name their containing element);
  // anything else — zero, past-the-end, NaN — fails identically.
  if (!(utf16Offset > 0 && utf16Offset <= textLength)) fail('failed to resolve insert anchor for offset');
  let lo = 1;
  let hi = visibleOffsets.length - 1;
  while (lo < hi) {
    const mid = lo + ((hi - lo) >> 1);
    if (visibleOffsets[mid] >= utf16Offset) hi = mid;
    else lo = mid + 1;
  }
  const [, element] = order[lo - 1];
  return ['element', [[...element.op], element.ordinal]];
}

/** An absolute-offset insert/delete against the whole document (unique actor per edit). */
export function textOperationForOffsetEdit(family, edit, actor, lamport) {
  assertTrustedFamily(family);
  const basis = family.checkpoint.frontier;
  const text = materializeText(family);
  if (edit.kind === 'text.insert') {
    assertUtf16Offset(text, edit.at.offset);
    const anchor = edit.at.offset === 0 || text.length === 0
      ? ['root']
      : insertAnchorForOffset(family, edit.at.offset);
    return canonicalTextOp(['workbench.text', 1, [actor, 1], lamport, basis, ['insert', anchor, edit.text]]);
  }
  if (edit.kind !== 'text.delete') fail('text.replace is not supported by this builder — compose delete + insert operations; emitting a delete-only op would silently drop the replacement text');
  if (edit.from.offset >= edit.to.offset) fail('delete range must be non-empty and forward');
  assertUtf16Offset(text, edit.from.offset);
  assertUtf16Offset(text, edit.to.offset);

  const byOp = new Map();
  let offset = 0;
  for (const [, element] of derivedIndex(family).order) {
    if (element.deletedBy.length) continue;
    const next = offset + element.scalar.length;
    if (offset >= edit.from.offset && next <= edit.to.offset) {
      const opKey = `${element.op[0]}:${element.op[1]}`;
      const list = byOp.get(opKey);
      if (list) list.push(element.ordinal);
      else byOp.set(opKey, [element.ordinal]);
    }
    offset = next;
  }
  if (offset !== text.length || byOp.size === 0) fail('delete range cannot be resolved');
  const spans = [];
  const sortedKeys = [...byOp.keys()].sort((a, b) => {
    const [aActor, aCounter] = a.split(':');
    const [bActor, bCounter] = b.split(':');
    return compareOpId([aActor, Number(aCounter)], [bActor, Number(bCounter)]);
  });
  for (const key of sortedKeys) {
    const [spActor, spCounterS] = key.split(':');
    const spCounter = Number(spCounterS);
    const ordinals = byOp.get(key).sort((a, b) => a - b);
    let spanStart = ordinals[0];
    let spanCount = 1;
    for (let i = 1; i < ordinals.length; i += 1) {
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
  return canonicalTextOp(['workbench.text', 1, [actor, 1], lamport, basis, ['delete', spans]]);
}

let offsetEditActor = 0;
function nextOffsetEditActor() {
  offsetEditActor += 1;
  return offsetEditActor.toString(16).padStart(32, '0');
}

function nextOffsetEditLamport(family) {
  // Max lamport is folded onto the family at apply/restore time, so this is
  // O(1) instead of scanning every element on the per-keystroke hot path.
  return (family.maxLamport ?? 0) + 1;
}

/** Apply one absolute-offset splice [from, to) → `text` to a family copy. */
export function applyOffsetTextEdit(family, from, to, text) {
  assertTrustedFamily(family);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) {
    fail('applyOffsetTextEdit requires a forward [from, to) interval');
  }
  let next = family;
  if (from < to) {
    next = applyTextOperation(next, textOperationForOffsetEdit(
      next, { kind: 'text.delete', from: { offset: from }, to: { offset: to } },
      nextOffsetEditActor(), nextOffsetEditLamport(next),
    ));
  }
  if (typeof text === 'string' && text.length > 0) {
    next = applyTextOperation(next, textOperationForOffsetEdit(
      next, { kind: 'text.insert', at: { offset: from, affinity: 'right' }, text },
      nextOffsetEditActor(), nextOffsetEditLamport(next),
    ));
  }
  return next;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/** Apply a whole-document text operation, returning the next family. */
export function applyTextOperation(family, operation) {
  assertTrustedFamily(family);
  const nextState = applyTextOp(family.checkpoint, operation);
  // Lamport clocks are monotonic; the newest op's lamport extends the max.
  return trustFamily({
    id: family.id,
    checkpoint: nextState,
    maxLamport: Math.max(family.maxLamport ?? 1, operation[3]),
  });
}

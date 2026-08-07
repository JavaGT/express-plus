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
  assertFrontier,
  assertStructuralPoint,
  assertUtf16Offset,
  canonicalTextOp,
  compareOpId,
  frontierDominates,
  materializeText as materializeCheckpointText,
  restoreTextCheckpoint,
  textCheckpoint,
  applyTextOp,
} from './annotated-text.mjs';
import {
  assertStructuralEndpoint,
  rgaTraversal,
} from './annotated-text-family.mjs';

const ROOT_ID = 'root';

function fail(message) {
  throw new Error(`annotated-text continuous: ${message}`);
}

function anchorKeyStr(anchor) {
  if (anchor[0] === 'root') return ROOT_ID;
  return `${anchor[1][0][0]}:${anchor[1][0][1]}:${anchor[1][1]}`;
}

/** A continuous family is the document id + the RGA checkpoint. No blocks. */
export function restoreTextFamily(familyCheckpoint) {
  if (!familyCheckpoint || typeof familyCheckpoint !== 'object' || Array.isArray(familyCheckpoint)) {
    fail('family checkpoint must be a non-array object');
  }
  const allowedKeys = new Set(['id', 'checkpoint']);
  for (const key of Object.keys(familyCheckpoint)) {
    if (!allowedKeys.has(key)) fail(`unknown family checkpoint key: ${key}`);
  }
  if (typeof familyCheckpoint.id !== 'string' || familyCheckpoint.id.length === 0) {
    fail('family checkpoint id must be a non-empty string');
  }
  const checkpoint = restoreTextCheckpoint(familyCheckpoint.checkpoint);
  return deepFreeze({ id: familyCheckpoint.id, checkpoint });
}

export function createTextFamily(id, checkpoint) {
  if (typeof id !== 'string' || id.length === 0) fail('document id must be a non-empty string');
  const restored = restoreTextCheckpoint(checkpoint);
  return deepFreeze({ id, checkpoint: restored });
}

export function textFamilyCheckpoint(family) {
  return deepFreeze({ id: family.id, checkpoint: family.checkpoint });
}

export function materializeText(family) {
  return materializeCheckpointText(restoreTextCheckpoint(family.checkpoint));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object') return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/**
 * Absolute document-wide endpoint position: the index in the RGA traversal
 * order where this endpoint (with its HISTORICAL basis frontier + affinity)
 * sits against the CURRENT checkpoint.
 */
function endpointVirtualPosition(family, endpoint) {
  const checkpoint = family.checkpoint;
  const order = rgaTraversal(checkpoint);
  const anchor = endpoint.point[1];
  const affinity = endpoint.point[2];
  const anchorKey = anchorKeyStr(anchor);
  const basis = endpoint.basisFrontier;

  if (anchorKey === ROOT_ID) {
    if (affinity === 'left') return 0;
    for (let i = 0; i < order.length; i += 1) {
      const [, element] = order[i];
      if (element.parent === ROOT_ID && frontierDominates(basis, [[...element.op]])) return i;
    }
    return order.length;
  }

  const anchorIdx = order.findIndex(([key]) => key === anchorKey);
  if (anchorIdx === -1) fail('anchor element not found in checkpoint');

  if (affinity === 'left') return anchorIdx + 1;

  for (let i = anchorIdx + 1; i < order.length; i += 1) {
    const [, element] = order[i];
    if (element.parent === anchorKey && frontierDominates(basis, [[...element.op]])) return i;
  }
  return order.length;
}

function assertDominatingBasis(family, endpoint, label) {
  if (!frontierDominates(family.checkpoint.frontier, endpoint.basisFrontier)) {
    fail(`${label}: current frontier does not dominate endpoint basis — anchor is lost`);
  }
  const anchorKey = anchorKeyStr(endpoint.point[1]);
  if (anchorKey !== ROOT_ID && !Object.hasOwn(family.checkpoint.elements, anchorKey)) {
    fail(`${label}: endpoint anchor element no longer exists`);
  }
}

/**
 * Compare two structural endpoints against the current checkpoint. Each keeps
 * its historical basis; both must be dominated by the current frontier.
 */
export function compareStructuralEndpoints(family, left, right) {
  assertDominatingBasis(family, left, 'compareStructuralEndpoints');
  assertDominatingBasis(family, right, 'compareStructuralEndpoints');

  const leftAnchor = left.point[1];
  const rightAnchor = right.point[1];
  const leftKey = anchorKeyStr(leftAnchor);
  const rightKey = anchorKeyStr(rightAnchor);

  if (leftKey === rightKey) {
    const leftAffinity = left.point[2];
    const rightAffinity = right.point[2];
    if (leftAffinity === rightAffinity) return 0;
    return leftAffinity === 'left' ? -1 : 1;
  }

  const leftPos = endpointVirtualPosition(family, left);
  const rightPos = endpointVirtualPosition(family, right);
  if (leftPos !== rightPos) return leftPos - rightPos;
  return leftKey < rightKey ? -1 : 1;
}

/** Materialize the visible text between two structural endpoints (zero-width allowed). */
export function materializeRange(family, start, end) {
  assertDominatingBasis(family, start, 'materializeRange');
  assertDominatingBasis(family, end, 'materializeRange');
  if (compareStructuralEndpoints(family, start, end) > 0) fail('materializeRange: start must not be after end');
  const order = rgaTraversal(family.checkpoint);
  const startPos = endpointVirtualPosition(family, start);
  const endPos = endpointVirtualPosition(family, end);
  let text = '';
  for (let i = startPos; i < endPos; i += 1) {
    const [, element] = order[i];
    if (element.deletedBy.length === 0) text += element.scalar;
  }
  return text;
}

/**
 * Resolve an ABSOLUTE UTF-16 offset into the whole document to a structural
 * endpoint. The basis must equal the current frontier (offsets are always
 * resolved against the live document).
 */
export function resolveOffsetToEndpoint(family, utf16Offset, basisFrontier, affinity) {
  if (JSON.stringify(family.checkpoint.frontier) !== JSON.stringify(basisFrontier)) {
    fail('resolveOffsetToEndpoint requires basisFrontier equal to family checkpoint frontier');
  }
  const text = materializeText(family);
  assertUtf16Offset(text, utf16Offset);
  if (affinity !== 'left' && affinity !== 'right') fail('resolveOffsetToEndpoint requires an explicit affinity');

  const order = rgaTraversal(family.checkpoint);
  if (utf16Offset === 0) {
    return assertStructuralEndpoint({ point: ['point', ['root'], 'left'], basisFrontier });
  }
  if (utf16Offset === text.length) {
    return endpointAfterLastVisible(family, order, basisFrontier);
  }

  let accumulated = 0;
  for (const [, element] of order) {
    if (element.deletedBy.length) continue;
    const width = element.scalar.length;
    const postScalar = accumulated + width;
    if (accumulated < utf16Offset && utf16Offset <= postScalar) {
      const anchor = ['element', [[...element.op], element.ordinal]];
      if (utf16Offset === postScalar) {
        return assertStructuralEndpoint({ point: ['point', anchor, 'right'], basisFrontier });
      }
      return assertStructuralEndpoint({ point: ['point', anchor, 'left'], basisFrontier });
    }
    accumulated = postScalar;
  }
  fail('failed to resolve offset to endpoint');
}

function endpointAfterLastVisible(family, order, basisFrontier) {
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const [, element] = order[i];
    if (element.deletedBy.length === 0) {
      return assertStructuralEndpoint({ point: ['point', ['element', [[...element.op], element.ordinal]], 'right'], basisFrontier });
    }
  }
  return assertStructuralEndpoint({ point: ['point', ['root'], 'left'], basisFrontier });
}

/**
 * Project a HISTORICAL-basis endpoint to an absolute UTF-16 offset in the
 * CURRENT document. The current frontier must dominate the endpoint basis and
 * the anchor must still exist (including as a tombstone).
 */
export function projectEndpointToOffset(family, endpoint) {
  assertDominatingBasis(family, endpoint, 'projectEndpointToOffset');
  const order = rgaTraversal(family.checkpoint);
  const pos = endpointVirtualPosition(family, endpoint);
  let offset = 0;
  for (let i = 0; i < pos; i += 1) {
    const [, element] = order[i];
    if (element.deletedBy.length === 0) offset += element.scalar.length;
  }
  return offset;
}

/** An absolute-offset insert/delete/replace against the whole document. */
export function textOperationForOffsetEdit(family, edit, actor, lamport) {
  const basis = family.checkpoint.frontier;
  const text = materializeText(family);
  if (edit.kind === 'text.insert') {
    assertUtf16Offset(text, edit.at.offset);
    const anchor = edit.at.offset === 0 || text.length === 0
      ? ['root']
      : resolveOffsetToEndpoint(family, edit.at.offset, basis, edit.at.affinity).point[1];
    return canonicalTextOp(['workbench.text', 1, [actor, 1], lamport, basis, ['insert', anchor, edit.text]]);
  }
  if (edit.kind !== 'text.delete' && edit.kind !== 'text.replace') fail(`unsupported edit kind: ${edit.kind}`);
  if (edit.from.offset >= edit.to.offset) fail('delete range must be non-empty and forward');
  assertUtf16Offset(text, edit.from.offset);
  assertUtf16Offset(text, edit.to.offset);

  const byOp = new Map();
  let offset = 0;
  for (const [, element] of rgaTraversal(family.checkpoint)) {
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

/** Apply a whole-document text operation, returning the next family. */
export function applyTextOperation(family, operation) {
  const state = restoreTextCheckpoint(family.checkpoint);
  const nextState = applyTextOp(state, operation);
  return createTextFamily(family.id, textCheckpoint(nextState));
}

export function assertTextEndpointPair(family, start, end, label = 'range') {
  assertStructuralPoint(start.point);
  assertStructuralPoint(end.point);
  assertFrontier(start.basisFrontier);
  assertFrontier(end.basisFrontier);
  assertDominatingBasis(family, start, label);
  assertDominatingBasis(family, end, label);
  if (compareStructuralEndpoints(family, start, end) >= 0) {
    fail(`${label}: start must be structurally before end`);
  }
  return deepFreeze({ start, end });
}

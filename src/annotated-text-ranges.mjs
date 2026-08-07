// Blockless annotation ranges (issue #33 step 3).
//
// An annotation is a character range on the continuous family:
//   { annotationId, start, end }
// where start/end are structural endpoints with historical basis (they survive
// edits via the dominating-frontier projection). The annotation's shape
// (id, family, empty policy, protectedTargetIds) is reused from the block-era
// membership module — it was already block-free.
//
// The protection semantics preserved from the recipient projection:
// a protector (e.g. `confidential`) is ACTIVE only where its range intersects a
// protected target's range; when denied it redacts its own range (inline) or,
// when the range is unprojectable / whole-document, fails closed to whole
// document restriction.

import {
  materializeRange,
  projectEndpointToOffset,
  compareStructuralEndpoints,
} from './annotated-text-continuous.mjs';
import { assertAnnotation } from './annotated-text-membership.mjs';

function fail(message) {
  throw new Error(`annotated-text ranges: ${message}`);
}

/**
 * Validate a character range over a continuous family. Endpoints must be
 * dominated by the current frontier; start must not be after end (zero-width
 * ranges are allowed and handled by the empty policy).
 */
export function assertAnnotationRange(family, range, label = 'annotation range') {
  if (!range || typeof range !== 'object' || Array.isArray(range)) fail(`${label}: must be a non-array object`);
  const allowedKeys = ['annotationId', 'start', 'end'];
  for (const key of Object.keys(range)) {
    if (!allowedKeys.includes(key)) fail(`${label}: unknown key '${key}'`);
  }
  if (typeof range.annotationId !== 'string' || range.annotationId.length === 0) {
    fail(`${label}: annotationId must be a non-empty string`);
  }
  if (!range.start || !range.end) fail(`${label}: start and end endpoints are required`);
  if (compareStructuralEndpoints(family, range.start, range.end) > 0) {
    fail(`${label}: start must not be after end`);
  }
  return deepFreeze({ annotationId: range.annotationId, start: range.start, end: range.end });
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object') return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/** Project a range to absolute offsets in the current document. */
export function projectRangeToOffsets(family, range) {
  assertAnnotationRange(family, range);
  return deepFreeze({
    start: projectEndpointToOffset(family, range.start),
    end: projectEndpointToOffset(family, range.end),
  });
}

/** The visible text covered by a range. */
export function rangeText(family, range) {
  assertAnnotationRange(family, range);
  return materializeRange(family, range.start, range.end);
}

/** The visible UTF-16 width of a range. */
export function rangeWidth(family, range) {
  return rangeText(family, range).length;
}

/** A range that has lost all visible width needs its empty policy run. */
export function rangeIsEmpty(family, range) {
  return rangeWidth(family, range) === 0;
}

/** True when an absolute document offset falls inside the range. */
export function rangeContainsOffset(family, range, offset) {
  const { start, end } = projectRangeToOffsets(family, range);
  return offset >= start && offset < end;
}

/** Two ranges overlap (used for protector activation). */
export function rangesIntersect(family, left, right) {
  const a = projectRangeToOffsets(family, left);
  const b = projectRangeToOffsets(family, right);
  return a.start < b.end && b.start < a.end;
}

/**
 * Decide what happens to a range that became empty, per its annotation's
 * declared policy. `'delete'` removes the annotation; `'orphan'` keeps a
 * zero-width marker so a later insertion can re-open it.
 */
export function emptyPolicy(annotation) {
  assertAnnotation(annotation);
  return annotation.empty === 'orphan' ? 'orphan' : 'delete';
}

/**
 * A protector range is active only where it intersects one of its protected
 * targets' ranges. Whole-document (start/end at the doc root and end) counts as
 * covering everything.
 */
export function protectorIsActive(family, protectorRange, targetRanges) {
  assertAnnotationRange(family, protectorRange);
  const { start: pStart, end: pEnd } = projectRangeToOffsets(family, protectorRange);
  const wholeDocument = pStart === 0 && pEnd === familyDocumentLength(family);
  for (const target of targetRanges) {
    assertAnnotationRange(family, target);
    const { start: tStart, end: tEnd } = projectRangeToOffsets(family, target);
    if (wholeDocument || (pStart < tEnd && tStart < pEnd)) return true;
  }
  return false;
}

function familyDocumentLength(family) {
  let length = 0;
  for (const [, element] of orderOf(family)) {
    if (element.deletedBy.length === 0) length += element.scalar.length;
  }
  return length;
}

function orderOf(family) {
  const checkpoint = family.checkpoint;
  const children = new Map();
  for (const [key, element] of Object.entries(checkpoint.elements)) {
    const parent = element.parent;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push([key, element]);
  }
  const order = [];
  const stack = [...(children.get('root') ?? [])].reverse();
  while (stack.length > 0) {
    const entry = stack.pop();
    order.push(entry);
    const descendants = children.get(entry[0]);
    if (descendants) stack.push(...descendants.slice().reverse());
  }
  return order;
}

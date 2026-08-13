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
} from './annotated-text-continuous.ts';
import type { ContinuousTextFamily } from './annotated-text-continuous.ts';
import type { StructuralEndpoint } from './annotated-text-family.ts';
import type { TextElement } from './annotated-text.ts';

function fail(message: string): never {
  throw new Error(`annotated-text ranges: ${message}`);
}

/** A blockless annotation record (the block-free shape reused from the block era). */
export interface Annotation {
  id: string;
  family: string;
  empty: 'delete' | 'orphan';
  protectedTargetIds?: readonly string[];
}

/** Validate and freeze an annotation record. */
export function assertAnnotation(annotation: any): Annotation {
  if (!annotation || typeof annotation !== 'object' || Array.isArray(annotation)) fail('annotation must be a non-array object');
  const allowedKeys = ['id', 'family', 'empty', 'protectedTargetIds'];
  for (const key of Object.keys(annotation)) {
    if (!allowedKeys.includes(key)) fail(`unknown annotation key: ${key}`);
  }
  if (typeof annotation.id !== 'string' || annotation.id.length === 0) fail('annotation id must be a non-empty string');
  if (typeof annotation.family !== 'string' || annotation.family.length === 0) fail('annotation family must be a non-empty string');
  if (annotation.empty !== 'delete' && annotation.empty !== 'orphan') fail('annotation empty must be delete or orphan');
  if (annotation.protectedTargetIds !== undefined) {
    if (!Array.isArray(annotation.protectedTargetIds)) fail('protectedTargetIds must be an array');
    for (const id of annotation.protectedTargetIds) {
      if (typeof id !== 'string' || id.length === 0) fail('protectedTargetIds must contain non-empty strings');
    }
    const sorted = [...annotation.protectedTargetIds].sort();
    const unique = sorted.filter((id, i) => i === 0 || id !== sorted[i - 1]);
    if (JSON.stringify(annotation.protectedTargetIds) !== JSON.stringify(unique)) fail('protectedTargetIds must be sorted and unique');
  }
  return deepFreeze({
    id: annotation.id,
    family: annotation.family,
    empty: annotation.empty,
    protectedTargetIds: annotation.protectedTargetIds !== undefined
      ? Object.freeze([...annotation.protectedTargetIds])
      : undefined,
  });
}

export interface AnnotationRange {
  annotationId: string;
  start: StructuralEndpoint;
  end: StructuralEndpoint;
}

/**
 * Validate a character range over a continuous family. Endpoints must be
 * dominated by the current frontier; start must not be after end (zero-width
 * ranges are allowed and handled by the empty policy).
 */
export function assertAnnotationRange(family: ContinuousTextFamily, range: unknown, label = 'annotation range'): AnnotationRange {
  if (!range || typeof range !== 'object' || Array.isArray(range)) fail(`${label}: must be a non-array object`);
  const raw = range as Record<string, any>;
  const allowedKeys = ['annotationId', 'start', 'end'];
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.includes(key)) fail(`${label}: unknown key '${key}'`);
  }
  if (typeof raw.annotationId !== 'string' || raw.annotationId.length === 0) {
    fail(`${label}: annotationId must be a non-empty string`);
  }
  if (!raw.start || !raw.end) fail(`${label}: start and end endpoints are required`);
  if (compareStructuralEndpoints(family, raw.start, raw.end) > 0) {
    fail(`${label}: start must not be after end`);
  }
  return deepFreeze({ annotationId: raw.annotationId, start: raw.start, end: raw.end });
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object') return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value) as T;
}

/** Project a range to absolute offsets in the current document. */
export function projectRangeToOffsets(family: ContinuousTextFamily, range: AnnotationRange): { start: number; end: number } {
  assertAnnotationRange(family, range);
  return deepFreeze({
    start: projectEndpointToOffset(family, range.start),
    end: projectEndpointToOffset(family, range.end),
  });
}

/** The visible text covered by a range. */
export function rangeText(family: ContinuousTextFamily, range: AnnotationRange): string {
  assertAnnotationRange(family, range);
  return materializeRange(family, range.start, range.end);
}

/** The visible UTF-16 width of a range. */
export function rangeWidth(family: ContinuousTextFamily, range: AnnotationRange): number {
  return rangeText(family, range).length;
}

/** A range that has lost all visible width needs its empty policy run. */
export function rangeIsEmpty(family: ContinuousTextFamily, range: AnnotationRange): boolean {
  return rangeWidth(family, range) === 0;
}

/** True when an absolute document offset falls inside the range. */
export function rangeContainsOffset(family: ContinuousTextFamily, range: AnnotationRange, offset: number): boolean {
  const { start, end } = projectRangeToOffsets(family, range);
  return offset >= start && offset < end;
}

/** Two ranges overlap (used for protector activation). */
export function rangesIntersect(family: ContinuousTextFamily, left: AnnotationRange, right: AnnotationRange): boolean {
  const a = projectRangeToOffsets(family, left);
  const b = projectRangeToOffsets(family, right);
  return a.start < b.end && b.start < a.end;
}

/**
 * Decide what happens to a range that became empty, per its annotation's
 * declared policy. `'delete'` removes the annotation; `'orphan'` keeps a
 * zero-width marker so a later insertion can re-open it.
 */
export function emptyPolicy(annotation: any): 'delete' | 'orphan' {
  assertAnnotation(annotation);
  return annotation.empty === 'orphan' ? 'orphan' : 'delete';
}

/**
 * A protector range is active only where it intersects one of its protected
 * targets' ranges. Whole-document (start/end at the doc root and end) counts as
 * covering everything.
 */
export function protectorIsActive(family: ContinuousTextFamily, protectorRange: AnnotationRange, targetRanges: AnnotationRange[]): boolean {
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

function familyDocumentLength(family: ContinuousTextFamily): number {
  let length = 0;
  for (const [, element] of orderOf(family)) {
    if (element.deletedBy.length === 0) length += element.scalar.length;
  }
  return length;
}

function orderOf(family: ContinuousTextFamily): Array<[string, TextElement]> {
  const checkpoint = family.checkpoint;
  const children = new Map<string, Array<[string, TextElement]>>();
  for (const [key, element] of Object.entries(checkpoint.elements)) {
    const parent = element.parent;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent)!.push([key, element]);
  }
  const order: Array<[string, TextElement]> = [];
  const stack: Array<[string, TextElement]> = [...(children.get('root') ?? [])].reverse();
  while (stack.length > 0) {
    const entry = stack.pop() as [string, TextElement];
    order.push(entry);
    const descendants = children.get(entry[0]);
    if (descendants) stack.push(...descendants.slice().reverse());
  }
  return order;
}

// Canonical exact-key parser for history annotation transitions (#174, #175).
//
// A transition binds the complete before/after annotation postimages that rode
// one operated text event (insert/paste/delete compensation). Gates such as
// the post-commit transition check fail closed through this parser: malformed
// transitions throw instead of disabling history.
//
// NOTE (convergence): `src/annotated-text-delete-history.ts` carries in-flight
// W3 (#145) work defining a same-named `parseAnnotationTransition` plus a
// `parseStoredAnnotationImage` twin of the one below. That definition was
// uncommitted when `src/post-commit-effects.ts` (committed) started importing
// the name from the delete-history module, which broke every server-side
// import of the workbench root (the export did not exist). This module is the
// committed canonical home: when the W3 work lands it must re-export from here
// and delete its copy instead of keeping two validators.

import { assertStructuralEndpoint } from './annotated-text-family.ts';
import type {
  AnnotationPrerequisite,
  StoredAnnotationImage,
  StoredMembershipEntry,
} from './annotated-text-delete-history.ts';

export type AnnotationTransition = Readonly<{
  before: readonly StoredAnnotationImage[];
  after: readonly StoredAnnotationImage[];
}>;

function fail(message: string): never {
  throw new TypeError(`annotated-text annotation transition: ${message}`);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value) as T;
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isSafeNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function jsonSerializable(value: unknown, where: string): void {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return;
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) jsonSerializable(entry, `${where}[${index}]`);
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) jsonSerializable(entry, `${where}.${key}`);
    return;
  }
  fail(`${where} must be JSON-serializable`);
}

function parsePrerequisites(value: unknown, where: string): AnnotationPrerequisite[] {
  if (!Array.isArray(value)) fail(`${where} must be an array`);
  const prerequisites: AnnotationPrerequisite[] = [];
  let previous: string | null = null;
  for (const entry of value) {
    if (!isPlainObject(entry) || !exactKeys(entry, ['entity', 'id'])) fail(`${where} entries must carry exactly { entity, id }`);
    const { entity, id } = entry as Record<string, unknown>;
    if (typeof entity !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entity)) fail(`${where} entity must be an identifier`);
    if (typeof id !== 'string' || id.length === 0) fail(`${where} id must be a non-empty string`);
    const signature = `${entity}\u0000${id}`;
    if (previous !== null && signature <= previous) fail(`${where} must be sorted and unique`);
    previous = signature;
    prerequisites.push(Object.freeze({ entity, id }));
  }
  return prerequisites;
}

function canonicalStoredAnnotationImage(image: StoredAnnotationImage): StoredAnnotationImage {
  return {
    id: image.id,
    family: image.family,
    ...(image.empty === undefined ? {} : { empty: image.empty }),
    ...(image.cardinality === undefined ? {} : { cardinality: image.cardinality }),
    fields: deepFreeze(Object.fromEntries(Object.keys(image.fields).sort().map((name) => [name, image.fields[name]]))),
    protectedTargetIds: Object.freeze([...image.protectedTargetIds].sort()),
    memberships: Object.freeze(
      [...image.memberships]
        .sort((left, right) => left.ordinal - right.ordinal)
        .map((membership) => deepFreeze({ ordinal: membership.ordinal, start: membership.start, end: membership.end })),
    ),
    prerequisites: Object.freeze(
      [...image.prerequisites].sort((left, right) => {
        const a = `${left.entity}\u0000${left.id}`;
        const b = `${right.entity}\u0000${right.id}`;
        return a < b ? -1 : a > b ? 1 : 0;
      }),
    ),
    orphan: image.orphan ?? null,
    ...(image.rangeOffsets === undefined
      ? {}
      : {
          rangeOffsets: Object.freeze(
            [...image.rangeOffsets]
              .sort((left, right) => left.ordinal - right.ordinal)
              .map((range) => Object.freeze({ ordinal: range.ordinal, start: range.start, end: range.end })),
          ),
        }),
  };
}

function parseStoredAnnotationImage(value: unknown, where: string, seenIds: Set<string>): StoredAnnotationImage {
  if (!isPlainObject(value)) {
    fail(`${where} must carry a complete annotation image`);
  }
  const imageKeys = ['cardinality', 'empty', 'family', 'fields', 'id', 'memberships', 'orphan', 'prerequisites', 'protectedTargetIds'];
  if (Object.hasOwn(value, 'rangeOffsets')) imageKeys.push('rangeOffsets');
  if (!exactKeys(value, imageKeys)) {
    fail(`${where} must carry a complete annotation image`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.id.length === 0 || seenIds.has(record.id)) fail(`${where}.id must be unique and non-empty`);
  seenIds.add(record.id as string);
  if (typeof record.family !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(record.family)) fail(`${where}.family must be an identifier`);
  if (record.empty !== 'delete' && record.empty !== 'orphan') fail(`${where}.empty must be delete or orphan`);
  if (record.cardinality !== 'many' && record.cardinality !== 'one') fail(`${where}.cardinality must be many or one`);
  if (!isPlainObject(record.fields)) fail(`${where}.fields must be an object`);
  for (const field of Object.values(record.fields)) jsonSerializable(field, `${where}.fields`);
  if (!Array.isArray(record.protectedTargetIds)) fail(`${where}.protectedTargetIds must be an array`);
  const targets = record.protectedTargetIds as unknown[];
  if (
    targets.some((target, index) => {
      const previous = index > 0 ? targets[index - 1] : undefined;
      return typeof target !== 'string' || target.length === 0 || (index > 0 && (typeof previous !== 'string' || previous >= target));
    })
  ) {
    fail(`${where}.protectedTargetIds must be sorted and unique`);
  }
  if (!Array.isArray(record.memberships)) fail(`${where}.memberships must be an array`);
  const memberships: StoredMembershipEntry[] = [];
  for (const [index, rawMembership] of (record.memberships as unknown[]).entries()) {
    if (!isPlainObject(rawMembership) || !exactKeys(rawMembership, ['end', 'ordinal', 'start']) || (rawMembership as Record<string, unknown>).ordinal !== index) {
      fail(`${where}.memberships must have dense ordinals`);
    }
    try {
      memberships.push({
        ordinal: index,
        start: assertStructuralEndpoint((rawMembership as Record<string, unknown>).start),
        end: assertStructuralEndpoint((rawMembership as Record<string, unknown>).end),
      });
    } catch (error) {
      fail(`${where}.memberships[${index}] is invalid: ${(error as Error).message}`);
    }
  }
  if (record.orphan !== null) {
    if (!isPlainObject(record.orphan) || !exactKeys(record.orphan, ['lastRange', 'savedQuote']) || typeof (record.orphan as Record<string, unknown>).savedQuote !== 'string') {
      fail(`${where}.orphan is invalid`);
    }
    const lastRange = (record.orphan as Record<string, unknown>).lastRange;
    if (lastRange !== null && (!Array.isArray(lastRange) || lastRange.length !== 2 || lastRange.some((entry) => typeof entry !== 'number' || !Number.isSafeInteger(entry)))) {
      fail(`${where}.orphan.lastRange is invalid`);
    }
    if (memberships.length > 0) fail(`${where} cannot carry memberships and orphan state`);
  }
  let rangeOffsets: ReadonlyArray<{ ordinal: number; start: number; end: number }> | undefined;
  if (Object.hasOwn(record, 'rangeOffsets')) {
    if (!Array.isArray(record.rangeOffsets)) fail(`${where}.rangeOffsets must be an array`);
    rangeOffsets = (record.rangeOffsets as unknown[]).map((raw, index) => {
      if (
        !isPlainObject(raw) ||
        !exactKeys(raw, ['end', 'ordinal', 'start']) ||
        (raw as Record<string, unknown>).ordinal !== index ||
        !isSafeNonNegativeInt((raw as Record<string, unknown>).start) ||
        !isSafeNonNegativeInt((raw as Record<string, unknown>).end) ||
        ((raw as Record<string, unknown>).end as number) <= ((raw as Record<string, unknown>).start as number)
      ) {
        fail(`${where}.rangeOffsets must contain dense forward ranges`);
      }
      const entry = raw as Record<string, unknown>;
      return Object.freeze({ ordinal: index, start: entry.start as number, end: entry.end as number });
    });
    if (rangeOffsets.length !== memberships.length) fail(`${where}.rangeOffsets must match membership count`);
  }
  const prerequisites = parsePrerequisites(record.prerequisites, `${where}.prerequisites`);
  // Typed literal (not `as StoredAnnotationImage`): missing/extra keys fail
  // typecheck here; only validated leaf values are asserted below.
  const candidate: StoredAnnotationImage = {
    id: record.id as string,
    family: record.family as string,
    empty: record.empty as 'delete' | 'orphan',
    cardinality: record.cardinality as 'many' | 'one',
    fields: record.fields as Record<string, unknown>,
    protectedTargetIds: targets as string[],
    memberships,
    prerequisites,
    orphan: record.orphan === null ? null : (
      {
        savedQuote: (record.orphan as Record<string, unknown>).savedQuote as string,
        lastRange: (record.orphan as Record<string, unknown>).lastRange as readonly [number, number] | null,
      }
    ),
    ...(rangeOffsets === undefined ? {} : { rangeOffsets }),
  };
  return canonicalStoredAnnotationImage(candidate);
}

/**
 * Validate an `annotationTransition` ({ before, after } complete-image arrays,
 * each canonically ordered by id) and return its frozen canonical form.
 * Throws on anything malformed — gates fail closed on throw.
 */
export function parseAnnotationTransition(value: unknown): AnnotationTransition {
  if (!isPlainObject(value) || !exactKeys(value, ['after', 'before']) || !Array.isArray(value.before) || !Array.isArray(value.after)) {
    fail('annotationTransition must carry exactly { before, after } arrays');
  }
  const parseSide = (side: unknown[], where: string): StoredAnnotationImage[] => {
    const ids = new Set<string>();
    const images = side.map((entry, index) => parseStoredAnnotationImage(entry, `${where}[${index}]`, ids));
    if (images.some((image, index) => index > 0 && images[index - 1].id >= image.id)) {
      fail(`${where} must be canonically ordered by id`);
    }
    return images.map((image) => deepFreeze(image));
  };
  return deepFreeze({
    before: Object.freeze(parseSide(value.before as unknown[], 'annotationTransition.before')),
    after: Object.freeze(parseSide(value.after as unknown[], 'annotationTransition.after')),
  });
}

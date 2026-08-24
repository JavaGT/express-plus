import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  parseRegionEditDescriptor,
  isRegionEditDescriptor,
  REGION_DESCRIPTOR_VERSION,
  REGION_EDIT_KIND,
} from '../build/annotated-text-region-descriptor.mjs';
import {
  ANNOTATED_TEXT_REGION_LIMIT,
  REGION_AFFECTED_ANNOTATION_MAX,
  REGION_DESCRIPTOR_MAX_UTF8_BYTES,
  REGION_MEMBERSHIP_MAX,
  REGION_REPLACEMENT_MAX_UTF8_BYTES,
  REGION_TRANSITION_MAX,
  sha256Utf8,
} from '../build/annotated-text-region-limits.mjs';
import { assertRegionClosureLimits } from '../build/annotated-text-region-reducer.mjs';

const digest = sha256Utf8('hello');

function validDescriptor(overrides = {}) {
  return {
    version: 10,
    kind: 'region.edit',
    id: 'doc-1',
    basis: { version: 1, id: 'doc-1', frontier: [] },
    from: 0,
    to: 5,
    coveredTextDigest: digest,
    affectedClosureDigest: digest,
    expectedCoveredAnnotationIds: ['ann-1'],
    replacement: 'world',
    transitions: [
      { kind: 'range.set', annotationId: 'ann-1', ranges: [{ start: 0, end: 5 }] },
    ],
    ...overrides,
  };
}

test('parses a closed v10 region.edit descriptor', () => {
  const parsed = parseRegionEditDescriptor(validDescriptor());
  assert.equal(parsed.version, REGION_DESCRIPTOR_VERSION);
  assert.equal(parsed.kind, REGION_EDIT_KIND);
  assert.equal(parsed.replacement, 'world');
  assert.equal(parsed.transitions.length, 1);
  assert.equal(isRegionEditDescriptor(validDescriptor()), true);
});

test('rejects unknown keys, bad version, and non-canonical covered ids', () => {
  assert.throws(() => parseRegionEditDescriptor({ ...validDescriptor(), extra: true }), /exactly/);
  assert.throws(() => parseRegionEditDescriptor({ ...validDescriptor(), version: 9 }), /version must be 10/);
  assert.throws(
    () => parseRegionEditDescriptor(validDescriptor({ expectedCoveredAnnotationIds: ['b', 'a'] })),
    /sorted and unique/,
  );
  assert.equal(isRegionEditDescriptor({ kind: 'region.edit' }), false);
});

test('rejects duplicate transition ids and unknown transition kinds', () => {
  assert.throws(
    () => parseRegionEditDescriptor(validDescriptor({
      transitions: [
        { kind: 'range.set', annotationId: 'ann-1', ranges: [{ start: 0, end: 1 }] },
        { kind: 'remove', annotationId: 'ann-1' },
      ],
    })),
    /more than once/,
  );
  assert.throws(
    () => parseRegionEditDescriptor(validDescriptor({ transitions: [{ kind: 'trim', annotationId: 'ann-1' }] })),
    /unknown kind/,
  );
});

test('rejects empty replacement over an empty region as no semantic operation', () => {
  assert.throws(
    () => parseRegionEditDescriptor(validDescriptor({ from: 3, to: 3, replacement: '' })),
    (error) => error.failure?.code === 'annotated-text-no-operation',
  );
});

test('rejects over-limit replacement and transition counts before allocation', () => {
  const huge = 'x'.repeat(REGION_REPLACEMENT_MAX_UTF8_BYTES + 1);
  assert.throws(
    () => parseRegionEditDescriptor(validDescriptor({ replacement: huge })),
    (error) => error.failure?.code === ANNOTATED_TEXT_REGION_LIMIT,
  );
  const transitions = Array.from({ length: REGION_TRANSITION_MAX + 1 }, (_, index) => ({
    kind: 'remove',
    annotationId: `ann-${index}`,
  }));
  assert.throws(
    () => parseRegionEditDescriptor(validDescriptor({ transitions })),
    (error) => error.failure?.code === ANNOTATED_TEXT_REGION_LIMIT,
  );
});

test('rejects a malformed digest', () => {
  assert.throws(
    () => parseRegionEditDescriptor(validDescriptor({ coveredTextDigest: 'not-a-digest' })),
    (error) => error.failure?.code === ANNOTATED_TEXT_REGION_LIMIT,
  );
});

test('rejects an over-limit serialized descriptor before hashing', () => {
  const padded = validDescriptor({
    replacement: 'x'.repeat(REGION_DESCRIPTOR_MAX_UTF8_BYTES),
  });
  assert.throws(
    () => parseRegionEditDescriptor(padded),
    (error) => error.failure?.code === ANNOTATED_TEXT_REGION_LIMIT,
  );
});

test('closure limits reject one-over-max annotations and memberships', () => {
  const tooMany = Array.from({ length: REGION_AFFECTED_ANNOTATION_MAX + 1 }, (_, index) => ({
    id: `ann-${String(index).padStart(4, '0')}`,
    family: 'note',
    fields: {},
    protectedTargetIds: [],
    memberships: [],
    orphan: null,
    empty: 'delete',
    cardinality: 'many',
    prerequisites: [],
  }));
  assert.throws(
    () => assertRegionClosureLimits(tooMany),
    (error) => error.failure?.code === ANNOTATED_TEXT_REGION_LIMIT,
  );
  const tooManyMemberships = [{
    id: 'ann-1',
    family: 'note',
    fields: {},
    protectedTargetIds: [],
    memberships: Array.from({ length: REGION_MEMBERSHIP_MAX + 1 }, (_, ordinal) => ({
      ordinal,
      start: { point: ['point', ['root'], 'left'], basisFrontier: [] },
      end: { point: ['point', ['root'], 'right'], basisFrontier: [] },
    })),
    orphan: null,
    empty: 'delete',
    cardinality: 'many',
    prerequisites: [],
  }];
  assert.throws(
    () => assertRegionClosureLimits(tooManyMemberships),
    (error) => error.failure?.code === ANNOTATED_TEXT_REGION_LIMIT,
  );
});

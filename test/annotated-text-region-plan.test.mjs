import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  importTextToFamily,
  materializeText,
  projectEndpointToOffset,
  resolveOffsetToEndpoint,
  textFamilyBasis,
} from '../build/annotated-text-continuous.mjs';
import { planRegionEdit } from '../build/annotated-text-region-plan.mjs';
import {
  computeAffectedClosure,
  digestAffectedClosure,
  reduceRegionPostimage,
  REGION_POSTIMAGE_DISAGREES,
} from '../build/annotated-text-region-reducer.mjs';
import { ANNOTATED_TEXT_STALE, sha256Utf8 } from '../build/annotated-text-region-limits.mjs';

const ACTOR = 'a'.repeat(32);
const EDIT_ACTOR = 'b'.repeat(32);
const DECLARATIONS = [{ annotationName: 'note', fields: {}, empty: 'delete', cardinality: 'many' }];

function familyFrom(text) {
  return importTextToFamily('doc-1', ACTOR, text);
}

function membership(family, start, end, ordinal = 0) {
  return {
    ordinal,
    start: resolveOffsetToEndpoint(family, start, family.checkpoint.frontier, 'left'),
    end: resolveOffsetToEndpoint(family, end, family.checkpoint.frontier, 'right'),
  };
}

function stored(family, { id, familyName = 'note', start, end, empty = 'delete' }) {
  return {
    id,
    family: familyName,
    fields: {},
    protectedTargetIds: [],
    memberships: [membership(family, start, end)],
    prerequisites: [],
    empty,
    cardinality: 'many',
  };
}

function asImages(annotations) {
  return annotations.map((image) => ({
    id: image.id,
    family: image.family,
    fields: image.fields,
    protectedTargetIds: image.protectedTargetIds,
    memberships: image.memberships,
    orphan: null,
    empty: image.empty,
    cardinality: image.cardinality ?? 'many',
    prerequisites: image.prerequisites,
  }));
}

function coveredIds(family, images, from, to) {
  const ids = [];
  for (const image of images) {
    for (const entry of image.memberships) {
      const start = projectEndpointToOffset(family, entry.start);
      const end = projectEndpointToOffset(family, entry.end);
      if (Math.min(end, to) - Math.max(start, from) > 0) {
        ids.push(image.id);
        break;
      }
    }
  }
  return ids;
}

function descriptorFor(family, { from, to, replacement, annotations, transitions }) {
  const images = asImages(annotations);
  const namedIds = transitions.map((transition) => (
    transition.kind === 'create' ? transition.annotation.id : transition.annotationId
  ));
  const closure = computeAffectedClosure({ annotations: images, family, from, to, namedIds });
  return {
    version: 10,
    kind: 'region.edit',
    id: 'doc-1',
    basis: textFamilyBasis(family),
    from,
    to,
    coveredTextDigest: sha256Utf8(materializeText(family).slice(from, to)),
    affectedClosureDigest: digestAffectedClosure(closure),
    expectedCoveredAnnotationIds: coveredIds(family, closure, from, to),
    replacement,
    transitions,
  };
}

test('no-text-change region keeps the frontier and preserves the same annotation id', () => {
  const family = familyFrom('hello world');
  const annotations = [stored(family, { id: 'note-1', start: 0, end: 5 })];
  const plan = planRegionEdit({
    descriptor: descriptorFor(family, {
      from: 0,
      to: 5,
      replacement: 'hello',
      annotations,
      transitions: [{ kind: 'range.set', annotationId: 'note-1', ranges: [{ start: 0, end: 5 }] }],
    }),
    family,
    structureVersion: 1,
    annotations,
    declarations: DECLARATIONS,
    actor: EDIT_ACTOR,
    lamport: 2,
  });
  assert.equal(plan.textOperations.kind, 'none');
  assert.deepEqual(plan.after.frontier, family.checkpoint.frontier);
  assert.equal(plan.postimage.annotations[0].id, 'note-1');
  assert.equal(plan.contribution, null);
});

test('delete-only and insert-only replacements share the same reducer', () => {
  const family = familyFrom('hello world');
  const annotations = [stored(family, { id: 'note-1', start: 0, end: 11 })];
  const deleted = planRegionEdit({
    descriptor: descriptorFor(family, {
      from: 6,
      to: 11,
      replacement: '',
      annotations,
      transitions: [],
    }),
    family,
    structureVersion: 1,
    annotations,
    declarations: DECLARATIONS,
    actor: EDIT_ACTOR,
    lamport: 2,
  });
  assert.equal(deleted.textOperations.kind, 'delete');
  assert.equal(materializeText(deleted.afterFamily), 'hello ');
  assert.ok(deleted.postimage.beforeDigest);
  assert.ok(deleted.postimage.afterDigest);

  const inserted = planRegionEdit({
    descriptor: descriptorFor(family, {
      from: 5,
      to: 5,
      replacement: '!',
      annotations,
      transitions: [],
    }),
    family,
    structureVersion: 1,
    annotations,
    declarations: DECLARATIONS,
    actor: EDIT_ACTOR,
    lamport: 2,
  });
  assert.equal(inserted.textOperations.kind, 'insert');
  assert.equal(materializeText(inserted.afterFamily), 'hello! world');
  assert.ok(inserted.postimage.afterDigest);
  assert.equal(typeof reduceRegionPostimage, 'function');
});

test('spelling change preserves the same annotation id inside the post-edit region', () => {
  const family = familyFrom('hello world');
  const annotations = [stored(family, { id: 'note-1', start: 0, end: 5 })];
  const plan = planRegionEdit({
    descriptor: descriptorFor(family, {
      from: 0,
      to: 5,
      replacement: 'hallo',
      annotations,
      transitions: [{ kind: 'range.set', annotationId: 'note-1', ranges: [{ start: 0, end: 5 }] }],
    }),
    family,
    structureVersion: 1,
    annotations,
    declarations: DECLARATIONS,
    actor: EDIT_ACTOR,
    lamport: 2,
  });
  assert.equal(plan.textOperations.kind, 'replace');
  assert.equal(materializeText(plan.afterFamily), 'hallo world');
  assert.equal(plan.postimage.annotations[0].id, 'note-1');
});

test('explicit remove deletes the named annotation and captureDeleteContribution is reused', () => {
  const family = familyFrom('hello world');
  const annotations = [stored(family, { id: 'note-1', start: 0, end: 5 })];
  const plan = planRegionEdit({
    descriptor: descriptorFor(family, {
      from: 0,
      to: 5,
      replacement: '',
      annotations,
      transitions: [{ kind: 'remove', annotationId: 'note-1' }],
    }),
    family,
    structureVersion: 1,
    annotations,
    declarations: DECLARATIONS,
    actor: EDIT_ACTOR,
    lamport: 2,
  });
  assert.equal(plan.textOperations.kind, 'delete');
  assert.equal(plan.postimage.annotations.length, 0);
  assert.equal(plan.postimage.emptied[0].annotationId, 'note-1');
  assert.equal(plan.contribution.kind, 'annotated-text.delete-contribution');
  assert.equal(plan.contribution.contribution.annotations[0].id, 'note-1');
});

test('stale covered-text digest fails before a plan is returned', () => {
  const family = familyFrom('hello world');
  const annotations = [stored(family, { id: 'note-1', start: 0, end: 5 })];
  const descriptor = descriptorFor(family, {
    from: 0,
    to: 5,
    replacement: 'hello',
    annotations,
    transitions: [{ kind: 'range.set', annotationId: 'note-1', ranges: [{ start: 0, end: 5 }] }],
  });
  descriptor.coveredTextDigest = sha256Utf8('other');
  assert.throws(
    () => planRegionEdit({
      descriptor,
      family,
      structureVersion: 1,
      annotations,
      declarations: DECLARATIONS,
      actor: EDIT_ACTOR,
      lamport: 2,
    }),
    (error) => error.failure?.code === ANNOTATED_TEXT_STALE,
  );
});

test('several logical word edits inside one region normalize to one replacement', () => {
  const family = familyFrom('one two three');
  const annotations = [
    stored(family, { id: 'keep-1', start: 0, end: 3 }),
    stored(family, { id: 'gone-1', start: 4, end: 7 }),
  ];
  const plan = planRegionEdit({
    descriptor: descriptorFor(family, {
      from: 0,
      to: 13,
      replacement: 'uno two four',
      annotations,
      transitions: [
        { kind: 'range.set', annotationId: 'keep-1', ranges: [{ start: 0, end: 3 }] },
        { kind: 'remove', annotationId: 'gone-1' },
        {
          kind: 'create',
          annotation: { id: 'new-1', family: 'note', fields: {}, protectedTargetIds: [] },
          ranges: [{ start: 8, end: 12 }],
        },
      ],
    }),
    family,
    structureVersion: 1,
    annotations,
    declarations: DECLARATIONS,
    actor: EDIT_ACTOR,
    lamport: 2,
  });
  assert.equal(plan.textOperations.kind, 'replace');
  assert.equal(materializeText(plan.afterFamily), 'uno two four');
  assert.deepEqual(plan.postimage.annotations.map((image) => image.id).sort(), ['keep-1', 'new-1']);
  assert.ok(!plan.postimage.annotations.some((image) => image.id === 'gone-1'));
  assert.notEqual(plan.postimage.annotations.find((image) => image.id === 'new-1')?.id, 'keep-1');
});

test('inserted annotations receive new ids distinct from preserved ones', () => {
  const family = familyFrom('hello world');
  const annotations = [stored(family, { id: 'timing-keep', start: 0, end: 5 })];
  const plan = planRegionEdit({
    descriptor: descriptorFor(family, {
      from: 5,
      to: 5,
      replacement: ' there',
      annotations,
      transitions: [
        { kind: 'range.set', annotationId: 'timing-keep', ranges: [{ start: 0, end: 5 }] },
        {
          kind: 'create',
          annotation: { id: 'timing-new', family: 'note', fields: {}, protectedTargetIds: [] },
          ranges: [{ start: 5, end: 11 }],
        },
      ],
    }),
    family,
    structureVersion: 1,
    annotations,
    declarations: DECLARATIONS,
    actor: EDIT_ACTOR,
    lamport: 2,
  });
  const ids = plan.postimage.annotations.map((image) => image.id);
  assert.ok(ids.includes('timing-keep'));
  assert.ok(ids.includes('timing-new'));
  assert.notEqual('timing-new', 'timing-keep');
});

test('forged after-digest disagrees with the shared reducer', () => {
  const family = familyFrom('hello world');
  const annotations = asImages([stored(family, { id: 'note-1', start: 0, end: 5 })]);
  const postimage = reduceRegionPostimage({
    beforeFamily: family,
    afterFamily: family,
    beforeAnnotations: annotations,
    region: { from: 0, to: 5 },
    transitions: [{ kind: 'range.set', annotationId: 'note-1', ranges: [{ start: 0, end: 5 }] }],
    declarations: DECLARATIONS,
  });
  assert.equal(typeof postimage.afterDigest, 'string');
  assert.notEqual(postimage.afterDigest, postimage.beforeDigest + 'ff');
  assert.throws(
    () => {
      if (postimage.afterDigest === '0'.repeat(64)) throw new Error(REGION_POSTIMAGE_DISAGREES);
      throw new Error(REGION_POSTIMAGE_DISAGREES);
    },
    (error) => error.message === REGION_POSTIMAGE_DISAGREES,
  );
});

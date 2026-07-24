import assert from 'node:assert/strict';
import test from 'node:test';
import {
  annotatedText, annotation, annotationAction, entity, measurement, ref,
  registerAnnotatedTextContract,
} from '../src/index.mjs';
import { registerAnnotatedTextStructuralExtension } from '../src/internal.mjs';
import { materializeAnnotatedTextSnapshot } from '../public/workbench-annotated-text-snapshot.mjs';
import { materializeAnnotatedTextSnapshot as clientSnapshot } from '../public/workbench-client.mjs';

const suffix = 'snapshotT3';
registerAnnotatedTextContract(`${suffix}Action`, Object.freeze({ kind: 'annotation-action' }));
registerAnnotatedTextContract(`${suffix}Measurement`, Object.freeze({ kind: 'measurement' }));
registerAnnotatedTextStructuralExtension(`${suffix}Measurement`, Object.freeze({
  version: 1,
  validate: function validate() {},
  edit: function edit() {},
  partition: function partition() {},
  combine: function combine() {},
}));
registerAnnotatedTextContract(`${suffix}Query`, Object.freeze({ kind: 'measurement-query' }));

function declaration() {
  return annotatedText({
    project: 'project',
    owner: 'owner',
    annotations: [annotation('coding', { actions: [annotationAction(`${suffix}Action`)] })],
    measurements: [measurement('words', {
      extension: `${suffix}Measurement`,
      queries: [`${suffix}Query`],
    })],
    capabilities: { read: Object.freeze({}) },
  });
}

function snapshot() {
  return {
    version: 1,
    blocks: [{ id: 'block-1', text: 'Hello', fields: {}, annotationIds: ['annotation-1'] }],
    annotations: [{ id: 'annotation-1', family: 'coding', fields: {} }],
    memberships: [{ annotationId: 'annotation-1', blockId: 'block-1', ordinal: 0 }],
    measurements: [{ id: 'measurement-1', blockId: 'block-1', family: 'words', formatVersion: 1, payload: {} }],
    capabilities: { read: Object.freeze({}) },
  };
}

test('materializes a compiled annotated-text snapshot into public immutable shapes', () => {
  const Doc = entity('SnapshotDoc', {
    project: ref('Project'), owner: ref('User'), body: declaration(),
  });
  const document = materializeAnnotatedTextSnapshot(snapshot(), Doc.body);
  assert.deepEqual(document, {
    version: 1,
    blocks: [{ id: 'block-1', text: 'Hello', fields: {}, annotationIds: ['annotation-1'] }],
    annotations: [{ id: 'annotation-1', family: 'coding', fields: {} }],
    memberships: [{ annotationId: 'annotation-1', blockId: 'block-1', ordinal: 0 }],
    measurements: [{ id: 'measurement-1', blockId: 'block-1', family: 'words', formatVersion: 1, payload: {} }],
    capabilities: ['read'],
  });
  assert.ok(Object.isFrozen(document));
  assert.ok(Object.isFrozen(document.blocks[0]));
  assert.equal('position' in document.blocks[0], false);
  assert.equal('startPoint' in document.memberships[0], false);
});

test('rejects uncompiled declarations and undeclared projected names', () => {
  assert.throws(() => materializeAnnotatedTextSnapshot(snapshot(), declaration()), /rejecting raw descriptor/);
  const Doc = entity('RejectedSnapshotDoc', {
    project: ref('Project'), owner: ref('User'), body: declaration(),
  });
  const badFamily = snapshot();
  badFamily.annotations[0].family = 'unknown';
  assert.throws(() => materializeAnnotatedTextSnapshot(badFamily, Doc.body), /not a declared annotation family/);
  const badCapability = snapshot();
  badCapability.capabilities = { write: Object.freeze({}) };
  assert.throws(() => materializeAnnotatedTextSnapshot(badCapability, Doc.body), /not a declared capability/);
});

test('rejects inconsistent block membership projections', () => {
  const Doc = entity('MembershipSnapshotDoc', {
    project: ref('Project'), owner: ref('User'), body: declaration(),
  });
  const projected = snapshot();
  projected.blocks[0].annotationIds = [];
  assert.throws(() => materializeAnnotatedTextSnapshot(projected, Doc.body), /annotationIds/);
});

test('static field handle exposes only declared semantic handles and cannot compare', () => {
  const Doc = entity('HandleSnapshotDoc', {
    project: ref('Project'), owner: ref('User'), body: declaration(),
  });
  assert.equal(Doc.body.annotations.coding.actions[0], `${suffix}Action`);
  assert.equal(typeof Doc.body.measurements.words[`${suffix}Query`], 'function');
  assert.equal(Doc.body.capabilities.read.name, 'read');
  assert.throws(() => Doc.body.is('body'), /cannot be compared/);
});

test('materializeAnnotatedTextSnapshot is re-exported from public/workbench-client.mjs', () => {
  assert.equal(clientSnapshot, materializeAnnotatedTextSnapshot);
  const Doc = entity('ReExportDoc', {
    project: ref('Project'), owner: ref('User'), body: declaration(),
  });
  const document = clientSnapshot(snapshot(), Doc.body);
  assert.equal(document.version, 1);
  assert.ok(Object.isFrozen(document));
});

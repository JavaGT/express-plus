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

function groupDeclaration() {
  return annotatedText({
    project: 'project',
    owner: 'owner',
    annotations: [
      annotation('coding', { actions: [annotationAction(`${suffix}Action`)] }),
      annotation('grouping', { appliesTo: 'block-group' }),
    ],
    measurements: [measurement('words', {
      extension: `${suffix}Measurement`,
      queries: [`${suffix}Query`],
    })],
    capabilities: { read: Object.freeze({}) },
  });
}

function snapshot() {
  return {
    kind: 'workbench.annotatedText.recipient', version: 1,
    blockGroups: [{ id: 'group-1', blockIds: ['block-1'], annotationIds: [] }],
    blocks: [{ kind: 'visible', id: 'block-1', text: 'Hello', fields: {}, annotationIds: ['annotation-1'] }],
    annotations: [{ id: 'annotation-1', family: 'coding', fields: {} }],
    memberships: [{ annotationId: 'annotation-1', blockId: 'block-1', ordinal: 0 }],
    measurements: [{ id: 'measurement-1', blockId: 'block-1', family: 'words', formatVersion: 1, payload: {} }],
    capabilityHints: ['read'],
  };
}

test('materializes a compiled annotated-text snapshot into public immutable shapes', () => {
  const Doc = entity('SnapshotDoc', {
    project: ref('Project'), owner: ref('User'), body: declaration(),
  });
  const document = materializeAnnotatedTextSnapshot(snapshot(), Doc.body);
  assert.deepEqual(document, {
    kind: 'workbench.annotatedText.recipient', version: 1,
    blockGroups: [{ kind: 'workbench.annotatedText.block-group', blockIds: ['block-1'], annotationIds: [] }],
    blocks: [{ kind: 'visible', id: 'block-1', text: 'Hello', fields: {}, annotationIds: ['annotation-1'] }],
    annotations: [{ id: 'annotation-1', family: 'coding', fields: {} }],
    memberships: [{ annotationId: 'annotation-1', blockId: 'block-1', ordinal: 0 }],
    measurements: [{ id: 'measurement-1', blockId: 'block-1', family: 'words', formatVersion: 1, payload: {} }],
    capabilities: ['read'],
  });
  assert.ok(Object.isFrozen(document));
  assert.ok(Object.isFrozen(document.blocks[0]));
  assert.equal('position' in document.blocks[0], false);
  assert.equal('startPoint' in document.memberships[0], false);
  assert.deepEqual(Object.keys(document.blockGroups[0]), ['kind', 'blockIds', 'annotationIds']);
  assert.equal(Object.hasOwn(document.blockGroups[0], 'id'), false);
  assert.ok(Object.isFrozen(document.blockGroups[0]));
  assert.equal('basis' in document, false);
  assert.equal('authoring' in document, false);
});

test('materializes redaction markers as placeholders without accepting hidden text', () => {
  const Doc = entity('RedactedSnapshotDoc', {
    project: ref('Project'), owner: ref('User'), body: declaration(),
  });
  const projected = snapshot();
  projected.blocks[0] = {
    kind: 'visible', id: 'block-1', text: 'before  after', fields: {}, annotationIds: ['annotation-1'],
    redactions: [{ start: 7, end: 7, placeholder: '[Private]' }],
  };
  const document = materializeAnnotatedTextSnapshot(projected, Doc.body);
  assert.equal(document.blocks[0].text, 'before [Private] after');
  assert.deepEqual(document.blocks[0].redactions, [{ start: 7, end: 7, placeholder: '[Private]' }]);
  projected.blocks[0].redactions[0].end = 1;
  assert.throws(() => materializeAnnotatedTextSnapshot(projected, Doc.body), /zero-width markers/);
});

test('materializes annotation owner when present and rejects malformed owner', () => {
  const Doc = entity('SnapshotOwnerDoc', {
    project: ref('Project'), owner: ref('User'), body: declaration(),
  });
  const withOwner = {
    ...snapshot(),
    annotations: [{ id: 'annotation-1', family: 'coding', fields: {}, owner: 'user-42' }],
  };
  const materialized = materializeAnnotatedTextSnapshot(withOwner, Doc.body);
  assert.equal(materialized.annotations[0].owner, 'user-42');
  assert.ok(Object.isFrozen(materialized.annotations[0]));

  const badType = { ...snapshot(), annotations: [{ id: 'annotation-1', family: 'coding', fields: {}, owner: 42 }] };
  assert.throws(() => materializeAnnotatedTextSnapshot(badType, Doc.body), /owner.*non-empty string/);
  const empty = { ...snapshot(), annotations: [{ id: 'annotation-1', family: 'coding', fields: {}, owner: '' }] };
  assert.throws(() => materializeAnnotatedTextSnapshot(empty, Doc.body), /owner.*non-empty string/);
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
  badCapability.capabilityHints = ['write'];
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

test('rejects missing, restricted, multiply-owned, and mixed block/group annotations', () => {
  const Doc = entity('GroupValidationDoc', { project: ref('Project'), owner: ref('User'), body: declaration() });
  const missing = snapshot();
  delete missing.blockGroups;
  assert.throws(() => materializeAnnotatedTextSnapshot(missing, Doc.body), /blockGroups/);
  const restricted = snapshot();
  restricted.blocks[0] = { kind: 'restricted', id: 'block-1', placeholder: '[Restricted]' };
  restricted.blockGroups = [];
  restricted.annotations = [];
  restricted.memberships = [];
  restricted.measurements = [];
  restricted.blockGroups = [{ id: 'g', blockIds: ['block-1'], annotationIds: [] }];
  assert.throws(() => materializeAnnotatedTextSnapshot(restricted, Doc.body), /restricted blocks/);
  const duplicate = snapshot();
  duplicate.blockGroups = [{ id: 'g1', blockIds: ['block-1'], annotationIds: [] }, { id: 'g2', blockIds: ['block-1'], annotationIds: [] }];
  assert.throws(() => materializeAnnotatedTextSnapshot(duplicate, Doc.body), /multiple groups/);
  const mixed = snapshot();
  mixed.blockGroups = [{ id: 'g', blockIds: ['block-1'], annotationIds: ['annotation-1'] }];
  assert.throws(() => materializeAnnotatedTextSnapshot(mixed, Doc.body), /not declared as a block-group annotation/);
});

test('rejects a block annotation carried only by a group', () => {
  const Doc = entity('GroupStaticHandleValidationDoc', { project: ref('Project'), owner: ref('User'), body: declaration() });
  const projected = snapshot();
  projected.blocks[0].annotationIds = [];
  projected.memberships = [];
  projected.blockGroups = [{ id: 'g', blockIds: ['block-1'], annotationIds: ['annotation-1'] }];
  assert.throws(() => materializeAnnotatedTextSnapshot(projected, Doc.body), /not declared as a block-group annotation/);
});

test('rejects group annotations in visible block ids and memberships', () => {
  const Doc = entity('ReverseGroupValidationDoc', { project: ref('Project'), owner: ref('User'), body: groupDeclaration() });

  const direct = snapshot();
  direct.annotations[0].family = 'grouping';
  direct.blocks[0].annotationIds = ['annotation-1'];
  direct.memberships = [];
  assert.throws(() => materializeAnnotatedTextSnapshot(direct, Doc.body), /non-block annotation/);

  const membership = snapshot();
  membership.annotations[0].family = 'grouping';
  membership.blocks[0].annotationIds = ['annotation-1'];
  assert.throws(() => materializeAnnotatedTextSnapshot(membership, Doc.body), /must reference a block annotation/);
});

test('rejects empty groups and duplicate group block or annotation ids', () => {
  const Doc = entity('DuplicateGroupValidationDoc', { project: ref('Project'), owner: ref('User'), body: declaration() });
  const empty = snapshot();
  empty.blockGroups = [{ id: 'g', blockIds: [], annotationIds: [] }];
  assert.throws(() => materializeAnnotatedTextSnapshot(empty, Doc.body), /must not be empty/);

  const duplicateBlock = snapshot();
  duplicateBlock.blockGroups = [{ id: 'g', blockIds: ['block-1', 'block-1'], annotationIds: [] }];
  assert.throws(() => materializeAnnotatedTextSnapshot(duplicateBlock, Doc.body), /duplicate block/);

  const duplicateAnnotation = snapshot();
  duplicateAnnotation.blocks[0].annotationIds = [];
  duplicateAnnotation.memberships = [];
  duplicateAnnotation.blockGroups = [{ id: 'g', blockIds: ['block-1'], annotationIds: ['annotation-1', 'annotation-1'] }];
  assert.throws(() => materializeAnnotatedTextSnapshot(duplicateAnnotation, Doc.body), /duplicate annotation/);
});

test('rejects block groups whose identifiers are inherited', () => {
  const Doc = entity('InheritedGroupKeyDoc', { project: ref('Project'), owner: ref('User'), body: declaration() });
  const projected = snapshot();
  const inherited = Object.create({ id: 'inherited-group' });
  inherited.blockIds = ['block-1'];
  inherited.annotationIds = [];
  projected.blockGroups = [inherited];
  assert.throws(() => materializeAnnotatedTextSnapshot(projected, Doc.body), /exactly id, blockIds, and annotationIds/);
});

test('rejects raw canonical snapshots and hidden fields on restricted blocks', () => {
  const Doc = entity('RecipientOnlySnapshotDoc', {
    project: ref('Project'), owner: ref('User'), body: declaration(),
  });
  const raw = snapshot();
  delete raw.kind;
  assert.throws(() => materializeAnnotatedTextSnapshot(raw, Doc.body), /recipient projection/);
  const restricted = snapshot();
  restricted.blocks[0] = { kind: 'restricted', id: 'block-1', placeholder: '[Restricted]', text: 'hidden' };
  restricted.annotations = [];
  restricted.memberships = [];
  restricted.measurements = [];
  assert.throws(() => materializeAnnotatedTextSnapshot(restricted, Doc.body), /restricted block/);
  restricted.blocks[0] = { kind: 'restricted', id: 'block-1', placeholder: '[Restricted]' };
  restricted.blockGroups = [];
  const document = materializeAnnotatedTextSnapshot(restricted, Doc.body);
  assert.deepEqual(document.blocks, [{ kind: 'restricted', id: 'block-1', placeholder: '[Restricted]' }]);
  restricted.blocks[0].extra = true;
  assert.throws(() => materializeAnnotatedTextSnapshot(restricted, Doc.body), /restricted block/);
  delete restricted.blocks[0].extra;
  restricted.measurements = [{ id: 'm', blockId: 'block-1', family: 'words', formatVersion: 1, payload: {} }];
  assert.throws(() => materializeAnnotatedTextSnapshot(restricted, Doc.body), /restricted blocks cannot have measurements/);
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
  assert.equal('basis' in document, false);
  assert.equal('authoring' in document, false);
});

test('rejects incomplete or invalid v9 authoring envelope', () => {
  const Doc = entity('AuthoringEnvelopeDoc', {
    project: ref('Project'), owner: ref('User'), body: declaration(),
  });

  assert.throws(() => materializeAnnotatedTextSnapshot({ ...snapshot(), authoring: null }, Doc.body), /authoring/);
  assert.throws(() => materializeAnnotatedTextSnapshot({ ...snapshot(), authoring: {} }, Doc.body), /authoring/);
  assert.throws(() => materializeAnnotatedTextSnapshot({ ...snapshot(), authoring: { version: 1 } }, Doc.body), /authoring/);
  assert.throws(() => materializeAnnotatedTextSnapshot({ ...snapshot(), authoring: { version: 1, stream: 's', lease: 'l', snapshot: 'snap', acknowledgementFence: -1, positionFrames: [], groupFrames: [], splitResolutions: [] } }, Doc.body), /authoring/);

  const authoring = { version: 1, stream: 's', lease: 'l', snapshot: 'snap', acknowledgementFence: 0, positionFrames: [{ blockId: 'block-1', positionToken: 'x' }], groupFrames: [], splitResolutions: [] };
  assert.throws(() => materializeAnnotatedTextSnapshot({ ...snapshot(), authoring: { ...authoring, positionFrames: [] } }, Doc.body), /authoring/);
});

test('accepts and strips valid v9 authoring envelope from public document', () => {
  const Doc = entity('AuthoringStrippedDoc', {
    project: ref('Project'), owner: ref('User'), body: declaration(),
  });
  const data = snapshot();
  const withAuthoring = { ...data, authoring: { version: 1, stream: 'a'.repeat(43), lease: 'b'.repeat(43), snapshot: 'c'.repeat(43), acknowledgementFence: 0, positionFrames: [{ blockId: 'block-1', positionToken: 'd'.repeat(43) }], groupFrames: [{ groupToken: 'e'.repeat(43) }], splitResolutions: [] } };
  const document = materializeAnnotatedTextSnapshot(withAuthoring, Doc.body);
  assert.equal('basis' in document, false);
  assert.equal('authoring' in document, false);
  assert.equal(document.version, 1);
});

test('validates authoring.positionFrames exactly match visible blocks', () => {
  const Doc = entity('PositionFrameMatchDoc', {
    project: ref('Project'), owner: ref('User'), body: declaration(),
  });

  const extra = { version: 1, stream: 'a'.repeat(43), lease: 'b'.repeat(43), snapshot: 'c'.repeat(43), acknowledgementFence: 0, positionFrames: [{ blockId: 'block-1', positionToken: 'a'.repeat(43) }, { blockId: 'block-2', positionToken: 'b'.repeat(43) }], groupFrames: [{ groupToken: 'e'.repeat(43) }], splitResolutions: [] };
  assert.throws(() => materializeAnnotatedTextSnapshot({ ...snapshot(), authoring: extra }, Doc.body), /positionFrames/);

  const empty = { version: 1, stream: 'a'.repeat(43), lease: 'b'.repeat(43), snapshot: 'c'.repeat(43), acknowledgementFence: 0, positionFrames: [], groupFrames: [{ groupToken: 'e'.repeat(43) }], splitResolutions: [] };
  assert.throws(() => materializeAnnotatedTextSnapshot({ ...snapshot(), authoring: empty }, Doc.body), /positionFrames/);
});

test('validates authoring.groupFrames exactly match block groups', () => {
  const Doc = entity('GroupFrameMatchDoc', {
    project: ref('Project'), owner: ref('User'), body: declaration(),
  });
  const extra = { version: 1, stream: 'a'.repeat(43), lease: 'b'.repeat(43), snapshot: 'c'.repeat(43), acknowledgementFence: 0, positionFrames: [{ blockId: 'block-1', positionToken: 'd'.repeat(43) }], groupFrames: [{ groupToken: 'g1'.repeat(22) }, { groupToken: 'g2'.repeat(22) }], splitResolutions: [] };
  assert.throws(() => materializeAnnotatedTextSnapshot({ ...snapshot(), authoring: extra }, Doc.body), /groupFrames/);
});

test('rejects authoring envelope with duplicate split resolution tokens', () => {
  const Doc = entity('DuplicateSplitDoc', {
    project: ref('Project'), owner: ref('User'), body: declaration(),
  });
  const data = snapshot();
  data.blocks.push({ kind: 'visible', id: 'block-2', text: 'World', fields: {}, annotationIds: [] });
  data.blockGroups = [{ id: 'group-1', blockIds: ['block-1', 'block-2'], annotationIds: [] }];
  data.memberships = [];
  data.measurements = [];
  const authoring = {
    version: 1, stream: 'a'.repeat(43), lease: 'b'.repeat(43), snapshot: 'c'.repeat(43), acknowledgementFence: 0,
    positionFrames: [
      { blockId: 'block-1', positionToken: 'd'.repeat(43) },
      { blockId: 'block-2', positionToken: 'e'.repeat(43) },
    ],
    groupFrames: [{ groupToken: 'g'.repeat(43) }],
    splitResolutions: [
      { temporaryBlock: 'f'.repeat(43), blockId: 'block-2' },
      { temporaryBlock: 'f'.repeat(43), blockId: 'block-2' },
    ],
  };
  assert.throws(() => materializeAnnotatedTextSnapshot({ ...data, authoring }, Doc.body), /splitResolutions/);
});

test('rejects authoring envelope extra keys, malformed tokens, and token reuse', () => {
  const Doc = entity('StrictAuthoringEnvelopeDoc', {
    project: ref('Project'), owner: ref('User'), body: declaration(),
  });
  const valid = {
    version: 1, stream: 'a'.repeat(43), lease: 'b'.repeat(43), snapshot: 'c'.repeat(43), acknowledgementFence: 0,
    positionFrames: [{ blockId: 'block-1', positionToken: 'd'.repeat(43) }], groupFrames: [{ groupToken: 'e'.repeat(43) }], splitResolutions: [],
  };
  assert.throws(() => materializeAnnotatedTextSnapshot({ ...snapshot(), authoring: { ...valid, extra: true } }, Doc.body), /authoring/);
  assert.throws(() => materializeAnnotatedTextSnapshot({ ...snapshot(), authoring: { ...valid, lease: valid.stream } }, Doc.body), /authoring/);
  assert.throws(() => materializeAnnotatedTextSnapshot({ ...snapshot(), authoring: { ...valid, positionFrames: [{ blockId: 'block-1', positionToken: 'not-a-256-bit-token' }] } }, Doc.body), /positionFrames/);
  assert.throws(() => materializeAnnotatedTextSnapshot({ ...snapshot(), authoring: { ...valid, positionFrames: [{ blockId: 'block-1', positionToken: valid.stream }] } }, Doc.body), /positionFrames/);
  assert.throws(() => materializeAnnotatedTextSnapshot({ ...snapshot(), authoring: { ...valid, groupFrames: [{ groupToken: valid.stream }] } }, Doc.body), /groupFrames/);
  assert.throws(() => materializeAnnotatedTextSnapshot({ ...snapshot(), authoring: { ...valid, positionFrames: [{ blockId: 'block-1', positionToken: 'd'.repeat(43), extra: true }] } }, Doc.body), /positionFrames/);
});

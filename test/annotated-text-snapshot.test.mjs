import assert from 'node:assert/strict';
import test from 'node:test';
import {
  annotatedText, annotation, annotationAction, entity, measurement, ref,
  registerAnnotatedTextContract,
} from '../build/index.mjs';
import { registerAnnotatedTextStructuralExtension } from '../build/internal.mjs';
import { materializeAnnotatedTextSnapshot, projectPendingAnnotatedTextDocument } from '../public/workbench-annotated-text-snapshot.mjs';
import { materializeAnnotatedTextSnapshot as clientSnapshot } from '../public/workbench-client.mjs';

const suffix = 'snapshotT3';
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
    annotations: [annotation('coding', { actions: { revise: annotationAction({ change: () => ({ fields: {} }) }) } })],
    measurements: [measurement('words', {
      extension: `${suffix}Measurement`,
      queries: [`${suffix}Query`],
    })],
    capabilities: { read: Object.freeze({}) },
  });
}

function Doc() {
  return entity('AnnotationSnapshotDoc', {
    project: ref('Project'), owner: ref('User'), body: declaration(),
  });
}

function recipient(overrides = {}) {
  return {
    kind: 'workbench.annotatedText.recipient', version: 1,
    text: 'Hello world',
    ranges: [{ annotationId: 'a1', start: 6, end: 11 }],
    annotations: [{ id: 'a1', family: 'coding', fields: {} }],
    orphans: [],
    measurements: [{ id: 'm1', family: 'words', formatVersion: 1, payload: {} }],
    capabilityHints: [],
    ...overrides,
  };
}

test('materializes a blockless recipient into public immutable shapes', () => {
  const handle = Doc().body;
  const document = materializeAnnotatedTextSnapshot(recipient(), handle);
  assert.deepEqual(document, {
    kind: 'workbench.annotatedText.recipient', version: 1,
    text: 'Hello world',
    ranges: [{ annotationId: 'a1', start: 6, end: 11 }],
    annotations: [{ id: 'a1', family: 'coding', fields: {} }],
    orphans: [],
    measurements: [{ id: 'm1', family: 'words', formatVersion: 1, payload: {} }],
    capabilities: [],
  });
  assert.ok(Object.isFrozen(document));
  assert.ok(Object.isFrozen(document.capabilities));
  assert.ok(Object.isFrozen(document.ranges[0]));
  assert.ok(Object.isFrozen(document.annotations[0]));
  assert.ok(Object.isFrozen(document.annotations[0].fields));
  assert.ok(Object.isFrozen(document.orphans));
  assert.ok(Object.isFrozen(document.measurements[0]));
  // No block-era or binding-era keys leak into the public document. The raw
  // capabilityHints wire property stays absent; its validated names appear
  // only under `capabilities`.
  for (const absent of ['basis', 'authoring', 'blocks', 'blockGroups', 'memberships', 'capabilityHints']) {
    assert.equal(absent in document, false, `${absent} must not leak`);
  }
});

test('materialization validates then adopts parsed collections without rebuilding them', () => {
  const snapshot = recipient();
  const document = materializeAnnotatedTextSnapshot(snapshot, Doc().body);
  assert.equal(document.ranges, snapshot.ranges);
  assert.equal(document.annotations, snapshot.annotations);
  assert.equal(document.annotations[0].fields, snapshot.annotations[0].fields);
  assert.equal(document.orphans, snapshot.orphans);
  assert.equal(document.measurements, snapshot.measurements);
  assert.ok(Object.isFrozen(snapshot.annotations[0].fields));
});

test('materialization rejects unknown nested wire keys before installation', () => {
  const handle = Doc().body;
  assert.throws(() => materializeAnnotatedTextSnapshot(recipient({
    ranges: [{ annotationId: 'a1', start: 6, end: 11, hidden: true }],
  }), handle), /v1 ranges must be offset pairs/);
  assert.throws(() => materializeAnnotatedTextSnapshot(recipient({
    annotations: [{ id: 'a1', family: 'coding', fields: {}, hidden: true }],
  }), handle), /annotation is invalid/);
  assert.throws(() => materializeAnnotatedTextSnapshot(recipient({
    measurements: [{ id: 'm1', family: 'words', formatVersion: 1, payload: {}, hidden: true }],
  }), handle), /measurement is invalid/);
});

test('projects capabilityHints into the public capabilities array (restricted recipients are review-only)', () => {
  const document = materializeAnnotatedTextSnapshot(recipient({ capabilityHints: ['edit', 'body.read'] }));
  assert.deepEqual(document.capabilities, ['edit', 'body.read']);
  assert.ok(Object.isFrozen(document.capabilities));
  assert.equal('capabilityHints' in document, false);

  const plain = materializeAnnotatedTextSnapshot(recipient());
  assert.deepEqual(plain.capabilities, []);

  const restricted = materializeAnnotatedTextSnapshot(recipient({
    restricted: true,
    text: '',
    ranges: [],
    annotations: [],
    orphans: [],
    measurements: [],
  }));
  assert.equal(restricted.restricted, true);
  assert.equal(restricted.capabilities, null);
  // Restricted documents retain the full recipient shape with empty sensitive
  // collections (issue #33 contract).
  assert.deepEqual(restricted.orphans, []);
  assert.deepEqual(restricted.measurements, []);
});

test('materializes granted capability hints into capabilities and rejects malformed hints fail-closed', () => {
  const handle = Doc().body;
  assert.deepEqual(materializeAnnotatedTextSnapshot(recipient({ capabilityHints: ['read'] }), handle).capabilities, ['read']);
  assert.throws(() => materializeAnnotatedTextSnapshot(recipient({ capabilityHints: ['read', 'read'] }), handle), /not a unique declared capability/);
  assert.throws(() => materializeAnnotatedTextSnapshot(recipient({ capabilityHints: ['unknown'] }), handle), /not a unique declared capability/);
  assert.throws(() => materializeAnnotatedTextSnapshot(recipient({ capabilityHints: ['read', 7] }), handle), /not a unique declared capability/);
  assert.throws(() => materializeAnnotatedTextSnapshot(recipient({ capabilityHints: 'nope' }), handle), /capabilityHints must be an array/);
  // A call without a compiled handle still receives the projected names.
  const plain = materializeAnnotatedTextSnapshot(recipient());
  assert.deepEqual(plain.capabilities, []);
  assert.equal('capabilityHints' in plain, false);
});

test('materializes document-level redactions without expanding text', () => {
  const document = materializeAnnotatedTextSnapshot(recipient({
    text: 'before  after',
    redactions: [{ start: 7, end: 7, placeholder: '[Private]' }],
  }));
  assert.equal(document.text, 'before  after');
  assert.deepEqual(document.redactions, [{ start: 7, end: 7, placeholder: '[Private]' }]);
  assert.ok(Object.isFrozen(document.redactions[0]));

  assert.throws(() => materializeAnnotatedTextSnapshot(recipient({ redactions: 'nope' })), /redactions must be an array/);
  // Malformed markers (non-integer, negative, reversed, out-of-bounds, missing
  // placeholder) are rejected fail-closed.
  for (const bad of [
    [{ start: '7', end: 7, placeholder: 'x' }],
    [{ start: -1, end: 0, placeholder: 'x' }],
    [{ start: 7, end: 5, placeholder: 'x' }],
    [{ start: 0, end: 999, placeholder: 'x' }],
    [{ start: 0, end: 1 }],
  ]) {
    assert.throws(() => materializeAnnotatedTextSnapshot(recipient({ text: 'abcdef', redactions: bad })), /redaction markers must be in-bounds/);
  }
  // Empty redactions array produces no redactions key at all.
  assert.equal('redactions' in materializeAnnotatedTextSnapshot(recipient({ redactions: [] })), false);
});

test('materializer rejects annotation families the handle does not declare', () => {
  const handle = Doc().body;
  assert.throws(() => materializeAnnotatedTextSnapshot(recipient({
    annotations: [{ id: 'x', family: 'undeclared', fields: {} }],
  }), handle), /family 'undeclared' is not declared/);
  // Declared families pass.
  const document = materializeAnnotatedTextSnapshot(recipient({
    annotations: [{ id: 'a1', family: 'coding', fields: {} }],
  }), handle);
  assert.equal(document.annotations[0].family, 'coding');
});

test('materializes annotation owner when present (pass-through)', () => {
  const document = materializeAnnotatedTextSnapshot(recipient({
    annotations: [{ id: 'a1', family: 'coding', fields: {}, owner: 'user-42' }],
  }));
  assert.equal(document.annotations[0].owner, 'user-42');
  assert.ok(Object.isFrozen(document.annotations[0]));
});

test('rejects incomplete or non-recipient envelopes', () => {
  const errors = [
    { ...recipient(), kind: 'other' },
    { ...recipient(), kind: undefined },
    { ...recipient(), version: 3 },
    { ...recipient(), text: undefined },
    { ...recipient(), ranges: 'nope' },
    { ...recipient(), annotations: 'nope' },
    { ...recipient(), measurements: 'nope' },
    'not-an-object',
    null,
  ];
  for (const bad of errors) {
    assert.throws(() => materializeAnnotatedTextSnapshot(bad), /complete blockless recipient envelope/);
  }
  assert.throws(() => materializeAnnotatedTextSnapshot(recipient({ orphans: 'nope' })), /orphans must be an array/);
  assert.throws(() => materializeAnnotatedTextSnapshot(recipient({ redactions: 'nope' })), /redactions must be an array/);
  assert.throws(() => materializeAnnotatedTextSnapshot(recipient({ version: 2 })), /family replica|structural endpoints/);
});

test('materializes restricted flag and orphans without savedRange', () => {
  const document = materializeAnnotatedTextSnapshot(recipient({
    restricted: true,
    orphans: [{ id: 'o1', family: 'coding', fields: {}, owner: 'u1', savedQuote: 'old text' }],
  }));
  assert.equal(document.restricted, true);
  assert.deepEqual(document.orphans, [{ id: 'o1', family: 'coding', fields: {}, owner: 'u1', savedQuote: 'old text' }]);
  assert.equal('savedRange' in document.orphans[0], false);
  assert.ok(Object.isFrozen(document.orphans[0]));
  assert.ok(Object.isFrozen(document.orphans[0].fields));
});

test('strips authoring from public document', () => {
  const authoring = {
    version: 1, stream: 'stream-token', lease: 'lease-token', snapshot: 'snapshot-token', acknowledgementFence: 7,
    positionFrames: [{ positionToken: 'position-token' }],
    family: { id: 'd1', checkpoint: { version: 1, frontier: [], elements: {}, operations: {}, pending: {}, rebootstrapRequired: false } },
  };
  const document = materializeAnnotatedTextSnapshot(recipient({ authoring }));
  assert.equal(document.version, 1);
  assert.equal('authoring' in document, false);
  assert.equal('basis' in document, false);
  assert.equal(document.text, 'Hello world');
});

test('materializeAnnotatedTextSnapshot is re-exported from public/workbench-client.mjs', () => {
  assert.equal(clientSnapshot, materializeAnnotatedTextSnapshot);
  const document = clientSnapshot(recipient());
  assert.equal(document.version, 1);
  assert.ok(Object.isFrozen(document));
});

test('projectPendingAnnotatedTextDocument splices absolute offsets', () => {
  const base = recipient();
  const insert = materializeAnnotatedTextSnapshot(base);
  const afterInsert = projectPendingAnnotatedTextDocument(insert, {
    payload: { version: 9, edit: { kind: 'text.insert', at: { offset: 6 }, text: 'brave ' } },
  });
  assert.equal(afterInsert.text, 'Hello brave world');
  assert.deepEqual(afterInsert.ranges, [{ annotationId: 'a1', start: 6, end: 17 }]);

  const afterDelete = projectPendingAnnotatedTextDocument(afterInsert, {
    payload: { version: 9, edit: { kind: 'text.delete', from: { offset: 6 }, to: { offset: 12 } } },
  });
  assert.equal(afterDelete.text, 'Hello world');

  const afterReplace = projectPendingAnnotatedTextDocument(insert, {
    payload: { version: 9, edit: { kind: 'text.replace', from: { offset: 6 }, to: { offset: 11 }, text: 'there' } },
  });
  assert.equal(afterReplace.text, 'Hello there');

  const afterAnnotationRemove = projectPendingAnnotatedTextDocument(insert, {
    payload: { version: 9, edit: { kind: 'annotation.remove', annotationId: 'a1' } },
  });
  assert.deepEqual(afterAnnotationRemove.ranges, []);
  assert.deepEqual(afterAnnotationRemove.annotations, []);
  assert.equal(afterAnnotationRemove.text, insert.text);
  assert.ok(Object.isFrozen(afterAnnotationRemove.ranges));
  assert.ok(Object.isFrozen(afterAnnotationRemove.annotations));

  // Non-v9 payloads are ignored and return the original document.
  assert.equal(projectPendingAnnotatedTextDocument(insert, { payload: { version: 8, edit: { kind: 'text.insert' } } }), insert);
  assert.equal(projectPendingAnnotatedTextDocument(insert, { payload: { version: 9, edit: null } }), insert);
  // Out-of-range offsets return the original document.
  assert.equal(projectPendingAnnotatedTextDocument(insert, {
    payload: { version: 9, edit: { kind: 'text.insert', at: { offset: 100 }, text: 'x' } },
  }), insert);
  assert.equal(projectPendingAnnotatedTextDocument(insert, {
    payload: { version: 9, edit: { kind: 'text.replace', from: { offset: 6 }, to: { offset: 5 }, text: 'x' } },
  }), insert);
  assert.ok(Object.isFrozen(afterInsert));
});

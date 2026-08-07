import assert from 'node:assert/strict';
import test from 'node:test';
import {
  annotatedText, annotation, annotationAction, entity, measurement, ref,
  registerAnnotatedTextContract,
} from '../src/index.mjs';
import { registerAnnotatedTextStructuralExtension } from '../src/internal.mjs';
import { materializeAnnotatedTextSnapshot, projectPendingAnnotatedTextDocument } from '../public/workbench-annotated-text-snapshot.mjs';
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
  });
  assert.ok(Object.isFrozen(document));
  assert.ok(Object.isFrozen(document.ranges[0]));
  assert.ok(Object.isFrozen(document.annotations[0]));
  assert.ok(Object.isFrozen(document.annotations[0].fields));
  assert.ok(Object.isFrozen(document.orphans));
  assert.ok(Object.isFrozen(document.measurements[0]));
  // No block-era or binding-era keys leak into the public document.
  for (const absent of ['basis', 'authoring', 'blocks', 'blockGroups', 'memberships', 'capabilityHints']) {
    assert.equal(absent in document, false, `${absent} must not leak`);
  }
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
  // Empty redactions array produces no redactions key at all.
  assert.equal('redactions' in materializeAnnotatedTextSnapshot(recipient({ redactions: [] })), false);
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
    { ...recipient(), version: 2 },
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
    version: 1, stream: 's', lease: 'l', snapshot: 'snap', acknowledgementFence: 0,
    positionFrames: [{ positionToken: 'x' }],
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

  const afterDelete = projectPendingAnnotatedTextDocument(afterInsert, {
    payload: { version: 9, edit: { kind: 'text.delete', from: { offset: 6 }, to: { offset: 12 } } },
  });
  assert.equal(afterDelete.text, 'Hello world');

  const afterReplace = projectPendingAnnotatedTextDocument(insert, {
    payload: { version: 9, edit: { kind: 'text.replace', from: { offset: 6 }, to: { offset: 11 }, text: 'there' } },
  });
  assert.equal(afterReplace.text, 'Hello there');

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

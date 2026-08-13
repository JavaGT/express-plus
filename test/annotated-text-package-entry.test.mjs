import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  annotatedText as rootAnnotatedText,
  annotation as rootAnnotation,
  entity,
  grant,
  measurement as rootMeasurement,
  protectingAnnotation as rootProtectingAnnotation,
  read,
  ref,
} from '../build/index.mjs';
import {
  annotatedText,
  annotation,
  measurement,
  protectingAnnotation,
  registerAnnotatedTextContract,
  registerAnnotatedTextStructuralExtension,
  annotatedTextAction,
  annotatedTextCreateAction,
  annotatedTextRetireAction,
  exportAnnotatedText,
  readAnnotatedTextForRecipient,
} from '../build/annotated-text-public.mjs';

const extension = 'packageEntryMeasurement';
const token = (label) => `${label}${'x'.repeat(43)}`.slice(0, 43);
registerAnnotatedTextContract(extension, Object.freeze({ kind: 'measurement' }));
registerAnnotatedTextStructuralExtension(extension, Object.freeze({
  version: 1,
  validate: function validate() {},
  edit: function edit() {},
  partition: function partition() {},
  combine: function combine() {},
}));

test('annotated-text package entry shares declarations and registry authority with root', () => {
  assert.equal(annotatedText, rootAnnotatedText);
  assert.equal(annotation, rootAnnotation);
  assert.equal(measurement, rootMeasurement);
  assert.equal(protectingAnnotation, rootProtectingAnnotation);
  assert.equal(typeof exportAnnotatedText, 'function');
  assert.equal(typeof readAnnotatedTextForRecipient, 'function');

  const Document = entity('PackageEntryDocument', {
    project: ref('Project'),
    owner: ref('User'),
    body: annotatedText({
      project: 'project',
      owner: 'owner',
      annotations: [annotation('coding'), protectingAnnotation('confidential', { protects: 'coding', access: async () => grant(read) })],
      measurements: [measurement('words', { extension })],
    }),
    grant: grant(read),
  });

  assert.equal(Document.fields.body.kind, 'annotatedText');
  assert.equal(Document.body.annotations.coding.annotationName, 'coding');
  assert.equal(Document.body.annotations.confidential.annotationName, 'confidential');
  assert.equal(Document.body.measurements.words.measurementName, 'words');
});

test('public action grammar validates field handles and emits closed v9 authoring action requests', () => {
  const Document = entity('PackageActionDocument', {
    project: ref('Project'), owner: ref('User'),
    body: annotatedText({ project: 'project', owner: 'owner', annotations: [annotation('coding')], measurements: [measurement('words', { extension })] }),
    summary: annotatedText({ project: 'project', owner: 'owner', annotations: [annotation('coding')], measurements: [measurement('words', { extension })] }),
    grant: grant(read),
  });
  const authoring = { version: 1, stream: token('stream'), lease: token('lease'), mutationId: 'insert-1' };
  const request = annotatedTextAction(Document, Document.body, { kind: 'text.insert', id: 'doc-1', authoring, at: { positionToken: token('position'), offset: 0, affinity: 'right' }, text: 'hello' });
  assert.equal(request.type, 'PackageActionDocument.body.operation');
  assert.equal('scope' in request, false);
  assert.equal(request.payload.version, 9);
  assert.ok(Object.isFrozen(request));
  assert.ok(Object.isFrozen(request.payload));
  assert.throws(() => annotatedTextAction(Document, Document.project, { kind: 'text.insert', id: 'doc-1', authoring, at: { positionToken: token('position'), offset: 0, affinity: 'right' }, text: 'hello' }), /not an annotatedText field/);
  assert.deepEqual(annotatedTextAction(Document, Document.body, { kind: 'text.delete', id: 'doc-1', authoring, from: { positionToken: token('position'), offset: 0, affinity: 'left' }, to: { positionToken: token('position'), offset: 1, affinity: 'right' } }).payload.edit, { kind: 'text.delete', from: { positionToken: token('position'), offset: 0, affinity: 'left' }, to: { positionToken: token('position'), offset: 1, affinity: 'right' } });
  assert.deepEqual(annotatedTextAction(Document, Document.body, {
    kind: 'text.replace', id: 'doc-1', authoring,
    from: { positionToken: token('position'), offset: 0, affinity: 'left' },
    to: { positionToken: token('position'), offset: 1, affinity: 'right' },
    text: 'x',
  }).payload.edit, {
    kind: 'text.replace',
    from: { positionToken: token('position'), offset: 0, affinity: 'left' },
    to: { positionToken: token('position'), offset: 1, affinity: 'right' },
    text: 'x',
  });
  const applied = annotatedTextAction(Document, Document.body, {
    kind: 'annotation.apply', id: 'doc-1', authoring,
    annotation: { id: 'annotation-1', family: 'coding', fields: { value: 'x' } },
    from: { positionToken: token('position'), offset: 0, affinity: 'left' },
    to: { positionToken: token('position'), offset: 5, affinity: 'right' },
  });
  assert.deepEqual(applied.payload.edit, {
    kind: 'annotation.apply',
    annotation: { id: 'annotation-1', family: 'coding', fields: { value: 'x' } },
    from: { positionToken: token('position'), offset: 0, affinity: 'left' },
    to: { positionToken: token('position'), offset: 5, affinity: 'right' },
  });
  assert.ok(Object.isFrozen(applied.payload.edit.annotation));
  assert.deepEqual(annotatedTextAction(Document, Document.body, {
    kind: 'annotation.remove', id: 'doc-1', authoring, annotationId: 'annotation-1',
  }).payload.edit, { kind: 'annotation.remove', annotationId: 'annotation-1' });

  assert.deepEqual(annotatedTextCreateAction(Document, Document.body, { id: 'doc-1', projectId: 'p1', ownerId: 'u1' }), {
    type: 'PackageActionDocument.create', payload: { id: 'doc-1', project: 'p1', owner: 'u1' },
  });
  assert.deepEqual(annotatedTextRetireAction(Document, 'doc-1'), {
    type: 'PackageActionDocument.annotatedText.retire', payload: { id: 'doc-1' },
  });
  assert.throws(() => annotatedTextCreateAction(Document, Document.body, { projectId: 'p1', ownerId: 'u1' }), /non-empty id/);
  assert.throws(() => annotatedTextCreateAction(Document, Document.body, { id: 'blank-source', projectId: 'p1', ownerId: 'u1', source: { text: '' } }), /source requires non-empty text/);
  assert.throws(() => annotatedTextCreateAction(Document, Document.body, { id: 'block-source', projectId: 'p1', ownerId: 'u1', source: { blocks: [{ text: 'fail-closed' }] } }), /source requires non-empty text/);
  assert.throws(() => annotatedTextCreateAction(Document, Document.body, { id: 'second-field', projectId: 'p1', ownerId: 'u1', fields: { summary: { version: 1, blocks: [{ text: 'bypass' }] } } }), /cannot include 'summary'/);
});

test('public structural registration remains required for measurement declarations', () => {
  const missingExtension = 'packageEntryMissingStructuralAdapter';
  registerAnnotatedTextContract(missingExtension, Object.freeze({ kind: 'measurement' }));

  assert.throws(() => entity('PackageEntryMissingAdapterDocument', {
    project: ref('Project'),
    owner: ref('User'),
    body: annotatedText({
      project: 'project', owner: 'owner',
      annotations: [annotation('coding')],
      measurements: [measurement('words', { extension: missingExtension })],
    }),
    grant: grant(read),
  }), /has no registered structural adapter/);
});

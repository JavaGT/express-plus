import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  annotatedText as rootAnnotatedText,
  annotation as rootAnnotation,
  entity,
  grant,
  measurement as rootMeasurement,
  read,
  ref,
} from '../src/index.mjs';
import {
  annotatedText,
  annotation,
  measurement,
  registerAnnotatedTextContract,
  registerAnnotatedTextStructuralExtension,
  annotatedTextAction,
  annotatedTextCreateAction,
} from '../src/annotated-text-public.mjs';

const extension = 'packageEntryMeasurement';
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

  const Document = entity('PackageEntryDocument', {
    project: ref('Project'),
    owner: ref('User'),
    body: annotatedText({
      project: 'project',
      owner: 'owner',
      block: {},
      annotations: [annotation('coding')],
      measurements: [measurement('words', { extension })],
    }),
    grant: grant(read),
  });

  assert.equal(Document.fields.body.kind, 'annotatedText');
  assert.equal(Document.body.annotations.coding.annotationName, 'coding');
  assert.equal(Document.body.measurements.words.measurementName, 'words');
});

test('public action grammar validates field handles and emits closed generated action requests', () => {
  const Document = entity('PackageActionDocument', {
    project: ref('Project'), owner: ref('User'),
    body: annotatedText({ project: 'project', owner: 'owner', block: {}, annotations: [annotation('coding')], measurements: [measurement('words', { extension })] }),
    grant: grant(read),
  });
  const request = annotatedTextAction(Document, Document.body, { kind: 'text.insert', id: 'doc-1', basis: 'opaque-basis', mutationId: 'insert-1', at: { blockId: 'block-1', offset: 0 }, text: 'hello' });
  assert.equal(request.type, 'PackageActionDocument.body.operation');
  assert.equal(request.scope, 'PackageActionDocument:doc-1');
  assert.equal(request.payload.version, 6);
  assert.ok(Object.isFrozen(request));
  assert.ok(Object.isFrozen(request.payload));
  assert.throws(() => annotatedTextAction(Document, Document.project, { kind: 'text.insert', id: 'doc-1', basis: 'opaque-basis', mutationId: 'insert-1', at: { blockId: 'block-1', offset: 0 }, text: 'hello' }), /not an annotatedText field/);
  assert.deepEqual(annotatedTextAction(Document, Document.body, { kind: 'text.delete', id: 'doc-1', basis: 'opaque-basis', mutationId: 'delete-1', from: { blockId: 'block-1', offset: 0 }, to: { blockId: 'block-1', offset: 1 } }).payload.edit, { kind: 'text.delete', from: { blockId: 'block-1', offset: 0 }, to: { blockId: 'block-1', offset: 1 } });

  assert.deepEqual(annotatedTextCreateAction(Document, { id: 'doc-1', project: 'p1', owner: 'u1' }), {
    type: 'PackageActionDocument.create', scope: 'PackageActionDocument:doc-1', payload: { id: 'doc-1', project: 'p1', owner: 'u1' },
  });
  assert.throws(() => annotatedTextCreateAction(Document, { project: 'p1' }), /non-empty id/);
});

test('public structural registration remains required for measurement declarations', () => {
  const missingExtension = 'packageEntryMissingStructuralAdapter';
  registerAnnotatedTextContract(missingExtension, Object.freeze({ kind: 'measurement' }));

  assert.throws(() => entity('PackageEntryMissingAdapterDocument', {
    project: ref('Project'),
    owner: ref('User'),
    body: annotatedText({
      project: 'project', owner: 'owner', block: {},
      annotations: [annotation('coding')],
      measurements: [measurement('words', { extension: missingExtension })],
    }),
    grant: grant(read),
  }), /has no registered structural adapter/);
});

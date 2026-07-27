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

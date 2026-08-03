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
  annotatedTextRetireAction,
} from '../src/annotated-text-public.mjs';

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

test('public action grammar validates field handles and emits closed v9 authoring action requests', () => {
  const Document = entity('PackageActionDocument', {
    project: ref('Project'), owner: ref('User'),
    body: annotatedText({ project: 'project', owner: 'owner', block: {}, annotations: [annotation('coding')], measurements: [measurement('words', { extension })] }),
    summary: annotatedText({ project: 'project', owner: 'owner', block: {}, annotations: [annotation('coding')], measurements: [measurement('words', { extension })] }),
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

  assert.deepEqual(annotatedTextCreateAction(Document, Document.body, { id: 'doc-1', projectId: 'p1', ownerId: 'u1' }), {
    type: 'PackageActionDocument.create', payload: { id: 'doc-1', project: 'p1', owner: 'u1' },
  });
  assert.deepEqual(annotatedTextAction(Document, Document.body, { kind: 'block.split', id: 'doc-1', authoring, at: { positionToken: token('position'), offset: 1, affinity: 'right' }, temporaryBlock: token('temporary') }).payload, {
    version: 9, id: 'doc-1', authoring, edit: { kind: 'block.split', at: { positionToken: token('position'), offset: 1, affinity: 'right' }, temporaryBlock: token('temporary') },
  });
  const assignment = annotatedTextAction(Document, Document.body, {
    kind: 'block-group.assignment.set', id: 'doc-1', authoring,
    selection: { kind: 'listed', groupTokens: [token('group2'), token('group1')] },
    annotation: { id: 'annotation-1', family: 'coding', fields: { value: 'x' } },
  });
  assert.deepEqual(assignment.payload, {
    version: 9, id: 'doc-1', authoring, edit: {
      kind: 'block-group.assignment.set', selection: { kind: 'listed', groupTokens: [token('group2'), token('group1')] },
      annotation: { id: 'annotation-1', family: 'coding', fields: { value: 'x' } },
    },
  });
  assert.ok(Object.isFrozen(assignment.payload.edit.selection));
  assert.ok(Object.isFrozen(assignment.payload.edit.annotation));
  assert.deepEqual(annotatedTextAction(Document, Document.body, {
    kind: 'block-group.assignment.clear', id: 'doc-1', authoring,
    selection: { kind: 'one', groupToken: token('group1') }, family: 'coding',
  }).payload.edit, { kind: 'block-group.assignment.clear', selection: { kind: 'one', groupToken: token('group1') }, family: 'coding' });
  const continued = annotatedTextAction(Document, Document.body, {
    kind: 'block.continue', id: 'doc-1', authoring, at: { positionToken: token('position'), offset: 1, affinity: 'right' }, temporaryBlock: token('temporary'),
  });
  assert.deepEqual(continued.payload.edit, { kind: 'block.continue', at: { positionToken: token('position'), offset: 1, affinity: 'right' }, temporaryBlock: token('temporary') });
  assert.equal(continued.payload.version, 9);
  const splitAssignment = annotatedTextAction(Document, Document.body, {
    kind: 'block.split-and-assign', id: 'doc-1', authoring, at: { positionToken: token('position'), offset: 1, affinity: 'right' }, temporaryBlock: token('temporary'),
    annotation: { id: 'annotation-2', family: 'coding', fields: {} },
  });
  assert.equal(splitAssignment.payload.edit.kind, 'block.split-and-assign');
  assert.equal(splitAssignment.payload.version, 9);
  assert.equal(annotatedTextAction(Document, Document.body, {
    kind: 'block-group.assignment.clear', id: 'doc-1', authoring,
    selection: { kind: 'one', groupToken: token('group1') }, family: 'coding',
  }).payload.version, 9);
  assert.equal(assignment.payload.version, 9);
  for (const command of [
    { kind: 'block-group.assignment.set', selection: { kind: 'one', groupToken: 'g', extra: true }, annotation: { id: 'a', family: 'f', fields: {} } },
    { kind: 'block-group.assignment.set', selection: { kind: 'listed', groupTokens: ['g', 'g'] }, annotation: { id: 'a', family: 'f', fields: {} } },
    { kind: 'block-group.assignment.set', selection: { kind: 'one', groupToken: 'g' }, annotation: { id: 'a', family: 'f', fields: {}, protectedTargetIds: [] } },
    { kind: 'block-group.assignment.clear', selection: { kind: 'one', groupToken: 'g' }, family: '' },
  ]) assert.throws(() => annotatedTextAction(Document, Document.body, { ...command, id: 'doc-1', authoring, mutationId: 'm' }));
  assert.deepEqual(annotatedTextRetireAction(Document, 'doc-1'), {
    type: 'PackageActionDocument.annotatedText.retire', payload: { id: 'doc-1' },
  });
  assert.throws(() => annotatedTextCreateAction(Document, Document.body, { projectId: 'p1', ownerId: 'u1' }), /non-empty id/);
  assert.throws(() => annotatedTextCreateAction(Document, Document.body, { id: 'blank-source', projectId: 'p1', ownerId: 'u1', source: { blocks: [{ text: '' }] } }), /empty block/);
  assert.throws(() => annotatedTextCreateAction(Document, Document.body, { id: 'second-field', projectId: 'p1', ownerId: 'u1', fields: { summary: { version: 1, blocks: [{ text: 'bypass' }] } } }), /cannot include 'summary'/);
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

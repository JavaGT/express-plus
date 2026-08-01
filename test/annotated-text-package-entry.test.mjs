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
    summary: annotatedText({ project: 'project', owner: 'owner', block: {}, annotations: [annotation('coding')], measurements: [measurement('words', { extension })] }),
    grant: grant(read),
  });
  const request = annotatedTextAction(Document, Document.body, { kind: 'text.insert', id: 'doc-1', basis: 'opaque-basis', mutationId: 'insert-1', at: { blockId: 'block-1', offset: 0 }, text: 'hello' });
  assert.equal(request.type, 'PackageActionDocument.body.operation');
  assert.equal('scope' in request, false);
  assert.equal(request.payload.version, 6);
  assert.ok(Object.isFrozen(request));
  assert.ok(Object.isFrozen(request.payload));
  assert.throws(() => annotatedTextAction(Document, Document.project, { kind: 'text.insert', id: 'doc-1', basis: 'opaque-basis', mutationId: 'insert-1', at: { blockId: 'block-1', offset: 0 }, text: 'hello' }), /not an annotatedText field/);
  assert.deepEqual(annotatedTextAction(Document, Document.body, { kind: 'text.delete', id: 'doc-1', basis: 'opaque-basis', mutationId: 'delete-1', from: { blockId: 'block-1', offset: 0 }, to: { blockId: 'block-1', offset: 1 } }).payload.edit, { kind: 'text.delete', from: { blockId: 'block-1', offset: 0 }, to: { blockId: 'block-1', offset: 1 } });

  assert.deepEqual(annotatedTextCreateAction(Document, Document.body, { id: 'doc-1', projectId: 'p1', ownerId: 'u1' }), {
    type: 'PackageActionDocument.create', payload: { id: 'doc-1', project: 'p1', owner: 'u1' },
  });
  assert.deepEqual(annotatedTextAction(Document, Document.body, { kind: 'block.split', id: 'doc-1', basis: 'opaque-basis', mutationId: 'split-1', at: { blockId: 'block-1', offset: 1 } }).payload, {
    version: 7, id: 'doc-1', basis: 'opaque-basis', mutationId: 'split-1', edit: { kind: 'block.split', at: { blockId: 'block-1', offset: 1 } },
  });
  const assignment = annotatedTextAction(Document, Document.body, {
    kind: 'block-group.assignment.set', id: 'doc-1', basis: 'opaque-basis', mutationId: 'assign-1',
    selection: { kind: 'listed', blockGroupIds: ['group-2', 'group-1'] },
    annotation: { id: 'annotation-1', family: 'coding', fields: { value: 'x' } },
  });
  assert.deepEqual(assignment.payload, {
    version: 8, id: 'doc-1', basis: 'opaque-basis', mutationId: 'assign-1', edit: {
      kind: 'block-group.assignment.set', selection: { kind: 'listed', blockGroupIds: ['group-2', 'group-1'] },
      annotation: { id: 'annotation-1', family: 'coding', fields: { value: 'x' } },
    },
  });
  assert.ok(Object.isFrozen(assignment.payload.edit.selection));
  assert.ok(Object.isFrozen(assignment.payload.edit.annotation));
  assert.deepEqual(annotatedTextAction(Document, Document.body, {
    kind: 'block-group.assignment.clear', id: 'doc-1', basis: 'opaque-basis', mutationId: 'clear-1',
    selection: { kind: 'one', blockGroupId: 'group-1' }, family: 'coding',
  }).payload.edit, { kind: 'block-group.assignment.clear', selection: { kind: 'one', blockGroupId: 'group-1' }, family: 'coding' });
  const continued = annotatedTextAction(Document, Document.body, {
    kind: 'block.continue', id: 'doc-1', basis: 'opaque-basis', mutationId: 'continue-1', at: { blockId: 'block-1', offset: 1 },
  });
  assert.deepEqual(continued.payload.edit, { kind: 'block.continue', at: { blockId: 'block-1', offset: 1 } });
  assert.equal(continued.payload.version, 8);
  const splitAssignment = annotatedTextAction(Document, Document.body, {
    kind: 'block.split-and-assign', id: 'doc-1', basis: 'opaque-basis', mutationId: 'split-assign-1', at: { blockId: 'block-1', offset: 1 },
    annotation: { id: 'annotation-2', family: 'coding', fields: {} },
  });
  assert.equal(splitAssignment.payload.edit.kind, 'block.split-and-assign');
  assert.equal(splitAssignment.payload.version, 8);
  assert.equal(annotatedTextAction(Document, Document.body, {
    kind: 'block-group.assignment.clear', id: 'doc-1', basis: 'opaque-basis', mutationId: 'clear-2',
    selection: { kind: 'one', blockGroupId: 'group-1' }, family: 'coding',
  }).payload.version, 8);
  assert.equal(assignment.payload.version, 8);
  for (const command of [
    { kind: 'block-group.assignment.set', selection: { kind: 'one', blockGroupId: 'g', extra: true }, annotation: { id: 'a', family: 'f', fields: {} } },
    { kind: 'block-group.assignment.set', selection: { kind: 'listed', blockGroupIds: ['g', 'g'] }, annotation: { id: 'a', family: 'f', fields: {} } },
    { kind: 'block-group.assignment.set', selection: { kind: 'one', blockGroupId: 'g' }, annotation: { id: 'a', family: 'f', fields: {}, protectedTargetIds: [] } },
    { kind: 'block-group.assignment.clear', selection: { kind: 'one', blockGroupId: 'g' }, family: '' },
  ]) assert.throws(() => annotatedTextAction(Document, Document.body, { ...command, id: 'doc-1', basis: 'b', mutationId: 'm' }));
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

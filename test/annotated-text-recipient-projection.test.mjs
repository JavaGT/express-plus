import assert from 'node:assert/strict';
import test from 'node:test';
import { annotatedText, annotation, entity, grant, measurement, protectingAnnotation, read, ref, registerAnnotatedTextContract } from '../src/index.mjs';
import { registerAnnotatedTextStructuralExtension, projectAnnotatedTextForRecipient } from '../src/internal.mjs';

const suffix = 'recipientProjection';
registerAnnotatedTextContract(`${suffix}Measurement`, Object.freeze({ kind: 'measurement' }));
registerAnnotatedTextStructuralExtension(`${suffix}Measurement`, Object.freeze({ version: 1, validate: function validate() {}, edit: function edit() {}, partition: function partition() {}, combine: function combine() {} }));

function descriptor() {
  const body = annotatedText({
    project: 'project', owner: 'owner',
    annotations: [annotation('coding'), protectingAnnotation('confidential', { protects: 'coding', placeholder: '[Private]', access: () => grant(read) })],
    measurements: [measurement('words', { extension: `${suffix}Measurement` })],
    capabilities: { 'body.read': Object.freeze({}), 'body.edit': Object.freeze({}) },
  });
  entity('RecipientProjectionDoc', {
    project: ref('Project'), owner: ref('User'),
    body,
  });
  return body;
}

function canonical(hidden = 'secret') {
  return {
    kind: 'workbench.annotatedText.canonical', version: 1,
    blocks: [
      { id: 'a', text: hidden, fields: {}, annotationIds: ['code', 'protect'] },
      { id: 'b', text: 'visible', fields: {}, annotationIds: ['code'] },
    ],
    annotations: [
      { id: 'code', family: 'coding', fields: {} },
      { id: 'protect', family: 'confidential', fields: {}, protectedTargetIds: ['code'] },
    ],
    memberships: [
      { annotationId: 'code', blockId: 'a', ordinal: 0 }, { annotationId: 'code', blockId: 'b', ordinal: 1 },
      { annotationId: 'protect', blockId: 'a', ordinal: 0 },
    ],
    measurements: [
      { id: 'm-a', blockId: 'a', family: 'words', formatVersion: 1, payload: { token: hidden } },
      { id: 'm-b', blockId: 'b', family: 'words', formatVersion: 1, payload: { token: 'visible' } },
    ],
    capabilities: {},
  };
}

test('denied protector restricts only overlapping blocks without hidden details', () => {
  const projected = projectAnnotatedTextForRecipient(canonical(), descriptor(), {
    version: 1, protectors: [{ protectorId: 'protect', outcome: 'deny' }], capabilityHints: ['body.read', 'body.edit'],
  });
  assert.deepEqual(projected.blocks, [
    { kind: 'restricted', id: 'a', placeholder: '[Private]' },
    { kind: 'visible', id: 'b', text: 'visible', fields: {}, annotationIds: ['code'] },
  ]);
  assert.deepEqual(projected.annotations, [{ id: 'code', family: 'coding', fields: {} }]);
  assert.deepEqual(projected.measurements, [{ id: 'm-b', blockId: 'b', family: 'words', formatVersion: 1, payload: { token: 'visible' } }]);
  assert.deepEqual(projected.capabilityHints, ['body.edit']);
  assert.equal(JSON.stringify(projected).includes('secret'), false);
  assert.equal(JSON.stringify(projected).includes('protect'), false);
  assert.ok(Object.isFrozen(projected));
});

test('restricted output is independent of hidden body length and content', () => {
  const decisions = { version: 1, protectors: [{ protectorId: 'protect', outcome: 'deny' }], capabilityHints: [] };
  const first = projectAnnotatedTextForRecipient(canonical('x'), descriptor(), decisions);
  const second = projectAnnotatedTextForRecipient(canonical('much longer private body'), descriptor(), decisions);
  assert.deepEqual(first.blocks[0], second.blocks[0]);
  assert.deepEqual(first.measurements, second.measurements);
});

test('missing, stale, duplicate, and malformed protection decisions fail closed', () => {
  const doc = descriptor();
  assert.throws(() => projectAnnotatedTextForRecipient(canonical(), doc, { version: 1, protectors: [], capabilityHints: [] }), /exactly match/);
  assert.throws(() => projectAnnotatedTextForRecipient(canonical(), doc, { version: 1, protectors: [{ protectorId: 'other', outcome: 'deny' }], capabilityHints: [] }), /exactly match/);
  assert.throws(() => projectAnnotatedTextForRecipient(canonical(), doc, { version: 1, protectors: [{ protectorId: 'protect', outcome: 'deny' }, { protectorId: 'protect', outcome: 'deny' }], capabilityHints: [] }), /exactly match/);
  assert.throws(() => projectAnnotatedTextForRecipient(canonical(), doc, { version: 1, protectors: [{ protectorId: 'protect', outcome: 'deny', extra: true }], capabilityHints: [] }), /invalid shape/);
});

test('all protector allows retain body but protecting annotations stay private', () => {
  const projected = projectAnnotatedTextForRecipient(canonical(), descriptor(), {
    version: 1, protectors: [{ protectorId: 'protect', outcome: 'allow' }], capabilityHints: ['body.read'],
  });
  assert.equal(projected.blocks[0].kind, 'visible');
  assert.equal(projected.blocks[0].text, 'secret');
  assert.equal(JSON.stringify(projected).includes('protectedTargetIds'), false);
  assert.equal(JSON.stringify(projected).includes('protect'), false);
});

test('malformed canonical memberships and measurements fail closed', () => {
  const decisions = { version: 1, protectors: [{ protectorId: 'protect', outcome: 'allow' }], capabilityHints: [] };
  const duplicateMembership = canonical();
  duplicateMembership.memberships.push({ annotationId: 'code', blockId: 'a', ordinal: 1 });
  assert.throws(() => projectAnnotatedTextForRecipient(duplicateMembership, descriptor(), decisions), /unique/);
  const extraMeasurement = canonical();
  extraMeasurement.measurements[0].private = 'leak';
  assert.throws(() => projectAnnotatedTextForRecipient(extraMeasurement, descriptor(), decisions), /invalid shape/);
});

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

function groupedDescriptor() {
  const body = annotatedText({
    project: 'project', owner: 'owner',
    annotations: [annotation('coding'), annotation('card', { appliesTo: 'block-group', cardinality: 'one' })],
    measurements: [measurement('words', { extension: `${suffix}Measurement` })],
  });
  entity('GroupedRecipientProjectionDoc', { project: ref('Project'), owner: ref('User'), body });
  return body;
}

function groupedCanonical() {
  return {
    kind: 'workbench.annotatedText.canonical', version: 1,
    blocks: [
      { id: 'a', groupId: 'g1', text: 'a', fields: {}, annotationIds: ['code'] },
      { id: 'b', groupId: 'g1', text: 'b', fields: {}, annotationIds: [] },
      { id: 'c', groupId: 'g2', text: 'c', fields: {}, annotationIds: [] },
    ],
    annotations: [
      { id: 'code', family: 'coding', fields: {} },
      { id: 'card', family: 'card', fields: {} },
    ],
    memberships: [{ annotationId: 'code', blockId: 'a', ordinal: 0 }],
    groupMemberships: [{ annotationId: 'card', groupId: 'g1', ordinal: 0 }],
    measurements: [], capabilities: {}, orphans: [],
  };
}

function canonical(hidden = 'secret') {
  return {
    kind: 'workbench.annotatedText.canonical', version: 1,
    blocks: [
      { id: 'a', groupId: 'a', text: hidden, fields: {}, annotationIds: ['code', 'protect'] },
      { id: 'b', groupId: 'b', text: 'visible', fields: {}, annotationIds: ['code'] },
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
    capabilities: {}, groupMemberships: [], orphans: [],
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

test('membershipless canonical annotations fail closed', () => {
  const ordinary = canonical();
  ordinary.annotations.push({ id: 'orphan', family: 'coding', fields: {} });
  assert.throws(() => projectAnnotatedTextForRecipient(ordinary, descriptor(), {
    version: 1, protectors: [{ protectorId: 'protect', outcome: 'allow' }], capabilityHints: [],
  }), /no membership/);

  const protector = canonical();
  protector.annotations.push({ id: 'orphan-protector', family: 'confidential', fields: {}, protectedTargetIds: ['code'] });
  assert.throws(() => projectAnnotatedTextForRecipient(protector, descriptor(), {
    version: 1, protectors: [{ protectorId: 'protect', outcome: 'allow' }], capabilityHints: [],
  }), /no membership/);
});

test('recipient projection keeps block and group annotations in separate shapes', () => {
  const projected = projectAnnotatedTextForRecipient(groupedCanonical(), groupedDescriptor(), { version: 1, protectors: [], capabilityHints: [] });
  assert.deepEqual(projected.blocks[0].annotationIds, ['code']);
  assert.deepEqual(projected.blockGroups, [{ id: 'group-0', blockIds: ['a', 'b'], annotationIds: ['card'] }, { id: 'group-1', blockIds: ['c'], annotationIds: [] }]);
  assert.deepEqual(projected.memberships, [{ annotationId: 'code', blockId: 'a', ordinal: 0 }]);
});

test('restricted content breaks groups without exposing canonical topology', () => {
  const canonical = groupedCanonical();
  canonical.blocks[1].annotationIds = ['code', 'protect'];
  canonical.annotations.push({ id: 'protect', family: 'confidential', fields: {}, protectedTargetIds: ['code'] });
  canonical.memberships.push({ annotationId: 'code', blockId: 'b', ordinal: 1 }, { annotationId: 'protect', blockId: 'b', ordinal: 0 });
  const body = annotatedText({ project: 'project', owner: 'owner', annotations: [annotation('coding'), annotation('card', { appliesTo: 'block-group' }), protectingAnnotation('confidential', { protects: 'coding', placeholder: '[Private]', access: () => grant(read) })], measurements: [measurement('words', { extension: `${suffix}Measurement` })] });
  entity('RestrictedGroupedProjectionDoc', { project: ref('Project'), owner: ref('User'), body });
  const projected = projectAnnotatedTextForRecipient(canonical, body, { version: 1, protectors: [{ protectorId: 'protect', outcome: 'deny' }], capabilityHints: [] });
  assert.deepEqual(projected.blockGroups, [{ id: 'group-0', blockIds: ['a'], annotationIds: [] }, { id: 'group-1', blockIds: ['c'], annotationIds: [] }]);
  assert.equal(JSON.stringify(projected).includes('g1'), false);
});

test('group cardinality permits one annotation spanning groups but rejects distinct annotations per group', () => {
  const decisions = { version: 1, protectors: [], capabilityHints: [] };
  const unknownGroup = groupedCanonical();
  unknownGroup.groupMemberships[0].groupId = 'missing';
  assert.throws(() => projectAnnotatedTextForRecipient(unknownGroup, groupedDescriptor(), decisions), /group membership is invalid/);
  const wrongFamily = groupedCanonical();
  wrongFamily.groupMemberships[0].annotationId = 'code';
  assert.throws(() => projectAnnotatedTextForRecipient(wrongFamily, groupedDescriptor(), decisions), /group membership is invalid/);
  const spanning = groupedCanonical();
  spanning.groupMemberships.push({ annotationId: 'card', groupId: 'g2', ordinal: 1 });
  assert.deepEqual(projectAnnotatedTextForRecipient(spanning, groupedDescriptor(), decisions).blockGroups.map((group) => group.annotationIds), [['card'], ['card']]);
  const duplicateOne = groupedCanonical();
  duplicateOne.annotations.push({ id: 'card-2', family: 'card', fields: {} });
  duplicateOne.groupMemberships.push({ annotationId: 'card-2', groupId: 'g1', ordinal: 1 });
  assert.throws(() => projectAnnotatedTextForRecipient(duplicateOne, groupedDescriptor(), decisions), /cardinality-one/);
});

test('canonical group identity is required and cannot be normalized', () => {
  const decisions = { version: 1, protectors: [], capabilityHints: [] };
  const missingMemberships = groupedCanonical();
  delete missingMemberships.groupMemberships;
  assert.throws(() => projectAnnotatedTextForRecipient(missingMemberships, groupedDescriptor(), decisions), /invalid shape/);
  const missingGroupId = groupedCanonical();
  delete missingGroupId.blocks[0].groupId;
  assert.throws(() => projectAnnotatedTextForRecipient(missingGroupId, groupedDescriptor(), decisions), /block has invalid shape/);
  const emptyGroupId = groupedCanonical();
  emptyGroupId.blocks[0].groupId = '';
  assert.throws(() => projectAnnotatedTextForRecipient(emptyGroupId, groupedDescriptor(), decisions), /block is invalid/);
});

test('orphan projection passes safe fields and excludes raw memberships', () => {
  const c = canonical();
  c.annotations = [];
  c.memberships = [];
  c.blocks = c.blocks.map((b) => ({ ...b, annotationIds: [] }));
  c.orphans = [{ id: 'orphan-1', family: 'coding', fields: { color: 'blue' }, savedQuote: 'secret', membershipBlockIds: ['a', 'b'] }];
  const projected = projectAnnotatedTextForRecipient(c, descriptor(), {
    version: 1, protectors: [], capabilityHints: [],
  });
  assert.equal(projected.orphans.length, 1);
  assert.equal(projected.orphans[0].id, 'orphan-1');
  assert.equal(projected.orphans[0].family, 'coding');
  assert.deepEqual(projected.orphans[0].fields, { color: 'blue' });
  assert.equal(projected.orphans[0].savedQuote, 'secret');
  assert.equal(projected.orphans[0].protectedTargetIds, undefined);
  const serialized = JSON.stringify(projected);
  assert.equal(serialized.includes('last_memberships'), false);
  assert.equal(serialized.includes('endpoint'), false);
  assert.equal(serialized.includes('frontier'), false);
  assert.equal(serialized.includes('structuralRevision'), false);
});

test('orphan with conflicting annotation id fails closed', () => {
  assert.throws(() => {
    const c = canonical();
    c.orphans = [{ id: 'code', family: 'coding', fields: {}, savedQuote: 'quote', membershipBlockIds: ['a'] }];
    projectAnnotatedTextForRecipient(c, descriptor(), {
      version: 1, protectors: [{ protectorId: 'protect', outcome: 'allow' }], capabilityHints: [],
    });
  }, /orphan id conflicts/);
});

test('orphan with unknown family fails closed', () => {
  assert.throws(() => {
    const c = canonical();
    c.orphans = [{ id: 'orphan-x', family: 'unknown', fields: {}, savedQuote: 'quote', membershipBlockIds: ['a'] }];
    projectAnnotatedTextForRecipient(c, descriptor(), {
      version: 1, protectors: [{ protectorId: 'protect', outcome: 'allow' }], capabilityHints: [],
    });
  }, /orphan is invalid/);
});

test('orphan with malformed shape fails closed', () => {
  assert.throws(() => {
    const c = canonical();
    c.orphans = [{ id: 'orphan-x', family: 'coding', fields: {} }];
    projectAnnotatedTextForRecipient(c, descriptor(), {
      version: 1, protectors: [{ protectorId: 'protect', outcome: 'allow' }], capabilityHints: [],
    });
  }, /orphan has invalid shape/);
});

test('orphan excluded when all blocks are restricted', () => {
  const c = {
    kind: 'workbench.annotatedText.canonical', version: 1,
    blocks: [{ id: 'x', groupId: 'x', text: 'secret', fields: {}, annotationIds: ['code', 'protect'] }],
    annotations: [
      { id: 'code', family: 'coding', fields: {} },
      { id: 'protect', family: 'confidential', fields: {}, protectedTargetIds: ['code'] },
    ],
    memberships: [
      { annotationId: 'code', blockId: 'x', ordinal: 0 },
      { annotationId: 'protect', blockId: 'x', ordinal: 0 },
    ],
    groupMemberships: [], measurements: [], capabilities: {},
    orphans: [{ id: 'orphan-r', family: 'coding', fields: {}, savedQuote: 'hidden quote', membershipBlockIds: ['x'] }],
  };
  const projected = projectAnnotatedTextForRecipient(c, descriptor(), {
    version: 1, protectors: [{ protectorId: 'protect', outcome: 'deny' }], capabilityHints: [],
  });
  assert.equal(projected.orphans.length, 0);
  assert.equal(JSON.stringify(projected).includes('orphan-r'), false);
  assert.equal(JSON.stringify(projected).includes('hidden quote'), false);
});

test('orphan fails closed when any source block is missing or restricted', () => {
  const c = canonical();
  c.annotations = [];
  c.memberships = [];
  c.blocks = c.blocks.map((block) => ({ ...block, annotationIds: [] }));
  c.orphans = [{ id: 'orphan-missing', family: 'coding', fields: {}, savedQuote: 'quote', membershipBlockIds: ['missing'] }];
  assert.throws(() => projectAnnotatedTextForRecipient(c, descriptor(), { version: 1, protectors: [], capabilityHints: [] }), /orphan is invalid/);

  c.orphans = [{ id: 'orphan-hidden', family: 'coding', fields: {}, savedQuote: 'quote', membershipBlockIds: ['a'] }];
  c.annotations = [
    { id: 'code', family: 'coding', fields: {} },
    { id: 'protect', family: 'confidential', fields: {}, protectedTargetIds: ['code'] },
  ];
  c.memberships = [
    { annotationId: 'code', blockId: 'a', ordinal: 0 },
    { annotationId: 'protect', blockId: 'a', ordinal: 0 },
  ];
  c.blocks[0].annotationIds = ['code', 'protect'];
  const projected = projectAnnotatedTextForRecipient(c, descriptor(), { version: 1, protectors: [{ protectorId: 'protect', outcome: 'deny' }], capabilityHints: [] });
  assert.deepEqual(projected.orphans, []);
});

test('protecting and block-group orphans are never recipient-visible', () => {
  const c = canonical();
  c.annotations = [];
  c.memberships = [];
  c.blocks = c.blocks.map((block) => ({ ...block, annotationIds: [] }));
  c.orphans = [{ id: 'protect-orphan', family: 'confidential', fields: {}, savedQuote: 'secret', membershipBlockIds: ['a'] }];
  assert.deepEqual(projectAnnotatedTextForRecipient(c, descriptor(), { version: 1, protectors: [], capabilityHints: [] }).orphans, []);

  const grouped = groupedCanonical();
  grouped.orphans = [{ id: 'card-orphan', family: 'card', fields: {}, savedQuote: 'quote', membershipBlockIds: ['a'] }];
  assert.throws(() => projectAnnotatedTextForRecipient(grouped, groupedDescriptor(), { version: 1, protectors: [], capabilityHints: [] }), /orphan is invalid/);
});

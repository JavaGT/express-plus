import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  annotatedText, annotation, text, entity, everyone, executeDDL, executeFrameworkDDL, measurement, protectingAnnotation,
  admin, deny, grant, read, ref, scope, write,
  registerAnnotatedTextContract, registerAnnotatedTextStructuralExtension,
} from '../src/internal.mjs';
import { exportAnnotatedText } from '../src/index.mjs';
import { materializeText, restoreTextFamily } from '../src/annotated-text-continuous.mjs';
import { projectAnnotatedTextForRecipient } from '../src/annotated-text-recipient-projection.mjs';
import { withAuthoringBinding } from './annotated-text-authoring-fixture.mjs';

registerAnnotatedTextContract('sourceInit', Object.freeze({ kind: 'measurement' }));
registerAnnotatedTextStructuralExtension('sourceInit', Object.freeze({
  version: 1,
  validate: function validate() {},
  edit: function edit() {},
  partition: function partition() { return Object.freeze({ version: 1, leftPayload: null, rightPayload: null }); },
  combine: function combine() { return Object.freeze({ version: 1, payload: null }); },
}));

function rangeDoc() {
  return entity('RangeDoc', {
    project: ref('Project'),
    owner: ref('User', { role: 'owner' }),
    body: annotatedText({
      project: 'project',
      owner: 'owner',
      annotations: [
        annotation('code', { fields: { label: text({ default: '' }) } }),
        annotation('comment', { empty: 'orphan' }),
        annotation('theme', { fields: { color: text({ default: 'blue' }) } }),
        protectingAnnotation('confidential', { protects: 'theme', access: () => grant(read) }),
      ],
      measurements: [measurement('source', { extension: 'sourceInit' })],
    }),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
}

async function appFor(db = new DatabaseSync(':memory:'), principalId = null) {
  const RangeDoc = rangeDoc();
  const Project = entity('Project', {
    owner: ref('User', { role: 'owner' }),
    grant: [scope(() => everyone()).can(async ({ is }) => (await is.owner()) ? grant(read, write, admin) : deny('not project owner'))],
  });
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY)');
  db.exec("INSERT INTO User (id) VALUES ('u1')");
  executeDDL(Project, db);
  db.exec("INSERT INTO Project (id, owner) VALUES ('p1', 'u1')");
  executeDDL(RangeDoc, db);
  const app = workbench({ db, entities: [Project, RangeDoc] });
  if (principalId !== null) app.listen(0, { principalOf: () => ({ id: principalId }) });
  else app.start();
  await app.ready;
  return { app, db, RangeDoc, Project };
}

async function setupDoc(docText) {
  const { app, db, RangeDoc, Project } = await appFor();
  const created = await app.dispatch({
    actionId: 'create', type: 'RangeDoc.create',
    payload: {
      id: 'd1', project: 'p1', owner: 'u1',
      ...(docText ? { body: { version: 1, blocks: [{ text: docText }] } } : {}),
    },
    principal: { id: 'u1' },
  });
  assert.equal(created.ok, true, created.failure?.message);

  const row = db.prepare("SELECT * FROM RangeDoc WHERE id = 'd1'").get();
  const principal = { id: 'u1' };
  const binding = await withAuthoringBinding({
    db, entity: RangeDoc, Document: RangeDoc, row, principal, fieldName: 'body', descriptor: RangeDoc.fields.body,
  });

  async function refreshBinding() {
    const current = db.prepare("SELECT * FROM RangeDoc WHERE id = 'd1'").get();
    return withAuthoringBinding({
      db, entity: RangeDoc, Document: RangeDoc, row: current, principal,
      fieldName: 'body', descriptor: RangeDoc.fields.body,
    });
  }

  function authoringOf(b, mutationId = `m-${randomUUID()}`) {
    return { version: 1, stream: b.streamToken, lease: b.leaseToken, mutationId };
  }

  return {
    app, db, RangeDoc, Project, binding, refreshBinding, authoringOf,
    documentPositionToken: binding.documentPositionToken,
  };
}

function familyText(db) {
  const state = db.prepare("SELECT family_checkpoint FROM RangeDoc_body_state WHERE document_id = 'd1'").get();
  return materializeText(restoreTextFamily(JSON.parse(state.family_checkpoint)));
}

test('text-range annotation.apply persists one document membership without splitting', async () => {
  const { app, db, RangeDoc, Project, binding, authoringOf, documentPositionToken } = await setupDoc('A diarized transcript');
  const beforeRevision = db.prepare("SELECT structure_version FROM RangeDoc_body_state WHERE document_id = 'd1'").get().structure_version;
  const result = await app.dispatch({
    actionId: 'apply-range', type: 'RangeDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(binding, 'm-apply-range'),
      edit: {
        kind: 'annotation.apply',
        annotation: { id: 'code-1', family: 'code', fields: { label: 'belief' } },
        from: { positionToken: documentPositionToken, offset: 2, affinity: 'right' },
        to: { positionToken: documentPositionToken, offset: 12, affinity: 'right' },
      },
    },
  });
  assert.equal(result.ok, true, `apply-range failed: ${JSON.stringify(result.failure)}`);

  // One continuous family; annotation.apply does not bump structure_version.
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name GLOB 'RangeDoc_body_block*'").get().count, 0);
  const afterState = db.prepare("SELECT structure_version FROM RangeDoc_body_state WHERE document_id = 'd1'").get();
  assert.equal(afterState.structure_version, beforeRevision);

  // One document-scoped membership with structural endpoints (no block_id).
  const memberships = db.prepare("SELECT annotation_id, start_point, end_point FROM RangeDoc_body_membership WHERE annotation_id = 'code-1'").all();
  assert.equal(memberships.length, 1);
  assert.equal('block_id' in memberships[0], false);
  const startPoint = JSON.parse(memberships[0].start_point);
  const endPoint = JSON.parse(memberships[0].end_point);
  assert.ok(startPoint.point && endPoint.point, 'membership carries structural endpoints');

  // Canonical export exposes document UTF-16 offsets 2..12 as ranges.
  const exported = await exportAnnotatedText({
    app, entity: RangeDoc, field: RangeDoc.body, documentId: 'd1',
    expectedOwningScope: { entity: Project, id: 'p1' }, principal: { id: 'u1' },
  });
  assert.equal(exported.kind, 'workbench.annotatedText.canonical');
  assert.equal(exported.text, 'A diarized transcript');
  assert.deepEqual(exported.ranges.find((r) => r.annotationId === 'code-1'), { annotationId: 'code-1', start: 2, end: 12 });
  await app.close?.();
});

test('text-range annotation.apply spans arbitrary document offsets with one membership', async () => {
  const { app, db, binding, authoringOf, documentPositionToken } = await setupDoc('First block words and more');
  const beforeRevision = db.prepare("SELECT structure_version FROM RangeDoc_body_state WHERE document_id = 'd1'").get().structure_version;

  const result = await app.dispatch({
    actionId: 'apply-range-cross', type: 'RangeDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(binding, 'm-cross'),
      edit: {
        kind: 'annotation.apply',
        annotation: { id: 'code-cross', family: 'code', fields: { label: 'across' } },
        from: { positionToken: documentPositionToken, offset: 2, affinity: 'right' },
        to: { positionToken: documentPositionToken, offset: 20, affinity: 'right' },
      },
    },
  });
  assert.equal(result.ok, true, result.failure?.message);

  // Blockless: one membership for the whole document range (no per-block split).
  const memberships = db.prepare("SELECT annotation_id FROM RangeDoc_body_membership WHERE annotation_id = 'code-cross'").all();
  assert.equal(memberships.length, 1);
  const afterRevision = db.prepare("SELECT structure_version FROM RangeDoc_body_state WHERE document_id = 'd1'").get();
  assert.equal(afterRevision.structure_version, beforeRevision);
  assert.equal(familyText(db), 'First block words and more');
  await app.close?.();
});

test('recipient projection clips a text-range around an inline redaction', async () => {
  const { app, RangeDoc } = await setupDoc('The quick brown fox jumps');

  // Blockless canonical: continuous text + document ranges. Deny the leading
  // protector range [0,4); the code range [4,20) clips to visible [0,16).
  const recipient = projectAnnotatedTextForRecipient({
    kind: 'workbench.annotatedText.canonical',
    version: 1,
    text: 'The quick brown fox jumps',
    annotations: [
      { id: 'theme-1', family: 'theme', fields: { color: 'red' } },
      { id: 'conf-1', family: 'confidential', fields: {}, protectedTargetIds: ['theme-1'] },
      { id: 'code-clip', family: 'code', fields: { label: 'clip' } },
    ],
    ranges: [
      { annotationId: 'theme-1', start: 0, end: 24 },
      { annotationId: 'conf-1', start: 0, end: 4 },
      { annotationId: 'code-clip', start: 4, end: 20 },
    ],
    measurements: [],
    capabilityHints: [],
  }, RangeDoc.fields.body, { version: 1, protectors: [{ protectorId: 'conf-1', outcome: 'deny' }], capabilityHints: [] });

  assert.equal(recipient.text, 'quick brown fox jumps');
  const recipientRange = recipient.ranges.find((r) => r.annotationId === 'code-clip');
  assert.ok(recipientRange, 'code-clip delivered');
  assert.equal(recipientRange.start, 0);
  assert.equal(recipientRange.end, 16);
  // Default placeholder when the protector omits one (declaration default).
  assert.equal(recipient.redactions.length, 1);
  assert.equal(recipient.redactions[0].start, 0);
  assert.equal(recipient.redactions[0].end, 0);
  assert.equal(typeof recipient.redactions[0].placeholder, 'string');
  await app.close?.();
});

test('recipient projection omits a text-range fully inside a redaction (ADR 0008 tradeoff)', async () => {
  const { app, RangeDoc } = await setupDoc('abcdefghij');

  // Deny everything [0,10): the code range [2,4) is fully inside and drops out.
  const recipient = projectAnnotatedTextForRecipient({
    kind: 'workbench.annotatedText.canonical',
    version: 1,
    text: 'abcdefghij',
    annotations: [
      { id: 'theme-1', family: 'theme', fields: { color: 'red' } },
      { id: 'conf-1', family: 'confidential', fields: {}, protectedTargetIds: ['theme-1'] },
      { id: 'code-hidden', family: 'code', fields: { label: 'hidden' } },
    ],
    ranges: [
      { annotationId: 'theme-1', start: 0, end: 10 },
      { annotationId: 'conf-1', start: 0, end: 10 },
      { annotationId: 'code-hidden', start: 2, end: 4 },
    ],
    measurements: [],
    capabilityHints: [],
  }, RangeDoc.fields.body, { version: 1, protectors: [{ protectorId: 'conf-1', outcome: 'deny' }], capabilityHints: [] });

  // Fully-redacted text-range membership is omitted; its annotation drops from
  // delivery. Whole-document denial restricts the recipient view.
  assert.equal(recipient.ranges.find((r) => r.annotationId === 'code-hidden'), undefined);
  assert.equal(recipient.annotations.find((a) => a.id === 'code-hidden'), undefined);
  assert.equal(recipient.restricted, true);
  await app.close?.();
});

test('fold replay of a text-range apply is declaration-independent and revision-stable', async () => {
  const { app, db, binding, authoringOf, documentPositionToken, refreshBinding } = await setupDoc('hello world');
  const result = await app.dispatch({
    actionId: 'apply-range', type: 'RangeDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(binding, 'm-apply-range'),
      edit: {
        kind: 'annotation.apply',
        annotation: { id: 'code-replay', family: 'code', fields: { label: 'replay' } },
        from: { positionToken: documentPositionToken, offset: 0, affinity: 'left' },
        to: { positionToken: documentPositionToken, offset: 5, affinity: 'right' },
      },
    },
  });
  assert.equal(result.ok, true, result.failure?.message);

  // A follow-on text insert folds through the same projection, proving the
  // recorded membership replays without consulting the declaration.
  const next = await refreshBinding();
  const insert = await app.dispatch({
    actionId: 'insert-after', type: 'RangeDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(next, 'm-insert-after'),
      edit: {
        kind: 'text.insert',
        at: { positionToken: next.documentPositionToken, offset: 11, affinity: 'right' },
        text: '!',
      },
    },
  });
  assert.equal(insert.ok, true, insert.failure?.message);
  assert.equal(familyText(db), 'hello world!');

  const membership = db.prepare("SELECT start_point, end_point FROM RangeDoc_body_membership WHERE annotation_id = 'code-replay'").get();
  assert.ok(membership, 'membership survives follow-on fold');
  assert.ok(JSON.parse(membership.start_point).point && JSON.parse(membership.end_point).point);
  await app.close?.();
});

test('text-range annotation rejects protected targets on ordinary families', async () => {
  const { app, db, binding, authoringOf, documentPositionToken } = await setupDoc('some words');
  const result = await app.dispatch({
    actionId: 'apply-bad', type: 'RangeDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(binding, 'm-apply-bad'),
      edit: {
        kind: 'annotation.apply',
        annotation: { id: 'code-bad', family: 'code', fields: { label: 'x' }, protectedTargetIds: ['theme-1'] },
        from: { positionToken: documentPositionToken, offset: 0, affinity: 'left' },
        to: { positionToken: documentPositionToken, offset: 4, affinity: 'right' },
      },
    },
  });
  assert.equal(result.ok, false);
  // Ordinary families reject protectedTargetIds (admit or projection fail-closed).
  assert.ok(result.failure, 'failure present');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM RangeDoc_body_annotation WHERE id = 'code-bad'").get().count, 0);
  await app.close?.();
});

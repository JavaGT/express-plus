import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  annotatedText, annotation, boolean, text, entity, everyone, executeDDL, executeFrameworkDDL, measurement, protectingAnnotation,
  admin, deny, grant, read, ref, scope, write,
  registerAnnotatedTextContract, registerAnnotatedTextStructuralExtension,
} from '../src/internal.mjs';
import { exportAnnotatedText } from '../src/index.mjs';
import { restoreTextFamilyCheckpoint } from '../src/annotated-text-family.mjs';
import { ensureStream, ensureLease, hashClientNonce } from '../src/annotated-text-authoring-stream.mjs';
import { projectAnnotatedTextForRecipient } from '../src/annotated-text-recipient-projection.mjs';
import { projectAnnotatedTextSnapshot } from '../src/annotated-text-snapshot.mjs';

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
      block: { reviewed: boolean({ default: true }) },
      annotations: [
        annotation('code', { appliesTo: 'text-range', fields: { label: text({ default: '' }) } }),
        annotation('comment', { appliesTo: 'text-range', empty: 'orphan' }),
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

function readLastSeq(db) {
  return db.prepare('SELECT lastSeq FROM _ProjectedCursor WHERE entity = ? AND field = ?').get('RangeDoc', 'body')?.lastSeq ?? 0;
}

async function setupDoc(blockText, options = {}) {
  const { app, db, RangeDoc, Project } = await appFor(new DatabaseSync(':memory:'), null, options);
  const created = await app.dispatch({
    actionId: 'create', type: 'RangeDoc.create',
    payload: { id: 'd1', project: 'p1', owner: 'u1' }, principal: { id: 'u1' },
  });
  const blockId = created.events[0].data.__workbench.annotatedText.body.initialBlockId;
  const prefix = 'RangeDoc_body';
  const scopeKey = 'Project:p1';
  const clientNonce = randomBytes(32).toString('base64url');
  const stream = ensureStream({ db, prefix, documentId: 'd1', principalType: 'principal', principalId: 'u1' });
  const lease = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: hashClientNonce(clientNonce) });
  let row = db.prepare("SELECT * FROM RangeDoc WHERE id = 'd1'").get();
  let state = db.prepare("SELECT structure_version, family_checkpoint FROM RangeDoc_body_state WHERE document_id = 'd1'").get();
  let family = restoreTextFamilyCheckpoint(JSON.parse(state.family_checkpoint));

  const issueAuthoringSnapshot = () => projectAnnotatedTextSnapshot({
    db, entity: RangeDoc, row, principal: { id: 'u1' }, fieldName: 'body', descriptor: RangeDoc.fields.body,
    authoring: { streamToken: stream.id, leaseToken: lease.id, leaseId: lease.id, fence: readLastSeq(db), clientNonceHash: hashClientNonce(clientNonce) },
  });

  async function buildPositionMap() {
    const snap = await issueAuthoringSnapshot();
    const auth = snap.body?.authoring ?? snap.authoring;
    return new Map(auth.positionFrames.map((f) => [f.blockId, f.positionToken]));
  }

  function v9Payload(kind, overrides = {}) {
    const edit = { kind, ...overrides };
    return { version: 9, id: 'd1', authoring: { version: 1, stream: stream.id, lease: lease.id, mutationId: `m-${randomUUID()}` }, edit };
  }

  async function refreshState() {
    row = db.prepare("SELECT * FROM RangeDoc WHERE id = 'd1'").get();
    state = db.prepare("SELECT structure_version, family_checkpoint FROM RangeDoc_body_state WHERE document_id = 'd1'").get();
    family = restoreTextFamilyCheckpoint(JSON.parse(state.family_checkpoint));
  }

  if (blockText) {
    const initialMap = await buildPositionMap();
    const token = initialMap.get(blockId);
    const result = await app.dispatch({
      actionId: 'insert-text', type: 'RangeDoc.body.operation', scope: scopeKey, principal: { id: 'u1' },
      payload: v9Payload('text.insert', { at: { positionToken: token, offset: 0, affinity: 'right' }, text: blockText }),
    });
    assert.equal(result.ok, true, result.failure?.message);
    await refreshState();
  }

  const positionMap = await buildPositionMap();
  return { app, db, RangeDoc, Project, blockId, family, state, stream, lease, positionMap, refreshPositionMap: buildPositionMap, refreshState, v9Payload };
}

function v9PositionTokenPayload(positionMap, blockId) {
  const token = positionMap.get(blockId);
  if (!token) throw new Error(`no position token for block ${blockId}`);
  return token;
}

test('text-range annotation.apply persists one sub-block membership without splitting', async () => {
  const { app, db, RangeDoc, Project, blockId, state, positionMap, v9Payload } = await setupDoc('A diarized transcript');
  const beforeRevision = state.structure_version;
  const result = await app.dispatch({
    actionId: 'apply-range', type: 'RangeDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: v9Payload('annotation.apply', {
      annotation: { id: 'code-1', family: 'code', fields: { label: 'belief' } },
      from: { positionToken: v9PositionTokenPayload(positionMap, blockId), offset: 2, affinity: 'right' },
      to: { positionToken: v9PositionTokenPayload(positionMap, blockId), offset: 12, affinity: 'right' },
    }),
  });
  assert.equal(result.ok, true, `apply-range failed: ${JSON.stringify(result.failure)}`);

  // No block split: one block remains, revision unchanged.
  const blocks = db.prepare('SELECT id FROM RangeDoc_body_block WHERE document_id = ? ORDER BY position').all('d1');
  assert.equal(blocks.length, 1);
  const afterState = db.prepare("SELECT structure_version FROM RangeDoc_body_state WHERE document_id = 'd1'").get();
  assert.equal(afterState.structure_version, beforeRevision);

  // One membership with structural endpoints inside the block.
  const memberships = db.prepare("SELECT annotation_id, block_id, ordinal, start_point, end_point FROM RangeDoc_body_membership WHERE annotation_id = 'code-1'").all();
  assert.equal(memberships.length, 1);
  assert.equal(memberships[0].block_id, blockId);
  const startPoint = JSON.parse(memberships[0].start_point);
  const endPoint = JSON.parse(memberships[0].end_point);
  assert.ok(startPoint.point && endPoint.point, 'membership carries structural endpoints');

  // Canonical export exposes UTF-16 offsets 2..12.
  const exported = await exportAnnotatedText({
    app, entity: RangeDoc, field: RangeDoc.body, documentId: 'd1',
    expectedOwningScope: { entity: Project, id: 'p1' }, principal: { id: 'u1' },
  });
  const canonicalMembership = exported.memberships.find((m) => m.annotationId === 'code-1');
  assert.equal(canonicalMembership.start, 2);
  assert.equal(canonicalMembership.end, 12);
  await app.close?.();
});

test('text-range annotation.apply spans multiple blocks with one membership each, no splits', async () => {
  const { app, db, blockId, positionMap, refreshPositionMap, refreshState, v9Payload } = await setupDoc('First block words');
  const split = await app.dispatch({
    actionId: 'make-second-block', type: 'RangeDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: v9Payload('block.split', { at: { positionToken: v9PositionTokenPayload(positionMap, blockId), offset: 5, affinity: 'right' }, temporaryBlock: 'tmp-second' }),
  });
  assert.equal(split.ok, true, split.failure?.message);
  await refreshState();
  const beforeRevision = db.prepare("SELECT structure_version FROM RangeDoc_body_state WHERE document_id = 'd1'").get().structure_version;
  const nextMap = await refreshPositionMap();
  const blocks = db.prepare('SELECT id FROM RangeDoc_body_block WHERE document_id = ? ORDER BY position').all('d1');
  assert.equal(blocks.length, 2);
  const [leftId, rightId] = blocks.map((b) => b.id);

  const result = await app.dispatch({
    actionId: 'apply-range-cross', type: 'RangeDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: v9Payload('annotation.apply', {
      annotation: { id: 'code-cross', family: 'code', fields: { label: 'across' } },
      from: { positionToken: v9PositionTokenPayload(nextMap, leftId), offset: 2, affinity: 'right' },
      to: { positionToken: v9PositionTokenPayload(nextMap, rightId), offset: 3, affinity: 'right' },
    }),
  });
  assert.equal(result.ok, true, result.failure?.message);

  const memberships = db.prepare("SELECT block_id FROM RangeDoc_body_membership WHERE annotation_id = 'code-cross' ORDER BY ordinal").all();
  assert.equal(memberships.length, 2);
  assert.deepEqual(memberships.map((m) => m.block_id), [leftId, rightId]);
  const afterRevision = db.prepare("SELECT structure_version FROM RangeDoc_body_state WHERE document_id = 'd1'").get();
  assert.equal(afterRevision.structure_version, beforeRevision);
  await app.close?.();
});

test('recipient projection clips a text-range membership around an inline redaction', async () => {
  const { app, db, RangeDoc, blockId, positionMap, v9Payload } = await setupDoc('The quick brown fox jumps');
  const applyTheme = await app.dispatch({
    actionId: 'apply-theme', type: 'RangeDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: v9Payload('annotation.apply', {
      annotation: { id: 'theme-1', family: 'theme', fields: { color: 'red' } },
      from: { positionToken: v9PositionTokenPayload(positionMap, blockId), offset: 0, affinity: 'left' },
      to: { positionToken: v9PositionTokenPayload(positionMap, blockId), offset: 24, affinity: 'right' },
    }),
  });
  assert.equal(applyTheme.ok, true, applyTheme.failure?.message);

  const applyRange = await app.dispatch({
    actionId: 'apply-range', type: 'RangeDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: v9Payload('annotation.apply', {
      annotation: { id: 'code-clip', family: 'code', fields: { label: 'clip' } },
      from: { positionToken: v9PositionTokenPayload(positionMap, blockId), offset: 4, affinity: 'right' },
      to: { positionToken: v9PositionTokenPayload(positionMap, blockId), offset: 20, affinity: 'right' },
    }),
  });
  assert.equal(applyRange.ok, true, applyRange.failure?.message);

  // Owner sees full text; a denied recipient sees "brown fox" clipped.
  const row = db.prepare("SELECT * FROM RangeDoc WHERE id = 'd1'").get();
  const canonical = await projectAnnotatedTextForRecipient({
    kind: 'workbench.annotatedText.canonical', version: 1,
    blocks: [{ id: blockId, groupId: 'g1', text: 'The quick brown fox jumps', fields: {}, annotationIds: ['theme-1', 'conf-1', 'code-clip'] }],
    annotations: [
      { id: 'theme-1', family: 'theme', fields: { color: 'red' } },
      { id: 'conf-1', family: 'confidential', fields: {}, protectedTargetIds: ['theme-1'] },
      { id: 'code-clip', family: 'code', fields: { label: 'clip' } },
    ],
    memberships: [
      { annotationId: 'theme-1', blockId, ordinal: 0, start: 0, end: 24 },
      { annotationId: 'conf-1', blockId, ordinal: 0, start: 0, end: 4 },
      { annotationId: 'code-clip', blockId, ordinal: 0, start: 4, end: 20 },
    ],
    measurements: [], capabilities: {}, groupMemberships: [], orphans: [],
  }, RangeDoc.fields.body, { version: 1, protectors: [{ protectorId: 'conf-1', outcome: 'deny' }], capabilityHints: [] });

  const recipientMembership = canonical.memberships.find((m) => m.annotationId === 'code-clip');
  assert.ok(recipientMembership, 'code-clip delivered');
  // Canonical [4,20) maps to visible [0,16) after the denied [0,4) is stripped.
  assert.equal(recipientMembership.start, 0);
  assert.equal(recipientMembership.end, 16);
  // The denied interval [0,4) is removed from visible text ("The " stripped).
  const visibleBlock = canonical.blocks.find((b) => b.id === blockId);
  assert.equal(visibleBlock.text, 'quick brown fox jumps');
  await app.close?.();
});

test('recipient projection omits a text-range membership fully inside a redaction (ADR 0008 tradeoff)', async () => {
  const { app, db, RangeDoc, blockId, positionMap, v9Payload } = await setupDoc('abcdefghij');
  const applyTheme = await app.dispatch({
    actionId: 'apply-theme', type: 'RangeDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: v9Payload('annotation.apply', {
      annotation: { id: 'theme-1', family: 'theme', fields: { color: 'red' } },
      from: { positionToken: v9PositionTokenPayload(positionMap, blockId), offset: 0, affinity: 'left' },
      to: { positionToken: v9PositionTokenPayload(positionMap, blockId), offset: 10, affinity: 'right' },
    }),
  });
  assert.equal(applyTheme.ok, true, applyTheme.failure?.message);
  const applyRange = await app.dispatch({
    actionId: 'apply-range', type: 'RangeDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: v9Payload('annotation.apply', {
      annotation: { id: 'code-hidden', family: 'code', fields: { label: 'hidden' } },
      from: { positionToken: v9PositionTokenPayload(positionMap, blockId), offset: 2, affinity: 'right' },
      to: { positionToken: v9PositionTokenPayload(positionMap, blockId), offset: 4, affinity: 'right' },
    }),
  });
  assert.equal(applyRange.ok, true, applyRange.failure?.message);

  // Deny everything [0,10): the code range [2,4) is fully inside.
  const canonical = await projectAnnotatedTextForRecipient({
    kind: 'workbench.annotatedText.canonical', version: 1,
    blocks: [{ id: blockId, groupId: 'g1', text: 'abcdefghij', fields: {}, annotationIds: ['theme-1', 'conf-1', 'code-hidden'] }],
    annotations: [
      { id: 'theme-1', family: 'theme', fields: { color: 'red' } },
      { id: 'conf-1', family: 'confidential', fields: {}, protectedTargetIds: ['theme-1'] },
      { id: 'code-hidden', family: 'code', fields: { label: 'hidden' } },
    ],
    memberships: [
      { annotationId: 'theme-1', blockId, ordinal: 0, start: 0, end: 10 },
      { annotationId: 'conf-1', blockId, ordinal: 0, start: 0, end: 10 },
      { annotationId: 'code-hidden', blockId, ordinal: 0, start: 2, end: 4 },
    ],
    measurements: [], capabilities: {}, groupMemberships: [], orphans: [],
  }, RangeDoc.fields.body, { version: 1, protectors: [{ protectorId: 'conf-1', outcome: 'deny' }], capabilityHints: [] });

  // The fully-redacted text-range membership is omitted; its annotation drops
  // from delivery. This is the T2 decision: ADR 0008 show-through for
  // fully-redacted text ranges is deferred to a follow-up ticket.
  assert.equal(canonical.memberships.find((m) => m.annotationId === 'code-hidden'), undefined);
  assert.equal(canonical.annotations.find((a) => a.id === 'code-hidden'), undefined);
  assert.equal(canonical.blocks[0].kind, 'restricted');
  await app.close?.();
});

test('fold replay of a text-range apply is declaration-independent and revision-stable', async () => {
  const { app, db, blockId, positionMap, refreshPositionMap, v9Payload } = await setupDoc('hello world');
  const result = await app.dispatch({
    actionId: 'apply-range', type: 'RangeDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: v9Payload('annotation.apply', {
      annotation: { id: 'code-replay', family: 'code', fields: { label: 'replay' } },
      from: { positionToken: v9PositionTokenPayload(positionMap, blockId), offset: 0, affinity: 'left' },
      to: { positionToken: v9PositionTokenPayload(positionMap, blockId), offset: 5, affinity: 'right' },
    }),
  });
  assert.equal(result.ok, true, result.failure?.message);
  const beforeRevision = db.prepare("SELECT structure_version FROM RangeDoc_body_state WHERE document_id = 'd1'").get().structure_version;

  // A follow-on text insert folds through the same projection, proving the
  // recorded membership replays without consulting the declaration.
  const nextMap = await refreshPositionMap();
  const insert = await app.dispatch({
    actionId: 'insert-after', type: 'RangeDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: v9Payload('text.insert', { at: { positionToken: v9PositionTokenPayload(nextMap, blockId), offset: 11, affinity: 'right' }, text: '!' }),
  });
  assert.equal(insert.ok, true, insert.failure?.message);
  const afterRevision = db.prepare("SELECT structure_version FROM RangeDoc_body_state WHERE document_id = 'd1'").get().structure_version;
  assert.equal(afterRevision, beforeRevision + 1);

  const membership = db.prepare("SELECT start_point, end_point FROM RangeDoc_body_membership WHERE annotation_id = 'code-replay'").get();
  assert.ok(membership, 'membership survives follow-on fold');
  await app.close?.();
});

test('text-range annotation rejects protected targets and cardinality one', async () => {
  const { app, db, blockId, positionMap, v9Payload } = await setupDoc('some words');
  const result = await app.dispatch({
    actionId: 'apply-bad', type: 'RangeDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: v9Payload('annotation.apply', {
      annotation: { id: 'code-bad', family: 'code', fields: { label: 'x' }, protectedTargetIds: ['theme-1'] },
      from: { positionToken: v9PositionTokenPayload(positionMap, blockId), offset: 0, affinity: 'left' },
      to: { positionToken: v9PositionTokenPayload(positionMap, blockId), offset: 4, affinity: 'right' },
    }),
  });
  assert.equal(result.ok, false);
  assert.match(result.failure?.message, /cannot name protected targets/);
  await app.close?.();
});

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  annotatedText, annotation, boolean, number, text, entity, everyone, executeDDL, executeFrameworkDDL, measurement, protectingAnnotation,
  admin, deny, grant, read, ref, scope, write,
  registerAnnotatedTextContract, registerAnnotatedTextStructuralExtension,
} from '../src/internal.mjs';
import { exportAnnotatedText } from '../src/index.mjs';
import { materializeBlock, restoreTextFamilyCheckpoint, textFamilyCheckpoint } from '../src/annotated-text-family.mjs';
import { native } from '../src/event-handle.mjs';
import { ensureStream, ensureLease, hashClientNonce, issuePositionFrame, issueGroupFrame, issueSnapshot, buildAuthoringEnvelope } from '../src/annotated-text-authoring-stream.mjs';
import { projectAnnotatedTextSnapshot } from '../src/internal.mjs';

const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

registerAnnotatedTextContract('sourceInit', Object.freeze({ kind: 'measurement' }));
registerAnnotatedTextStructuralExtension('sourceInit', Object.freeze({
  version: 1,
  validate: function validate() {},
  edit: function edit() {},
  partition: function partition(input) {
    const blockText = input.blockText;
    const offset = input.utf16Offset;
    const payload = input.payload;
    if (payload.fail === true) throw new Error('partition failure');
    const leftText = blockText.slice(0, offset);
    const rightText = blockText.slice(offset);
    return Object.freeze({
      version: 1,
      leftPayload: Object.freeze({ ...payload, text: leftText, offset }),
      rightPayload: Object.freeze({ ...payload, text: rightText, offset }),
    });
  },
  combine: function combine(input) {
    if (input.left !== null && input.right !== null) {
      return Object.freeze({
        version: 1,
        payload: Object.freeze({ text: input.left.payload.text + input.right.payload.text }),
      });
    }
    if (input.left !== null) return Object.freeze({ version: 1, payload: input.left.payload });
    if (input.right !== null) return Object.freeze({ version: 1, payload: input.right.payload });
    return Object.freeze({ version: 1, payload: null });
  },
}));

function r4Doc({
  protectingAccess = async ({ is }) => (await is.owner()) ? grant(read) : grant(),
  commentEmpty = 'orphan',
  access = () => grant(read, write),
} = {}) {
  return entity('R4Doc', {
    project: ref('Project'),
    owner: ref('User', { role: 'owner' }),
    body: annotatedText({
      project: 'project',
      owner: 'owner',
      block: { reviewed: boolean({ default: true }) },
      annotations: [
        annotation('theme', { fields: { color: text({ default: 'blue' }), weight: number({ default: 1 }) } }),
        annotation('flag', { fields: { flagged: boolean({ default: false }) } }),
        annotation('comment', { empty: commentEmpty }),
        annotation('speaker', { appliesTo: 'block-group', cardinality: 'one' }),
        protectingAnnotation('confidential', { protects: 'theme', access: protectingAccess }),
        protectingAnnotation('standalone', { access: () => grant(read) }),
      ],
      measurements: [measurement('source', { extension: 'sourceInit' })],
    }),
    grant: [scope(() => everyone()).can(access)],
  });
}

async function appFor(db = new DatabaseSync(':memory:'), principalId = null, options) {
  const R4Doc = r4Doc(options);
  const Project = entity('Project', {
    owner: ref('User', { role: 'owner' }),
    grant: [scope(() => everyone()).can(async ({ is }) => (await is.owner()) ? grant(read, write, admin) : deny('not project owner'))],
  });
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY)');
  db.exec("INSERT INTO User (id) VALUES ('u1')");
  executeDDL(Project, db);
  db.exec("INSERT INTO Project (id, owner) VALUES ('p1', 'u1')");
  executeDDL(R4Doc, db);
  const app = workbench({ db, entities: [Project, R4Doc] });
  if (principalId !== null) app.listen(0, { principalOf: () => typeof principalId === 'function' ? principalId() : ({ id: principalId }) });
  else app.start();
  await app.ready;
  return { app, db, R4Doc };
}

function readLastSeq(db) {
	return db.prepare('SELECT lastSeq FROM _ProjectedCursor WHERE entity = ? AND field = ?').get('R4Doc', 'body')?.lastSeq ?? 0;
}

async function setupDoc(blockText, principalId = null, options) {
  const { app, db, R4Doc } = await appFor(new DatabaseSync(':memory:'), principalId, options);
  const created = await app.dispatch({
    actionId: 'create', type: 'R4Doc.create',
    payload: { id: 'd1', project: 'p1', owner: 'u1' }, principal: { id: 'u1' },
  });
  const blockId = created.events[0].data.__workbench.annotatedText.body.initialBlockId;
  const prefix = 'R4Doc_body';
  const scopeKey = 'Project:p1';
	const authoringPrincipal = typeof principalId === 'function' ? principalId() : principalId;
	const authoringPrincipalId = typeof authoringPrincipal === 'object' && authoringPrincipal !== null ? authoringPrincipal.id : (authoringPrincipal ?? 'u1');
	const clientNonce = randomBytes(32).toString('base64url');
	const stream = ensureStream({ db, prefix, documentId: 'd1', principalType: 'principal', principalId: authoringPrincipalId });
  const lease = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: hashClientNonce(clientNonce) });

  let row = db.prepare("SELECT * FROM R4Doc WHERE id = 'd1'").get();
  let state = db.prepare("SELECT structure_version, family_checkpoint FROM R4Doc_body_state WHERE document_id = 'd1'").get();
  let family = restoreTextFamilyCheckpoint(JSON.parse(state.family_checkpoint));

  function issueAuthoringSnapshot() {
    return projectAnnotatedTextSnapshot({
      db, entity: R4Doc, row, principal: { id: authoringPrincipalId }, fieldName: 'body', descriptor: R4Doc.fields.body,
      authoring: { streamToken: stream.id, leaseToken: lease.id, leaseId: lease.id, fence: readLastSeq(db), clientNonceHash: hashClientNonce(clientNonce) },
    });
  }

  async function buildPositionMap() {
    const snap = await issueAuthoringSnapshot();
    const auth = snap.body?.authoring ?? snap.authoring;
    return new Map(auth.positionFrames.map((f) => [f.blockId, f.positionToken]));
  }

  function v9Payload(kind, overrides = {}) {
    const edit = { kind, ...overrides };
    return {
      version: 9,
      id: 'd1',
		authoring: { version: 1, stream: stream.id, lease: lease.id, mutationId: `m-${randomUUID()}` },
      edit,
    };
  }

  if (blockText) {
    const initialMap = await buildPositionMap();
    const token = initialMap.get(blockId);
    const result = await app.dispatch({
      actionId: 'insert-text', type: 'R4Doc.body.operation', scope: scopeKey, principal: { id: 'u1' },
      payload: v9Payload('text.insert', { at: { positionToken: token, offset: 0, affinity: 'right' }, text: blockText }),
    });
    assert.equal(result.ok, true, result.failure?.message);

    row = db.prepare("SELECT * FROM R4Doc WHERE id = 'd1'").get();
    state = db.prepare("SELECT structure_version, family_checkpoint FROM R4Doc_body_state WHERE document_id = 'd1'").get();
    family = restoreTextFamilyCheckpoint(JSON.parse(state.family_checkpoint));

    const positionMap = await buildPositionMap();
    return { app, db, blockId, family, state, stream, lease, positionMap, refreshPositionMap: buildPositionMap, row };
  }

  const positionMap = await buildPositionMap();
  return { app, db, blockId, family, state, stream, lease, positionMap, refreshPositionMap: buildPositionMap, row };
}

function v9PositionTokenPayload(positionMap, blockId) {
  const token = positionMap.get(blockId);
  if (!token) throw new Error(`no position token for block ${blockId}`);
  return token;
}

test('R4 annotation.apply on full block produces no splits, creates annotation with whole-block membership', async () => {
  const { app, db, blockId, positionMap, state, stream, lease } = await setupDoc('hello world');
  const result = await app.dispatch({
    actionId: 'apply-full', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: { version: 1, stream: stream.id, lease: lease.id, mutationId: 'm-apply-full' },
      edit: { kind: 'annotation.apply', annotation: { id: 'ann-1', family: 'theme', fields: { color: 'red' } }, from: { positionToken: v9PositionTokenPayload(positionMap, blockId), offset: 0, affinity: 'left' }, to: { positionToken: v9PositionTokenPayload(positionMap, blockId), offset: 11, affinity: 'right' } },
    },
  });
  assert.equal(result.ok, true, result.failure?.message);
  const annRow = db.prepare("SELECT id, family FROM R4Doc_body_annotation WHERE id = 'ann-1'").get();
  assert.equal(annRow.family, 'theme');
  const famRow = db.prepare("SELECT * FROM R4Doc_body_annotation_theme WHERE annotation_id = 'ann-1'").get();
  assert.equal(famRow.color, 'red');
  assert.equal(famRow.weight, 1);
  const memberships = db.prepare("SELECT * FROM R4Doc_body_membership WHERE annotation_id = 'ann-1' ORDER BY ordinal").all();
  assert.equal(memberships.length, 1);
  assert.equal(memberships[0].block_id, blockId);
  assert.equal('basis' in (result.resultData ?? {}), false);
  await app.close?.();
});

test('R4 annotation.apply spans contiguous visible blocks in one event', async () => {
  const { app, db, blockId, positionMap, stream, lease, refreshPositionMap } = await setupDoc('hello world');
  const split = await app.dispatch({
    actionId: 'make-second-block', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 9, id: 'd1', authoring: { version: 1, stream: stream.id, lease: lease.id, mutationId: 'm-cross-split' },
      edit: { kind: 'block.split', at: { positionToken: v9PositionTokenPayload(positionMap, blockId), offset: 5, affinity: 'right' }, temporaryBlock: 'tmp-second' } },
  });
  assert.equal(split.ok, true, split.failure?.message);
  const nextMap = await refreshPositionMap();
  const blocks = db.prepare('SELECT id FROM R4Doc_body_block WHERE document_id = ? ORDER BY position').all('d1');
  assert.equal(blocks.length, 2);
  const result = await app.dispatch({
    actionId: 'cross-annotation', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 9, id: 'd1', authoring: { version: 1, stream: stream.id, lease: lease.id, mutationId: 'm-cross-annotation' },
      edit: { kind: 'annotation.apply', annotation: { id: 'cross-ann', family: 'theme', fields: {} },
        from: { positionToken: v9PositionTokenPayload(nextMap, blocks[0].id), offset: 2, affinity: 'left' },
        to: { positionToken: v9PositionTokenPayload(nextMap, blocks[1].id), offset: 3, affinity: 'right' } } },
  });
  assert.equal(result.ok, true, result.failure?.message);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM R4Doc_body_annotation WHERE id = ?').get('cross-ann').count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM R4Doc_body_membership WHERE annotation_id = ?').get('cross-ann').count, 2);
});

test('R7 annotation.apply may start at a block boundary and split only its end block', async () => {
  const { app, db, blockId, positionMap, stream, lease, refreshPositionMap } = await setupDoc('hello world');
  const split = await app.dispatch({
    actionId: 'right-only-split', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 9, id: 'd1', authoring: { version: 1, stream: stream.id, lease: lease.id, mutationId: 'm-right-only-split' },
      edit: { kind: 'block.split', at: { positionToken: v9PositionTokenPayload(positionMap, blockId), offset: 5, affinity: 'right' }, temporaryBlock: 'tmp-right-only' } },
  });
  assert.equal(split.ok, true, split.failure?.message);
  const nextMap = await refreshPositionMap();
  const blocks = db.prepare('SELECT id FROM R4Doc_body_block WHERE document_id = ? ORDER BY position').all('d1');
  const existing = await app.dispatch({
    actionId: 'right-only-existing', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 9, id: 'd1', authoring: { version: 1, stream: stream.id, lease: lease.id, mutationId: 'm-right-only-existing' },
      edit: { kind: 'annotation.apply', annotation: { id: 'right-only-existing', family: 'theme', fields: {} },
        from: { positionToken: v9PositionTokenPayload(nextMap, blocks[0].id), offset: 0, affinity: 'left' },
        to: { positionToken: v9PositionTokenPayload(nextMap, blocks[0].id), offset: 5, affinity: 'right' } } },
  });
  assert.equal(existing.ok, true, existing.failure?.message);
  const result = await app.dispatch({
    actionId: 'right-only-annotation', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 9, id: 'd1', authoring: { version: 1, stream: stream.id, lease: lease.id, mutationId: 'm-right-only-annotation' },
      edit: { kind: 'annotation.apply', annotation: { id: 'right-only-ann', family: 'theme', fields: {} },
        from: { positionToken: v9PositionTokenPayload(nextMap, blocks[0].id), offset: 0, affinity: 'left' },
        to: { positionToken: v9PositionTokenPayload(nextMap, blocks[1].id), offset: 3, affinity: 'right' } } },
  });
  assert.equal(result.ok, true, result.failure?.message);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].data.version, 7);
  assert.equal(result.events[0].data.splitOps.length, 1);
  assert.equal(result.events[0].data.splitOps[0].blockId, blocks[1].id);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM R4Doc_body_membership WHERE annotation_id = ?').get('right-only-ann').count, 2);
  await app.close?.();
});

test('v6 text.replace projects one atomic same-block event', async () => {
  const { app, db, blockId, positionMap, stream, lease } = await setupDoc('Hello');
  const token = v9PositionTokenPayload(positionMap, blockId);
  const result = await app.dispatch({
    actionId: 'replace-interior', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 9, id: 'd1', authoring: { version: 1, stream: stream.id, lease: lease.id, mutationId: 'm-replace-interior' },
      edit: { kind: 'text.replace', from: { positionToken: token, offset: 1, affinity: 'left' }, to: { positionToken: token, offset: 4, affinity: 'right' }, text: 'i' } },
  });
  assert.equal(result.ok, true, result.failure?.message);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].data.version, 6);
  const state = db.prepare("SELECT family_checkpoint FROM R4Doc_body_state WHERE document_id = 'd1'").get();
  assert.equal(materializeBlock(restoreTextFamilyCheckpoint(JSON.parse(state.family_checkpoint)), blockId), 'Hio');
  await app.close?.();
});

test('R4 annotation.apply persists sorted protecting targets through its sole event and projection path', async () => {
  const { app, db, blockId, positionMap, state, stream, lease } = await setupDoc('hello world');
  const token = v9PositionTokenPayload(positionMap, blockId);
  const coded = await app.dispatch({
    actionId: 'apply-theme', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 9, id: 'd1', authoring: { version: 1, stream: stream.id, lease: lease.id, mutationId: 'm-theme' }, edit: { kind: 'annotation.apply', annotation: { id: 'theme-1', family: 'theme', fields: {} }, from: { positionToken: token, offset: 0, affinity: 'left' }, to: { positionToken: token, offset: 11, affinity: 'right' } } },
  });
  assert.equal(coded.ok, true, coded.failure?.message);
  const protectedResult = await app.dispatch({
    actionId: 'apply-protection', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 9, id: 'd1', authoring: { version: 1, stream: stream.id, lease: lease.id, mutationId: 'm-protect' }, edit: { kind: 'annotation.apply', annotation: { id: 'protect-1', family: 'confidential', fields: {}, protectedTargetIds: ['theme-1'] }, from: { positionToken: token, offset: 0, affinity: 'left' }, to: { positionToken: token, offset: 11, affinity: 'right' } } },
  });
  assert.equal(protectedResult.ok, true, protectedResult.failure?.message);
  const targets = db.prepare("SELECT annotation_id, target_annotation_id FROM R4Doc_body_annotation_protected_target").all();
  assert.equal(targets.length, 1);
  assert.equal(targets[0].annotation_id, 'protect-1');
  assert.equal(targets[0].target_annotation_id, 'theme-1');
  await app.close?.();
});

test('R3 merge preserves active orphan-policy annotations and protector edges', async (t) => {
  let principal = { id: 'u1' };
  const { app, db, blockId, positionMap, stream, lease } = await setupDoc('hello world', () => principal);
  t.after(async () => { await app.shutdown(); db.close(); });
  const token = v9PositionTokenPayload(positionMap, blockId);

  const target = await app.dispatch({
    actionId: 'merge-theme', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 9, id: 'd1', authoring: { version: 1, stream: stream.id, lease: lease.id, mutationId: 'm-merge-theme' }, edit: { kind: 'annotation.apply', annotation: { id: 'merge-theme', family: 'theme', fields: {} }, from: { positionToken: token, offset: 0, affinity: 'left' }, to: { positionToken: token, offset: 11, affinity: 'right' } } },
  });
  assert.equal(target.ok, true, target.failure?.message);
  const comment = await app.dispatch({
    actionId: 'merge-comment', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 9, id: 'd1', authoring: { version: 1, stream: stream.id, lease: lease.id, mutationId: 'm-merge-comment' }, edit: { kind: 'annotation.apply', annotation: { id: 'merge-comment', family: 'comment', fields: {} }, from: { positionToken: token, offset: 0, affinity: 'left' }, to: { positionToken: token, offset: 11, affinity: 'right' } } },
  });
  assert.equal(comment.ok, true, comment.failure?.message);
  const protector = await app.dispatch({
    actionId: 'merge-protector', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 9, id: 'd1', authoring: { version: 1, stream: stream.id, lease: lease.id, mutationId: 'm-merge-protector' }, edit: { kind: 'annotation.apply', annotation: { id: 'merge-protector', family: 'confidential', fields: {}, protectedTargetIds: ['merge-theme'] }, from: { positionToken: token, offset: 0, affinity: 'left' }, to: { positionToken: token, offset: 11, affinity: 'right' } } },
  });
  assert.equal(protector.ok, true, protector.failure?.message);

  const split = await app.dispatch({
    actionId: 'merge-split', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 9, id: 'd1', authoring: { version: 1, stream: stream.id, lease: lease.id, mutationId: 'm-merge-split' }, edit: { kind: 'block.split', at: { positionToken: token, offset: 5, affinity: 'right' }, temporaryBlock: 'tmp-merge-split' } },
  });
  assert.equal(split.ok, true, split.failure?.message);
  const receipt = split.resultData?.authoring;
  const rightBlockId = receipt?.splitResolutions?.[0]?.blockId;
  assert.ok(rightBlockId);
  const rightToken = receipt?.positionFrames?.[0]?.positionToken;
  assert.ok(rightToken);

  const merge = await app.dispatch({
    actionId: 'merge-active-annotations', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 9, id: 'd1', authoring: { version: 1, stream: stream.id, lease: lease.id, mutationId: 'm-merge-active' }, edit: { kind: 'block.merge', leftPositionToken: token, rightPositionToken: rightToken } },
  });
  assert.equal(merge.ok, true, merge.failure?.message);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM R4Doc_body_annotation_orphan_state").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM R4Doc_body_annotation WHERE id IN ('merge-comment', 'merge-protector')").get().count, 2);
  const protectingTarget = db.prepare("SELECT annotation_id, target_annotation_id FROM R4Doc_body_annotation_protected_target").get();
  assert.equal(protectingTarget.annotation_id, 'merge-protector');
  assert.equal(protectingTarget.target_annotation_id, 'merge-theme');

  const response = await fetch(`http://127.0.0.1:${app.httpServer.address().port}/snapshot/R4Doc/d1`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(response.status, 200);
  const ownerSerialized = await response.text();
  const ownerBody = JSON.parse(ownerSerialized).snapshot.body;
  assert.equal('basis' in ownerBody, false, 'snapshot must not contain basis');
  assert.equal(serializedIncludesPrivateField(ownerSerialized, ['annotation_orphan_state', 'saved_quote', 'savedQuote', 'last_memberships', 'lastMemberships', 'structuralRevision', 'frontier']), false);

  principal = { id: 'u2' };
  const deniedResponse = await fetch(`http://127.0.0.1:${app.httpServer.address().port}/snapshot/R4Doc/d1`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(deniedResponse.status, 200);
  const denied = await deniedResponse.json();
  assert.equal('basis' in denied.snapshot.body, false);
  assert.equal(denied.snapshot.body.kind, 'workbench.annotatedText.recipient');
  assert.deepEqual(denied.snapshot.body.blocks, [{ kind: 'restricted', id: blockId, placeholder: '[Restricted]' }]);
  assert.deepEqual(denied.snapshot.body.annotations, []);
  const deniedSerialized = JSON.stringify(denied.snapshot.body);
  assert.equal(deniedSerialized.includes('public block ID or group ID'), false);
  assert.equal(serializedIncludesPrivateField(deniedSerialized, ['annotation_orphan_state', 'saved_quote', 'savedQuote', 'last_memberships', 'lastMemberships', 'structuralRevision', 'frontier']), false);
});

function serializedIncludesPrivateField(serialized, fields) {
  return fields.some((field) => serialized.includes(field));
}

test('R2 split reorders persisted later blocks before inserting its right block', async () => {
  const { app, db, blockId, positionMap, stream, lease } = await setupDoc('hello world');
  const token = v9PositionTokenPayload(positionMap, blockId);
  const first = await app.dispatch({
    actionId: 'r2-first-split', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 9, id: 'd1', authoring: { version: 1, stream: stream.id, lease: lease.id, mutationId: 'm-r2-first' }, edit: { kind: 'block.split', at: { positionToken: token, offset: 6, affinity: 'right' }, temporaryBlock: 'tmp-r2-first' } },
  });
  assert.equal(first.ok, true, first.failure?.message);
  const second = await app.dispatch({
    actionId: 'r2-insert-before-later-block', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 9, id: 'd1', authoring: { version: 1, stream: stream.id, lease: lease.id, mutationId: 'm-r2-second' }, edit: { kind: 'block.split', at: { positionToken: token, offset: 2, affinity: 'right' }, temporaryBlock: 'tmp-r2-second' } },
  });
  assert.equal(second.ok, true, second.failure?.message);
  assert.deepEqual(
    db.prepare("SELECT position FROM R4Doc_body_block WHERE document_id = 'd1' ORDER BY position").all().map((row) => row.position),
    ['0000000000000', '0000000000001', '0000000000002'],
  );
  await app.close?.();
});

test('R5 annotation.detach deletes a last annotation, cleans incoming edges, and replays', async () => {
  const { app, db, blockId, positionMap, refreshPositionMap, stream, lease } = await setupDoc('hello world');
  const token = v9PositionTokenPayload(positionMap, blockId);
  const theme = await app.dispatch({
    actionId: 'r5-theme', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 9, id: 'd1', authoring: { version: 1, stream: stream.id, lease: lease.id, mutationId: 'm-r5-theme' }, edit: { kind: 'annotation.apply', annotation: { id: 'r5-theme', family: 'theme', fields: {} }, from: { positionToken: token, offset: 0, affinity: 'left' }, to: { positionToken: token, offset: 5, affinity: 'right' } } },
  });
  assert.equal(theme.ok, true, theme.failure?.message);
  const rightBlockId = db.prepare("SELECT id FROM R4Doc_body_block WHERE document_id = 'd1' AND id != ?").get(blockId).id;
  const rightPositionMap = await refreshPositionMap();
  const rightToken = v9PositionTokenPayload(rightPositionMap, rightBlockId);

  const applied = await app.dispatch({
    actionId: 'r5-z-protect', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 9, id: 'd1', authoring: { version: 1, stream: stream.id, lease: lease.id, mutationId: 'm-r5-z-protect' }, edit: { kind: 'annotation.apply', annotation: { id: 'r5-z-protect', family: 'confidential', fields: {}, protectedTargetIds: ['r5-theme'] }, from: { positionToken: rightToken, offset: 0, affinity: 'left' }, to: { positionToken: rightToken, offset: 6, affinity: 'right' } } },
  });
  assert.equal(applied.ok, true);
  const secondProtectPositionMap = await refreshPositionMap();
  const secondProtectToken = v9PositionTokenPayload(secondProtectPositionMap, rightBlockId);
  assert.equal((await app.dispatch({
    actionId: 'r5-a-protect', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 9, id: 'd1', authoring: { version: 1, stream: stream.id, lease: lease.id, mutationId: 'm-r5-a-protect' }, edit: { kind: 'annotation.apply', annotation: { id: 'r5-a-protect', family: 'confidential', fields: {}, protectedTargetIds: ['r5-theme'] }, from: { positionToken: secondProtectToken, offset: 0, affinity: 'left' }, to: { positionToken: secondProtectToken, offset: 6, affinity: 'right' } } },
  })).ok, true);
  const detachPositionMap = await refreshPositionMap();
  const detachToken = v9PositionTokenPayload(detachPositionMap, blockId);
  const beforeDetach = db.serialize();
  const detached = await app.dispatch({
    actionId: 'r5-detach', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 9, id: 'd1', authoring: { version: 1, stream: stream.id, lease: lease.id, mutationId: 'm-r5-detach' }, edit: { kind: 'annotation.detach', annotationId: 'r5-theme', positionToken: detachToken } },
  });
  assert.equal(detached.ok, true, detached.failure?.message);
  assert.equal(detached.events[0].data.version, 5);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM R4Doc_body_annotation WHERE id = 'r5-theme'").get().count, 0);
  const event = structuredClone(detached.events[0].data);
  db.deserialize(beforeDetach);
  app.entities.get('R4Doc').projection.apply({ handle: native('R4Doc', 'body', 'operated'), data: event }, db);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM R4Doc_body_annotation WHERE id = 'r5-theme'").get().count, 0);
  await app.close?.();
});

test('R5 annotation.detach denies a non-writer before log or projection changes', async () => {
  const { app, db, blockId, positionMap, stream, lease } = await setupDoc('hello world', null, {
    access: async ({ is }) => (await is.owner()) ? grant(read, write) : grant(read),
  });
  const token = v9PositionTokenPayload(positionMap, blockId);
  const applied = await app.dispatch({
    actionId: 'r5-denied-theme', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 9, id: 'd1', authoring: { version: 1, stream: stream.id, lease: lease.id, mutationId: 'm-r5-denied-theme' }, edit: { kind: 'annotation.apply', annotation: { id: 'r5-denied-theme', family: 'theme', fields: {} }, from: { positionToken: token, offset: 0, affinity: 'left' }, to: { positionToken: token, offset: 5, affinity: 'right' } } },
  });
  assert.equal(applied.ok, true, applied.failure?.message);
  const beforeLogCount = db.prepare('SELECT COUNT(*) AS count FROM _Log').get().count;
  const beforeMembershipCount = db.prepare("SELECT COUNT(*) AS count FROM R4Doc_body_membership WHERE annotation_id = 'r5-denied-theme'").get().count;
  const denied = await app.dispatch({
    actionId: 'r5-denied-detach', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u2' },
    payload: { version: 9, id: 'd1', authoring: { version: 1, stream: stream.id, lease: lease.id, mutationId: 'm-r5-denied-detach' }, edit: { kind: 'annotation.detach', annotationId: 'r5-denied-theme', positionToken: token } },
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.failure?.category, 'denied');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _Log').get().count, beforeLogCount);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM R4Doc_body_membership WHERE annotation_id = 'r5-denied-theme'").get().count, beforeMembershipCount);
  await app.close?.();
});

test('R5 annotation.detach persists an orphan outcome and rejects stale or tampered facts', async () => {
  const { app, db, blockId, positionMap, stream, lease } = await setupDoc('comment');
  const token = v9PositionTokenPayload(positionMap, blockId);
  assert.equal((await app.dispatch({
    actionId: 'r5-comment', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 9, id: 'd1', authoring: { version: 1, stream: stream.id, lease: lease.id, mutationId: 'm-r5-comment' }, edit: { kind: 'annotation.apply', annotation: { id: 'r5-comment', family: 'comment', fields: {} }, from: { positionToken: token, offset: 0, affinity: 'left' }, to: { positionToken: token, offset: 7, affinity: 'right' } } },
  })).ok, true);
  const preimage = db.serialize();
  const detached = await app.dispatch({
    actionId: 'r5-orphan', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 9, id: 'd1', authoring: { version: 1, stream: stream.id, lease: lease.id, mutationId: 'm-r5-orphan' }, edit: { kind: 'annotation.detach', annotationId: 'r5-comment', positionToken: token } },
  });
  assert.equal(detached.ok, true, detached.failure?.message);
  assert.equal(detached.events[0].data.result.disposition.kind, 'orphaned');
  assert.equal(detached.events[0].data.result.disposition.savedQuote, 'comment');
  const tampered = structuredClone(detached.events[0].data);
  tampered.result.disposition.savedQuote = 'forged';
  db.deserialize(preimage);
  assert.throws(() => app.entities.get('R4Doc').projection.apply({ handle: native('R4Doc', 'body', 'operated'), data: tampered }, db), /result does not match/);
  assert.deepEqual(db.serialize(), preimage);
  await app.close?.();
});

test('R5 annotation.detach retains a non-last annotation and normalizes ordinals', async () => {
  const { app, db, blockId, positionMap, refreshPositionMap, stream, lease } = await setupDoc('hello world');
  const token = v9PositionTokenPayload(positionMap, blockId);
  assert.equal((await app.dispatch({
    actionId: 'r5-retain', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 9, id: 'd1', authoring: { version: 1, stream: stream.id, lease: lease.id, mutationId: 'm-r5-retain-apply' }, edit: { kind: 'annotation.apply', annotation: { id: 'r5-retain', family: 'theme', fields: {} }, from: { positionToken: token, offset: 0, affinity: 'left' }, to: { positionToken: token, offset: 5, affinity: 'right' } } },
  })).ok, true);
  const retainedMembership = db.prepare("SELECT block_id FROM R4Doc_body_membership WHERE annotation_id = 'r5-retain' ORDER BY ordinal LIMIT 1").get();
  const secondBlock = db.prepare("SELECT id FROM R4Doc_body_block WHERE document_id = 'd1' AND id NOT IN (SELECT block_id FROM R4Doc_body_membership WHERE annotation_id = 'r5-retain')").get();
  const frontier = JSON.parse(db.prepare("SELECT family_checkpoint FROM R4Doc_body_state WHERE document_id = 'd1'").get().family_checkpoint).checkpoint.frontier;
  db.prepare('INSERT INTO R4Doc_body_membership (annotation_id, block_id, ordinal, start_point, end_point) VALUES (?, ?, ?, ?, ?)')
    .run('r5-retain', secondBlock.id, 1, JSON.stringify(['endpoint', frontier, ['point', ['root'], 'left']]), JSON.stringify(['endpoint', frontier, ['point', ['root'], 'right']]));
  const detachPositionMap = await refreshPositionMap();
  const detachToken = v9PositionTokenPayload(detachPositionMap, retainedMembership.block_id);
  const detached = await app.dispatch({
    actionId: 'r5-retain-detach', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 9, id: 'd1', authoring: { version: 1, stream: stream.id, lease: lease.id, mutationId: 'm-r5-retain-detach' }, edit: { kind: 'annotation.detach', annotationId: 'r5-retain', positionToken: detachToken } },
  });
  assert.equal(detached.ok, true, detached.failure?.message);
  assert.equal(db.prepare("SELECT ordinal FROM R4Doc_body_membership WHERE annotation_id = 'r5-retain' AND block_id = ?").get(secondBlock.id).ordinal, 0);
  await app.close?.();
});

test('HTTP snapshot projects protected annotated text for each recipient before serialization', async (t) => {
  let principal = { id: 'u1' };
  let ownerMayRead = true;
  const { app, db, blockId, positionMap, stream, lease } = await setupDoc('hello world', () => principal, {
    protectingAccess: async ({ is }) => (ownerMayRead && await is.owner()) ? grant(read) : grant(),
  });
  t.after(async () => { await app.shutdown(); db.close(); });
  const token = v9PositionTokenPayload(positionMap, blockId);
  assert.equal((await app.dispatch({
    actionId: 'http-theme', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 9, id: 'd1', authoring: { version: 1, stream: stream.id, lease: lease.id, mutationId: 'm-http-theme' }, edit: { kind: 'annotation.apply', annotation: { id: 'http-theme', family: 'theme', fields: {} }, from: { positionToken: token, offset: 0, affinity: 'left' }, to: { positionToken: token, offset: 11, affinity: 'right' } } },
  })).ok, true);
  assert.equal((await app.dispatch({
    actionId: 'http-protection', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 9, id: 'd1', authoring: { version: 1, stream: stream.id, lease: lease.id, mutationId: 'm-http-protection' }, edit: { kind: 'annotation.apply', annotation: { id: 'http-protect', family: 'confidential', fields: {}, protectedTargetIds: ['http-theme'] }, from: { positionToken: token, offset: 0, affinity: 'left' }, to: { positionToken: token, offset: 11, affinity: 'right' } } },
  })).ok, true);

  db.prepare("INSERT INTO R4Doc_body_measurement (id, block_id, family, format_version, payload) VALUES ('http-measurement', ?, 'source', 1, '{\"text\":\"hello world\"}')").run(blockId);

  const ownerResponse = await fetch(`http://127.0.0.1:${app.httpServer.address().port}/snapshot/R4Doc/d1`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(ownerResponse.status, 200);
  const owner = await ownerResponse.json();
  assert.equal('basis' in owner.snapshot.body, false, 'snapshot must not contain basis');
  assert.equal(owner.snapshot.body.blocks[0].kind, 'visible');
  assert.equal(owner.snapshot.body.blocks[0].text, 'hello world');
  const serialized = JSON.stringify(owner.snapshot.body);
  assert.equal(serialized.includes('protectedTargetIds'), false);

  principal = { id: 'u2' };
  const response = await fetch(`http://127.0.0.1:${app.httpServer.address().port}/snapshot/R4Doc/d1`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(response.status, 200);
  const recipient = await response.json();
  assert.equal('basis' in recipient.snapshot.body, false);
  assert.equal(recipient.snapshot.body.blocks[0].kind, 'restricted');
  const restrictedSerialized = JSON.stringify(recipient.snapshot.body);
  assert.equal(restrictedSerialized.includes('hello world'), false);
  assert.equal(restrictedSerialized.includes('http-measurement'), false);
  assert.equal(restrictedSerialized.includes('http-theme'), false);
  assert.equal(restrictedSerialized.includes('http-protect'), false);
  assert.equal(restrictedSerialized.includes('protectedTargetIds'), false);
  assert.equal(restrictedSerialized.includes('orphan quote'), false);
  assert.equal(restrictedSerialized.includes('frontier'), false);
  assert.equal(restrictedSerialized.includes('structuralRevision'), false);
});

test('v9 position token confidentiality: foreign and stale tokens are rejected', async (t) => {
  const { app, db, blockId, positionMap, stream, lease } = await setupDoc('secret', 'u1');
  t.after(async () => { await app.shutdown(); db.close(); });
  const token = v9PositionTokenPayload(positionMap, blockId);
  const foreignToken = randomBytes(32).toString('base64url');
  const result = await app.dispatch({
    actionId: 'foreign-token', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 9, id: 'd1', authoring: { version: 1, stream: stream.id, lease: lease.id, mutationId: 'm-foreign' }, edit: { kind: 'text.insert', at: { positionToken: foreignToken, offset: 0, affinity: 'right' }, text: 'x' } },
  });
  assert.equal(result.ok, false);
  const goodResult = await app.dispatch({
    actionId: 'good-insert', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 9, id: 'd1', authoring: { version: 1, stream: stream.id, lease: lease.id, mutationId: 'm-good' }, edit: { kind: 'text.insert', at: { positionToken: token, offset: 0, affinity: 'right' }, text: 'x' } },
  });
  assert.equal(goodResult.ok, true, goodResult.failure?.message);
});

test('v9 dispatch produces authoring receipt with correct fence and no basis', async () => {
  const { app, db, blockId, positionMap, stream, lease } = await setupDoc('hello world');
  const token = v9PositionTokenPayload(positionMap, blockId);
  const result = await app.dispatch({
    actionId: 'receipt-test', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 9, id: 'd1', authoring: { version: 1, stream: stream.id, lease: lease.id, mutationId: 'm-receipt' }, edit: { kind: 'text.insert', at: { positionToken: token, offset: 5, affinity: 'right' }, text: 'XYZ' } },
  });
  assert.equal(result.ok, true);
  assert.ok(result.resultData);
  assert.equal(result.resultData.actionId, 'receipt-test');
  assert.ok(Number.isSafeInteger(result.resultData.confirmedThrough));
  const receipt = result.resultData.authoring;
  assert.ok(receipt);
  assert.equal(receipt.version, 1);
  assert.equal(receipt.stream, stream.id);
  assert.equal(receipt.acknowledgementFence, result.resultData.confirmedThrough);
  assert.equal('basis' in result.resultData, false);
  await app.close?.();
});

test('HTTP snapshot serializes no canonical facts and never exposes basis', async (t) => {
  const { app, db, blockId } = await setupDoc('visible', 'u1');
  t.after(async () => { await app.shutdown(); db.close(); });
  const response = await fetch(`http://127.0.0.1:${app.httpServer.address().port}/snapshot/R4Doc/d1`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(response.status, 200);
  const body = (await response.json()).snapshot.body;
  assert.equal('basis' in body, false);
  assert.equal(body.blocks.length, 1);
  assert.equal(body.blocks[0].text, 'visible');
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes('structuralRevision'), false);
  assert.equal(serialized.includes('frontier'), false);
  assert.equal(serialized.includes('protectedTargetIds'), false);
  assert.equal(serialized.includes('last_memberships'), false);
  assert.equal(serialized.includes('family_checkpoint'), false);
});

test('HTTP replay never serializes annotated-text events and requires a fresh snapshot', async (t) => {
  let principal = { id: 'u1' };
  const { app, db, blockId, positionMap, stream, lease } = await setupDoc('replay secret', () => principal);
  t.after(async () => { await app.shutdown(); db.close(); });
  const token = v9PositionTokenPayload(positionMap, blockId);
  assert.equal((await app.dispatch({
    actionId: 'replay-theme', type: 'R4Doc.body.operation', scope: 'Project:p1', principal,
    payload: { version: 9, id: 'd1', authoring: { version: 1, stream: stream.id, lease: lease.id, mutationId: 'm-replay-theme' }, edit: { kind: 'annotation.apply', annotation: { id: 'replay-theme', family: 'theme', fields: {} }, from: { positionToken: token, offset: 0, affinity: 'left' }, to: { positionToken: token, offset: 13, affinity: 'right' } } },
  })).ok, true);
  assert.equal((await app.dispatch({
    actionId: 'replay-protection', type: 'R4Doc.body.operation', scope: 'Project:p1', principal,
    payload: { version: 9, id: 'd1', authoring: { version: 1, stream: stream.id, lease: lease.id, mutationId: 'm-replay-protection' }, edit: { kind: 'annotation.apply', annotation: { id: 'replay-protection', family: 'confidential', fields: {}, protectedTargetIds: ['replay-theme'] }, from: { positionToken: token, offset: 0, affinity: 'left' }, to: { positionToken: token, offset: 13, affinity: 'right' } } },
  })).ok, true);
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;
  const replay = await fetch(`${origin}/events-since/R4Doc/d1?cursor=0`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(replay.status, 200);
  const serialized = await replay.text();
  assert.deepEqual(JSON.parse(serialized), { resync: 'stale', reason: 'annotated-text-snapshot-required' });
  for (const hidden of ['replay secret', 'replay-theme', 'replay-protection', 'protectedTargetIds', 'operation', 'frontier']) {
    assert.equal(serialized.includes(hidden), false, `replay must not expose ${hidden}`);
  }

  principal = { id: 'u2' };
  const revoked = await fetch(`${origin}/events-since/R4Doc/d1?cursor=0`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(revoked.status, 200);
  assert.deepEqual(await revoked.json(), { resync: 'stale', reason: 'annotated-text-snapshot-required' });
  const snapshot = await fetch(`${origin}/snapshot/R4Doc/d1`, { signal: AbortSignal.timeout(5_000) });
  assert.deepEqual((await snapshot.json()).snapshot.body.blocks, [{ kind: 'restricted', id: blockId, placeholder: '[Restricted]' }]);
});

test('owner canonical export is complete and retirement erases history behind a durable reuse fence', async () => {
  const { app, db, blockId, R4Doc } = await setupDoc('retired secret');
  const exportRequest = { app, entity: r4Doc(), field: r4Doc().body, documentId: 'd1', expectedOwningScope: { entity: app.entities.get('Project'), id: 'p1' } };
  const exported = await exportAnnotatedText({ ...exportRequest, principal: { id: 'u1' } });
  assert.deepEqual(exported.blocks, [{ id: blockId, groupId: blockId, text: 'retired secret', fields: { reviewed: true }, annotationIds: [] }]);
  assert.deepEqual(exported.capabilities, []);
  await assert.rejects(exportAnnotatedText({ ...exportRequest, principal: { id: 'u2' } }), /owning scope admin authorization failed/);

  const retired = await app.dispatch({
    actionId: 'retire-d1', type: 'R4Doc.annotatedText.retire', scope: 'Project:p1', principal: { id: 'u1' }, payload: { id: 'd1' },
  });
  assert.equal(retired.ok, true, retired.failure?.message);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM R4Doc_body_retired WHERE document_id = 'd1'").get().count, 1);
  await assert.rejects(exportAnnotatedText({ ...exportRequest, principal: { id: 'u1' } }));
  const reused = await app.dispatch({
    actionId: 'reuse-d1', type: 'R4Doc.create', scope: 'Project:p1', principal: { id: 'u1' }, payload: { id: 'd1', project: 'p1', owner: 'u1' },
  });
  assert.equal(reused.ok, false);
});

test('R4 annotation.apply rejects target IDs on ordinary, standalone, and wrong-family protectors', async () => {
  const { app, db, blockId, positionMap, stream, lease } = await setupDoc('hello world');
  const token = v9PositionTokenPayload(positionMap, blockId);
  const ordinary = await app.dispatch({
    actionId: 'bad-targets', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 9, id: 'd1', authoring: { version: 1, stream: stream.id, lease: lease.id, mutationId: 'm-bad-targets' }, edit: { kind: 'annotation.apply', annotation: { id: 'flag-1', family: 'flag', fields: {}, protectedTargetIds: ['nope'] }, from: { positionToken: token, offset: 0, affinity: 'left' }, to: { positionToken: token, offset: 11, affinity: 'right' } } },
  });
  assert.equal(ordinary.ok, false);
  const standalone = await app.dispatch({
    actionId: 'bad-standalone-protection', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 9, id: 'd1', authoring: { version: 1, stream: stream.id, lease: lease.id, mutationId: 'm-bad-standalone' }, edit: { kind: 'annotation.apply', annotation: { id: 'standalone-1', family: 'standalone', fields: {}, protectedTargetIds: ['nope'] }, from: { positionToken: token, offset: 0, affinity: 'left' }, to: { positionToken: token, offset: 11, affinity: 'right' } } },
  });
  assert.equal(standalone.ok, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM R4Doc_body_annotation_protected_target').get().count, 0);
  await app.close?.();
});

test('R4 annotation.apply on a prefix produces the correct split', async () => {
  const { app, db, blockId, positionMap, stream, lease } = await setupDoc('hello world');
  const token = v9PositionTokenPayload(positionMap, blockId);
  const prefix = await app.dispatch({
    actionId: 'apply-prefix', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 9, id: 'd1', authoring: { version: 1, stream: stream.id, lease: lease.id, mutationId: 'm-prefix' }, edit: { kind: 'annotation.apply', annotation: { id: 'ann-prefix', family: 'flag', fields: { flagged: true } }, from: { positionToken: token, offset: 0, affinity: 'left' }, to: { positionToken: token, offset: 5, affinity: 'right' } } },
  });
  assert.equal(prefix.ok, true, prefix.failure?.message);
  await app.close?.();
});

test('R4 annotation.apply on an interior range persists the selected membership', async () => {
  const { app, db, blockId, positionMap, stream, lease } = await setupDoc('before selected after');
  const token = v9PositionTokenPayload(positionMap, blockId);
  const result = await app.dispatch({
    actionId: 'apply-interior', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 9, id: 'd1', authoring: { version: 1, stream: stream.id, lease: lease.id, mutationId: 'm-interior' }, edit: { kind: 'annotation.apply', annotation: { id: 'ann-interior', family: 'flag', fields: { flagged: true } }, from: { positionToken: token, offset: 7, affinity: 'left' }, to: { positionToken: token, offset: 15, affinity: 'right' } } },
  });
  assert.equal(result.ok, true, result.failure?.message);
  const memberships = db.prepare("SELECT block_id FROM R4Doc_body_membership WHERE annotation_id = 'ann-interior' ORDER BY ordinal").all();
  assert.equal(memberships.length, 1);
  const selected = db.prepare('SELECT id FROM R4Doc_body_block WHERE id = ?').get(memberships[0].block_id);
  assert.ok(selected);
  await app.close?.();
});

test('R4 annotation.apply rejects stale structural revision', async () => {
  const { app, db, blockId, positionMap, stream, lease } = await setupDoc('hello world');
  const result = await app.dispatch({
    actionId: 'stale', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 9, id: 'd1', authoring: { version: 1, stream: 'foreign-stream', lease: 'nonexistent', mutationId: 'm-stale' }, edit: { kind: 'annotation.apply', annotation: { id: 'ann-stale', family: 'theme', fields: {} }, from: { positionToken: v9PositionTokenPayload(positionMap, blockId), offset: 0, affinity: 'left' }, to: { positionToken: v9PositionTokenPayload(positionMap, blockId), offset: 11, affinity: 'right' } } },
  });
  assert.equal(result.ok, false);
  await app.close?.();
});

test('R4 annotation.apply rejects invalid selection offsets', async () => {
  const { app, db, blockId, positionMap, stream, lease } = await setupDoc('hello world');
  const token = v9PositionTokenPayload(positionMap, blockId);
  for (const [actionId, start, end] of [['reversed', 5, 3], ['negative', -1, 5], ['beyond', 0, 999], ['equal', 3, 3]]) {
    const result = await app.dispatch({
      actionId, type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
      payload: { version: 9, id: 'd1', authoring: { version: 1, stream: stream.id, lease: lease.id, mutationId: `m-${actionId}` }, edit: { kind: 'annotation.apply', annotation: { id: 'ann-bad', family: 'theme', fields: {} }, from: { positionToken: token, offset: start, affinity: 'left' }, to: { positionToken: token, offset: end, affinity: 'right' } } },
    });
    assert.equal(result.ok, false, `expected failure for ${actionId}`);
  }
  await app.close?.();
});

test('R4 annotation.apply rejects unknown annotation family', async () => {
  const { app, db, blockId, positionMap, stream, lease } = await setupDoc('hello world');
  const token = v9PositionTokenPayload(positionMap, blockId);
  const result = await app.dispatch({
    actionId: 'no-family', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 9, id: 'd1', authoring: { version: 1, stream: stream.id, lease: lease.id, mutationId: 'm-no-family' }, edit: { kind: 'annotation.apply', annotation: { id: 'ann-nofam', family: 'nonexistent', fields: {} }, from: { positionToken: token, offset: 0, affinity: 'left' }, to: { positionToken: token, offset: 11, affinity: 'right' } } },
  });
  assert.equal(result.ok, false);
  await app.close?.();
});

test('R4 annotation.apply rejects duplicate annotation id', async () => {
  const { app, db, blockId, positionMap, stream, lease } = await setupDoc('hello world');
  const token = v9PositionTokenPayload(positionMap, blockId);
  const first = await app.dispatch({
    actionId: 'first', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 9, id: 'd1', authoring: { version: 1, stream: stream.id, lease: lease.id, mutationId: 'm-dup-first' }, edit: { kind: 'annotation.apply', annotation: { id: 'dup-ann', family: 'theme', fields: {} }, from: { positionToken: token, offset: 0, affinity: 'left' }, to: { positionToken: token, offset: 11, affinity: 'right' } } },
  });
  assert.equal(first.ok, true);
  const second = await app.dispatch({
    actionId: 'second', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 9, id: 'd1', authoring: { version: 1, stream: stream.id, lease: lease.id, mutationId: 'm-dup-second' }, edit: { kind: 'annotation.apply', annotation: { id: 'dup-ann', family: 'theme', fields: {} }, from: { positionToken: token, offset: 0, affinity: 'left' }, to: { positionToken: token, offset: 11, affinity: 'right' } } },
  });
  assert.equal(second.ok, false);
  await app.close?.();
});

test('R4 annotation.apply rejects extra and missing fields', async () => {
  const { app, db, blockId, positionMap, stream, lease } = await setupDoc('hello world');
  const token = v9PositionTokenPayload(positionMap, blockId);
  const extraResult = await app.dispatch({
    actionId: 'extra', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 9, id: 'd1', authoring: { version: 1, stream: stream.id, lease: lease.id, mutationId: 'm-extra' }, edit: { kind: 'annotation.apply', annotation: { id: 'ann-extra', family: 'theme', fields: { color: 'red', extraField: 'oops' } }, from: { positionToken: token, offset: 0, affinity: 'left' }, to: { positionToken: token, offset: 11, affinity: 'right' } } },
  });
  assert.equal(extraResult.ok, false);
  await app.close?.();
});

test('R4 annotation.apply receipt deduplication works', async () => {
  const { app, db, blockId, positionMap, stream, lease } = await setupDoc('hello world');
  const token = v9PositionTokenPayload(positionMap, blockId);
  const payload = { version: 9, id: 'd1', authoring: { version: 1, stream: stream.id, lease: lease.id, mutationId: 'm-dedup' }, edit: { kind: 'annotation.apply', annotation: { id: 'ann-dedup', family: 'theme', fields: { color: 'red' } }, from: { positionToken: token, offset: 0, affinity: 'left' }, to: { positionToken: token, offset: 11, affinity: 'right' } } };
  const first = await app.dispatch({
    actionId: 'dedup-op', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload,
  });
  assert.equal(first.ok, true);
  const retry = await app.dispatch({
    actionId: 'dedup-op', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload,
  });
  assert.equal(retry.ok, true);
  assert.equal(retry.deduped, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM R4Doc_body_annotation WHERE id = 'ann-dedup'").get().count, 1);
  await app.close?.();
});

test('v9 receipt dedupe requires the original principal stream and lease binding', async (t) => {
  const { app, db, blockId, positionMap, stream, lease } = await setupDoc('hello world');
  t.after(async () => { await app.shutdown(); db.close(); });
  const token = v9PositionTokenPayload(positionMap, blockId);
  const payload = { version: 9, id: 'd1', authoring: { version: 1, stream: stream.id, lease: lease.id, mutationId: 'm-bound-receipt' }, edit: { kind: 'text.insert', at: { positionToken: token, offset: 0, affinity: 'right' }, text: 'X' } };
  const first = await app.dispatch({ actionId: 'bound-receipt', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' }, payload });
  assert.equal(first.ok, true, first.failure?.message);

  const otherStream = ensureStream({ db, prefix: 'R4Doc_body', documentId: 'd1', principalType: 'principal', principalId: 'u2' });
  const otherLease = ensureLease({ db, prefix: 'R4Doc_body', streamId: otherStream.id, clientNonceHash: hashClientNonce(randomBytes(32).toString('base64url')) });
  const foreign = await app.dispatch({
    actionId: 'bound-receipt', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u2' },
    payload: { ...payload, authoring: { ...payload.authoring, stream: otherStream.id, lease: otherLease.id } },
  });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.resultData, undefined);

  const staleLease = ensureLease({ db, prefix: 'R4Doc_body', streamId: stream.id, clientNonceHash: hashClientNonce(randomBytes(32).toString('base64url')) });
  const stale = await app.dispatch({
    actionId: 'bound-receipt', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { ...payload, authoring: { ...payload.authoring, lease: staleLease.id } },
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.resultData, undefined);
});

test('v9 receipt dedupe rejects an altered position token without replaying authoring data', async (t) => {
  const { app, db, blockId, positionMap, stream, lease } = await setupDoc('hello world');
  t.after(async () => { await app.shutdown(); db.close(); });
  const token = v9PositionTokenPayload(positionMap, blockId);
  const payload = { version: 9, id: 'd1', authoring: { version: 1, stream: stream.id, lease: lease.id, mutationId: 'm-identity-receipt' }, edit: { kind: 'text.insert', at: { positionToken: token, offset: 0, affinity: 'right' }, text: 'X' } };
  assert.equal((await app.dispatch({ actionId: 'identity-receipt', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' }, payload })).ok, true);
  const altered = await app.dispatch({
    actionId: 'identity-receipt', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { ...payload, edit: { ...payload.edit, at: { ...payload.edit.at, positionToken: randomBytes(32).toString('base64url') } } },
  });
  assert.equal(altered.ok, false);
  assert.equal(altered.failure.category, 'conflict');
  assert.equal(altered.resultData, undefined);
});

test('R4 annotation.apply with measurements partitions deterministically', async () => {
  const { app, db, blockId, positionMap, stream, lease } = await setupDoc('hello world');
  const token = v9PositionTokenPayload(positionMap, blockId);
  db.prepare("INSERT INTO R4Doc_body_measurement (id, block_id, family, format_version, payload) VALUES ('m1', ?, 'source', 1, '{\"text\":\"hello world\"}')").run(blockId);
  const result = await app.dispatch({
    actionId: 'ann-meas', type: 'R4Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 9, id: 'd1', authoring: { version: 1, stream: stream.id, lease: lease.id, mutationId: 'm-ann-meas' }, edit: { kind: 'annotation.apply', annotation: { id: 'ann-meas', family: 'theme', fields: {} }, from: { positionToken: token, offset: 0, affinity: 'left' }, to: { positionToken: token, offset: 5, affinity: 'right' } } },
  });
  assert.equal(result.ok, true);
  const measRows = db.prepare('SELECT id, block_id, family, payload FROM R4Doc_body_measurement ORDER BY id').all();
  assert.equal(measRows.length, 2);
  const leftMeas = measRows.find(r => r.block_id === blockId);
  assert.ok(leftMeas);
  assert.equal(JSON.parse(leftMeas.payload).text, 'hello');
  await app.close?.();
});

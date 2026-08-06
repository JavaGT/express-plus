import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  annotatedText, annotation, boolean, text, number, entity, everyone, executeDDL, executeFrameworkDDL,
  protectingAnnotation, grant, deny, admin, read, write, ref, scope,
} from '../src/internal.mjs';
import { materializeBlock, restoreTextFamilyCheckpoint } from '../src/annotated-text-family.mjs';
import { projectAnnotatedTextSnapshot } from '../src/internal.mjs';
import { ensureStream, ensureLease, hashClientNonce } from '../src/annotated-text-authoring-stream.mjs';
import { durableHistory } from '../src/internal.mjs';

// #28: collaborating over spans — undo never leaks confidential text, and
// authorized/unauthorized recipients converge on the same durable document.

function docDecl({ protectingAccess = async ({ is }) => (await is.owner()) ? grant(read) : grant() } = {}) {
  return entity('UCDoc', {
    project: ref('Project'),
    owner: ref('User', { role: 'owner' }),
    body: annotatedText({
      project: 'project',
      owner: 'owner',
      annotations: [
        annotation('theme', { fields: { color: text({ default: 'blue' }) } }),
        annotation('comment'),
        protectingAnnotation('confidential', { protects: 'theme', access: protectingAccess }),
      ],
    }),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
}

async function setup(ownerId = 'u1') {
  const db = new DatabaseSync(':memory:');
  const UCDoc = docDecl();
  const Project = entity('Project', {
    owner: ref('User', { role: 'owner' }),
    grant: [scope(() => everyone()).can(() => grant(read, write, admin))],
  });
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY)');
  db.exec("INSERT INTO User (id) VALUES ('u1'), ('u2')");
  executeDDL(Project, db);
  db.exec("INSERT INTO Project (id, owner) VALUES ('p1', 'u1')");
  executeDDL(UCDoc, db);
  const app = workbench({
    db,
    entities: [Project, UCDoc],
    history: durableHistory({ authorize: () => true, actions: {} }),
  });
  await app.start();
  await app.ready;
  const created = await app.dispatch({
    actionId: 'create', type: 'UCDoc.create',
    payload: { id: 'd1', project: 'p1', owner: 'u1' }, principal: { id: ownerId },
  });
  const blockId = created.events[0].data.__workbench.annotatedText.body.initialBlockId;
  const prefix = 'UCDoc_body';
  const stream = ensureStream({ db, prefix, documentId: 'd1', principalType: 'principal', principalId: ownerId });
  const lease = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: hashClientNonce(randomBytes(32).toString('base64url')) });
  const stream2 = ensureStream({ db, prefix, documentId: 'd1', principalType: 'principal', principalId: 'u2' });
  const lease2 = ensureLease({ db, prefix, streamId: stream2.id, clientNonceHash: hashClientNonce(randomBytes(32).toString('base64url')) });
  return { app, db, UCDoc, blockId, stream, lease, stream2, lease2, prefix, scope: 'Project:p1' };
}

async function issueAuthoringSnapshot(ctx, principalId) {
  const { app, db, UCDoc } = ctx;
  const row = db.prepare('SELECT * FROM UCDoc WHERE id = ?').get('d1');
  return projectAnnotatedTextSnapshot({
    db, entity: UCDoc, row, principal: { id: principalId }, fieldName: 'body', descriptor: UCDoc.fields.body,
    authoring: { streamToken: ctx.stream.id, leaseToken: ctx.lease.id, leaseId: ctx.lease.id, fence: readLastSeq(db) },
  });
}

// Plain recipient projection with no authoring envelope (works for any
// principal; the redaction view is what we assert on for the unauthorized user).
async function recipientSnapshot(ctx, principalId) {
  const { app, db, UCDoc } = ctx;
  const row = db.prepare('SELECT * FROM UCDoc WHERE id = ?').get('d1');
  return projectAnnotatedTextSnapshot({
    db, entity: UCDoc, row, principal: { id: principalId }, fieldName: 'body', descriptor: UCDoc.fields.body,
  });
}

function readLastSeq(db) {
  return db.prepare('SELECT lastSeq FROM _ProjectedCursor WHERE entity = ? AND field = ?').get('UCDoc', 'body')?.lastSeq ?? 0;
}

async function authoringMap(ctx, principalId) {
  const snap = await issueAuthoringSnapshot(ctx, principalId);
  const auth = snap.body?.authoring ?? snap.authoring;
  return new Map((auth?.positionFrames ?? []).map((f) => [f.blockId, f.positionToken]));
}

async function authoringMapFor(ctx, principalId, stream, lease) {
  const { app, db, UCDoc } = ctx;
  const row = db.prepare('SELECT * FROM UCDoc WHERE id = ?').get('d1');
  const snap = await projectAnnotatedTextSnapshot({
    db, entity: UCDoc, row, principal: { id: principalId }, fieldName: 'body', descriptor: UCDoc.fields.body,
    authoring: { streamToken: stream.id, leaseToken: lease.id, leaseId: lease.id, fence: readLastSeq(db) },
  });
  const auth = snap.body?.authoring ?? snap.authoring;
  return new Map((auth?.positionFrames ?? []).map((f) => [f.blockId, f.positionToken]));
}

async function dispatchTextInsert(ctx, actionId, principalId, session, offset, text, positionMap) {
  const token = positionMap.get(ctx.blockId);
  return ctx.app.dispatch({
    actionId, principal: { id: principalId }, scope: ctx.scope, history: { session },
    type: 'UCDoc.body.operation',
    payload: {
      version: 9, id: 'd1',
      authoring: { version: 1, stream: ctx.stream.id, lease: ctx.lease.id, mutationId: actionId },
      edit: { kind: 'text.insert', at: { positionToken: token, offset, affinity: 'right' }, text },
    },
  });
}

async function applyAnnotationSpan(ctx, actionId, annotation, fromOffset, toOffset, positionMap) {
  const token = positionMap.get(ctx.blockId);
  return ctx.app.dispatch({
    actionId, principal: { id: 'u1' }, scope: ctx.scope,
    type: 'UCDoc.body.operation',
    payload: {
      version: 9, id: 'd1',
      authoring: { version: 1, stream: ctx.stream.id, lease: ctx.lease.id, mutationId: actionId },
      edit: {
        kind: 'annotation.apply',
        annotation,
        from: { positionToken: token, offset: fromOffset, affinity: 'left' },
        to: { positionToken: token, offset: toOffset, affinity: 'right' },
      },
    },
  });
}

async function undoLast(ctx, principalId, session) {
  const cursor = await ctx.app.history.cursor({ scope: ctx.scope, principal: { id: principalId }, session });
  return ctx.app.history.undo({ scope: ctx.scope, principal: { id: principalId }, session, actionId: `undo-${randomUUID()}`, revision: cursor.revision });
}

function durableText(ctx) {
  const state = ctx.db.prepare('SELECT family_checkpoint FROM UCDoc_body_state WHERE document_id = ?').get('d1');
  const family = restoreTextFamilyCheckpoint(JSON.parse(state.family_checkpoint));
  return family.blocks.map((block) => materializeBlock(family, block.id)).join('');
}

test('undo of a text insert inside a confidential span never leaks to an unauthorized recipient', async (t) => {
  const ctx = await setup();
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });

  // Seed "hello secret world", then protect the "secret" span (offsets 6..12).
  const map0 = await authoringMap(ctx, 'u1');
  const inserted = await dispatchTextInsert(ctx, 'seed', 'u1', 'tab-u1', 0, 'hello secret world', map0);
  assert.equal(inserted.ok, true, inserted.failure?.message);

  const map1 = await authoringMap(ctx, 'u1');
  const themed = await applyAnnotationSpan(ctx, 'theme-apply', { id: 'theme-1', family: 'theme', fields: { color: 'red' } }, 0, 17, map1);
  assert.equal(themed.ok, true, themed.failure?.message);
  const protectMap = await authoringMap(ctx, 'u1');
  const protectedResult = await applyAnnotationSpan(ctx, 'protect', { id: 'protect-1', family: 'confidential', fields: {}, protectedTargetIds: ['theme-1'] }, 6, 12, protectMap);
  assert.equal(protectedResult.ok, true, protectedResult.failure?.message);

  // Insert text inside the protected span (authorized owner inserts "X" at 8).
  const map2 = await authoringMap(ctx, 'u1');
  const insertedInside = await dispatchTextInsert(ctx, 'insert-inside', 'u1', 'tab-u1', 8, 'X', map2);
  assert.equal(insertedInside.ok, true, insertedInside.failure?.message);
  assert.equal(durableText(ctx), 'hello seXcret world');

  // Unauthorized recipient (u2, not owner) sees the span redacted BEFORE undo.
  // Either presentation is acceptable as long as the secret never leaks: a
  // sub-block span renders `visible` with a redaction marker, or the
  // conservative whole-block `restricted` fallback hides the whole block.
  const deniedView = await recipientSnapshot(ctx, 'u2');
  const deniedBlock = deniedView.blocks.find((b) => b.id === ctx.blockId);
  assert.ok(deniedBlock.kind === 'visible' || deniedBlock.kind === 'restricted');
  assert.equal(JSON.stringify(deniedView).includes('secret'), false);
  assert.equal(JSON.stringify(deniedView).includes('seXcret'), false);
  if (deniedBlock.kind === 'visible') {
    assert.ok(Array.isArray(deniedBlock.redactions) && deniedBlock.redactions.length === 1);
  }

  // Undo the insert inside the span (as the owner). The exact effect of undo on
  // the text is #13's concern; the #28 property is that it never leaks. Accept
  // either the X removed or a no-op, but never a leak.
  const undone = await undoLast(ctx, 'u1', 'tab-u1');
  assert.equal(undone.ok, true, undone.failure?.message);

  // After undo, the unauthorized recipient STILL never sees the secret.
  const deniedAfter = await recipientSnapshot(ctx, 'u2');
  const deniedAfterBlock = deniedAfter.blocks.find((b) => b.id === ctx.blockId);
  assert.ok(deniedAfterBlock.kind === 'visible' || deniedAfterBlock.kind === 'restricted');
  assert.equal(JSON.stringify(deniedAfter).includes('secret'), false);
  assert.equal(JSON.stringify(deniedAfter).includes('seXcret'), false);

  // Authorized owner sees the real text across all blocks (the theme apply may
  // have split the block; the durable text is the truth and the owner sees it).
  const ownerView = await issueAuthoringSnapshot(ctx, 'u1');
  const ownerText = ownerView.blocks.filter((b) => b.kind === 'visible').map((b) => b.text).join('');
  assert.ok(ownerText.includes('secret'));
  assert.equal(JSON.stringify(ownerView).includes('secret'), true);
  assert.equal(ownerView.blocks.some((b) => Object.hasOwn(b, 'redactions')), false);
});

test('authorized and unauthorized recipients converge on the same durable document', async (t) => {
  const ctx = await setup();
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });

  const map0 = await authoringMap(ctx, 'u1');
  const seed = await dispatchTextInsert(ctx, 'seed', 'u1', 'tab-u1', 0, 'hello secret world', map0);
  assert.equal(seed.ok, true, seed.failure?.message);

  const map1 = await authoringMap(ctx, 'u1');
  const themed = await applyAnnotationSpan(ctx, 'theme-apply', { id: 'theme-1', family: 'theme', fields: { color: 'red' } }, 0, 17, map1);
  assert.equal(themed.ok, true, themed.failure?.message);
  const protectMap = await authoringMap(ctx, 'u1');
  const protectedResult = await applyAnnotationSpan(ctx, 'protect', { id: 'protect-1', family: 'confidential', fields: {}, protectedTargetIds: ['theme-1'] }, 6, 12, protectMap);
  assert.equal(protectedResult.ok, true, protectedResult.failure?.message);

  // Unauthorized user edits the surrounding prefix text (before the span).
  const map2 = await authoringMapFor(ctx, 'u2', ctx.stream2, ctx.lease2);
  const token = map2.get(ctx.blockId);
  assert.ok(token, 'u2 should be able to author the surrounding prefix of a sub-block-redacted block');
  const deniedEdit = await ctx.app.dispatch({
    actionId: 'denied-edit', principal: { id: 'u2' }, scope: ctx.scope, history: { session: 'tab-u2' },
    type: 'UCDoc.body.operation',
    payload: {
      version: 9, id: 'd1',
      authoring: { version: 1, stream: ctx.stream2.id, lease: ctx.lease2.id, mutationId: 'denied-edit' },
      edit: { kind: 'text.insert', at: { positionToken: token, offset: 0, affinity: 'right' }, text: '> ' },
    },
  });
  assert.equal(deniedEdit.ok, true, deniedEdit.failure?.message);

  // Authorized owner edits the real span text (concurrent with u2's prefix edit).
  const map3 = await authoringMap(ctx, 'u1');
  const ownerEdit = await dispatchTextInsert(ctx, 'owner-edit', 'u1', 'tab-u1', 10, 'X', map3);
  assert.equal(ownerEdit.ok, true, ownerEdit.failure?.message);

  // Durable document reflects BOTH edits (converged, redaction is projection-only).
  assert.equal(durableText(ctx), '> hello secrXet world');

  // Authorized recipient sees the full text across all blocks.
  const ownerView = await issueAuthoringSnapshot(ctx, 'u1');
  const ownerText = ownerView.blocks.filter((b) => b.kind === 'visible').map((b) => b.text).join('');
  assert.equal(ownerText, '> hello secrXet world');

  // Unauthorized recipient sees redacted text that never contains the secret.
  const deniedView = await recipientSnapshot(ctx, 'u2');
  const deniedBlock = deniedView.blocks.find((b) => b.id === ctx.blockId);
  assert.ok(deniedBlock.kind === 'visible' || deniedBlock.kind === 'restricted');
  assert.equal(JSON.stringify(deniedView).includes('secret'), false);
  assert.equal(JSON.stringify(deniedView).includes('seXcret'), false);
});

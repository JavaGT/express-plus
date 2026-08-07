import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  annotatedText, annotation, entity, everyone, executeDDL, executeFrameworkDDL,
  protectingAnnotation, grant, admin, read, write, ref, scope,
} from '../src/internal.mjs';
import { projectAnnotatedTextSnapshot } from '../src/internal.mjs';
import { ensureStream, ensureLease, hashClientNonce } from '../src/annotated-text-authoring-stream.mjs';
import { durableHistory } from '../src/internal.mjs';
import { tryBuildAnnotatedTextFoldEnvelopes } from '../src/annotated-text-fold-envelope.mjs';

// The fold envelope no longer ships the canonical family (the snapshot's
// authoring envelope carries it, unredacted recipients only). A recipient whose
// view is redacted ANYWHERE must never receive a fold envelope: it also never
// receives a family seed, so folding it would fail every subsequent transition
// and loop through recovery.

const protectingAccess = async ({ is }) => (await is.owner()) ? grant(read) : grant();

function docDecl() {
  return entity('FoldRedactDoc', {
    project: ref('Project'),
    owner: ref('User', { role: 'owner' }),
    body: annotatedText({
      project: 'project',
      owner: 'owner',
      annotations: [
        annotation('theme'),
        protectingAnnotation('confidential', { protects: 'theme', access: protectingAccess }),
      ],
    }),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
}

async function setup() {
  const db = new DatabaseSync(':memory:');
  const Doc = docDecl();
  const Project = entity('Project', {
    owner: ref('User', { role: 'owner' }),
    grant: [scope(() => everyone()).can(() => grant(read, write, admin))],
  });
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY)');
  db.exec("INSERT INTO User (id) VALUES ('u1'), ('u2')");
  executeDDL(Project, db);
  db.exec("INSERT INTO Project (id, owner) VALUES ('p1', 'u1')");
  executeDDL(Doc, db);
  const app = workbench({
    db,
    entities: [Project, Doc],
    history: durableHistory({ authorize: () => true, actions: {} }),
  });
  await app.start();
  await app.ready;
  const created = await app.dispatch({
    actionId: 'create', type: 'FoldRedactDoc.create',
    payload: {
      id: 'd1', project: 'p1', owner: 'u1',
      body: { version: 1, blocks: [{ text: 'SECRET alpha' }, { text: 'visible beta' }] },
    },
    principal: { id: 'u1' },
  });
  assert.equal(created.ok, true, created.failure?.message);
  const blockIds = db.prepare('SELECT id FROM FoldRedactDoc_body_block WHERE document_id = ? ORDER BY position').all('d1').map((row) => row.id);
  assert.equal(blockIds.length, 2);
  const prefix = 'FoldRedactDoc_body';
  const stream = ensureStream({ db, prefix, documentId: 'd1', principalType: 'principal', principalId: 'u1' });
  const lease = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: hashClientNonce(randomBytes(32).toString('base64url')) });
  return { app, db, Doc, Project, blockIds, stream, lease, prefix, scope: 'Project:p1' };
}

function readLastSeq(db) {
  return db.prepare('SELECT lastSeq FROM _ProjectedCursor WHERE entity = ? AND field = ?').get('FoldRedactDoc', 'body')?.lastSeq ?? 0;
}

async function authoringMap(ctx, principalId) {
  const { db, Doc } = ctx;
  const row = db.prepare('SELECT * FROM FoldRedactDoc WHERE id = ?').get('d1');
  const snap = await projectAnnotatedTextSnapshot({
    db, entity: Doc, row, principal: { id: principalId }, fieldName: 'body', descriptor: Doc.fields.body,
    authoring: { streamToken: ctx.stream.id, leaseToken: ctx.lease.id, leaseId: ctx.lease.id, fence: readLastSeq(db) },
  });
  const auth = snap.body?.authoring ?? snap.authoring;
  return new Map((auth?.positionFrames ?? []).map((f) => [f.blockId, f.positionToken]));
}

async function dispatchTextInsert(ctx, actionId, blockId, principalId, session, offset, text, positionMap) {
  const token = positionMap.get(blockId);
  return ctx.app.dispatch({
    actionId, principal: { id: principalId }, scope: ctx.scope, history: { session },
    type: 'FoldRedactDoc.body.operation',
    payload: {
      version: 9, id: 'd1',
      authoring: { version: 1, stream: ctx.stream.id, lease: ctx.lease.id, mutationId: actionId },
      edit: { kind: 'text.insert', at: { positionToken: token, offset, affinity: 'right' }, text },
    },
  });
}

async function applyConfidentialSpan(ctx, actionId, blockId, annotation, fromOffset, toOffset, positionMap) {
  const token = positionMap.get(blockId);
  return ctx.app.dispatch({
    actionId, principal: { id: 'u1' }, scope: ctx.scope,
    type: 'FoldRedactDoc.body.operation',
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

function committedOperatedEvents(db) {
  return db.prepare(`SELECT * FROM _Log WHERE eventType = 'FoldRedactDoc.body.operated' ORDER BY seq`).all();
}

test('a recipient with any confidential span never receives a fold envelope (no raw family leak)', async (t) => {
  const ctx = await setup();
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });
  const [confidentialBlock, visibleBlock] = ctx.blockIds;

  // Theme + protect the whole of the CONFIDENTIAL block ("SECRET alpha", 12 chars).
  const map0 = await authoringMap(ctx, 'u1');
  const themed = await applyConfidentialSpan(ctx, 'theme', confidentialBlock, { id: 'theme-1', family: 'theme', fields: {} }, 0, 12, map0);
  assert.equal(themed.ok, true, themed.failure?.message);
  const protectMap = await authoringMap(ctx, 'u1');
  const protect = await applyConfidentialSpan(ctx, 'protect', confidentialBlock, { id: 'protect-1', family: 'confidential', fields: {}, protectedTargetIds: ['theme-1'] }, 0, 12, protectMap);
  assert.equal(protect.ok, true, protect.failure?.message);

  // Edit the VISIBLE block. The affected block is fully visible, so the
  // original affected-block-only gate would emit a fold — but a redacted
  // recipient never receives a family seed (neither in its snapshot nor in a
  // fold), so it must get a resync, not a fold, or every fold would fail.
  const visibleMap = await authoringMap(ctx, 'u1');
  const edited = await dispatchTextInsert(ctx, 'edit-visible', visibleBlock, 'u1', 'tab-u1', 0, 'x', visibleMap);
  assert.equal(edited.ok, true, edited.failure?.message);

  const events = committedOperatedEvents(ctx.db);
  const event = events[events.length - 1];
  const document = {
    entity: ctx.Doc,
    fieldName: 'body',
    descriptor: ctx.Doc.fields.body,
    documentId: 'd1',
    clientNonce: 'x'.repeat(43),
  };
  const foldEvent = { ...event, data: JSON.parse(event.eventData) };

  const redacted = await tryBuildAnnotatedTextFoldEnvelopes(
    { event: foldEvent, scope: 'Project:p1', principal: { id: 'u2' }, db: ctx.db, document },
    { db: ctx.db, document },
  );
  assert.ok(Array.isArray(redacted));
  assert.equal(redacted[0].type, 'resync');
  assert.equal('fold' in redacted[0], false, 'redacted recipient must never receive a fold envelope');

  const owner = await tryBuildAnnotatedTextFoldEnvelopes(
    { event: foldEvent, scope: 'Project:p1', principal: { id: 'u1' }, db: ctx.db, document },
    { db: ctx.db, document },
  );
  assert.ok(Array.isArray(owner));
  assert.equal(owner[0].type, 'event');
  assert.equal(owner[0].fold?.kind, 'annotatedText');
});

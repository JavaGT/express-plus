import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  annotatedText, annotation, entity, everyone, executeDDL, executeFrameworkDDL,
  protectingAnnotation, grant, admin, read, write, ref, scope,
} from '../build/internal.mjs';
import { durableHistory } from '../build/internal.mjs';
import { tryBuildAnnotatedTextFoldEnvelopes } from '../build/annotated-text-fold-envelope.mjs';
import { createOwnedLiveDelivery } from '../build/live-delivery-public.mjs';
import { projectAnnotatedTextSnapshot } from '../build/annotated-text-snapshot.mjs';
import { ensureStream, ensureLease, hashClientNonce } from '../build/annotated-text-authoring-stream.mjs';
import { createAnnotatedTextHttpSession, materializeAnnotatedTextSnapshot } from '../public/workbench-client.mjs';
import { projectEndpointToOffset, restoreTextFamily } from '../public/workbench-annotated-text-continuous.mjs';
import { withAuthoringBinding } from './annotated-text-authoring-fixture.mjs';

// A foldable text edit that empties an annotation carries the server's
// authoritative disposition (deleted vs orphaned, with the orphan's saved
// quote) so the client's one reconciliation path reproduces the projection
// instead of inferring the policy. Dispositions never disclose protecting-
// family annotations, and an edit that empties a protecting annotation falls
// back to snapshot recovery because it can change a recipient's visibility.

const protectingAccess = async ({ is }) => (await is.owner()) ? grant(read) : grant();

function docDecl() {
  return entity('FoldDispositionDoc', {
    project: ref('Project'),
    owner: ref('User', { role: 'owner' }),
    body: annotatedText({
      project: 'project',
      owner: 'owner',
      annotations: [
        annotation('comment', { empty: 'orphan' }),
        annotation('mark', { empty: 'delete' }),
        protectingAnnotation('confidential', { protects: 'mark', placeholder: '[REDACTED]', access: protectingAccess }),
      ],
    }),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
}

async function setup(text = 'hello world tail') {
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
    actionId: 'create', type: 'FoldDispositionDoc.create',
    payload: {
      id: 'd1', project: 'p1', owner: 'u1',
      body: { version: 1, blocks: [{ text }] },
    },
    principal: { id: 'u1' },
  });
  assert.equal(created.ok, true, created.failure?.message);
  return { app, db, Doc, Project, scope: 'Project:p1' };
}

async function binding(ctx, principalId = 'u1') {
  const row = ctx.db.prepare('SELECT * FROM FoldDispositionDoc WHERE id = ?').get('d1');
  return withAuthoringBinding({
    db: ctx.db, entity: ctx.Doc, Document: ctx.Doc, row,
    principal: { id: principalId }, fieldName: 'body', descriptor: ctx.Doc.fields.body,
  });
}

async function applyRange(ctx, actionId, annotation, fromOffset, toOffset, auth) {
  return ctx.app.dispatch({
    actionId, principal: { id: 'u1' }, scope: ctx.scope,
    type: 'FoldDispositionDoc.body.operation',
    payload: {
      version: 9, id: 'd1',
      authoring: { version: 1, stream: auth.streamToken, lease: auth.leaseToken, mutationId: actionId },
      edit: {
        kind: 'annotation.apply',
        annotation,
        from: { positionToken: auth.documentPositionToken, offset: fromOffset, affinity: 'left' },
        to: { positionToken: auth.documentPositionToken, offset: toOffset, affinity: 'right' },
      },
    },
  });
}

async function deleteRange(ctx, actionId, fromOffset, toOffset, auth) {
  return ctx.app.dispatch({
    actionId, principal: { id: 'u1' }, scope: ctx.scope,
    type: 'FoldDispositionDoc.body.operation',
    payload: {
      version: 9, id: 'd1',
      authoring: { version: 1, stream: auth.streamToken, lease: auth.leaseToken, mutationId: actionId },
      edit: {
        kind: 'text.delete',
        from: { positionToken: auth.documentPositionToken, offset: fromOffset, affinity: 'left' },
        to: { positionToken: auth.documentPositionToken, offset: toOffset, affinity: 'right' },
      },
    },
  });
}

async function insertAt(ctx, actionId, offset, text, auth) {
  return ctx.app.dispatch({
    actionId, principal: { id: 'u1' }, scope: ctx.scope,
    type: 'FoldDispositionDoc.body.operation',
    payload: {
      version: 9, id: 'd1',
      authoring: { version: 1, stream: auth.streamToken, lease: auth.leaseToken, mutationId: actionId },
      edit: {
        kind: 'text.insert',
        at: { positionToken: auth.documentPositionToken, offset, affinity: 'right' },
        text,
      },
    },
  });
}

function lastOperatedEvent(db) {
  const events = db.prepare(`SELECT * FROM _Log WHERE eventType = 'FoldDispositionDoc.body.operated' ORDER BY seq`).all();
  return events[events.length - 1];
}

async function buildFold(ctx, event, principalId = 'u1') {
  const document = {
    entity: ctx.Doc, fieldName: 'body', descriptor: ctx.Doc.fields.body,
    documentId: 'd1', clientNonce: 'x'.repeat(43),
  };
  return tryBuildAnnotatedTextFoldEnvelopes(
    { event: { ...event, data: JSON.parse(event.eventData) }, scope: ctx.scope, principal: { id: principalId }, db: ctx.db, document },
    { db: ctx.db, document },
  );
}

async function ownerRecipient(ctx) {
  const row = ctx.db.prepare('SELECT * FROM FoldDispositionDoc WHERE id = ?').get('d1');
  return projectAnnotatedTextSnapshot({
    db: ctx.db, entity: ctx.Doc, row, principal: { id: 'u1' },
    fieldName: 'body', descriptor: ctx.Doc.fields.body, mintBasis: false,
  });
}

function ownerFamily(ctx) {
  return restoreTextFamily(JSON.parse(
    ctx.db.prepare("SELECT family_checkpoint FROM FoldDispositionDoc_body_state WHERE document_id = 'd1'").get().family_checkpoint,
  ));
}

function materializeOwner(ctx, recipient) {
  return materializeAnnotatedTextSnapshot(recipient, ctx.Doc.body, { family: ownerFamily(ctx) });
}

async function buildFoldWithNonce(ctx, event, clientNonce) {
  const document = {
    entity: ctx.Doc, fieldName: 'body', descriptor: ctx.Doc.fields.body,
    documentId: 'd1', clientNonce,
  };
  return tryBuildAnnotatedTextFoldEnvelopes(
    { event: { ...event, data: JSON.parse(event.eventData) }, scope: ctx.scope, principal: { id: 'u1' }, db: ctx.db, document },
    { db: ctx.db, document },
  );
}

test('an emptied orphan-policy annotation ships its server disposition and saved quote in the fold', async (t) => {
  const ctx = await setup();
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });

  const auth0 = await binding(ctx, 'u1');
  const themed = await applyRange(ctx, 'theme', { id: 'comment-1', family: 'comment', fields: {} }, 6, 11, auth0);
  assert.equal(themed.ok, true, themed.failure?.message);

  const auth1 = await binding(ctx, 'u1');
  const deleted = await deleteRange(ctx, 'empty-comment', 6, 11, auth1);
  assert.equal(deleted.ok, true, deleted.failure?.message);

  const envelopes = await buildFold(ctx, lastOperatedEvent(ctx.db));
  assert.equal(envelopes[0].type, 'event');
  assert.equal(envelopes[0].fold.kind, 'annotatedText');
  assert.deepEqual(envelopes[0].fold.dispositions, [{
    annotationId: 'comment-1', kind: 'orphaned', family: 'comment', savedQuote: 'world',
  }]);

  // The disposition mirrors exactly what a fresh authorized snapshot discloses.
  const recipient = await ownerRecipient(ctx);
  assert.deepEqual(recipient.orphans, [{
    id: 'comment-1', family: 'comment', fields: {}, owner: 'u1', savedQuote: 'world',
  }]);
  assert.deepEqual(recipient.ranges, []);
  assert.deepEqual(recipient.annotations, []);
});

test('an annotation-only operated event delivers an atomic recipient state instead of resync', async (t) => {
  const ctx = await setup();
  const owned = createOwnedLiveDelivery({
    db: ctx.db,
    entities: ctx.app.entities,
    mayVerb: async () => true,
  });
  t.after(async () => { await owned.close(); await ctx.app.shutdown(); ctx.db.close(); });

  const delivered = [];
  const controller = new AbortController();
  const boundDoc = ctx.app.entities.get('FoldDispositionDoc');
  const document = {
    scope: ctx.scope, entity: boundDoc, fieldName: 'body', descriptor: boundDoc.fields.body,
    documentId: 'd1', clientNonce: 'x'.repeat(43),
  };
  const activation = await owned.delivery.subscribe({
    principal: { type: 'user', id: 'u1' }, scope: ctx.scope,
    after: ctx.db.prepare('SELECT lastSeq FROM _Cursor WHERE scope = ?').get(ctx.scope).lastSeq,
    signal: controller.signal, document,
    deliver: async (batch) => delivered.push(...batch),
  });
  await activation.activate();

  const auth = await binding(ctx, 'u1');
  const applied = await applyRange(ctx, 'annotation-state', { id: 'comment-1', family: 'comment', fields: {} }, 0, 5, auth);
  assert.equal(applied.ok, true, applied.failure?.message);
  const event = lastOperatedEvent(ctx.db);
  await owned.consumer([{
    scope: event.scope, eventType: event.eventType, seq: event.seq,
    data: JSON.parse(event.eventData), actionId: event.actionId, committedAt: event.committedAt,
  }]);
  for (let attempt = 0; delivered.length === 0 && attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].type, 'state');
  assert.equal(delivered[0].seq, event.seq);
  assert.equal(delivered[0].state.body.annotations[0].id, 'comment-1');
  assert.equal(delivered[0].authoring.acknowledgementFence, event.seq);
  assert.ok(delivered[0].authoring.family, 'fully visible recipients receive the matching family checkpoint');
  assert.equal(delivered.some((envelope) => envelope.type === 'resync'), false);
  controller.abort();
});

test('an emptied delete-policy annotation ships a deleted disposition', async (t) => {
  const ctx = await setup();
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });

  const auth0 = await binding(ctx, 'u1');
  const marked = await applyRange(ctx, 'mark', { id: 'mark-1', family: 'mark', fields: {} }, 0, 5, auth0);
  assert.equal(marked.ok, true, marked.failure?.message);

  const auth1 = await binding(ctx, 'u1');
  const deleted = await deleteRange(ctx, 'empty-mark', 0, 5, auth1);
  assert.equal(deleted.ok, true, deleted.failure?.message);

  const envelopes = await buildFold(ctx, lastOperatedEvent(ctx.db));
  assert.equal(envelopes[0].type, 'event');
  assert.deepEqual(envelopes[0].fold.dispositions, [{
    annotationId: 'mark-1', kind: 'deleted', family: 'mark',
  }]);

  const recipient = await ownerRecipient(ctx);
  assert.deepEqual(recipient.orphans, []);
  assert.deepEqual(recipient.annotations, []);
  assert.deepEqual(recipient.ranges, []);
});

test('a fold for an edit that empties nothing ships an empty dispositions array', async (t) => {
  const ctx = await setup();
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });

  const auth0 = await binding(ctx, 'u1');
  const themed = await applyRange(ctx, 'theme', { id: 'comment-1', family: 'comment', fields: {} }, 6, 11, auth0);
  assert.equal(themed.ok, true, themed.failure?.message);

  const auth1 = await binding(ctx, 'u1');
  const inserted = await insertAt(ctx, 'grow', 0, 'pre ', auth1);
  assert.equal(inserted.ok, true, inserted.failure?.message);

  const envelopes = await buildFold(ctx, lastOperatedEvent(ctx.db));
  assert.equal(envelopes[0].type, 'event');
  assert.deepEqual(envelopes[0].fold.dispositions, []);
});

test('an edit that empties a protecting-family annotation falls back to snapshot recovery (no fold)', async (t) => {
  const ctx = await setup();
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });

  const auth0 = await binding(ctx, 'u1');
  const marked = await applyRange(ctx, 'mark', { id: 'mark-1', family: 'mark', fields: {} }, 0, 5, auth0);
  assert.equal(marked.ok, true, marked.failure?.message);
  const auth1 = await binding(ctx, 'u1');
  const protectedAnn = await applyRange(
    ctx, 'confidential',
    { id: 'conf-1', family: 'confidential', fields: {}, protectedTargetIds: ['mark-1'] },
    0, 5, auth1,
  );
  assert.equal(protectedAnn.ok, true, protectedAnn.failure?.message);

  // Deleting the range empties BOTH the protected target and its protector.
  const auth2 = await binding(ctx, 'u1');
  const deleted = await deleteRange(ctx, 'empty-protected', 0, 5, auth2);
  assert.equal(deleted.ok, true, deleted.failure?.message);

  // Even the fully-visible owner must not receive a fold: this edit could have
  // un-redacted a previously-denied recipient, and the fold's dispositions
  // would disclose annotations that recipient was never entitled to see.
  const ownerEnvelopes = await buildFold(ctx, lastOperatedEvent(ctx.db), 'u1');
  assert.equal(ownerEnvelopes[0].type, 'resync');
  assert.equal('fold' in ownerEnvelopes[0], false);
});

test('a denied-protector recipient never receives a fold or dispositions', async (t) => {
  const ctx = await setup();
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });

  const auth0 = await binding(ctx, 'u1');
  const marked = await applyRange(ctx, 'mark', { id: 'mark-1', family: 'mark', fields: {} }, 0, 5, auth0);
  assert.equal(marked.ok, true, marked.failure?.message);
  const auth1 = await binding(ctx, 'u1');
  const protectedAnn = await applyRange(
    ctx, 'confidential',
    { id: 'conf-1', family: 'confidential', fields: {}, protectedTargetIds: ['mark-1'] },
    0, 5, auth1,
  );
  assert.equal(protectedAnn.ok, true, protectedAnn.failure?.message);

  // u2 is denied the protector, so its pre-edit view is redacted; the fold
  // gate (and the protecting-family fallback) must keep every fold path closed.
  const auth2 = await binding(ctx, 'u1');
  const deleted = await deleteRange(ctx, 'empty-protected', 0, 5, auth2);
  assert.equal(deleted.ok, true, deleted.failure?.message);

  const deniedEnvelopes = await buildFold(ctx, lastOperatedEvent(ctx.db), 'u2');
  assert.equal(deniedEnvelopes[0].type, 'resync');
  assert.equal('fold' in deniedEnvelopes[0], false);

  // u2's authorized snapshot also discloses none of the emptied annotations:
  // the protected target never showed through its redaction, and the protector
  // was never disclosed at all.
  const row = ctx.db.prepare('SELECT * FROM FoldDispositionDoc WHERE id = ?').get('d1');
  const deniedRecipient = await projectAnnotatedTextSnapshot({
    db: ctx.db, entity: ctx.Doc, row, principal: { id: 'u2' },
    fieldName: 'body', descriptor: ctx.Doc.fields.body, mintBasis: false,
  });
  assert.equal(deniedRecipient.restricted ?? false, false);
  assert.deepEqual(deniedRecipient.annotations, []);
  assert.deepEqual(deniedRecipient.ranges, []);
  assert.deepEqual(deniedRecipient.orphans, []);
});

// ---------------------------------------------------------------------------
// Integrated client-session test: the fold envelope fed through the session is
// REAL `tryBuildAnnotatedTextFoldEnvelopes` output over committed event facts
// (never a hand-built envelope), and the session's materialized state must be
// exactly a fresh authorized server snapshot after each fold — for an OWN echo
// (optimistic placeholder resolved by the dispositions) and for a FOREIGN event
// alike. Pre-existing orphan ids sort before/after the new orphan id, proving
// the folded `orphans` is the server's canonical id-ascending order.
// ---------------------------------------------------------------------------

test('integrated: real fold envelopes reconcile own echo and foreign events to the fresh authorized snapshot', async (t) => {
  // "one two three four five six" — four words survive setup as active text:
  // 'three' (m-del, delete policy), 'four' (m-new, orphan policy), 'five'
  // (f-orph, orphan policy); 'one' and 'two' become pre-existing orphans
  // a-old / z-old BEFORE the session bootstraps. Deleting a word plus its
  // following space keeps every later delete window exact (no shared boundary
  // character), so the client's fold range projection equals the server's.
  const ctx = await setup('one two three four five six');
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });

  let auth = await binding(ctx);
  assert.equal((await applyRange(ctx, 'a-old-apply', { id: 'a-old', family: 'comment', fields: {} }, 0, 4, auth)).ok, true);
  auth = await binding(ctx);
  assert.equal((await deleteRange(ctx, 'a-old-delete', 0, 4, auth)).ok, true);
  auth = await binding(ctx);
  assert.equal((await applyRange(ctx, 'z-old-apply', { id: 'z-old', family: 'comment', fields: {} }, 0, 4, auth)).ok, true);
  auth = await binding(ctx);
  assert.equal((await deleteRange(ctx, 'z-old-delete', 0, 4, auth)).ok, true);
  auth = await binding(ctx);
  assert.equal((await applyRange(ctx, 'm-del-apply', { id: 'm-del', family: 'mark', fields: {} }, 0, 5, auth)).ok, true);
  auth = await binding(ctx);
  assert.equal((await applyRange(ctx, 'm-new-apply', { id: 'm-new', family: 'comment', fields: {} }, 6, 10, auth)).ok, true);
  auth = await binding(ctx);
  assert.equal((await applyRange(ctx, 'f-orph-apply', { id: 'f-orph', family: 'comment', fields: {} }, 11, 15, auth)).ok, true);

  // The pre-edit authorized snapshot is the comparison oracle throughout.
  const freshBefore = materializeOwner(ctx, await ownerRecipient(ctx));
  assert.equal(freshBefore.text, 'three four five six');
  assert.deepEqual(freshBefore.orphans.map((orphan) => orphan.id), ['a-old', 'z-old']);

  // Bootstrap the client session against the REAL server projection, minting
  // authoring for the client's own random authoringClient nonce so the client's
  // actions and every later real fold envelope resolve the same lease.
  const sources = [];
  let clientNonce;
  let bootstrapCursor;
  let releaseOwnEchoReceipt;
  const ownEchoReceipt = new Promise((resolve) => { releaseOwnEchoReceipt = resolve; });
  const session = createAnnotatedTextHttpSession({
    baseUrl: 'https://example.test/live-delivery',
    context: { entity: ctx.Doc, field: ctx.Doc.body, documentId: 'd1' },
    historySession: 'tab-a', createActionId: () => 'client-own-echo',
    fetchImpl: async (url, options) => {
      if (options?.method === 'POST') {
        if (url.includes('/authoring/ack')) {
          return { ok: true, status: 200, json: async () => ({ ok: true, acknowledgedThrough: bootstrapCursor }) };
        }
        const body = JSON.parse(options.body);
        const result = await ctx.app.dispatch({
          actionId: body.actionId, type: body.type, payload: body.payload,
          scope: ctx.scope, principal: { id: 'u1' },
        });
        assert.equal(result.ok, true, result.failure?.message);
        // Hold the sender receipt until the real fold echo has been delivered
        // so the settlement resolves through the fold, not the grace-timed
        // snapshot fallback.
        await ownEchoReceipt;
        return { ok: true, status: 200, json: async () => ({ ok: true, actionId: result.resultData.actionId, confirmedThrough: result.resultData.confirmedThrough }) };
      }
      const parsed = new URL(url);
      clientNonce = parsed.searchParams.get('authoringClient');
      assert.match(clientNonce, /^[A-Za-z0-9_-]{43}$/);
      const row = ctx.db.prepare('SELECT * FROM FoldDispositionDoc WHERE id = ?').get('d1');
      const prefix = 'FoldDispositionDoc_body';
      const stream = ensureStream({ db: ctx.db, prefix, documentId: 'd1', principalType: 'principal', principalId: 'u1' });
      const lease = ensureLease({ db: ctx.db, prefix, streamId: stream.id, clientNonceHash: hashClientNonce(clientNonce) });
      // The real delivery seam pairs the snapshot with the scope's committed log
      // head as the authoring fence (live-delivery-public.mjs bootstrap), which
      // is exactly the cursor the next fold's `fence`/`baseCursor` continue from.
      const fence = ctx.db.prepare('SELECT lastSeq FROM _Cursor WHERE scope = ?').get('Project:p1')?.lastSeq ?? 0;
      const snapshot = await projectAnnotatedTextSnapshot({
        db: ctx.db, entity: ctx.Doc, row, principal: { id: 'u1' },
        fieldName: 'body', descriptor: ctx.Doc.fields.body,
        authoring: { streamToken: stream.id, leaseToken: lease.id, leaseId: lease.id, clientNonceHash: hashClientNonce(clientNonce), fence },
      });
      bootstrapCursor = snapshot.authoring.acknowledgementFence;
      const { authoring, ...body } = snapshot;
      return { ok: true, status: 200, json: async () => ({ kind: 'snapshot', snapshot: { body }, cursor: bootstrapCursor, authoring }) };
    },
    eventSourceFactory: () => {
      const source = { close() {}, onmessage: null, onerror: null };
      sources.push(source);
      return source;
    },
  });
  await session.ready;
  assert.equal(session.document.text, 'three four five six');
  assert.deepEqual(session.document.orphans.map((orphan) => orphan.id), ['a-old', 'z-old']);

  // OWN ECHO with optimistic placeholder. The client optimistically splices
  // the delete of 'three four' (0..11) and leaves the emptied ranges COLLAPSED
  // but attached — disposition-neutral, no pruning, no policy inference.
  const pendingDelete = session.delete({ mutationId: 'ph-a', from: { offset: 0, affinity: 'right' }, to: { offset: 11, affinity: 'left' } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(session.document.text, 'five six');
  const collapsed = session.document.ranges.filter((range) => {
    const start = typeof range.start === 'number' ? range.start : projectEndpointToOffset(session.family, range.start);
    const end = typeof range.end === 'number' ? range.end : projectEndpointToOffset(session.family, range.end);
    return start >= end;
  }).map((range) => range.annotationId).sort();
  assert.deepEqual(collapsed, ['m-del', 'm-new'], 'the optimistic placeholder keeps emptied ranges attached and zero-width');
  assert.deepEqual(session.document.ranges.map((range) => range.annotationId).sort(), ['f-orph', 'm-del', 'm-new']);

  // Build the fold from the REAL committed event facts and deliver the exact
  // envelope through the session's SSE source.
  const ownEchoEvent = lastOperatedEvent(ctx.db);
  const ownEchoEnvelope = await buildFoldWithNonce(ctx, ownEchoEvent, clientNonce);
  assert.equal(ownEchoEnvelope[0].type, 'event');
  assert.equal(ownEchoEnvelope[0].event.actionId, 'client-own-echo');
  assert.deepEqual([...ownEchoEnvelope[0].fold.dispositions].sort((a, b) => a.annotationId.localeCompare(b.annotationId)), [
    { annotationId: 'm-del', kind: 'deleted', family: 'mark' },
    { annotationId: 'm-new', kind: 'orphaned', family: 'comment', savedQuote: 'four' },
  ]);
  sources[0].onmessage({ data: JSON.stringify(ownEchoEnvelope) });
  releaseOwnEchoReceipt();
  const ownResult = await pendingDelete;
  assert.equal(ownResult.ok, true);
  assert.equal((await ownResult.settlement.wait()).status, 'reconciled');
  assert.equal(session.document.text, 'five six');

  // The folded document is EXACTLY a fresh authorized snapshot: the delete
  // policy dropped m-del, the orphan policy kept m-new, and the combined
  // orphan list is the canonical id-ascending order with the new orphan
  // BETWEEN the pre-existing a-old and z-old.
  const freshAfterOwn = materializeOwner(ctx, await ownerRecipient(ctx));
  assert.equal(freshAfterOwn.text, 'five six');
  assert.deepEqual(freshAfterOwn.orphans.map((orphan) => orphan.id), ['a-old', 'm-new', 'z-old']);
  assert.equal(session.document.text, freshAfterOwn.text);
  assert.deepEqual(session.document.ranges, freshAfterOwn.ranges);
  assert.deepEqual(session.document.annotations, freshAfterOwn.annotations);
  assert.deepEqual(session.document.orphans, freshAfterOwn.orphans);
  assert.deepEqual(session.document.measurements, freshAfterOwn.measurements);

  // FOREIGN event: a separate real edit (committed through the app, not the
  // client) whose real fold envelope resolves the still-active f-orph.
  const foreignAuth = await binding(ctx);
  assert.equal((await deleteRange(ctx, 'foreign-del', 0, 5, foreignAuth)).ok, true);
  const foreignEnvelope = await buildFoldWithNonce(ctx, lastOperatedEvent(ctx.db), clientNonce);
  assert.equal(foreignEnvelope[0].type, 'event');
  assert.equal(foreignEnvelope[0].event.actionId, 'foreign-del');
  assert.deepEqual(foreignEnvelope[0].fold.dispositions, [
    { annotationId: 'f-orph', kind: 'orphaned', family: 'comment', savedQuote: 'five' },
  ]);
  sources[0].onmessage({ data: JSON.stringify(foreignEnvelope) });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const freshAfterForeign = materializeOwner(ctx, await ownerRecipient(ctx));
  assert.equal(freshAfterForeign.text, 'six');
  assert.deepEqual(freshAfterForeign.orphans.map((orphan) => orphan.id), ['a-old', 'f-orph', 'm-new', 'z-old']);
  assert.equal(session.document.text, freshAfterForeign.text);
  assert.deepEqual(session.document.ranges, freshAfterForeign.ranges);
  assert.deepEqual(session.document.annotations, freshAfterForeign.annotations);
  assert.deepEqual(session.document.orphans, freshAfterForeign.orphans);
  assert.deepEqual(session.document.measurements, freshAfterForeign.measurements);
  session.close();
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  annotatedText, annotation, text, entity, everyone, executeDDL, executeFrameworkDDL,
  protectingAnnotation, grant, admin, read, write, ref, scope,
} from '../build/internal.mjs';
import { materializeText, restoreTextFamily } from '../build/annotated-text-continuous.mjs';
import { projectAnnotatedTextSnapshot } from '../build/internal.mjs';
import { durableHistory } from '../build/internal.mjs';
import { withAuthoringBinding } from './annotated-text-authoring-fixture.mjs';

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
  assert.equal(created.ok, true, created.failure?.message);
  return { app, db, UCDoc, scope: 'Project:p1' };
}

async function issueAuthoringSnapshot(ctx, principalId) {
  const { db, UCDoc } = ctx;
  const row = db.prepare('SELECT * FROM UCDoc WHERE id = ?').get('d1');
  const binding = await withAuthoringBinding({
    db, entity: UCDoc, Document: UCDoc, row,
    principal: { id: principalId }, fieldName: 'body', descriptor: UCDoc.fields.body,
  });
  return binding.snapshot;
}

// Plain recipient projection with no authoring envelope (works for any
// principal; the redaction view is what we assert on for the unauthorized user).
async function recipientSnapshot(ctx, principalId) {
  const { db, UCDoc } = ctx;
  const row = db.prepare('SELECT * FROM UCDoc WHERE id = ?').get('d1');
  return projectAnnotatedTextSnapshot({
    db, entity: UCDoc, row, principal: { id: principalId }, fieldName: 'body', descriptor: UCDoc.fields.body,
  });
}

async function dispatchTextInsert(ctx, actionId, principalId, session, offset, textValue) {
  const row = ctx.db.prepare('SELECT * FROM UCDoc WHERE id = ?').get('d1');
  const binding = await withAuthoringBinding({
    db: ctx.db, entity: ctx.UCDoc, Document: ctx.UCDoc, row,
    principal: { id: principalId }, fieldName: 'body', descriptor: ctx.UCDoc.fields.body,
  });
  return ctx.app.dispatch({
    actionId, principal: { id: principalId }, scope: ctx.scope, history: { session },
    type: 'UCDoc.body.operation',
    payload: {
      version: 9, id: 'd1',
      authoring: { version: 1, stream: binding.streamToken, lease: binding.leaseToken, mutationId: actionId },
      edit: { kind: 'text.insert', at: { positionToken: binding.documentPositionToken, offset, affinity: 'right' }, text: textValue },
    },
  });
}

async function applyAnnotationSpan(ctx, actionId, annotationValue, fromOffset, toOffset) {
  const row = ctx.db.prepare('SELECT * FROM UCDoc WHERE id = ?').get('d1');
  const binding = await withAuthoringBinding({
    db: ctx.db, entity: ctx.UCDoc, Document: ctx.UCDoc, row,
    principal: { id: 'u1' }, fieldName: 'body', descriptor: ctx.UCDoc.fields.body,
  });
  return ctx.app.dispatch({
    actionId, principal: { id: 'u1' }, scope: ctx.scope,
    type: 'UCDoc.body.operation',
    payload: {
      version: 9, id: 'd1',
      authoring: { version: 1, stream: binding.streamToken, lease: binding.leaseToken, mutationId: actionId },
      edit: {
        kind: 'annotation.apply',
        annotation: annotationValue,
        from: { positionToken: binding.documentPositionToken, offset: fromOffset, affinity: 'left' },
        to: { positionToken: binding.documentPositionToken, offset: toOffset, affinity: 'right' },
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
  return materializeText(restoreTextFamily(JSON.parse(state.family_checkpoint)));
}

test('undo of a text insert inside a confidential span never leaks to an unauthorized recipient', async (t) => {
  const ctx = await setup();
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });

  // Seed "hello secret world", then protect the "secret" span (offsets 6..12).
  const inserted = await dispatchTextInsert(ctx, 'seed', 'u1', 'tab-u1', 0, 'hello secret world');
  assert.equal(inserted.ok, true, inserted.failure?.message);

  const themed = await applyAnnotationSpan(ctx, 'theme-apply', { id: 'theme-1', family: 'theme', fields: { color: 'red' } }, 0, 17);
  assert.equal(themed.ok, true, themed.failure?.message);
  const protectedResult = await applyAnnotationSpan(ctx, 'protect', { id: 'protect-1', family: 'confidential', fields: {}, protectedTargetIds: ['theme-1'] }, 6, 12);
  assert.equal(protectedResult.ok, true, protectedResult.failure?.message);

  // Insert text inside the protected span (authorized owner inserts "X" at 8).
  const insertedInside = await dispatchTextInsert(ctx, 'insert-inside', 'u1', 'tab-u1', 8, 'X');
  assert.equal(insertedInside.ok, true, insertedInside.failure?.message);
  assert.equal(durableText(ctx), 'hello seXcret world');

  // Unauthorized recipient (u2, not owner) sees the span redacted BEFORE undo.
  // Either presentation is acceptable as long as the secret never leaks: a
  // range redaction marker, or a whole-document restricted fallback.
  const deniedView = await recipientSnapshot(ctx, 'u2');
  assert.equal(deniedView.kind, 'workbench.annotatedText.recipient');
  assert.ok(deniedView.restricted === true || (Array.isArray(deniedView.redactions) && deniedView.redactions.length >= 1));
  assert.equal(JSON.stringify(deniedView).includes('secret'), false);
  assert.equal(JSON.stringify(deniedView).includes('seXcret'), false);

  // Undo the insert inside the span (as the owner). The exact effect of undo on
  // the text is #13's concern; the #28 property is that it never leaks. Accept
  // either the X removed or a no-op, but never a leak.
  const undone = await undoLast(ctx, 'u1', 'tab-u1');
  assert.equal(undone.ok, true, undone.failure?.message);

  // The compensation fact must carry the BLOCKLESS contribution shape:
  // { kind: 'text.insert', opId, anchor, text, scalarCount } with NO blockId.
  const undoFact = JSON.parse(ctx.db.prepare("SELECT fact FROM _PrivateActionFact ORDER BY originOrder DESC LIMIT 1").get().fact);
  assert.equal(undoFact.kind, 'annotated-text.compensation');
  assert.equal(undoFact.contribution.kind, 'text.insert');
  assert.ok(Array.isArray(undoFact.contribution.opId));
  assert.ok(Array.isArray(undoFact.contribution.anchor));
  assert.equal(typeof undoFact.contribution.text, 'string');
  assert.ok(Number.isSafeInteger(undoFact.contribution.scalarCount));
  assert.equal('blockId' in undoFact.contribution, false);

  // After undo, the unauthorized recipient STILL never sees the secret.
  const deniedAfter = await recipientSnapshot(ctx, 'u2');
  assert.equal(deniedAfter.kind, 'workbench.annotatedText.recipient');
  assert.ok(deniedAfter.restricted === true || (Array.isArray(deniedAfter.redactions) && deniedAfter.redactions.length >= 1));
  assert.equal(JSON.stringify(deniedAfter).includes('secret'), false);
  assert.equal(JSON.stringify(deniedAfter).includes('seXcret'), false);

  // Authorized owner sees the real continuous text (redaction is projection-only).
  const ownerView = await issueAuthoringSnapshot(ctx, 'u1');
  assert.ok(typeof ownerView.text === 'string' && ownerView.text.includes('secret'));
  assert.equal(JSON.stringify(ownerView).includes('secret'), true);
  assert.equal(Object.hasOwn(ownerView, 'redactions'), false);
  assert.equal(ownerView.restricted, undefined);
});

test('authorized and unauthorized recipients converge on the same durable document', async (t) => {
  const ctx = await setup();
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });

  const seed = await dispatchTextInsert(ctx, 'seed', 'u1', 'tab-u1', 0, 'hello secret world');
  assert.equal(seed.ok, true, seed.failure?.message);

  const themed = await applyAnnotationSpan(ctx, 'theme-apply', { id: 'theme-1', family: 'theme', fields: { color: 'red' } }, 0, 17);
  assert.equal(themed.ok, true, themed.failure?.message);
  const protectedResult = await applyAnnotationSpan(ctx, 'protect', { id: 'protect-1', family: 'confidential', fields: {}, protectedTargetIds: ['theme-1'] }, 6, 12);
  assert.equal(protectedResult.ok, true, protectedResult.failure?.message);

  // Unauthorized user edits the surrounding prefix text (before the span).
  const deniedEdit = await dispatchTextInsert(ctx, 'denied-edit', 'u2', 'tab-u2', 0, '> ');
  assert.equal(deniedEdit.ok, true, deniedEdit.failure?.message);

  // Authorized owner edits inside the protected span after the prefix landed.
  // Absolute offsets are document-scoped: "> hello secr|et world" → offset 12.
  const ownerEdit = await dispatchTextInsert(ctx, 'owner-edit', 'u1', 'tab-u1', 12, 'X');
  assert.equal(ownerEdit.ok, true, ownerEdit.failure?.message);

  // Durable document reflects BOTH edits (converged, redaction is projection-only).
  assert.equal(durableText(ctx), '> hello secrXet world');

  // Authorized recipient sees the full continuous text.
  const ownerView = await issueAuthoringSnapshot(ctx, 'u1');
  assert.equal(ownerView.text, '> hello secrXet world');

  // Unauthorized recipient sees redacted text that never contains the secret.
  const deniedView = await recipientSnapshot(ctx, 'u2');
  assert.equal(deniedView.kind, 'workbench.annotatedText.recipient');
  assert.ok(deniedView.restricted === true || (Array.isArray(deniedView.redactions) && deniedView.redactions.length >= 1));
  assert.equal(JSON.stringify(deniedView).includes('secret'), false);
  assert.equal(JSON.stringify(deniedView).includes('seXcret'), false);
  assert.equal(JSON.stringify(deniedView).includes('secrXet'), false);
});

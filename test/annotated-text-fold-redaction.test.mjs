import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  annotatedText, annotation, entity, everyone, executeDDL, executeFrameworkDDL,
  protectingAnnotation, grant, admin, read, write, ref, scope,
} from '../src/internal.mjs';
import { durableHistory } from '../src/internal.mjs';
import { tryBuildAnnotatedTextFoldEnvelopes } from '../src/annotated-text-fold-envelope.mjs';
import { withAuthoringBinding } from './annotated-text-authoring-fixture.mjs';

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
  // Continuous document: confidential span + visible tail (no block table).
  const created = await app.dispatch({
    actionId: 'create', type: 'FoldRedactDoc.create',
    payload: {
      id: 'd1', project: 'p1', owner: 'u1',
      body: { version: 1, blocks: [{ text: 'SECRET alpha visible beta' }] },
    },
    principal: { id: 'u1' },
  });
  assert.equal(created.ok, true, created.failure?.message);
  return { app, db, Doc, Project, scope: 'Project:p1' };
}

async function binding(ctx, principalId = 'u1') {
  const row = ctx.db.prepare('SELECT * FROM FoldRedactDoc WHERE id = ?').get('d1');
  return withAuthoringBinding({
    db: ctx.db, entity: ctx.Doc, Document: ctx.Doc, row,
    principal: { id: principalId }, fieldName: 'body', descriptor: ctx.Doc.fields.body,
  });
}

async function applyRange(ctx, actionId, annotation, fromOffset, toOffset, auth) {
  return ctx.app.dispatch({
    actionId, principal: { id: 'u1' }, scope: ctx.scope,
    type: 'FoldRedactDoc.body.operation',
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

async function insertAt(ctx, actionId, offset, text, auth, session) {
  return ctx.app.dispatch({
    actionId, principal: { id: 'u1' }, scope: ctx.scope, history: { session },
    type: 'FoldRedactDoc.body.operation',
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

function committedOperatedEvents(db) {
  return db.prepare(`SELECT * FROM _Log WHERE eventType = 'FoldRedactDoc.body.operated' ORDER BY seq`).all();
}

test('a recipient with any confidential span never receives a fold envelope (no raw family leak)', async (t) => {
  const ctx = await setup();
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });

  // Theme + protect the confidential prefix ("SECRET alpha", 12 chars).
  const auth0 = await binding(ctx, 'u1');
  const themed = await applyRange(ctx, 'theme', { id: 'theme-1', family: 'theme', fields: {} }, 0, 12, auth0);
  assert.equal(themed.ok, true, themed.failure?.message);
  const auth1 = await binding(ctx, 'u1');
  const protect = await applyRange(
    ctx, 'protect',
    { id: 'protect-1', family: 'confidential', fields: {}, protectedTargetIds: ['theme-1'] },
    0, 12, auth1,
  );
  assert.equal(protect.ok, true, protect.failure?.message);

  // Edit the VISIBLE tail. The affected range is fully visible, so a naive
  // affected-only gate would emit a fold — but a redacted recipient never
  // receives a family seed, so it must get a resync, not a fold.
  const auth2 = await binding(ctx, 'u1');
  const edited = await insertAt(ctx, 'edit-visible', 13, 'x', auth2, 'tab-u1');
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
  assert.equal(owner[0].fold?.version, 3);
  assert.equal(typeof owner[0].fold?.projection?.text, 'string');
  assert.match(owner[0].fold.projection.text, /x/);
});

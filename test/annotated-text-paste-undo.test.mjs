// Atomic annotation.paste undo/redo — dispatch-level test.
//
// A paste commits ONE operated event carrying both the text insert and the
// fresh annotation postimage. Undo must remove the pasted text AND the created
// annotation in one step; redo must restore both under the same annotation id.
// A drifted live annotation (collaborator field change) makes undo a durable
// no-op instead of a partial restore.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  annotatedText, annotation, durableHistory, entity, everyone, executeDDL, executeFrameworkDDL,
  grant, read, ref, scope, write,
} from '../build/internal.mjs';
import { createdAnnotationFromMarker } from '../build/entity/crud.mjs';
import { materializeText, restoreTextFamily } from '../build/annotated-text-continuous.mjs';
import { withAuthoringBinding } from './annotated-text-authoring-fixture.mjs';

const SCOPE = 'Project:p1';
const ALICE = { type: 'user', id: 'alice' };
const PREFIX = 'PasteDoc_body';

function declaration() {
  const Project = entity('Project', {
    owner: ref('User'),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
  const Document = entity('PasteDoc', {
    project: ref('Project'),
    owner: ref('User'),
    body: annotatedText({
      project: 'project', owner: 'owner',
      annotations: [annotation('coding')],
    }).can(() => grant(read, write)),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
  return { Project, Document };
}

async function setup() {
  const db = new DatabaseSync(':memory:');
  const { Project, Document } = declaration();
  executeFrameworkDDL(db);
  db.exec("CREATE TABLE User (id TEXT PRIMARY KEY); INSERT INTO User VALUES ('alice')");
  executeDDL(Project, db);
  db.exec("INSERT INTO Project VALUES ('p1', 'alice')");
  executeDDL(Document, db);
  const app = workbench({ db, entities: [Project, Document], history: durableHistory({ authorize: () => true, actions: {} }) });
  await app.start();
  await app.dispatch({
    actionId: 'create', type: 'PasteDoc.create', principal: ALICE,
    payload: { id: 'd1', project: 'p1', owner: 'alice', body: { version: 1, blocks: [{ text: 'hello world' }] } },
  });
  return { app, db, Document: app.entities.get('PasteDoc') };
}

async function bindingFor(ctx) {
  const row = ctx.db.prepare('SELECT * FROM PasteDoc WHERE id = ?').get('d1');
  return withAuthoringBinding({
    db: ctx.db, entity: ctx.Document, Document: ctx.Document, row,
    principal: ALICE, fieldName: 'body', descriptor: ctx.Document.fields.body,
  });
}

async function paste(ctx, actionId, offset, textValue) {
  const binding = await bindingFor(ctx);
  return ctx.app.dispatch({
    actionId, principal: ALICE, scope: SCOPE, history: { session: 'tab-a' },
    type: 'PasteDoc.body.operation',
    payload: {
      version: 9, id: 'd1',
      authoring: { version: 1, stream: binding.streamToken, lease: binding.leaseToken, mutationId: actionId },
      edit: {
        kind: 'annotation.paste',
        annotation: { id: 'coding-1', family: 'coding', fields: {} },
        at: { positionToken: binding.documentPositionToken, offset, affinity: 'right' },
        text: textValue,
      },
    },
  });
}

async function move(ctx, operation, actionId) {
  const cursor = await ctx.app.history.cursor({ scope: SCOPE, principal: ALICE, session: 'tab-a' });
  return ctx.app.history[operation]({ scope: SCOPE, principal: ALICE, session: 'tab-a', actionId, revision: cursor.revision });
}

function durableText(ctx) {
  const state = ctx.db.prepare(`SELECT family_checkpoint FROM ${PREFIX}_state WHERE document_id = 'd1'`).get();
  return materializeText(restoreTextFamily(JSON.parse(state.family_checkpoint)));
}

function annotationIds(ctx) {
  return ctx.db.prepare(`SELECT id FROM ${PREFIX}_annotation WHERE document_id = ? ORDER BY id`).all('d1').map((row) => row.id);
}

test('paste origin fact binds the created annotation; undo removes text and annotation together', async (t) => {
  const c = await setup();
  t.after(() => { c.app.shutdown(); c.db.close(); });

  const pasted = await paste(c, 'paste-1', 6, 'zz');
  assert.equal(pasted.ok, true, pasted.failure?.message);
  assert.equal(durableText(c), 'hello zzworld');
  assert.equal(annotationIds(c).length, 1);
  const createdId = annotationIds(c)[0];

  const originFact = JSON.parse(c.db.prepare("SELECT fact FROM _PrivateActionFact WHERE actionId = 'paste-1'").get().fact);
  assert.equal(originFact.kind, 'annotated-text.contribution');
  assert.equal(originFact.contribution.kind, 'text.insert');
  assert.ok(originFact.contribution.createdAnnotation, 'paste fact binds the created annotation');
  assert.equal(originFact.contribution.createdAnnotation.id, createdId);
  assert.equal(originFact.contribution.createdAnnotation.family, 'coding');

  const undone = await move(c, 'undo', 'paste-1-undo');
  assert.equal(undone.ok, true, undone.failure?.message ?? JSON.stringify(undone));
  assert.equal(durableText(c), 'hello world');
  assert.deepEqual(annotationIds(c), [], 'created annotation removed with its text');
  const undoFact = JSON.parse(c.db.prepare("SELECT fact FROM _PrivateActionFact WHERE actionId = 'paste-1-undo'").get().fact);
  assert.equal(undoFact.kind, 'annotated-text.compensation');
  assert.equal(undoFact.linkage.outcome, 'applied');
  assert.ok(undoFact.contribution.createdAnnotation, 'undo fact propagates the image for redo');
});

test('redo of a paste undo restores the same annotation id over the re-inserted text', async (t) => {
  const c = await setup();
  t.after(() => { c.app.shutdown(); c.db.close(); });

  assert.equal((await paste(c, 'paste-1', 6, 'zz')).ok, true);
  const createdId = annotationIds(c)[0];
  assert.equal((await move(c, 'undo', 'paste-1-undo')).ok, true);
  assert.deepEqual(annotationIds(c), []);

  const redone = await move(c, 'redo', 'paste-1-redo');
  assert.equal(redone.ok, true, redone.failure?.message ?? JSON.stringify(redone));
  assert.equal(durableText(c), 'hello zzworld');
  assert.deepEqual(annotationIds(c), [createdId], 'same annotation identity restored');
  const ranges = c.db.prepare(`SELECT range.start_point AS start_point FROM ${PREFIX}_membership AS membership JOIN ${PREFIX}_range AS range ON range.id = membership.range_id WHERE membership.annotation_id = ?`).all(createdId);
  assert.equal(ranges.length, 1);
});

test('paste undo is a durable no-op when the created annotation drifted', async (t) => {
  const c = await setup();
  t.after(() => { c.app.shutdown(); c.db.close(); });

  assert.equal((await paste(c, 'paste-1', 6, 'zz')).ok, true);
  const createdId = annotationIds(c)[0];
  // A collaborator retargets the annotation outside the history path: direct
  // membership rewrite simulates a concurrent move of the live image.
  c.db.prepare(`DELETE FROM ${PREFIX}_membership WHERE annotation_id = ?`).run(createdId);

  const undone = await move(c, 'undo', 'paste-1-undo-drifted');
  assert.equal(undone.ok, true, undone.failure?.message ?? JSON.stringify(undone));
  assert.deepEqual(undone.events, [], 'noop undo appends nothing');
  assert.equal(c.db.prepare("SELECT historyOutcome FROM _ActionReceipt WHERE actionId = 'paste-1-undo-drifted'").get().historyOutcome, 'noop');
  assert.equal(durableText(c), 'hello zzworld', 'text untouched on no-op');
});

test('createdAnnotationFromMarker binds the marker image without a pre-image', async (t) => {
  void t;
  const marker = {
    kind: 'text-edit-postimage',
    from: 0,
    to: 0,
    annotationIds: ['c1'],
    annotations: [{
      id: 'c1', family: 'coding', fields: {},
      protectedTargetIds: [],
      memberships: [{ ordinal: 0, start: { point: 'p', basisFrontier: [] }, end: { point: 'q', basisFrontier: [] } }],
      empty: 'delete', cardinality: 'many', orphan: null,
    }],
    createdAnnotationId: 'c1',
  };
  const image = createdAnnotationFromMarker(marker, { annotations: [{ annotationName: 'coding', fields: {} }] });
  assert.deepEqual(image, {
    id: 'c1', family: 'coding', fields: {},
    protectedTargetIds: [],
    memberships: [{ ordinal: 0, start: { point: 'p', basisFrontier: [] }, end: { point: 'q', basisFrontier: [] } }],
    empty: 'delete',
  });
  assert.throws(() => createdAnnotationFromMarker({ ...marker, createdAnnotationId: 'missing' }, { annotations: [] }), /no created annotation/);
});

test('paste as the first edit on an empty document undoes atomically', async (t) => {
  const db = new DatabaseSync(':memory:');
  const { Project, Document } = declaration();
  executeFrameworkDDL(db);
  db.exec("CREATE TABLE User (id TEXT PRIMARY KEY); INSERT INTO User VALUES ('alice')");
  executeDDL(Project, db);
  db.exec("INSERT INTO Project VALUES ('p1', 'alice')");
  executeDDL(Document, db);
  const app = workbench({ db, entities: [Project, Document], history: durableHistory({ authorize: () => true, actions: {} }) });
  await app.start();
  t.after(() => { app.shutdown(); db.close(); });
  // Body-less create seeds an empty document with no text contribution.
  await app.dispatch({
    actionId: 'create', type: 'PasteDoc.create', principal: ALICE,
    payload: { id: 'd1', project: 'p1', owner: 'alice' },
  });
  const ctx = { app, db, Document: app.entities.get('PasteDoc') };
  const pasted = await paste(ctx, 'paste-first', 0, 'zz');
  assert.equal(pasted.ok, true, pasted.failure?.message);
  assert.equal(durableText(ctx), 'zz');
  assert.equal(annotationIds(ctx).length, 1);

  const originFact = JSON.parse(db.prepare("SELECT fact FROM _PrivateActionFact WHERE actionId = 'paste-first'").get().fact);
  assert.ok(originFact.contribution.createdAnnotation, 'first-edit paste fact binds the created annotation');

  const undone = await move(ctx, 'undo', 'paste-first-undo');
  assert.equal(undone.ok, true, undone.failure?.message ?? JSON.stringify(undone));
  assert.equal(durableText(ctx), '');
  assert.deepEqual(annotationIds(ctx), [], 'no orphan annotation row survives undo');
});

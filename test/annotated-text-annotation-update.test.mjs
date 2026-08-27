// Semantic atomic annotation-update operation (issue #174).
//
// One continuous RGA document; annotations are document-scoped ranges. Updating
// an existing annotation's fields (and optionally its range) must be ONE
// semantic history step: a single operated event, endpoint basis anchors
// preserved whenever the range is unchanged, Decision 0013 undo/redo applying
// the whole prior/new image in one move, and compare-and-compensate no-ops when
// a collaborator changed the annotation after the forward update.
//
// Covered here through the ordinary dispatch path (real app, real projection):
//   - field-only update emits exactly one annotation.update event; stored
//     range endpoints stay byte-identical (historical basis anchoring,
//     workbench decision 0023)
//   - undo restores ALL prior fields (and range) in ONE step; redo re-applies
//   - range+field update moves endpoints and compensates atomically
//   - updating a nonexistent annotation fails cleanly with no document change
//   - a stale undo (annotation edited concurrently in another history session)
//     is a durable noop: compare-and-compensate never half-restores

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  annotatedText, annotation, durableHistory, entity, everyone, executeDDL, executeFrameworkDDL,
  grant, read, ref, scope, write,
} from '../build/internal.mjs';
import {
  materializeText, projectEndpointToOffset, restoreTextFamily,
} from '../build/annotated-text-continuous.mjs';
import { text as textField } from '../build/field.mjs';
import { withAuthoringBinding } from './annotated-text-authoring-fixture.mjs';

const SCOPE = 'Project:p1';
const ALICE = { type: 'user', id: 'alice' };
const PREFIX = 'UpdateDoc_body';

function declaration() {
  const Project = entity('Project', {
    owner: ref('User'),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
  const Document = entity('UpdateDoc', {
    project: ref('Project'),
    owner: ref('User'),
    body: annotatedText({
      project: 'project', owner: 'owner',
      annotations: [annotation('coding', { empty: 'delete', fields: { label: textField() } })],
    }).can(() => grant(read, write)),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
  return { Project, Document };
}

async function setup(dbPath) {
  const db = new DatabaseSync(dbPath);
  const { Project, Document } = declaration();
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE IF NOT EXISTS User (id TEXT PRIMARY KEY)');
  db.exec("INSERT OR IGNORE INTO User (id) VALUES ('alice')");
  executeDDL(Project, db);
  db.exec("INSERT OR IGNORE INTO Project (id, owner) VALUES ('p1', 'alice')");
  executeDDL(Document, db);
  const app = workbench({
    db,
    entities: [Project, Document],
    history: durableHistory({ authorize: () => true, actions: {} }),
  });
  await app.start();
  const created = await app.dispatch({
    actionId: 'create', type: 'UpdateDoc.create',
    principal: ALICE,
    payload: { id: 'd1', project: 'p1', owner: 'alice', body: { version: 1, blocks: [{ text: 'hello world' }] } },
  });
  assert.equal(created.ok, true, created.failure?.message);
  return { app, db, Document: app.entities.get('UpdateDoc') };
}

function bindingFor(ctx) {
  const row = ctx.db.prepare('SELECT * FROM UpdateDoc WHERE id = ?').get('d1');
  return withAuthoringBinding({
    db: ctx.db, entity: ctx.Document, Document: ctx.Document, row,
    principal: ALICE, fieldName: 'body', descriptor: ctx.Document.fields.body,
  });
}

function authoring(binding, mutationId) {
  return { version: 1, stream: binding.streamToken, lease: binding.leaseToken, mutationId };
}

/** Seed an annotation span over absolute canonical offsets. */
async function applyAnnotationSpan(ctx, actionId, annotationValue, fromOffset, toOffset) {
  const binding = await bindingFor(ctx);
  return ctx.app.dispatch({
    actionId, principal: ALICE, scope: SCOPE,
    type: 'UpdateDoc.body.operation',
    payload: {
      version: 9, id: 'd1',
      authoring: authoring(binding, actionId),
      edit: {
        kind: 'annotation.apply',
        annotation: annotationValue,
        from: { positionToken: binding.documentPositionToken, offset: fromOffset, affinity: 'left' },
        to: { positionToken: binding.documentPositionToken, offset: toOffset, affinity: 'right' },
      },
    },
  });
}

/**
 * Dispatch the issue-#174 atomic update. `fields` is required (the complete
 * declared record); giving fromOffset/toOffset also moves the range.
 */
async function updateAnnotation(ctx, actionId, spec, session = 'tab-a') {
  const binding = await bindingFor(ctx);
  const rangeEdit = spec.fromOffset === undefined && spec.toOffset === undefined ? {} : {
    from: { positionToken: binding.documentPositionToken, offset: spec.fromOffset, affinity: 'left' },
    to: { positionToken: binding.documentPositionToken, offset: spec.toOffset, affinity: 'right' },
  };
  return ctx.app.dispatch({
    actionId, principal: ALICE, scope: SCOPE, history: { session },
    type: 'UpdateDoc.body.operation',
    payload: {
      version: 9, id: 'd1',
      authoring: authoring(binding, actionId),
      edit: { kind: 'annotation.update', annotationId: spec.annotationId, fields: spec.fields, ...rangeEdit },
    },
  });
}

async function move(ctx, operation, actionId, session = 'tab-a') {
  const cursor = await ctx.app.history.cursor({ scope: SCOPE, principal: ALICE, session });
  return ctx.app.history[operation]({ scope: SCOPE, principal: ALICE, session, actionId, revision: cursor.revision });
}

function durableText(ctx) {
  const state = ctx.db.prepare(`SELECT family_checkpoint FROM ${PREFIX}_state WHERE document_id = 'd1'`).get();
  return materializeText(restoreTextFamily(JSON.parse(state.family_checkpoint)));
}

function currentFamily(ctx) {
  const state = ctx.db.prepare(`SELECT family_checkpoint FROM ${PREFIX}_state WHERE document_id = 'd1'`).get();
  return restoreTextFamily(JSON.parse(state.family_checkpoint));
}

function operatedEvents(db) {
  return db.prepare("SELECT * FROM _Log WHERE eventType = 'UpdateDoc.body.operated' ORDER BY seq").all();
}

function latestEventOperation(db) {
  return JSON.parse(operatedEvents(db).at(-1).eventData).operation;
}

/** Stored membership rows joined with interned ranges, endpoint objects parsed. */
function rangeRows(ctx) {
  return ctx.db.prepare(
    `SELECT membership.annotation_id AS annotationId, membership.ordinal AS ordinal, range.start_point AS start_point, range.end_point AS end_point
       FROM ${PREFIX}_membership AS membership
       JOIN ${PREFIX}_range AS range ON range.id = membership.range_id
      ORDER BY membership.annotation_id, membership.ordinal`,
  ).all().map((row) => ({
    annotationId: row.annotationId,
    ordinal: row.ordinal,
    start: JSON.parse(row.start_point),
    end: JSON.parse(row.end_point),
  }));
}

function ownRangeProjection(ctx, rows, annotationId) {
  const family = currentFamily(ctx);
  const own = rows.filter((row) => row.annotationId === annotationId);
  assert.equal(own.length, 1, `expected exactly one range for '${annotationId}'`);
  return {
    start: projectEndpointToOffset(family, own[0].start),
    end: projectEndpointToOffset(family, own[0].end),
  };
}

function annotationFields(ctx, family, annotationId) {
  const row = ctx.db.prepare(`SELECT * FROM ${PREFIX}_annotation_${family} WHERE annotation_id = ?`).get(annotationId);
  if (!row) return null;
  const { annotation_id: ignored, ...fields } = row;
  void ignored;
  return fields;
}

test('field-only annotation.update commits one event and preserves stored endpoint basis anchors byte-for-byte', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'workbench-anno-update-'));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); });
  const ctx = await setup(join(dir, 'wb.sqlite'));
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });

  const applied = await applyAnnotationSpan(ctx, 'a1', { id: 'a1', family: 'coding', fields: { label: 'seed' } }, 6, 11);
  assert.equal(applied.ok, true, applied.failure?.message);

  const rangesBefore = rangeRows(ctx);
  assert.equal(rangesBefore.length, 1);
  const eventsBefore = operatedEvents(ctx.db).length;

  const updated = await updateAnnotation(ctx, 'u1', { annotationId: 'a1', fields: { label: 'reviewed' } });
  assert.equal(updated.ok, true, updated.failure?.message);

  // Exactly ONE new operated event carrying the semantic update.
  assert.equal(operatedEvents(ctx.db).length, eventsBefore + 1);
  const operation = latestEventOperation(ctx.db);
  assert.equal(operation.kind, 'annotation.update');
  assert.equal(operation.annotation.id, 'a1');

  // Endpoint basis anchors preserved: identical membership set, identical
  // stored structural endpoints (historical basis frontier untouched).
  assert.deepEqual(rangeRows(ctx), rangesBefore);

  // The typed row carries the new field value.
  assert.equal(annotationFields(ctx, 'coding', 'a1').label, 'reviewed');
  assert.equal(durableText(ctx), 'hello world');
});

test('one undo restores all prior fields as a single step; redo re-applies them', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'workbench-anno-update-'));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); });
  const ctx = await setup(join(dir, 'wb.sqlite'));
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });

  const applied = await applyAnnotationSpan(ctx, 'a1', { id: 'a1', family: 'coding', fields: { label: 'before' } }, 6, 11);
  assert.equal(applied.ok, true, applied.failure?.message);
  const updated = await updateAnnotation(ctx, 'u1', { annotationId: 'a1', fields: { label: 'after' } });
  assert.equal(updated.ok, true, updated.failure?.message);

  const rangesAfterForward = rangeRows(ctx);
  const eventsAfterForward = operatedEvents(ctx.db).length;

  const undone = await move(ctx, 'undo', 'u1-undo');
  assert.equal(undone.ok, true, undone.failure?.message ?? JSON.stringify(undone));
  assert.equal(undone.events.length, 1);
  assert.equal(undone.events[0].data.operation.kind, 'annotation.update');
  assert.equal(operatedEvents(ctx.db).length, eventsAfterForward + 1, 'undo commits exactly one further operated event');

  // The WHOLE prior field image restored as one step.
  assert.equal(annotationFields(ctx, 'coding', 'a1').label, 'before');
  assert.deepEqual(rangeRows(ctx), rangesAfterForward);

  const redone = await move(ctx, 'redo', 'u1-redo');
  assert.equal(redone.ok, true, redone.failure?.message ?? JSON.stringify(redone));
  assert.equal(redone.events.length, 1);
  assert.equal(annotationFields(ctx, 'coding', 'a1').label, 'after');

  // The private facts bind the chain exactly like the insert algebra does.
  const originFact = JSON.parse(ctx.db.prepare("SELECT fact FROM _PrivateActionFact WHERE actionId = 'u1'").get().fact);
  assert.equal(originFact.kind, 'annotated-text.annotation-update');
  assert.equal(originFact.contribution.kind, 'annotation.update');
  const undoFact = JSON.parse(ctx.db.prepare("SELECT fact FROM _PrivateActionFact WHERE actionId = 'u1-undo'").get().fact);
  assert.equal(undoFact.kind, 'annotated-text.compensation');
  assert.equal(undoFact.linkage.outcome, 'applied');

  // Retrying the same undo id is idempotent via its durable receipt.
  const retried = await move(ctx, 'undo', 'u1-undo');
  assert.equal(retried.ok, true);
  assert.equal(retried.deduped, true);
});

test('range+field update moves endpoints atomically; undo restores prior range AND prior fields together', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'workbench-anno-update-'));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); });
  const ctx = await setup(join(dir, 'wb.sqlite'));
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });

  const applied = await applyAnnotationSpan(ctx, 'a1', { id: 'a1', family: 'coding', fields: { label: 'old' } }, 0, 5);
  assert.equal(applied.ok, true, applied.failure?.message);
  const rangesBefore = rangeRows(ctx);

  const updated = await updateAnnotation(ctx, 'u2', { annotationId: 'a1', fields: { label: 'new' }, fromOffset: 3, toOffset: 8 });
  assert.equal(updated.ok, true, updated.failure?.message);

  const operation = latestEventOperation(ctx.db);
  assert.equal(operation.kind, 'annotation.update');

  // The single membership moved with the update, endpoints re-resolved on the
  // current frontier; every other range passes through untouched.
  const rangesAfter = rangeRows(ctx);
  assert.equal(rangesAfter.length, rangesBefore.length);
  assert.deepEqual(ownRangeProjection(ctx, rangesAfter, 'a1'), { start: 3, end: 8 });
  assert.deepEqual(
    rangesAfter.filter((row) => row.annotationId !== 'a1'),
    rangesBefore.filter((row) => row.annotationId !== 'a1'),
  );

  // Undo restores BOTH the old endpoints (byte-identical basis anchors) and
  // the old field value in ONE move.
  const undone = await move(ctx, 'undo', 'u2-undo');
  assert.equal(undone.ok, true, undone.failure?.message ?? JSON.stringify(undone));
  assert.equal(undone.events.length, 1);
  assert.deepEqual(rangeRows(ctx), rangesBefore);
  assert.equal(annotationFields(ctx, 'coding', 'a1').label, 'old');

  const redone = await move(ctx, 'redo', 'u2-redo');
  assert.equal(redone.ok, true, redone.failure?.message ?? JSON.stringify(redone));
  assert.equal(annotationFields(ctx, 'coding', 'a1').label, 'new');
  assert.equal(rangeRows(ctx).filter((row) => row.annotationId === 'a1').length, 1);
});

test('updating a nonexistent annotation fails cleanly without any document change', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'workbench-anno-update-'));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); });
  const ctx = await setup(join(dir, 'wb.sqlite'));
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });

  const applied = await applyAnnotationSpan(ctx, 'a1', { id: 'a1', family: 'coding', fields: { label: 'keep' } }, 6, 11);
  assert.equal(applied.ok, true, applied.failure?.message);

  const eventsBefore = operatedEvents(ctx.db).length;
  const rangesBefore = rangeRows(ctx);
  const fieldsBefore = JSON.stringify(annotationFields(ctx, 'coding', 'a1'));

  const failed = await updateAnnotation(ctx, 'ghost', { annotationId: 'does-not-exist', fields: { label: 'nope' } });
  assert.equal(failed.ok, false);
  assert.match(String(failed.failure?.message ?? ''), /annotation not found/);

  // Zero events appended, zero durable writes: admission failed closed.
  assert.equal(operatedEvents(ctx.db).length, eventsBefore);
  assert.deepEqual(rangeRows(ctx), rangesBefore);
  assert.equal(JSON.stringify(annotationFields(ctx, 'coding', 'a1')), fieldsBefore);
  assert.equal(durableText(ctx), 'hello world');
});

test('stale undo after a concurrent annotator change is a durable noop — compare-and-compensate, never half-restore', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'workbench-anno-update-'));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); });
  const ctx = await setup(join(dir, 'wb.sqlite'));
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });

  const applied = await applyAnnotationSpan(ctx, 'a1', { id: 'a1', family: 'coding', fields: { label: 's0' } }, 6, 11);
  assert.equal(applied.ok, true, applied.failure?.message);

  // Alice updates twice from two DIFFERENT history sessions. Tab-a's stack
  // only knows about u-stale; tab-b moved the annotation again afterwards.
  const first = await updateAnnotation(ctx, 'u-stale', { annotationId: 'a1', fields: { label: 's1' } }, 'tab-a');
  assert.equal(first.ok, true, first.failure?.message);
  const second = await updateAnnotation(ctx, 'u-live', { annotationId: 'a1', fields: { label: 's2' } }, 'tab-b');
  assert.equal(second.ok, true, second.failure?.message);

  const eventsBeforeUndo = operatedEvents(ctx.db).length;

  const undone = await move(ctx, 'undo', 'u-stale-undo', 'tab-a');
  assert.equal(undone.ok, true, undone.failure?.message ?? JSON.stringify(undone));
  assert.deepEqual(undone.events, [], 'noop undo appends nothing');
  assert.equal(ctx.db.prepare("SELECT historyOutcome FROM _ActionReceipt WHERE actionId = 'u-stale-undo'").get().historyOutcome, 'noop');
  const undoFact = JSON.parse(ctx.db.prepare("SELECT fact FROM _PrivateActionFact WHERE actionId = 'u-stale-undo'").get().fact);
  assert.equal(undoFact.linkage.outcome, 'noop');

  // The live annotation keeps the OTHER session's value, byte-stable state.
  assert.equal(annotationFields(ctx, 'coding', 'a1').label, 's2');
  assert.equal(operatedEvents(ctx.db).length, eventsBeforeUndo);
});

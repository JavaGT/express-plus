import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import workbench, { annotatedText, durableHistory, entity, executeDDL, executeFrameworkDDL, grant, ref, read, scope, write, everyone } from '../src/internal.mjs';
import { materializeBlock, restoreTextFamilyCheckpoint } from '../src/annotated-text-family.mjs';
import { withAuthoringBinding } from './annotated-text-authoring-fixture.mjs';

function declaration(fieldAccess = () => grant(read, write)) {
  const Project = entity('Project', { owner: ref('User'), grant: [scope(() => everyone()).can(() => grant(read, write))] });
  const Document = entity('HistoryDocument', { project: ref('Project'), owner: ref('User'), body: annotatedText({ project: 'project', owner: 'owner' }).can(fieldAccess), grant: [scope(() => everyone()).can(() => grant(read, write))] });
  return { Project, Document };
}

async function setup(fieldAccess) {
  const db = new DatabaseSync(':memory:'); const { Project, Document } = declaration(fieldAccess);
  executeFrameworkDDL(db); db.exec("CREATE TABLE User (id TEXT PRIMARY KEY); INSERT INTO User VALUES ('alice'), ('bob')"); executeDDL(Project, db); db.exec("INSERT INTO Project VALUES ('p1', 'alice')"); executeDDL(Document, db);
  const app = workbench({ db, entities: [Project, Document], history: durableHistory({ authorize: () => true, actions: {} }) }); await app.start();
  await app.dispatch({ actionId: 'create', type: 'HistoryDocument.create', principal: { type: 'user', id: 'alice' }, payload: { id: 'd1', project: 'p1', owner: 'alice', body: { version: 1, blocks: [{ text: 'hello' }] } } });
  return { app, db, Document: app.entities.get('HistoryDocument'), blockId: db.prepare('SELECT id FROM HistoryDocument_body_block').get().id };
}

async function insert(ctx, actionId, principal, session, offset, text) {
  const row = ctx.db.prepare('SELECT * FROM HistoryDocument WHERE id = ?').get('d1');
  const binding = await withAuthoringBinding({ db: ctx.db, entity: ctx.Document, Document: ctx.Document, row, principal, fieldName: 'body', descriptor: ctx.Document.fields.body });
  return ctx.app.dispatch({ actionId, principal, scope: 'Project:p1', history: { session }, type: 'HistoryDocument.body.operation', payload: { version: 9, id: 'd1', authoring: { version: 1, stream: binding.streamToken, lease: binding.leaseToken, mutationId: actionId }, edit: { kind: 'text.insert', at: { positionToken: binding.positionTokens.get(ctx.blockId), offset, affinity: 'right' }, text } } });
}

async function move(ctx, operation, actionId, principal = { type: 'user', id: 'alice' }, session = 'tab-a') {
  const cursor = await ctx.app.history.cursor({ scope: 'Project:p1', principal, session });
  return ctx.app.history[operation]({ scope: 'Project:p1', principal, session, actionId, revision: cursor.revision });
}

function text(ctx) {
  const state = ctx.db.prepare('SELECT family_checkpoint FROM HistoryDocument_body_state WHERE document_id = ?').get('d1');
  const family = restoreTextFamilyCheckpoint(JSON.parse(state.family_checkpoint));
  return family.blocks.map((block) => materializeBlock(family, block.id)).join('');
}

test('undo and redo compensate only Alice insertion after Bob edits', async (t) => {
  const c = await setup(); t.after(() => { c.app.shutdown(); c.db.close(); });
  assert.equal((await insert(c, 'alice-insert', { type: 'user', id: 'alice' }, 'tab-a', 5, ' A')).ok, true);
  assert.equal((await insert(c, 'bob-insert', { type: 'user', id: 'bob' }, 'tab-b', 0, 'B ')).ok, true);
  assert.equal(text(c), 'B hello A');
  const original = JSON.parse(c.db.prepare("SELECT fact FROM _PrivateActionFact WHERE actionId = 'alice-insert'").get().fact);
  assert.equal(original.kind, 'annotated-text.contribution'); assert.equal(JSON.stringify(original).includes('tables'), false);
  const undone = await move(c, 'undo', 'alice-undo'); assert.equal(undone.ok, true, JSON.stringify(undone)); assert.equal(text(c), 'B hello');
  const undoFact = JSON.parse(c.db.prepare("SELECT fact FROM _PrivateActionFact WHERE actionId = 'alice-undo'").get().fact);
  assert.equal(undoFact.linkage.outcome, 'applied'); assert.equal(undone.events[0].data.operation.operation[5][0], 'delete');
  assert.equal((await move(c, 'undo', 'alice-undo')).deduped, true);
  const redone = await move(c, 'redo', 'alice-redo'); assert.equal(redone.ok, true); assert.equal(text(c), 'B hello A');
  assert.notDeepEqual(redone.events[0].data.operation.operation[2], original.contribution.opId);
  assert.equal((await move(c, 'undo', 'alice-undo-again')).ok, true); assert.equal(text(c), 'B hello');
  assert.deepEqual((await c.app.history.cursor({ scope: 'Project:p1', principal: { type: 'user', id: 'alice' }, session: 'tab-a' })).undo, 0);
});

test('history is isolated and an unsupported annotated action is a barrier', async (t) => {
  const c = await setup(); t.after(() => { c.app.shutdown(); c.db.close(); });
  await insert(c, 'alice-insert', { type: 'user', id: 'alice' }, 'tab-a', 5, '!');
  assert.equal((await c.app.history.cursor({ scope: 'Project:p1', principal: { type: 'user', id: 'bob' }, session: 'tab-a' })).undo, 0);
  assert.equal((await c.app.history.cursor({ scope: 'Project:p1', principal: { type: 'user', id: 'alice' }, session: 'other' })).undo, 0);
  // A delete is not modeled in Landing 1. It clears Alice's cursor rather than exposing an older insert across it.
  const row = c.db.prepare('SELECT * FROM HistoryDocument WHERE id = ?').get('d1'); const principal = { type: 'user', id: 'alice' };
  const binding = await withAuthoringBinding({ db: c.db, entity: c.Document, Document: c.Document, row, principal, fieldName: 'body', descriptor: c.Document.fields.body });
  const token = binding.positionTokens.get(c.blockId);
  const deleted = await c.app.dispatch({ actionId: 'delete', principal, scope: 'Project:p1', history: { session: 'tab-a' }, type: 'HistoryDocument.body.operation', payload: { version: 9, id: 'd1', authoring: { version: 1, stream: binding.streamToken, lease: binding.leaseToken, mutationId: 'delete' }, edit: { kind: 'text.delete', from: { positionToken: token, offset: 0, affinity: 'right' }, to: { positionToken: token, offset: 1, affinity: 'right' } } } });
  assert.equal(deleted.ok, true, deleted.failure?.message);
  assert.equal((await c.app.history.cursor({ scope: 'Project:p1', principal, session: 'tab-a' })).undo, 0);
});

test('compensation is not a public action', async (t) => {
  const c = await setup(); t.after(() => { c.app.shutdown(); c.db.close(); });
  const result = await c.app.dispatch({
    actionId: 'forged-compensation', principal: { type: 'user', id: 'alice' }, scope: 'Project:p1',
    type: 'HistoryDocument.body.compensate',
    payload: { version: 1, id: 'd1', history: { version: 1, rootActionId: 'x', targetActionId: 'x', direction: 'undo' } },
  });
  assert.equal(result.ok, false);
  assert.equal(text(c), 'hello');
  assert.equal(c.db.prepare("SELECT COUNT(*) AS count FROM _ActionReceipt WHERE actionId = 'forged-compensation'").get().count, 0);
});

test('undo and redo retain a durable no-op when another action deleted the contribution', async (t) => {
  const c = await setup(); t.after(() => { c.app.shutdown(); c.db.close(); });
  const alice = { type: 'user', id: 'alice' };
  assert.equal((await insert(c, 'alice-insert', alice, 'tab-a', 5, '!')).ok, true);
  const row = c.db.prepare('SELECT * FROM HistoryDocument WHERE id = ?').get('d1');
  const binding = await withAuthoringBinding({ db: c.db, entity: c.Document, Document: c.Document, row, principal: { type: 'user', id: 'bob' }, fieldName: 'body', descriptor: c.Document.fields.body });
  const token = binding.positionTokens.get(c.blockId);
  const deleted = await c.app.dispatch({ actionId: 'bob-delete', principal: { type: 'user', id: 'bob' }, scope: 'Project:p1', type: 'HistoryDocument.body.operation', payload: { version: 9, id: 'd1', authoring: { version: 1, stream: binding.streamToken, lease: binding.leaseToken, mutationId: 'bob-delete' }, edit: { kind: 'text.delete', from: { positionToken: token, offset: 5, affinity: 'right' }, to: { positionToken: token, offset: 6, affinity: 'right' } } } });
  assert.equal(deleted.ok, true, deleted.failure?.message);
  const undone = await move(c, 'undo', 'alice-noop-undo');
  assert.equal(undone.ok, true); assert.deepEqual(undone.events, []);
  assert.equal(c.db.prepare("SELECT historyOutcome FROM _ActionReceipt WHERE actionId = 'alice-noop-undo'").get().historyOutcome, 'noop');
  const redone = await move(c, 'redo', 'alice-noop-redo');
  assert.equal(redone.ok, true); assert.deepEqual(redone.events, []);
  assert.equal(c.db.prepare("SELECT historyOutcome FROM _ActionReceipt WHERE actionId = 'alice-noop-redo'").get().historyOutcome, 'noop');
  assert.equal(text(c), 'hello');
});

test('history reconstructs a compensation chain from durable receipts', async (t) => {
  const c = await setup(); t.after(() => { c.app.shutdown(); c.db.close(); });
  assert.equal((await insert(c, 'alice-insert', { type: 'user', id: 'alice' }, 'tab-a', 5, '!')).ok, true);
  assert.equal((await move(c, 'undo', 'alice-undo')).ok, true);
  c.db.exec('DELETE FROM _HistoryCursor');
  const cursor = await c.app.history.cursor({ scope: 'Project:p1', principal: { type: 'user', id: 'alice' }, session: 'tab-a' });
  assert.deepEqual({ undo: cursor.undo, redo: cursor.redo }, { undo: 0, redo: 1 });
  assert.equal((await c.app.history.redo({ scope: 'Project:p1', principal: { type: 'user', id: 'alice' }, session: 'tab-a', actionId: 'alice-redo', revision: cursor.revision })).ok, true);
  assert.equal(text(c), 'hello!');
});

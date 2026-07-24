import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  annotatedText, annotation, boolean, entity, everyone, executeDDL, executeFrameworkDDL, measurement,
  createServer, grant, read, ref, scope, text, write,
  registerAnnotatedTextContract, registerAnnotatedTextStructuralExtension,
} from '../src/internal.mjs';
import { applyTextOperationToBlock, restoreTextFamilyCheckpoint, textFamilyCheckpoint } from '../src/annotated-text-family.mjs';
import { native } from '../src/event-handle.mjs';

const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const INSERT_HELLO = ['workbench.text', 1, [A, 1], 1, [], ['insert', ['root'], 'hello']];

// Register semantic contract and structural adapter for the init measurement
registerAnnotatedTextContract('sourceInit', Object.freeze({ kind: 'measurement' }));
registerAnnotatedTextStructuralExtension('sourceInit', Object.freeze({
  version: 1,
  validate: function validate() {},
  edit: function edit() {},
  partition: function partition() {},
  combine: function combine() {},
}));

function doc() {
  return entity('InitDoc', {
    project: ref('Project'),
    owner: ref('User'),
    body: annotatedText({
      project: 'project',
      owner: 'owner',
      block: { reviewed: boolean({ default: true }) },
      annotations: [annotation('note', { fields: {} })],
      measurements: [measurement('source', { extension: 'sourceInit' })],
    }),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
}

async function appFor(db = new DatabaseSync(':memory:')) {
  const InitDoc = doc();
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY)');
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY)');
  db.exec("INSERT INTO Project (id) VALUES ('p1')");
  db.exec("INSERT INTO User (id) VALUES ('u1')");
  executeDDL(InitDoc, db);
  const app = workbench({ db, entities: [InitDoc] });
  app.start();
  await app.ready;
  return { app, db };
}

test('annotated text create atomically initializes one canonical empty family and block', async () => {
  const { app, db } = await appFor();
  const result = await app.dispatch({
    actionId: 'create', type: 'InitDoc.create',
    payload: { id: 'd1', project: 'p1', owner: 'u1' }, principal: { id: 'u1' },
  });
  assert.equal(result.ok, true);
  const blockId = result.events[0].data.__workbench.annotatedText.body.initialBlockId;
  assert.equal(typeof blockId, 'string');
  assert.ok(blockId.length > 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM InitDoc WHERE id = ?').get('d1').count, 1);
  const state = db.prepare('SELECT * FROM InitDoc_body_state WHERE document_id = ?').get('d1');
  const block = db.prepare('SELECT * FROM InitDoc_body_block WHERE document_id = ?').get('d1');
  assert.equal(state.structure_version, 1);
  assert.equal(block.id, blockId);
  assert.equal(block.position, 'a0');
  assert.equal(block.epoch, 1);
  assert.equal(block.structure_version, 1);
  assert.equal(block.reviewed, 1);
  const family = restoreTextFamilyCheckpoint(JSON.parse(state.family_checkpoint));
  assert.equal(family.id, 'd1');
  assert.deepEqual(family.blocks, [{ id: blockId, elementKeys: [] }]);
  assert.ok(!Object.hasOwn(db.prepare('SELECT * FROM InitDoc WHERE id = ?').get('d1'), '__workbench'));
});

test('annotated text field and framework metadata are rejected from generic payloads', async () => {
  const { app, db } = await appFor();
  for (const [actionId, payload] of [
    ['body-value', { id: 'd1', project: 'p1', owner: 'u1', body: null }],
    ['reserved', { id: 'd2', project: 'p1', owner: 'u1', __workbench: {} }],
  ]) {
    const result = await app.dispatch({ actionId, type: 'InitDoc.create', payload, principal: { id: 'u1' } });
    assert.equal(result.ok, false);
  }
  const created = await app.dispatch({
    actionId: 'create', type: 'InitDoc.create', payload: { id: 'd3', project: 'p1', owner: 'u1' }, principal: { id: 'u1' },
  });
  assert.equal(created.ok, true);
  const update = await app.dispatch({
    actionId: 'update', type: 'InitDoc.update', payload: { id: 'd3', body: {} }, principal: { id: 'u1' },
  });
  assert.equal(update.ok, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM InitDoc_body_state').get().count, 1);
});

test('create retry retains its event-carried initial block identity without duplicate projection rows', async () => {
  const { app, db } = await appFor();
  const request = {
    actionId: 'create', type: 'InitDoc.create',
    payload: { id: 'd1', project: 'p1', owner: 'u1' }, principal: { id: 'u1' },
  };
  const first = await app.dispatch(request);
  const retry = await app.dispatch(request);
  assert.equal(first.ok, true);
  assert.equal(retry.ok, true);
  assert.equal(retry.deduped, true);
  assert.equal(
    retry.events[0].data.__workbench.annotatedText.body.initialBlockId,
    first.events[0].data.__workbench.annotatedText.body.initialBlockId,
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM InitDoc_body_state').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM InitDoc_body_block').get().count, 1);
});

test('annotated-text operation commits one canonical family fact and rejects a stale structural revision', async () => {
  const { app, db } = await appFor();
  const created = await app.dispatch({
    actionId: 'create', type: 'InitDoc.create',
    payload: { id: 'd1', project: 'p1', owner: 'u1' }, principal: { id: 'u1' },
  });
  assert.equal(created.ok, true);
  const blockId = created.events[0].data.__workbench.annotatedText.body.initialBlockId;
  const result = await app.dispatch({
    actionId: 'operation', type: 'InitDoc.body.operation', scope: 'InitDoc:d1', principal: { id: 'u1' },
    payload: {
      version: 1,
      id: 'd1',
      expected: { structuralRevision: 1, frontier: [] },
      operation: { kind: 'text.apply', blockId, operation: INSERT_HELLO },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].type, 'InitDoc.body.operated');
  assert.equal(result.events[0].data.version, 1);
  assert.equal(result.events[0].data.id, 'd1');
  assert.equal(result.events[0].data.operation.kind, 'text.apply');
  assert.deepEqual(result.events[0].data.before, { structuralRevision: 1, frontier: [] });
  assert.deepEqual(result.events[0].data.after, { structuralRevision: 1, frontier: [[A, 1]] });
  const state = db.prepare('SELECT * FROM InitDoc_body_state WHERE document_id = ?').get('d1');
  const family = restoreTextFamilyCheckpoint(JSON.parse(state.family_checkpoint));
  assert.equal(family.checkpoint.elements[`${A}:1:0`].scalar, 'h');
  assert.deepEqual(result.events[0].data.family, JSON.parse(state.family_checkpoint));
  assert.equal(state.structure_version, 1);
  assert.equal(db.prepare('SELECT structure_version FROM InitDoc_body_block WHERE id = ?').get(blockId).structure_version, 1);
  const second = await app.dispatch({
    actionId: 'operation-two', type: 'InitDoc.body.operation', scope: 'InitDoc:d1', principal: { id: 'u1' },
    payload: {
      version: 1,
      id: 'd1',
      expected: { structuralRevision: 1, frontier: [[A, 1]] },
      operation: { kind: 'text.apply', blockId, operation: ['workbench.text', 1, [A, 2], 2, [[A, 1]], ['insert', ['root'], '!']] },
    },
  });
  assert.equal(second.ok, true);
  assert.deepEqual(second.events[0].data.before, { structuralRevision: 1, frontier: [[A, 1]] });
  assert.deepEqual(second.events[0].data.after, { structuralRevision: 1, frontier: [[A, 2]] });
  const retry = await app.dispatch({
    actionId: 'operation', type: 'InitDoc.body.operation', scope: 'InitDoc:d1', principal: { id: 'u1' },
    payload: {
      version: 1,
      id: 'd1',
      expected: { structuralRevision: 1, frontier: [] },
      operation: { kind: 'text.apply', blockId, operation: INSERT_HELLO },
    },
  });
  assert.equal(retry.ok, true);
  assert.equal(retry.deduped, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM _Log WHERE eventType = 'InitDoc.body.operated'").get().count, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _ActionReceipt WHERE actionId = ?').get('operation').count, 1);
  const stale = await app.dispatch({
    actionId: 'stale', type: 'InitDoc.body.operation', scope: 'InitDoc:d1', principal: { id: 'u1' },
    payload: {
      version: 1,
      id: 'd1',
      expected: { structuralRevision: 2, frontier: [] },
      operation: { kind: 'text.apply', blockId, operation: INSERT_HELLO },
    },
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.failure.category, 'invalid-input');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _Log WHERE actionId = ?').get('stale').count, 0);
  await app.close?.();
});

test('annotated-text operation rejects malformed and causally unready commands without a composite event', async () => {
  const { app, db } = await appFor();
  const created = await app.dispatch({
    actionId: 'create', type: 'InitDoc.create',
    payload: { id: 'd1', project: 'p1', owner: 'u1' }, principal: { id: 'u1' },
  });
  const blockId = created.events[0].data.__workbench.annotatedText.body.initialBlockId;
  for (const [actionId, payload] of [
    ['malformed', { version: 1, id: 'd1', expected: { structuralRevision: 1, frontier: [] }, operation: { kind: 'text.apply', blockId, operation: INSERT_HELLO }, extra: true }],
    ['unready', { version: 1, id: 'd1', expected: { structuralRevision: 1, frontier: [] }, operation: { kind: 'text.apply', blockId, operation: ['workbench.text', 1, [A, 2], 2, [[A, 1]], ['insert', ['root'], 'x']] } }],
  ]) {
    const result = await app.dispatch({ actionId, type: 'InitDoc.body.operation', scope: 'InitDoc:d1', payload, principal: { id: 'u1' } });
    assert.equal(result.ok, false);
    assert.equal(result.failure.category, 'invalid-input');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _Log WHERE actionId = ?').get(actionId).count, 0);
  }
  await app.close?.();
});

test('annotated-text operation is rejected from generic batches before aggregate reduction', async () => {
  const { app, db } = await appFor();
  const created = await app.dispatch({
    actionId: 'create', type: 'InitDoc.create',
    payload: { id: 'd1', project: 'p1', owner: 'u1' }, principal: { id: 'u1' },
  });
  const blockId = created.events[0].data.__workbench.annotatedText.body.initialBlockId;
  const result = await app.batch([{
    type: 'InitDoc.body.operation',
    payload: {
      version: 1,
      id: 'd1',
      expected: { structuralRevision: 1, frontier: [] },
      operation: { kind: 'text.apply', blockId, operation: INSERT_HELLO },
    },
  }], { principal: { id: 'u1' } });
  assert.equal(result.ok, false);
  assert.equal(result.failure.category, 'invalid-input');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM _Log WHERE eventType = 'InitDoc.body.operated'").get().count, 0);
  await app.close?.();
});

test('annotated-text projection rejects a canonical family fact that does not match its text operation', async () => {
  const { app, db } = await appFor();
  const created = await app.dispatch({
    actionId: 'create', type: 'InitDoc.create',
    payload: { id: 'd1', project: 'p1', owner: 'u1' }, principal: { id: 'u1' },
  });
  const blockId = created.events[0].data.__workbench.annotatedText.body.initialBlockId;
  const current = restoreTextFamilyCheckpoint(JSON.parse(
    db.prepare('SELECT family_checkpoint FROM InitDoc_body_state WHERE document_id = ?').get('d1').family_checkpoint,
  ));
  const substituted = textFamilyCheckpoint(applyTextOperationToBlock(current, blockId,
    ['workbench.text', 1, [A, 1], 1, [], ['insert', ['root'], 'bye']],
  ));
  const handle = native('InitDoc', 'body', 'operated');
  assert.throws(() => app.entities.get('InitDoc').projection.apply({
    handle,
    data: {
      version: 1,
      id: 'd1',
      before: { structuralRevision: 1, frontier: [] },
      operation: { kind: 'text.apply', blockId, operation: INSERT_HELLO },
      after: { structuralRevision: 1, frontier: [[A, 1]] },
      family: substituted,
    },
  }, db), /does not match its text operation/);
  const persisted = restoreTextFamilyCheckpoint(JSON.parse(
    db.prepare('SELECT family_checkpoint FROM InitDoc_body_state WHERE document_id = ?').get('d1').family_checkpoint,
  ));
  assert.deepEqual(persisted, current);
  await app.close?.();
});

test('annotated-text operation requires its document scope for receipt ownership', async () => {
  const { app, db } = await appFor();
  const created = await app.dispatch({
    actionId: 'create', type: 'InitDoc.create',
    payload: { id: 'd1', project: 'p1', owner: 'u1' }, principal: { id: 'u1' },
  });
  const blockId = created.events[0].data.__workbench.annotatedText.body.initialBlockId;
  const result = await app.dispatch({
    actionId: 'wrong-scope', type: 'InitDoc.body.operation', scope: 'InitDoc:other', principal: { id: 'u1' },
    payload: {
      version: 1,
      id: 'd1',
      expected: { structuralRevision: 1, frontier: [] },
      operation: { kind: 'text.apply', blockId, operation: INSERT_HELLO },
    },
  });
  assert.equal(result.ok, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _ActionReceipt WHERE actionId = ?').get('wrong-scope').count, 0);
  await app.close?.();
});

test('annotated-text operation validates document scope before returning a colliding receipt', async () => {
  const { app, db } = await appFor();
  const created = await app.dispatch({
    actionId: 'create', type: 'InitDoc.create',
    payload: { id: 'd1', project: 'p1', owner: 'u1' }, principal: { id: 'u1' },
  });
  const blockId = created.events[0].data.__workbench.annotatedText.body.initialBlockId;
  const unrelated = await app.dispatch({
    actionId: 'collides', type: 'InitDoc.create', scope: 'InitDoc:other', principal: { id: 'u1' },
    payload: { id: 'd2', project: 'p1', owner: 'u1' },
  });
  assert.equal(unrelated.ok, true);
  const result = await app.dispatch({
    actionId: 'collides', type: 'InitDoc.body.operation', scope: 'InitDoc:other', principal: { id: 'u1' },
    payload: {
      version: 1,
      id: 'd1',
      expected: { structuralRevision: 1, frontier: [] },
      operation: { kind: 'text.apply', blockId, operation: INSERT_HELLO },
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.failure.category, 'invalid-input');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _Log WHERE actionId = ?').get('collides').count, 1);
  await app.close?.();
});

test('in-memory batches reject explicitly single-dispatch actions before handler invocation', () => {
  const handler = () => {
    throw new Error('must not run');
  };
  Object.defineProperty(handler, 'batchForbidden', { value: true });
  const server = createServer({
    handlers: { 'aggregate.operation': handler },
    authorize: () => true,
  });
  const result = server.dispatchBatch({
    actionId: 'batch', principal: { id: 'u1' }, actions: [{ type: 'aggregate.operation', payload: {} }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.failure.category, 'invalid-input');
  assert.equal(server.log.length, 0);
});

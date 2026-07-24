import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  annotatedText, annotation, boolean, entity, everyone, executeDDL, executeFrameworkDDL, measurement,
  createServer, grant, read, ref, scope, write,
  registerAnnotatedTextContract, registerAnnotatedTextStructuralExtension,
} from '../src/internal.mjs';
import { applyTextOperationToBlock, restoreTextFamilyCheckpoint, textFamilyCheckpoint, materializeBlock, splitBlock } from '../src/annotated-text-family.mjs';
import { native } from '../src/event-handle.mjs';
import { frozenJsonSnapshot } from '../src/annotated-text-r2.mjs';

const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const INSERT_HELLO = ['workbench.text', 1, [A, 1], 1, [], ['insert', ['root'], 'hello']];
const INSERT_WORLD = ['workbench.text', 1, [A, 2], 2, [[A, 1]], ['insert', ['root'], 'world']];

registerAnnotatedTextContract('sourceInit', Object.freeze({ kind: 'measurement' }));
registerAnnotatedTextStructuralExtension('sourceInit', Object.freeze({
  version: 1,
  validate: function validate() {},
  edit: function edit() {},
  partition: function partition(input) {
    const blockText = input.blockText;
    const offset = input.utf16Offset;
    const payload = input.payload;
    const leftText = blockText.slice(0, offset);
    const rightText = blockText.slice(offset);
    return Object.freeze({
      version: 1,
      leftPayload: Object.freeze({ ...payload, text: leftText, offset }),
      rightPayload: Object.freeze({ ...payload, text: rightText, offset }),
    });
  },
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

test('R2 measurement adapter inputs receive an isolated deep-frozen JSON snapshot', () => {
  const source = { nested: { value: 1 } };
  const snapshot = frozenJsonSnapshot(source);
  assert.notEqual(snapshot, source);
  assert.notEqual(snapshot.nested, source.nested);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.nested), true);
  assert.throws(() => { snapshot.nested.value = 2; }, TypeError);
  assert.equal(source.nested.value, 1);
});

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

// ---- R2 block.split tests ----

test('R2 block.split emits one changed v2 event and projection produces two blocks', async () => {
  const { app, db } = await appFor();
  const created = await app.dispatch({
    actionId: 'create', type: 'InitDoc.create',
    payload: { id: 'd1', project: 'p1', owner: 'u1' }, principal: { id: 'u1' },
  });
  assert.equal(created.ok, true);
  const blockId = created.events[0].data.__workbench.annotatedText.body.initialBlockId;

  const op1 = await app.dispatch({
    actionId: 'op1', type: 'InitDoc.body.operation', scope: 'InitDoc:d1', principal: { id: 'u1' },
    payload: { version: 1, id: 'd1', expected: { structuralRevision: 1, frontier: [] }, operation: { kind: 'text.apply', blockId, operation: INSERT_HELLO } },
  });
  assert.equal(op1.ok, true);

  const op2 = await app.dispatch({
    actionId: 'op2', type: 'InitDoc.body.operation', scope: 'InitDoc:d1', principal: { id: 'u1' },
    payload: { version: 1, id: 'd1', expected: { structuralRevision: 1, frontier: [[A, 1]] }, operation: { kind: 'text.apply', blockId, operation: INSERT_WORLD } },
  });
  assert.equal(op2.ok, true);

  const blockText = db.prepare(`SELECT * FROM InitDoc_body_block WHERE document_id = 'd1'`).all();
  assert.equal(blockText.length, 1);

  const split = await app.dispatch({
    actionId: 'split', type: 'InitDoc.body.operation', scope: 'InitDoc:d1', principal: { id: 'u1' },
    payload: { version: 2, id: 'd1', expected: { structuralRevision: 1, frontier: [[A, 2]] }, operation: { kind: 'block.split', blockId, utf16Offset: 5 } },
  });
  assert.equal(split.ok, true);
  assert.equal(split.events.length, 1);
  assert.equal(split.events[0].data.version, 2);
  assert.equal(split.events[0].data.operation.kind, 'block.split');
  assert.equal(split.events[0].data.operation.leftBlockId, blockId);
  assert.ok(split.events[0].data.operation.rightBlockId);
  assert.notEqual(split.events[0].data.operation.rightBlockId, blockId);
  assert.equal(split.events[0].data.operation.utf16Offset, 5);
  assert.equal(split.events[0].data.before.structuralRevision, 1);
  assert.equal(split.events[0].data.after.structuralRevision, 2);
  assert.deepEqual(split.events[0].data.before.frontier, [[A, 2]]);
  assert.deepEqual(split.events[0].data.after.frontier, [[A, 2]]);

  const state = db.prepare('SELECT * FROM InitDoc_body_state WHERE document_id = ?').get('d1');
  assert.equal(state.structure_version, 2);
  const family = restoreTextFamilyCheckpoint(JSON.parse(state.family_checkpoint));
  assert.equal(family.blocks.length, 2);
  assert.equal(family.blocks[0].id, blockId);
  assert.equal(family.blocks[1].id, split.events[0].data.operation.rightBlockId);

  const blocks = db.prepare("SELECT * FROM InitDoc_body_block WHERE document_id = 'd1' ORDER BY position").all();
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].id, blockId);
  assert.equal(blocks[0].structure_version, 2);
  assert.equal(blocks[1].id, split.events[0].data.operation.rightBlockId);
  assert.equal(blocks[1].structure_version, 2);
  assert.equal(blocks[0].epoch, 1);
  assert.equal(blocks[1].epoch, 1);
  assert.equal(blocks[0].reviewed, 1);
  assert.equal(blocks[1].reviewed, 1);
  assert.equal(materializeBlock(family, blockId), 'world');
  assert.equal(materializeBlock(family, split.events[0].data.operation.rightBlockId), 'hello');

  await app.close?.();
});

test('R2 block.split at offset 0 or text.length returns zero events', async () => {
  const { app, db } = await appFor();
  const created = await app.dispatch({
    actionId: 'create', type: 'InitDoc.create',
    payload: { id: 'd1', project: 'p1', owner: 'u1' }, principal: { id: 'u1' },
  });
  const blockId = created.events[0].data.__workbench.annotatedText.body.initialBlockId;

  const op1 = await app.dispatch({
    actionId: 'op1', type: 'InitDoc.body.operation', scope: 'InitDoc:d1', principal: { id: 'u1' },
    payload: { version: 1, id: 'd1', expected: { structuralRevision: 1, frontier: [] }, operation: { kind: 'text.apply', blockId, operation: INSERT_HELLO } },
  });
  assert.equal(op1.ok, true);

  const atStart = await app.dispatch({
    actionId: 'at-start', type: 'InitDoc.body.operation', scope: 'InitDoc:d1', principal: { id: 'u1' },
    payload: { version: 2, id: 'd1', expected: { structuralRevision: 1, frontier: [[A, 1]] }, operation: { kind: 'block.split', blockId, utf16Offset: 0 } },
  });
  assert.equal(atStart.ok, true);
  assert.equal(atStart.events.length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM _Log WHERE actionId = 'at-start'").get().count, 0);

  const atEnd = await app.dispatch({
    actionId: 'at-end', type: 'InitDoc.body.operation', scope: 'InitDoc:d1', principal: { id: 'u1' },
    payload: { version: 2, id: 'd1', expected: { structuralRevision: 1, frontier: [[A, 1]] }, operation: { kind: 'block.split', blockId, utf16Offset: 5 } },
  });
  assert.equal(atEnd.ok, true);
  assert.equal(atEnd.events.length, 0);

  const blocks = db.prepare("SELECT COUNT(*) AS count FROM InitDoc_body_block WHERE document_id = 'd1'").get().count;
  assert.equal(blocks, 1);

  await app.close?.();
});

test('R2 block.split zero-event retry is idempotent via existing receipt', async () => {
  const { app, db } = await appFor();
  const created = await app.dispatch({
    actionId: 'create', type: 'InitDoc.create',
    payload: { id: 'd1', project: 'p1', owner: 'u1' }, principal: { id: 'u1' },
  });
  const blockId = created.events[0].data.__workbench.annotatedText.body.initialBlockId;

  const op1 = await app.dispatch({
    actionId: 'op1', type: 'InitDoc.body.operation', scope: 'InitDoc:d1', principal: { id: 'u1' },
    payload: { version: 1, id: 'd1', expected: { structuralRevision: 1, frontier: [] }, operation: { kind: 'text.apply', blockId, operation: INSERT_HELLO } },
  });
  assert.equal(op1.ok, true);

  const first = await app.dispatch({
    actionId: 'zero-retry', type: 'InitDoc.body.operation', scope: 'InitDoc:d1', principal: { id: 'u1' },
    payload: { version: 2, id: 'd1', expected: { structuralRevision: 1, frontier: [[A, 1]] }, operation: { kind: 'block.split', blockId, utf16Offset: 0 } },
  });
  assert.equal(first.ok, true);
  assert.equal(first.events.length, 0);

  const retry = await app.dispatch({
    actionId: 'zero-retry', type: 'InitDoc.body.operation', scope: 'InitDoc:d1', principal: { id: 'u1' },
    payload: { version: 2, id: 'd1', expected: { structuralRevision: 1, frontier: [[A, 1]] }, operation: { kind: 'block.split', blockId, utf16Offset: 0 } },
  });
  assert.equal(retry.ok, true);
  assert.equal(retry.deduped, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM _Log WHERE eventType = 'InitDoc.body.operated'").get().count, 1);

  await app.close?.();
});

test('R2 block.split rejects invalid payload and stale structural revision', async () => {
  const { app, db } = await appFor();
  const created = await app.dispatch({
    actionId: 'create', type: 'InitDoc.create',
    payload: { id: 'd1', project: 'p1', owner: 'u1' }, principal: { id: 'u1' },
  });
  const blockId = created.events[0].data.__workbench.annotatedText.body.initialBlockId;

  const op1 = await app.dispatch({
    actionId: 'op1', type: 'InitDoc.body.operation', scope: 'InitDoc:d1', principal: { id: 'u1' },
    payload: { version: 1, id: 'd1', expected: { structuralRevision: 1, frontier: [] }, operation: { kind: 'text.apply', blockId, operation: INSERT_HELLO } },
  });
  assert.equal(op1.ok, true);

  const invalid = await app.dispatch({
    actionId: 'invalid', type: 'InitDoc.body.operation', scope: 'InitDoc:d1', principal: { id: 'u1' },
    payload: { version: 2, id: 'd1', expected: { structuralRevision: 1, frontier: [[A, 1]] }, operation: { kind: 'block.split', blockId: 'nonexistent', utf16Offset: 3 } },
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.failure.category, 'invalid-input');

  const stale = await app.dispatch({
    actionId: 'stale', type: 'InitDoc.body.operation', scope: 'InitDoc:d1', principal: { id: 'u1' },
    payload: { version: 2, id: 'd1', expected: { structuralRevision: 2, frontier: [[A, 1]] }, operation: { kind: 'block.split', blockId, utf16Offset: 3 } },
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.failure.category, 'invalid-input');

  const wrongScope = await app.dispatch({
    actionId: 'wrong-scope', type: 'InitDoc.body.operation', scope: 'InitDoc:other', principal: { id: 'u1' },
    payload: { version: 2, id: 'd1', expected: { structuralRevision: 1, frontier: [[A, 1]] }, operation: { kind: 'block.split', blockId, utf16Offset: 3 } },
  });
  assert.equal(wrongScope.ok, false);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM _Log WHERE eventType = 'InitDoc.body.operated'").get().count, 1);

  await app.close?.();
});

test('R2 block.split with membership expansion produces canonical rows', async () => {
  const { app, db } = await appFor();
  const created = await app.dispatch({
    actionId: 'create', type: 'InitDoc.create',
    payload: { id: 'd1', project: 'p1', owner: 'u1' }, principal: { id: 'u1' },
  });
  const blockId = created.events[0].data.__workbench.annotatedText.body.initialBlockId;

  const op1 = await app.dispatch({
    actionId: 'op1', type: 'InitDoc.body.operation', scope: 'InitDoc:d1', principal: { id: 'u1' },
    payload: { version: 1, id: 'd1', expected: { structuralRevision: 1, frontier: [] }, operation: { kind: 'text.apply', blockId, operation: INSERT_HELLO } },
  });
  assert.equal(op1.ok, true);

  const op2 = await app.dispatch({
    actionId: 'op2', type: 'InitDoc.body.operation', scope: 'InitDoc:d1', principal: { id: 'u1' },
    payload: { version: 1, id: 'd1', expected: { structuralRevision: 1, frontier: [[A, 1]] }, operation: { kind: 'text.apply', blockId, operation: INSERT_WORLD } },
  });
  assert.equal(op2.ok, true);

  const annId = 'ann1';
  const noteFamily = 'note';
  db.prepare(`INSERT INTO InitDoc_body_annotation (id, document_id, project_id, owner_id, family) VALUES (?, 'd1', 'p1', 'u1', ?)`).run(annId, noteFamily);
  db.prepare(`INSERT INTO InitDoc_body_annotation_note (annotation_id) VALUES (?)`).run(annId);
  db.prepare(`INSERT INTO InitDoc_body_membership (annotation_id, block_id, ordinal, start_point, end_point) VALUES (?, ?, 0, ?, ?)`)
    .run(annId, blockId, JSON.stringify({ point: ['point', ['root'], 'left'], basisFrontier: [] }), JSON.stringify({ point: ['point', ['element', [[A, 2], 1]], 'right'], basisFrontier: [[A, 2]] }));

  const split = await app.dispatch({
    actionId: 'split', type: 'InitDoc.body.operation', scope: 'InitDoc:d1', principal: { id: 'u1' },
    payload: { version: 2, id: 'd1', expected: { structuralRevision: 1, frontier: [[A, 2]] }, operation: { kind: 'block.split', blockId, utf16Offset: 5 } },
  });
  assert.equal(split.ok, true);
  const rightBlockId = split.events[0].data.operation.rightBlockId;

  const memberships = db.prepare(`SELECT * FROM InitDoc_body_membership WHERE annotation_id = ?`).all(annId);
  assert.equal(memberships.length, 2);
  const leftMembership = memberships.find(m => m.block_id === blockId);
  const rightMembership = memberships.find(m => m.block_id === rightBlockId);
  assert.ok(leftMembership);
  assert.ok(rightMembership);
  assert.equal(leftMembership.ordinal, 0);
  assert.equal(rightMembership.ordinal, 1);

  await app.close?.();
});

test('R2 block.split with measurement partition produces measurement facts', async () => {
  const { app, db } = await appFor();
  const created = await app.dispatch({
    actionId: 'create', type: 'InitDoc.create',
    payload: { id: 'd1', project: 'p1', owner: 'u1' }, principal: { id: 'u1' },
  });
  const blockId = created.events[0].data.__workbench.annotatedText.body.initialBlockId;

  const op1 = await app.dispatch({
    actionId: 'op1', type: 'InitDoc.body.operation', scope: 'InitDoc:d1', principal: { id: 'u1' },
    payload: { version: 1, id: 'd1', expected: { structuralRevision: 1, frontier: [] }, operation: { kind: 'text.apply', blockId, operation: INSERT_HELLO } },
  });
  assert.equal(op1.ok, true);

  const measId = 'meas1';
  const measPayload = JSON.stringify({ source: 'test', text: 'hello', offset: 0 });
  db.prepare(`INSERT INTO InitDoc_body_measurement (id, block_id, family, format_version, payload) VALUES (?, ?, 'source', 1, ?)`).run(measId, blockId, measPayload);

  const split = await app.dispatch({
    actionId: 'split', type: 'InitDoc.body.operation', scope: 'InitDoc:d1', principal: { id: 'u1' },
    payload: { version: 2, id: 'd1', expected: { structuralRevision: 1, frontier: [[A, 1]] }, operation: { kind: 'block.split', blockId, utf16Offset: 2 } },
  });
  assert.equal(split.ok, true);
  const rightBlockId = split.events[0].data.operation.rightBlockId;

  const measurements = db.prepare(`SELECT * FROM InitDoc_body_measurement WHERE block_id = ?`).all(blockId);
  assert.equal(measurements.length, 1);
  assert.equal(measurements[0].id, measId);
  const leftPayload = JSON.parse(measurements[0].payload);
  assert.equal(leftPayload.text, 'he');

  const rightMeasurements = db.prepare(`SELECT * FROM InitDoc_body_measurement WHERE block_id = ?`).all(rightBlockId);
  assert.equal(rightMeasurements.length, 1);
  assert.notEqual(rightMeasurements[0].id, measId);
  const rightPayload = JSON.parse(rightMeasurements[0].payload);
  assert.equal(rightPayload.text, 'llo');

  await app.close?.();
});

test('R2 block.split with failing measurement adapter rolls back', async () => {
  registerAnnotatedTextContract('failingMeas', Object.freeze({ kind: 'measurement' }));
  registerAnnotatedTextStructuralExtension('failingMeas', Object.freeze({
    version: 1,
    validate: function validate() {},
    edit: function edit() {},
    partition: function partition() {
      throw new Error('intentional partition failure');
    },
    combine: function combine() {},
  }));

  function failingDoc() {
    return entity('FailingDoc', {
      project: ref('Project'),
      owner: ref('User'),
      body: annotatedText({
        project: 'project',
        owner: 'owner',
        block: {},
        annotations: [annotation('note', { fields: {} })],
        measurements: [measurement('failing', { extension: 'failingMeas' })],
      }),
      grant: [scope(() => everyone()).can(() => grant(read, write))],
    });
  }

  const db = new DatabaseSync(':memory:');
  const FailingDoc = failingDoc();
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY)');
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY)');
  db.exec("INSERT INTO Project (id) VALUES ('p1')");
  db.exec("INSERT INTO User (id) VALUES ('u1')");
  executeDDL(FailingDoc, db);
  const app = workbench({ db, entities: [FailingDoc] });
  app.start();
  await app.ready;

  const created = await app.dispatch({
    actionId: 'create', type: 'FailingDoc.create',
    payload: { id: 'd1', project: 'p1', owner: 'u1' }, principal: { id: 'u1' },
  });
  const blockId = created.events[0].data.__workbench.annotatedText.body.initialBlockId;

  const op1 = await app.dispatch({
    actionId: 'op1', type: 'FailingDoc.body.operation', scope: 'FailingDoc:d1', principal: { id: 'u1' },
    payload: { version: 1, id: 'd1', expected: { structuralRevision: 1, frontier: [] }, operation: { kind: 'text.apply', blockId, operation: INSERT_HELLO } },
  });
  assert.equal(op1.ok, true);

  db.prepare(`INSERT INTO FailingDoc_body_measurement (id, block_id, family, format_version, payload) VALUES ('m1', ?, 'failing', 1, '{}')`).run(blockId);

  const split = await app.dispatch({
    actionId: 'split', type: 'FailingDoc.body.operation', scope: 'FailingDoc:d1', principal: { id: 'u1' },
    payload: { version: 2, id: 'd1', expected: { structuralRevision: 1, frontier: [[A, 1]] }, operation: { kind: 'block.split', blockId, utf16Offset: 2 } },
  });
  assert.equal(split.ok, false);
  assert.equal(split.failure.category, 'invalid-input');

  const state = db.prepare('SELECT structure_version FROM FailingDoc_body_state WHERE document_id = ?').get('d1');
  assert.equal(state.structure_version, 1);

  await app.close?.();
});

test('R2 block.split with non-deterministic measurement partition rolls back', async () => {
  let callCount = 0;
  registerAnnotatedTextContract('nonDetMeas', Object.freeze({ kind: 'measurement' }));
  registerAnnotatedTextStructuralExtension('nonDetMeas', Object.freeze({
    version: 1,
    validate: function validate() {},
    edit: function edit() {},
    partition: function partition(input) {
      callCount++;
      const offset = input.utf16Offset;
      const blockText = input.blockText;
      if (callCount === 1) {
        return Object.freeze({ version: 1, leftPayload: { text: blockText.slice(0, offset) }, rightPayload: { text: blockText.slice(offset) } });
      }
      return Object.freeze({ version: 1, leftPayload: { text: blockText.slice(0, offset).toUpperCase() }, rightPayload: { text: blockText.slice(offset).toUpperCase() } });
    },
    combine: function combine() {},
  }));

  function nonDetDoc() {
    return entity('NonDetDoc', {
      project: ref('Project'),
      owner: ref('User'),
      body: annotatedText({
        project: 'project',
        owner: 'owner',
        block: {},
        annotations: [annotation('note', { fields: {} })],
        measurements: [measurement('nonDet', { extension: 'nonDetMeas' })],
      }),
      grant: [scope(() => everyone()).can(() => grant(read, write))],
    });
  }

  const db = new DatabaseSync(':memory:');
  const NonDetDoc = nonDetDoc();
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY)');
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY)');
  db.exec("INSERT INTO Project (id) VALUES ('p1')");
  db.exec("INSERT INTO User (id) VALUES ('u1')");
  executeDDL(NonDetDoc, db);
  const app = workbench({ db, entities: [NonDetDoc] });
  app.start();
  await app.ready;

  const created = await app.dispatch({
    actionId: 'create', type: 'NonDetDoc.create',
    payload: { id: 'd1', project: 'p1', owner: 'u1' }, principal: { id: 'u1' },
  });
  const blockId = created.events[0].data.__workbench.annotatedText.body.initialBlockId;

  const op1 = await app.dispatch({
    actionId: 'op1', type: 'NonDetDoc.body.operation', scope: 'NonDetDoc:d1', principal: { id: 'u1' },
    payload: { version: 1, id: 'd1', expected: { structuralRevision: 1, frontier: [] }, operation: { kind: 'text.apply', blockId, operation: INSERT_HELLO } },
  });
  assert.equal(op1.ok, true);

  db.prepare(`INSERT INTO NonDetDoc_body_measurement (id, block_id, family, format_version, payload) VALUES ('m1', ?, 'nonDet', 1, '{}')`).run(blockId);

  const split = await app.dispatch({
    actionId: 'split', type: 'NonDetDoc.body.operation', scope: 'NonDetDoc:d1', principal: { id: 'u1' },
    payload: { version: 2, id: 'd1', expected: { structuralRevision: 1, frontier: [[A, 1]] }, operation: { kind: 'block.split', blockId, utf16Offset: 2 } },
  });
  assert.equal(split.ok, false);

  const state = db.prepare('SELECT structure_version FROM NonDetDoc_body_state WHERE document_id = ?').get('d1');
  assert.equal(state.structure_version, 1);

  await app.close?.();
});

test('R2 v2 event with substituted memberships is rejected with no partial rows', async () => {
  const { app, db } = await appFor();
  const created = await app.dispatch({
    actionId: 'create', type: 'InitDoc.create',
    payload: { id: 'd1', project: 'p1', owner: 'u1' }, principal: { id: 'u1' },
  });
  const blockId = created.events[0].data.__workbench.annotatedText.body.initialBlockId;

  const op1 = await app.dispatch({
    actionId: 'op1', type: 'InitDoc.body.operation', scope: 'InitDoc:d1', principal: { id: 'u1' },
    payload: { version: 1, id: 'd1', expected: { structuralRevision: 1, frontier: [] }, operation: { kind: 'text.apply', blockId, operation: INSERT_HELLO } },
  });
  assert.equal(op1.ok, true);

  const op2 = await app.dispatch({
    actionId: 'op2', type: 'InitDoc.body.operation', scope: 'InitDoc:d1', principal: { id: 'u1' },
    payload: { version: 1, id: 'd1', expected: { structuralRevision: 1, frontier: [[A, 1]] }, operation: { kind: 'text.apply', blockId, operation: INSERT_WORLD } },
  });
  assert.equal(op2.ok, true);

  const current = restoreTextFamilyCheckpoint(JSON.parse(
    db.prepare('SELECT family_checkpoint FROM InitDoc_body_state WHERE document_id = ?').get('d1').family_checkpoint,
  ));
  const newBlockId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const splitResult = splitBlock(current, blockId, newBlockId, 5);
  assert.equal(splitResult.type, 'split');

  const handle = native('InitDoc', 'body', 'operated');
  const badMemberships = [{ annotationId: 'fake', blockId, ordinal: 0, start: { point: ['point', ['root'], 'left'], basisFrontier: [] }, end: { point: ['point', ['element', [[A, 2], 1]], 'right'], basisFrontier: [[A, 2]] } }];

  assert.throws(() => app.entities.get('InitDoc').projection.apply({
    handle,
    data: {
      version: 2,
      id: 'd1',
      before: { structuralRevision: 1, frontier: [[A, 2]] },
      operation: { kind: 'block.split', leftBlockId: blockId, rightBlockId: newBlockId, utf16Offset: 5 },
      after: { structuralRevision: 2, frontier: [[A, 2]] },
      family: textFamilyCheckpoint(splitResult.family),
      blocks: [{ id: blockId, epoch: 1, fields: { reviewed: true } }, { id: newBlockId, epoch: 1, fields: { reviewed: true } }],
      memberships: badMemberships,
      measurements: [],
    },
  }, db), /do not match split membership projection/);

  const persisted = db.prepare('SELECT structure_version FROM InitDoc_body_state WHERE document_id = ?').get('d1');
  assert.equal(persisted.structure_version, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM InitDoc_body_block WHERE document_id = 'd1'").get().count, 1);

  await app.close?.();
});

test('R2 projection rejects a fabricated right block epoch', async () => {
  const { app, db } = await appFor();
  const created = await app.dispatch({
    actionId: 'create', type: 'InitDoc.create',
    payload: { id: 'd1', project: 'p1', owner: 'u1' }, principal: { id: 'u1' },
  });
  const blockId = created.events[0].data.__workbench.annotatedText.body.initialBlockId;
  await app.dispatch({
    actionId: 'op1', type: 'InitDoc.body.operation', scope: 'InitDoc:d1', principal: { id: 'u1' },
    payload: { version: 1, id: 'd1', expected: { structuralRevision: 1, frontier: [] }, operation: { kind: 'text.apply', blockId, operation: INSERT_HELLO } },
  });

  const current = restoreTextFamilyCheckpoint(JSON.parse(
    db.prepare('SELECT family_checkpoint FROM InitDoc_body_state WHERE document_id = ?').get('d1').family_checkpoint,
  ));
  const rightBlockId = 'cccccccccccccccccccccccccccccccc';
  const split = splitBlock(current, blockId, rightBlockId, 2);
  const handle = native('InitDoc', 'body', 'operated');
  assert.throws(() => app.entities.get('InitDoc').projection.apply({
    handle,
    data: {
      version: 2, id: 'd1',
      before: { structuralRevision: 1, frontier: [[A, 1]] },
      operation: { kind: 'block.split', leftBlockId: blockId, rightBlockId, utf16Offset: 2 },
      after: { structuralRevision: 2, frontier: [[A, 1]] },
      family: textFamilyCheckpoint(split.family),
      blocks: [{ id: blockId, epoch: 1, fields: { reviewed: true } }, { id: rightBlockId, epoch: 2, fields: { reviewed: true } }],
      memberships: [], measurements: [],
    },
  }, db), /epochs do not match source/);
  assert.equal(db.prepare('SELECT structure_version FROM InitDoc_body_state WHERE document_id = ?').get('d1').structure_version, 1);
  await app.close?.();
});

test('R1 text.apply still works after R2 code is present', async () => {
  const { app, db } = await appFor();
  const created = await app.dispatch({
    actionId: 'create', type: 'InitDoc.create',
    payload: { id: 'd1', project: 'p1', owner: 'u1' }, principal: { id: 'u1' },
  });
  const blockId = created.events[0].data.__workbench.annotatedText.body.initialBlockId;

  const result = await app.dispatch({
    actionId: 'op1', type: 'InitDoc.body.operation', scope: 'InitDoc:d1', principal: { id: 'u1' },
    payload: { version: 1, id: 'd1', expected: { structuralRevision: 1, frontier: [] }, operation: { kind: 'text.apply', blockId, operation: INSERT_HELLO } },
  });
  assert.equal(result.ok, true);
  assert.equal(result.events[0].data.version, 1);

  const state = db.prepare('SELECT * FROM InitDoc_body_state WHERE document_id = ?').get('d1');
  assert.equal(state.structure_version, 1);

  const family = restoreTextFamilyCheckpoint(JSON.parse(state.family_checkpoint));
  assert.equal(materializeBlock(family, blockId), 'hello');

  await app.close?.();
});

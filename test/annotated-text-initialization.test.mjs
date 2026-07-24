import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  annotatedText, annotation, boolean, entity, everyone, executeDDL, executeFrameworkDDL, measurement,
  grant, read, ref, scope, text, write,
} from '../src/internal.mjs';
import { restoreTextFamilyCheckpoint } from '../src/annotated-text-family.mjs';

function doc() {
  return entity('InitDoc', {
    project: ref('Project'),
    owner: ref('User'),
    body: annotatedText({
      project: 'project',
      owner: 'owner',
      block: { reviewed: boolean({ default: true }) },
      annotations: [annotation('note', { fields: {} })],
      measurements: [measurement('source')],
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

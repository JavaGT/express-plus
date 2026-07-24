import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, { entity, everyone, executeDDL, executeFrameworkDDL, grant, read, scope, text, write } from '../src/internal.mjs';
import { canonicalTextOp } from '../src/annotated-text.mjs';

const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const insert = ['workbench.text', 1, [A, 1], 1, [], ['insert', ['root'], 'hello']];

function doc() {
  return entity('TextDoc', {
    body: text.crdt(),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
}

test('text.crdt native operation is authorized, committed raw, and stores its checkpoint in the declared field cell', async () => {
  const db = new DatabaseSync(':memory:');
  const TextDoc = doc();
  executeFrameworkDDL(db);
  executeDDL(TextDoc, db);
  const app = workbench({ db, entities: [TextDoc] });
  app.start();
  await app.ready;
  const created = await app.dispatch({ actionId: 'create', type: 'TextDoc.create', payload: { id: 'd1' }, principal: { id: 'u1' } });
  assert.equal(created.ok, true);
  const result = await app.dispatch({ actionId: 'apply', type: 'TextDoc.body.apply', payload: { id: 'd1', operation: insert }, principal: { id: 'u1' } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.events[0].data, { id: 'd1', operation: canonicalTextOp(insert) });
  assert.equal(result.events[0].type, 'TextDoc.body.applied');
  const stored = db.prepare('SELECT body FROM TextDoc WHERE id = ?').get('d1');
  assert.ok(JSON.parse(stored.body).operations[`${A}:1`]);
  const hydrated = app.entities.get('TextDoc').deserializeRow(stored);
  assert.equal(hydrated.body, 'hello');
  assert.equal(hydrated.__textCheckpoints, undefined);
  const rejected = await app.dispatch({ actionId: 'whole', type: 'TextDoc.create', payload: { id: 'd2', body: 'whole' }, principal: { id: 'u1' } });
  assert.equal(rejected.ok, false);
  const updateRejected = await app.dispatch({ actionId: 'whole-update', type: 'TextDoc.update', payload: { id: 'd1', body: 'whole' }, principal: { id: 'u1' } });
  assert.equal(updateRejected.ok, false);
  await app.close?.();
});

test('text.crdt native operation rejects malformed payload before commit', async () => {
  const db = new DatabaseSync(':memory:');
  const TextDoc = doc();
  executeFrameworkDDL(db);
  executeDDL(TextDoc, db);
  const app = workbench({ db, entities: [TextDoc] });
  app.start();
  await app.ready;
  await app.dispatch({ actionId: 'create', type: 'TextDoc.create', payload: { id: 'd1' }, principal: { id: 'u1' } });
  const malformed = await app.dispatch({ actionId: 'bad', type: 'TextDoc.body.apply', payload: { id: 'd1', operation: ['bad'] }, principal: { id: 'u1' } });
  assert.equal(malformed.ok, false);
  const extra = await app.dispatch({ actionId: 'extra', type: 'TextDoc.body.apply', payload: { id: 'd1', operation: insert, extra: true }, principal: { id: 'u1' } });
  assert.equal(extra.ok, false);
});

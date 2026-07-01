// app.batch() — a server-side composed mutation (SPEC §11, ADR #13).
// N actions run as ONE transaction = ONE composed commit (one actionId, one
// `now`), all-or-nothing. Any sub-action denial rolls back the ENTIRE batch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import expressPlus, { entity, text, ref, scope, grant, read, write, subscribe, everyone } from '../src/index.mjs';
import { principal } from '../src/principal.mjs';

// An owner-scoped Note: only the owner may write/remove.
function ownedNote() {
  return entity('BatchNote', {
    fields: {
      body: text(),
      owner: ref('User', { role: 'owner', readonly: true }),
    },
    grant: () => [
      scope(() => everyone()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read),
      ),
    ],
  });
}

function ownedCounter() {
  return entity('BatchCounter', {
    fields: {
      n: text(),
      owner: ref('User', { role: 'owner', readonly: true }),
    },
    grant: () => [
      scope(() => everyone()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read),
      ),
    ],
  });
}

async function setup(t, Entity, who) {
  const db = new DatabaseSync(':memory:');
  const app = expressPlus({ db });
  app.mount('/notes', Entity);
  await app.ddl();
  app.listen(0, { principalOf: () => who });
  await app.ready;
  t.after(() => { app.httpServer.close(); db.close(); });
  return { app, db };
}

const alice = principal({ type: 'user', id: 'alice' });

test('batch commits multiple creates atomically under one actionId', async (t) => {
  const { app, db } = await setup(t, ownedNote(), alice);

  const result = await app.batch([
    { type: 'BatchNote.create', payload: { body: 'first' } },
    { type: 'BatchNote.create', payload: { body: 'second' } },
  ], { principal: alice });

  assert.equal(result.granted, true, 'batch granted');
  assert.equal(result.deduped, false, 'fresh batch');
  assert.equal(result.events.length, 2, 'two composed events');
  // ONE actionId across the whole batch (one composed commit).
  const actionIds = new Set(result.events.map((e) => e.actionId));
  assert.equal(actionIds.size, 1, 'all events share one actionId');

  // Both rows committed.
  const rows = db.prepare('SELECT body FROM BatchNote ORDER BY body').all();
  assert.deepEqual(rows.map((r) => r.body), ['first', 'second']);
});

test('a denied sub-action rolls back the ENTIRE batch (all-or-nothing)', async (t) => {
  // The BatchDeny grant only grants read — its post-grant denies writes.
  // A batch that creates a BatchNote then a BatchDeny must roll back BOTH.
  const alwaysDeny = entity('BatchDeny', {
    fields: { body: text() },
    grant: () => [scope(() => everyone()).can(() => grant(read))],
  });
  const db = new DatabaseSync(':memory:');
  const app = expressPlus({ db });
  app.mount('/notes', ownedNote());
  app.mount('/deny', alwaysDeny);
  await app.ddl();
  app.listen(0, { principalOf: () => alice });
  await app.ready;
  t.after(() => { app.httpServer.close(); db.close(); });

  const result = await app.batch([
    { type: 'BatchNote.create', payload: { body: 'mine' } },
    { type: 'BatchDeny.create', payload: { body: 'should-be-denied' } },
  ], { principal: alice });

  assert.equal(result.granted, false, 'batch denied by the second sub-action');
  assert.equal(result.events.length, 0, 'no events on a denied batch');

  const count = db.prepare('SELECT COUNT(*) AS c FROM BatchNote').get().c;
  assert.equal(count, 0, 'no row survived the rollback');
});

test('re-sending the same actionId is a dedupe (returns the committed events)', async (t) => {
  const { app } = await setup(t, ownedNote(), alice);

  const actions = [
    { type: 'BatchNote.create', payload: { body: 'dedupe' } },
  ];

  const first = await app.batch(actions, { principal: alice });
  assert.equal(first.granted, true);
  assert.equal(first.deduped, false);
  const firstActionId = first.events[0].actionId;

  // Re-dispatch the SAME actionId manually through the kernel to confirm dedupe.
  const retry = await app.writeQueue.run(() => app.kernel.dispatchBatch({
    actionId: firstActionId,
    actions,
    principal: alice,
  }));
  assert.equal(retry.granted, true);
  assert.equal(retry.deduped, true, 'second dispatch with the same actionId dedupes');
  assert.equal(retry.events.length, 1);
  assert.equal(retry.events[0].type, 'BatchNote.created');
});

test('batch spans multiple entity types in one composed commit', async (t) => {
  const db = new DatabaseSync(':memory:');
  const app = expressPlus({ db });
  app.mount('/notes', ownedNote());
  app.mount('/counters', ownedCounter());
  await app.ddl();
  app.listen(0, { principalOf: () => alice });
  await app.ready;
  t.after(() => { app.httpServer.close(); db.close(); });

  const result = await app.batch([
    { type: 'BatchNote.create', payload: { body: 'note' } },
    { type: 'BatchCounter.create', payload: { n: '1' } },
  ], { principal: alice });

  assert.equal(result.granted, true);
  assert.equal(result.events.length, 2);
  const types = result.events.map((e) => e.type).sort();
  assert.deepEqual(types, ['BatchCounter.created', 'BatchNote.created']);
  const actionIds = new Set(result.events.map((e) => e.actionId));
  assert.equal(actionIds.size, 1, 'cross-entity batch shares one actionId');

  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM BatchNote').get().c, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM BatchCounter').get().c, 1);
});

test('empty batch is a no-op granted with no events', async (t) => {
  const { app } = await setup(t, ownedNote(), alice);
  const result = await app.batch([], { principal: alice });
  assert.equal(result.granted, true);
  assert.equal(result.events.length, 0);
});

// app.batch() — a server-side composed mutation (SPEC §11, ADR #13).
// N actions run as ONE transaction = ONE composed commit (one actionId, one
// `now`), all-or-nothing. Any sub-action denial rolls back the ENTIRE batch.

import { text, ref, scope, grant, read, write, subscribe, everyone } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import workbench, { entity } from '../build/internal.mjs';
import { principal } from '../build/principal.mjs';

// An owner-scoped Note: only the owner may write/remove.
function ownedNote() {
  return entity('BatchNote', {
        body: text(),
    owner: ref('User', { role: 'owner', readonly: true }),

    grant: () => [
      scope(() => everyone()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read),
      ),
    ],
  });
}

function ownedCounter() {
  return entity('BatchCounter', {
        n: text(),
    owner: ref('User', { role: 'owner', readonly: true }),

    grant: () => [
      scope(() => everyone()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read),
      ),
    ],
  });
}

async function setup(t, Entity, who) {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db });
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

  assert.equal(result.ok, true, 'batch granted');
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
        body: text(),

    grant: () => [scope(() => everyone()).can(() => grant(read))],
  });
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db });
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

  assert.equal(result.ok, false, 'batch denied by the second sub-action');
  assert.equal(result.failure.category, 'denied');

  const count = db.prepare('SELECT COUNT(*) AS c FROM BatchNote').get().c;
  assert.equal(count, 0, 'no row survived the rollback');
});

test('re-sending the same actionId is a dedupe (returns the committed events)', async (t) => {
  const { app } = await setup(t, ownedNote(), alice);

  const actions = [
    { type: 'BatchNote.create', payload: { body: 'dedupe' } },
  ];

  const first = await app.batch(actions, { principal: alice });
  assert.equal(first.ok, true);
  assert.equal(first.deduped, false);
  const firstActionId = first.events[0].actionId;

  // Re-dispatch the SAME actionId manually through the kernel to confirm dedupe.
  const retry = await app.writeQueue.run(() => app.kernel.dispatchBatch({
    actionId: firstActionId,
    actions,
    principal: alice,
  }));
  assert.equal(retry.ok, true);
  assert.equal(retry.deduped, true, 'second dispatch with the same actionId dedupes');
  assert.equal(retry.events.length, 1);
  assert.equal(retry.events[0].type, 'BatchNote.created');
});

test('a reused batch actionId with different actions is rejected instead of aliasing the receipt', async (t) => {
  const { app, db } = await setup(t, ownedNote(), alice);
  const first = [{ type: 'BatchNote.create', payload: { body: 'first' } }];
  const conflicting = [{ type: 'BatchNote.create', payload: { body: 'conflict' } }];

  assert.equal((await app.kernel.dispatchBatch({ actionId: 'browser-id', actions: first, principal: alice, scope: 'project:p1' })).ok, true);
  const retry = await app.kernel.dispatchBatch({ actionId: 'browser-id', actions: conflicting, principal: alice, scope: 'project:p1' });

  assert.equal(retry.ok, false);
  assert.equal(retry.failure.category, 'conflict');
  assert.deepEqual(db.prepare('SELECT body FROM BatchNote').all().map((row) => row.body), ['first']);
});

test('batch spans multiple entity types in one composed commit', async (t) => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db });
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

  assert.equal(result.ok, true);
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
  assert.equal(result.ok, true);
  assert.equal(result.events.length, 0);
});

test('batch action factories run inside the write queue and feed the ordinary batch pipeline', async (t) => {
  const { app, db } = await setup(t, ownedNote(), alice);
  let factoryRan = false;

  const result = await app.batch(() => {
    factoryRan = true;
    assert.equal(
      db.prepare('SELECT COUNT(*) AS c FROM BatchNote').get().c,
      0,
      'the factory observes state immediately before its composed mutation',
    );
    return [{ type: 'BatchNote.create', payload: { body: 'planned-in-queue' } }];
  }, { principal: alice });

  assert.equal(factoryRan, true);
  assert.equal(result.ok, true);
  assert.equal(result.events[0].type, 'BatchNote.created');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM BatchNote').get().c, 1);
});

test('batch action factories must be synchronous and a failure releases the write queue', async (t) => {
  const { app, db } = await setup(t, ownedNote(), alice);

  await assert.rejects(
    app.batch(async () => [{ type: 'BatchNote.create', payload: { body: 'never' } }], { principal: alice }),
    /synchronous action array/,
  );

  const result = await app.batch(
    [{ type: 'BatchNote.create', payload: { body: 'queue-released' } }],
    { principal: alice },
  );
  assert.equal(result.ok, true);
	assert.deepEqual(
		db.prepare('SELECT body FROM BatchNote').all().map((row) => row.body),
		['queue-released']
	);
});

// The deny in `a denied sub-action rolls back…` could come from either the
// first-layer `authorize` OR the durable variant's in-txn afterProjection seam.
// The kernel's `authorize` is `() => true` (serve.mjs), so a create deny reaches
// the in-txn post-grant — this test pins that: it confirms the ROLLBACK happens
// mid-transaction (the first action's row is undone), proving the 403 came from
// inside the open BEGIN→COMMIT, not a pre-txn gate. A pre-txn authorize deny
// would leave the first action un-attempted; an in-txn deny leaves it rolled back.
test('a post-grant deny rolls back the first action mid-transaction (in-txn ROLLBACK)', async (t) => {
  // PostGrantDeny grants only read → create passes `authorize: () => true` and
  // runs the handler, but the in-txn afterProjection admission → mayVerb('create')
  // denies → 403 thrown inside the open transaction → ROLLBACK.
  const postGrantDeny = entity('PostGrantDeny', {
        body: text(),

    grant: () => [scope(() => everyone()).can(() => grant(read))],
  });
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db });
  app.mount('/notes', ownedNote());
  app.mount('/deny', postGrantDeny);
  await app.ddl();
  app.listen(0, { principalOf: () => alice });
  await app.ready;
  t.after(() => { app.httpServer.close(); db.close(); });

  // First action commits a BatchNote; second action is denied IN-TXN. If the
  // rollback is mid-transaction, the BatchNote row is undone (count 0). The
  // cursor/seq also must not advance past the rolled-back work.
  const result = await app.batch([
    { type: 'BatchNote.create', payload: { body: 'committed-then-rolled-back' } },
    { type: 'PostGrantDeny.create', payload: { body: 'denied-in-txn' } },
  ], { principal: alice });

  assert.equal(result.ok, false, 'denied by the in-txn post-grant');
  assert.equal(result.failure.category, 'denied');

  // The first action's row must NOT survive — proving the 403 was thrown INSIDE
  // the open transaction (ROLLBACK undid the projected BatchNote), not before it.
  const noteCount = db.prepare('SELECT COUNT(*) AS c FROM BatchNote').get().c;
  assert.equal(noteCount, 0, 'first action rolled back mid-transaction');

  // And the _Log must hold no row for this actionId — the whole composed commit
  // was undone, so nothing was appended to the durable log.
  const logCount = db.prepare('SELECT COUNT(*) AS c FROM _Log WHERE actionId = ?').get(
    result.events?.[0]?.actionId ?? '',
  ).c;
  assert.equal(logCount, 0, 'no _Log row survives a rolled-back batch');
});

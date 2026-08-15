// app-live-mutation.test.mjs — the S3/A8 wiring (JavaGT/workbench#114): the
// app kernel routes `live`-tier entities through the no-history mutation lane
// (#100) exactly like the package-internal createServer path. The app-level
// generated CRUD, registered actions, and atomic operations on live entities
// must produce the #100 write surface — no `_Log` row, no `_Cursor` bump,
// `_LiveRevision` + `_InvalidationLedger` marker, `_NoHistoryReceipt`
// idempotency, and no `_ActionReceipt` payload retention — while the durable
// lane stays byte-for-byte unchanged.
//
// Acceptance coverage:
//   1. app-level live create/update — storage-asserted no-history surface +
//      retry dedupe via `_NoHistoryReceipt`;
//   2. mixed-tier app dispatch (live + durable in one commit) reassembles in
//      original order; a mixed retry returns the complete outcome;
//   3. app-level atomic operations on live entities run through the live lane
//      with field admission;
//   4. `live: true` routes correctly; `history: 'none'` stays a compile error;
//   5. regression — the durable lane writes `_Log` + `_ActionReceipt` as before.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

import workbench from '../build/internal.mjs';
import {
  atomicOperation,
  entity,
  grant,
  increment,
  number,
  principal,
  read,
  subscribe,
  text,
  write,
} from '../build/index.mjs';

const user = principal({ type: 'user', id: 'u1' });

const LiveNote = entity('LiveNote', {
  title: text(),
  count: number({ default: 0 }),
  grant: () => grant(read, write, subscribe),
  live: true,
});

const DurableNote = entity('DurableNote', {
  title: text(),
  grant: () => grant(read, write, subscribe),
});

// The mixed-tier registered action. LiveNote routes live; DurableNote durable.
const mixedAction = {
  type: 'Mixed.commit',
  authorize: async () => true,
  handler: ({ payload }) => [
    { type: 'LiveNote.created', scope: `LiveNote:${payload.live.id}`, data: payload.live },
    { type: 'DurableNote.created', scope: `DurableNote:${payload.durable.id}`, data: payload.durable },
  ],
};

function boot({ entities = [LiveNote, DurableNote], actions = [] } = {}) {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, entities, actions });
  return { db, app };
}

const logRows = (db) => db.prepare('SELECT * FROM _Log').all();
const cursorRows = (db) => db.prepare('SELECT * FROM _Cursor').all();
const receiptRows = (db) => db.prepare('SELECT * FROM _NoHistoryReceipt').all();
const actionReceiptCount = (db) => db.prepare('SELECT COUNT(*) AS count FROM _ActionReceipt').get().count;
const revisionOf = (db, key) => {
  const row = db.prepare('SELECT revision FROM _LiveRevision WHERE resourceKey = ?').get(key);
  return row === undefined ? 0 : row.revision;
};
const invalidationOf = (db, key) => db.prepare(
  'SELECT resourceKey, kind, revision FROM _InvalidationLedger WHERE resourceKey = ? ORDER BY revision',
).all(key).map((row) => ({ resourceKey: row.resourceKey, kind: row.kind, revision: row.revision }));

// ---- 1. app-level live create/update — no-history surface -------------------

test('app-level live create/update writes no _Log, no _Cursor, no _ActionReceipt; bumps revision + ledger marker', async (t) => {
  const { db, app } = boot();
  t.after(async () => { await app.shutdown(); db.close(); });
  await app.start();

  const created = await app.dispatch({
    actionId: randomUUID(), type: 'LiveNote.create',
    payload: { id: 'n1', title: 'live note' },
    principal: user,
  });
  assert.equal(created.ok, true);
  assert.equal(logRows(db).length, 0, 'a live app mutation must never write _Log');
  assert.equal(cursorRows(db).length, 0, 'a live app mutation must not bump _Cursor');
  assert.equal(db.prepare('SELECT id, title FROM LiveNote WHERE id = ?').get('n1').title, 'live note');
  assert.equal(revisionOf(db, 'LiveNote:n1'), 1, 'the live revision is bumped');
  assert.deepEqual(
    invalidationOf(db, 'LiveNote:n1'),
    [{ resourceKey: 'LiveNote:n1', kind: 'resource', revision: 1 }],
    'the invalidation ledger marker is written',
  );
  assert.equal(actionReceiptCount(db), 0, 'a live-only commit retains no _ActionReceipt payload');

  const updated = await app.dispatch({
    actionId: randomUUID(), type: 'LiveNote.update',
    payload: { id: 'n1', title: 'live note v2' },
    principal: user,
  });
  assert.equal(updated.ok, true);
  assert.equal(logRows(db).length, 0);
  assert.equal(cursorRows(db).length, 0);
  assert.equal(db.prepare('SELECT title FROM LiveNote WHERE id = ?').get('n1').title, 'live note v2');
  assert.equal(revisionOf(db, 'LiveNote:n1'), 2);
  assert.equal(actionReceiptCount(db), 0);
});

test('app-level live retry dedupes via _NoHistoryReceipt without a second apply', async (t) => {
  const { db, app } = boot();
  t.after(async () => { await app.shutdown(); db.close(); });
  await app.start();

  const request = {
    actionId: 'live-retry-app', type: 'LiveNote.create',
    payload: { id: 'n1', title: 'once' },
    principal: user,
  };
  const first = await app.dispatch(request);
  const retry = await app.dispatch(request);

  assert.equal(first.ok, true);
  assert.equal(first.deduped, false);
  assert.equal(retry.ok, true);
  assert.equal(retry.deduped, true, 'the retry settles from the minimized receipt');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM LiveNote').get().count, 1);
  assert.equal(revisionOf(db, 'LiveNote:n1'), 1);
  assert.equal(receiptRows(db).length, 1);
  assert.equal(logRows(db).length, 0);
  assert.equal(actionReceiptCount(db), 0);
});

// ---- 2. mixed-tier app dispatch reassembles in order ------------------------

test('a mixed-tier app action routes per entity tier and reassembles in original order', async (t) => {
  const { db, app } = boot({ actions: [mixedAction] });
  t.after(async () => { await app.shutdown(); db.close(); });
  await app.start();

  const request = {
    actionId: 'mixed-app-1', type: 'Mixed.commit',
    payload: {
      live: { id: 'n1', title: 'live' },
      durable: { id: 'a1', title: 'durable' },
    },
    principal: user,
  };
  const outcome = await app.dispatch(request);
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.events.map((event) => event.type), ['LiveNote.created', 'DurableNote.created']);
  assert.equal(logRows(db).length, 1, 'only the durable event reaches _Log');
  assert.equal(logRows(db)[0].eventType, 'DurableNote.created');
  assert.equal(db.prepare('SELECT title FROM LiveNote WHERE id = ?').get('n1').title, 'live');
  assert.equal(db.prepare('SELECT title FROM DurableNote WHERE id = ?').get('a1').title, 'durable');
  assert.equal(revisionOf(db, 'LiveNote:n1'), 1);
  assert.equal(actionReceiptCount(db), 1, 'a mixed commit still writes the owning-stream receipt');

  const retry = await app.dispatch(request);
  assert.equal(retry.ok, true);
  assert.equal(retry.deduped, true, 'a mixed retry is served from both receipts');
  assert.deepEqual(retry.events.map((event) => event.type), ['LiveNote.created', 'DurableNote.created']);
  assert.deepEqual(retry.events.map((event) => event.data.title), ['live', 'durable']);
  assert.deepEqual(retry.resultData, outcome.resultData);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM LiveNote').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM DurableNote').get().count, 1);
  assert.equal(logRows(db).length, 1, 'the durable event is not appended twice');
});

// ---- 3. app-level atomic operations on live entities ------------------------

// A registered atomic action over the live LiveNote entity. The registration
// carries the compiled (unbound) record — enough for field admission; the
// transactional read resolves the row inside the commit's write transaction.
function liveAtomicApp({ authorization }) {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, entities: [LiveNote], actions: [{
    type: 'LiveNote.bump',
    authorize: async () => true,
    handler: atomicOperation({
      entity: LiveNote,
      read: ({ db: transactionDb }) => {
        const row = transactionDb.prepare('SELECT count FROM LiveNote WHERE id = ?').get('live-atomic');
        return { id: 'live-atomic', count: row.count };
      },
    }, ({ atomic }) => [{
      type: 'LiveNote.updated',
      scope: 'LiveNote:live-atomic',
      data: { id: 'live-atomic', count: atomic.row.count },
    }]),
  }] });
  app.listen(0, { principalOf: () => user, authorization });
  return { db, app };
}

test('app-level atomic operations on a live entity run through the live lane with field admission', async (t) => {
  const denied = liveAtomicApp({
    authorization: { admit: async ({ fieldName }) => ({ admitted: fieldName !== 'count' }) },
  });
  t.after(async () => {
    denied.app.httpServer?.close();
    await denied.app.shutdown();
    denied.db.close();
  });
  await denied.app.ready;

  const seed = await denied.app.dispatch({
    actionId: 'atomic-seed', type: 'LiveNote.create',
    payload: { id: 'live-atomic', title: 'seed', count: 0 },
    principal: user,
  });
  assert.equal(seed.ok, true);

  const rejected = await denied.app.dispatch({
    actionId: 'atomic-denied-app', type: 'LiveNote.bump',
    payload: { atomicOperations: [increment('count')] },
    principal: user,
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.failure.category, 'denied', 'field admission rejects the atomic update');
  assert.equal(denied.db.prepare('SELECT count FROM LiveNote WHERE id = ?').get('live-atomic').count, 0, 'nothing was applied');
  assert.equal(denied.db.prepare('SELECT COUNT(*) AS count FROM _NoHistoryReceipt').get().count, 1, 'only the seed create receipt — no receipt for the denied atomic update');

  const admitted = liveAtomicApp({ authorization: { admit: async () => ({ admitted: true }) } });
  t.after(async () => {
    admitted.app.httpServer?.close();
    await admitted.app.shutdown();
    admitted.db.close();
  });
  await admitted.app.ready;

  const admittedSeed = await admitted.app.dispatch({
    actionId: 'atomic-seed-2', type: 'LiveNote.create',
    payload: { id: 'live-atomic', title: 'seed', count: 0 },
    principal: user,
  });
  assert.equal(admittedSeed.ok, true);

  const request = {
    actionId: 'atomic-app', type: 'LiveNote.bump',
    payload: { atomicOperations: [increment('count')] },
    principal: user,
  };
  const outcome = await admitted.app.dispatch(request);
  assert.equal(outcome.ok, true);
  assert.equal(admitted.db.prepare('SELECT count FROM LiveNote WHERE id = ?').get('live-atomic').count, 1);
  assert.equal(revisionOf(admitted.db, 'LiveNote:live-atomic'), 2, 'the seed create + the atomic bump both ran through the live lane');
  assert.equal(admitted.db.prepare('SELECT COUNT(*) AS count FROM _Log').get().count, 0, 'the atomic live commit wrote no _Log');
  assert.equal(admitted.db.prepare('SELECT COUNT(*) AS count FROM _ActionReceipt').get().count, 0, 'no _ActionReceipt payload retention');

  const retry = await admitted.app.dispatch(request);
  assert.equal(retry.ok, true);
  assert.equal(retry.deduped, true, 'the atomic live retry settles via _NoHistoryReceipt');
  assert.equal(admitted.db.prepare('SELECT count FROM LiveNote WHERE id = ?').get('live-atomic').count, 1, 'no second apply');
});

// ---- 4. live: true routes; history: 'none' stays a compile error ------------

test('history: \'none\' stays a declaration compile rejection; live: true is the live spelling', () => {
  assert.throws(
    () => entity('RejectedNote', { title: text(), history: { update: 'none' } }),
    /'none' is reserved.*live: true/,
  );
  assert.throws(
    () => entity('RejectedNote2', { title: text(), live: true, history: { update: 'conditional' } }),
    /live entity.*hard error/,
  );
});

// ---- 4b. durable effects are refused on live-tier entities (#114 review #2) --

// A live entity must not declare a durable effect: durable effects anchor
// their job to the triggering event's _Log sequence, and live mutations write
// no _Log row — the row would commit but the job would never enqueue (a silent
// behavioral loss). Refused at declaration compile with a named error.
test('a live-tier entity cannot declare durable effects (compile-time rejection)', () => {
  assert.throws(
    () => entity('LiveDurableNote', {
      title: text(),
      grant: () => grant(read, write, subscribe),
      live: true,
      effects: (Self) => [[Self.created, { durable: 'send-title', with: { title: 'sent' } }]],
    }),
    /live-tier entity.*cannot declare durable effects \(send-title\)/,
  );
  // A history-tier entity keeps declaring the same durable effect (no regression).
  const DurableSource = entity('DurableSourceNote', {
    title: text(),
    grant: () => grant(read, write, subscribe),
    effects: (Self) => [[Self.created, { durable: 'send-title', with: { title: 'sent' } }]],
  });
  assert.equal(DurableSource.name, 'DurableSourceNote');
});

// ---- 4c. no-db app + live entity fails closed at dispatch (#114 review #1) ---

// Without a database the kernel keeps its ephemeral in-memory path (history
// entities stay usable), but a live-tier mutation must NEVER silently degrade
// into the in-memory durable log — it is refused here before any in-memory
// event/log entry is written.
test('a live-tier mutation on a database-less app is refused; no in-memory event/log is written', async (t) => {
  const app = workbench({ entities: [LiveNote] });
  t.after(async () => { await app.shutdown(); });
  await app.start();

  const outcome = await app.dispatch({
    actionId: randomUUID(), type: 'LiveNote.create',
    payload: { id: 'n1', title: 'no db' },
    principal: user,
  });
  assert.equal(outcome.ok, false, 'a live-tier mutation must be refused without a database');
  assert.equal(outcome.failure.category, 'invalid-input');
  assert.match(outcome.failure.message, /live-tier mutations require a durable database/);
  assert.equal(app.kernel.log.length, 0, 'no in-memory event/log entry is written');
});

// ---- 5. regression — the durable lane is unchanged --------------------------

test('the app-level durable lane still writes _Log + _ActionReceipt for history entities', async (t) => {
  const { db, app } = boot();
  t.after(async () => { await app.shutdown(); db.close(); });
  await app.start();

  const result = await app.dispatch({
    actionId: randomUUID(), type: 'DurableNote.create',
    payload: { id: 'a1', title: 'history note' },
    principal: user,
  });
  assert.equal(result.ok, true);
  assert.equal(logRows(db).length, 1);
  assert.equal(logRows(db)[0].eventType, 'DurableNote.created');
  assert.equal(logRows(db)[0].scope, 'DurableNote:a1');
  assert.equal(cursorRows(db).length, 1, 'the durable cursor advanced');
  assert.equal(cursorRows(db)[0].scope, 'DurableNote:a1');
  assert.equal(cursorRows(db)[0].lastSeq, 1);
  assert.equal(actionReceiptCount(db), 1, 'the durable receipt retained');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _NoHistoryReceipt').get().count, 0);
  assert.equal(revisionOf(db, 'DurableNote:a1'), 0, 'no live revision for a history entity');
});

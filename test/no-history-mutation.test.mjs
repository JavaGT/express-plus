// no-history-mutation.test.mjs — the S3/A2 no-history mutation lane
// (JavaGT/workbench#100).
//
// A live-tier entity's mutation must NOT quietly write every mutation into
// `_Log`. It applies the row change, bumps the resource/collection revision,
// writes a MINIMIZED idempotency receipt, and settles the caller — inside the
// write-coordinator transaction. The durable `history` lane is unchanged. This
// suite proves:
//   1. no `_Log` row for live entities (storage-asserted); history still logs;
//   2. the receipt is minimal — ONLY the enumerated fields, no payload/prior
//      values, no event refs;
//   3. retry dedupe — one actionId mutates once under network retry;
//   4. revision conflict — an edit carrying a stale expectedRevision is
//      rejected with the safe `conflict` classification;
//   5. concurrent write settlement through the write coordinator;
//   6. the history path stays byte-for-byte unchanged.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

import workbench, {
  entity,
  text,
  createServer,
  durableMutationVariant,
  liveMutationVariant,
  executeFrameworkDDL,
  generateDDL,
} from '../build/internal.mjs';
import { createWriteQueue } from '../build/write-queue.mjs';

const Note = entity('Note', {
  title: text(),
});

const Article = entity('Article', {
  title: text(),
});

// ---- helpers ---------------------------------------------------------------

// A durable server whose tier resolver routes `Note` to the live lane and
// everything else (Article) to the history lane.
function liveRoutedServer({ db, liveConsumers = [], durableConsumers = [], handlers }) {
  return createServer({
    db,
    handlers,
    pipeline: durableMutationVariant({ projectionConsumers: durableConsumers, postCommitConsumers: durableConsumers }),
    livePipeline: liveMutationVariant({ projectionConsumers: liveConsumers, postCommitConsumers: liveConsumers }),
    tierOfEvent: (handle) => (handle?.entity === 'Note' ? 'live' : 'history'),
    authorize: async () => true,
  });
}

function setup() {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  for (const sql of [...generateDDL(Note), ...generateDDL(Article)]) db.exec(sql);
  const app = workbench({ db, entities: [Note, Article] });
  const boundNote = app.entity(Note);
  const boundArticle = app.entity(Article);
  return { db, boundNote, boundArticle };
}

const noteEvents = (payload, type = 'Note.create') => {
  const verb = type.endsWith('update') ? 'updated' : type.endsWith('remove') ? 'removed' : 'created';
  return [{
    type: `Note.${verb}`,
    scope: `Note:${payload.id}`,
    data: { id: payload.id, title: payload.title },
  }];
};

const articleEvents = (payload) => [{
  type: 'Article.created',
  scope: `Article:${payload.id}`,
  data: { id: payload.id, title: payload.title },
}];

const commonHandlers = {
  'Note.create': ({ payload }) => noteEvents(payload, 'Note.create'),
  'Note.update': ({ payload }) => noteEvents(payload, 'Note.update'),
  'Article.create': ({ payload }) => articleEvents(payload),
};

const logRows = (db) => db.prepare('SELECT * FROM _Log').all();
const receiptRows = (db) => db.prepare('SELECT * FROM _NoHistoryReceipt').all();
const revisionOf = (db, key) => {
  const row = db.prepare('SELECT revision FROM _LiveRevision WHERE resourceKey = ?').get(key);
  return row === undefined ? 0 : row.revision;
};

// ---- 1. no _Log for live entities; history path unchanged ------------------

test('a live mutation writes no _Log row and the history mutation still does', async () => {
  const { db, boundNote, boundArticle } = setup();
  const server = liveRoutedServer({
    db,
    liveConsumers: [boundNote.projection],
    durableConsumers: [boundArticle.projection],
    handlers: commonHandlers,
  });

  const live = await server.dispatch({
    actionId: randomUUID(), type: 'Note.create', payload: { id: 'n1', title: 'live note' },
  });
  assert.equal(live.ok, true);
  assert.equal(logRows(db).length, 0, 'a live-tier mutation must never write _Log');
  // The row change still landed (the live variant applies the projection).
  assert.equal(db.prepare('SELECT id, title FROM Note WHERE id = ?').get('n1').title, 'live note');
  assert.equal(revisionOf(db, 'Note:n1'), 1);

  const history = await server.dispatch({
    actionId: randomUUID(), type: 'Article.create', payload: { id: 'a1', title: 'history article' },
  });
  assert.equal(history.ok, true);
  assert.equal(logRows(db).length, 1, 'a history-tier mutation still writes _Log');
  assert.equal(logRows(db)[0].eventType, 'Article.created');
  assert.equal(logRows(db)[0].scope, 'Article:a1');

  db.close();
});

test('a mixed action routes per entity tier: live events skip _Log, history events land', async () => {
  const { db, boundNote, boundArticle } = setup();
  const server = liveRoutedServer({
    db,
    liveConsumers: [boundNote.projection],
    durableConsumers: [boundArticle.projection],
    handlers: {
      'Mixed.commit': ({ payload }) => [
        ...noteEvents(payload.note, 'Note.create'),
        ...articleEvents(payload.article),
      ],
    },
  });

  const outcome = await server.dispatch({
    actionId: randomUUID(), type: 'Mixed.commit',
    payload: { note: { id: 'n1', title: 'live' }, article: { id: 'a1', title: 'history' } },
  });
  assert.equal(outcome.ok, true);
  const logs = logRows(db);
  assert.equal(logs.length, 1, 'only the history event reaches _Log');
  assert.equal(logs[0].eventType, 'Article.created');

  // The live row change still landed (projection ran for the live event).
  const noteRow = db.prepare('SELECT id, title FROM Note WHERE id = ?').get('n1');
  assert.equal(noteRow.title, 'live');
  const articleRow = db.prepare('SELECT id, title FROM Article WHERE id = ?').get('a1');
  assert.equal(articleRow.title, 'history');

  db.close();
});

test('a mixed-tier retry returns the complete original outcome without applying twice', async () => {
  const { db, boundNote, boundArticle } = setup();
  let calls = 0;
  const server = liveRoutedServer({
    db,
    liveConsumers: [boundNote.projection],
    durableConsumers: [boundArticle.projection],
    handlers: {
      'Mixed.commit': ({ payload }) => {
        calls += 1;
        return [...noteEvents(payload.note, 'Note.create'), ...articleEvents(payload.article)];
      },
    },
  });
  const request = {
    actionId: 'mixed-retry-1', type: 'Mixed.commit',
    payload: { note: { id: 'n1', title: 'live' }, article: { id: 'a1', title: 'history' } },
  };

  const first = await server.dispatch(request);
  const retry = await server.dispatch(request);

  assert.equal(retry.ok, true);
  assert.equal(retry.deduped, true);
  assert.deepEqual(retry.events.map((event) => event.type), ['Note.created', 'Article.created']);
  assert.deepEqual(retry.events.map((event) => event.data.title), ['live', 'history']);
  assert.deepEqual(retry.resultData, first.resultData);
  assert.equal(calls, 1, 'the retry must not rerun the handler');
  assert.equal(revisionOf(db, 'Note:n1'), 1, 'the live projection applies once');
  assert.equal(logRows(db).length, 1, 'the durable event is not appended twice');
  db.close();
});

test('a server without the live pipeline writes _Log for every entity (zero behavior change)', async () => {
  const { db } = setup();
  const server = createServer({
    db,
    handlers: commonHandlers,
    pipeline: durableMutationVariant({ projectionConsumers: [] }),
    authorize: async () => true,
  });
  await server.dispatch({
    actionId: randomUUID(), type: 'Note.create', payload: { id: 'n1', title: 'unrouted' },
  });
  assert.equal(logRows(db).length, 1, 'without live routing the durable lane is the default for every entity');
  db.close();
});

// ---- 2. minimized receipt — enumerated fields only --------------------------

test('the receipt holds only the enumerated fields — no payload, no prior values, no event refs', async () => {
  const { db } = setup();
  const server = liveRoutedServer({ db, handlers: commonHandlers });

  await server.dispatch({
    actionId: 'action-live-1', type: 'Note.create',
    payload: { id: 'n1', title: 'a long title that must never be retained' },
    principal: { type: 'user', id: 'alice' },
  });

  const rows = receiptRows(db);
  assert.equal(rows.length, 1);
  const r = rows[0];
  // Structural assertion — the row carries ONLY the enumerated columns.
  assert.deepEqual(
    Object.keys(r).sort(),
    ['actionId', 'actorId', 'actorType', 'committedAt', 'committedRevision', 'outcome', 'resourceKey', 'safeErrorClassification', 'scope'].sort(),
  );
  assert.equal(r.scope, '');
  assert.equal(r.actionId, 'action-live-1');
  assert.equal(r.resourceKey, 'Note:n1');
  assert.equal(r.committedRevision, 1);
  assert.equal(r.outcome, 'committed');
  assert.equal(r.actorType, 'user');
  assert.equal(r.actorId, 'alice');
  assert.equal(r.safeErrorClassification, null);
  // No payload/prior-value leakage anywhere in the receipt table.
  const raw = db.prepare('SELECT * FROM _NoHistoryReceipt').all();
  assert.ok(!JSON.stringify(raw).includes('long title'), 'the request payload must never reach the receipt');
  // No _ActionReceipt row either (it would retain the payload).
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _ActionReceipt').get().count, 0);

  // Revisions bumped exactly once.
  assert.equal(revisionOf(db, 'Note:n1'), 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _LiveRevision').get().count, 1);
  db.close();
});

// ---- 3. retry dedupe — one actionId mutates once ---------------------------

test('a retried actionId settles to the same outcome without a second apply', async () => {
  const { db, boundNote } = setup();
  const server = liveRoutedServer({ db, liveConsumers: [boundNote.projection], handlers: commonHandlers });

  const first = await server.dispatch({
    actionId: 'action-retry-1', type: 'Note.create', payload: { id: 'n1', title: 'once' },
  });
  assert.equal(first.ok, true);
  assert.equal(first.deduped, false);

  const retry = await server.dispatch({
    actionId: 'action-retry-1', type: 'Note.create', payload: { id: 'n1', title: 'once' },
  });
  assert.equal(retry.ok, true);
  assert.equal(retry.deduped, true, 'the retry is served from the receipt');
  assert.deepEqual(retry.resultData, {
    actionId: 'action-retry-1', resourceKey: 'Note:n1', committedRevision: 1,
  });

  // The row changed exactly once and the revision bumped exactly once.
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM Note').get().count, 1);
  assert.equal(revisionOf(db, 'Note:n1'), 1);
  assert.equal(receiptRows(db).length, 1);
  assert.equal(logRows(db).length, 0);
  db.close();
});

test('an empty actionId is accepted by the live receipt lane like the durable lane', async () => {
  const { db, boundNote } = setup();
  const server = liveRoutedServer({ db, liveConsumers: [boundNote.projection], handlers: commonHandlers });

  const outcome = await server.dispatch({
    actionId: '', type: 'Note.create', payload: { id: 'n1', title: 'empty id' },
  });

  assert.equal(outcome.ok, true);
  assert.equal(receiptRows(db)[0].actionId, '');
  db.close();
});

test('a retry after a process restart (fresh server, same db) still settles without re-applying', async () => {
  const { db, boundNote } = setup();
  const liveConsumers = [boundNote.projection];
  const first = liveRoutedServer({ db, liveConsumers, handlers: commonHandlers });
  await first.dispatch({
    actionId: 'action-restart-1', type: 'Note.create', payload: { id: 'n1', title: 'persisted' },
  });

  const restarted = liveRoutedServer({ db, liveConsumers, handlers: commonHandlers });
  const retry = await restarted.dispatch({
    actionId: 'action-restart-1', type: 'Note.create', payload: { id: 'n1', title: 'persisted' },
  });
  assert.equal(retry.ok, true);
  assert.equal(retry.deduped, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM Note').get().count, 1);
  assert.equal(revisionOf(db, 'Note:n1'), 1);
  db.close();
});

// ---- 4. expected-revision guard --------------------------------------------

function guardedServer({ db, boundNote }) {
  // Custom update handler so `expectedRevision` flows through to the live
  // variant's guard (the generated CRUD handler rejects undeclared payload
  // keys before the guard could see them — the guard is the S3/A6 hook).
  return liveRoutedServer({
    db,
    liveConsumers: [boundNote.projection],
    handlers: {
      ...commonHandlers,
      'Note.update': ({ payload }) => noteEvents(payload, 'Note.update'),
    },
  });
}

test('a revision-mismatch edit is rejected with the safe conflict classification', async () => {
  const { db, boundNote } = setup();
  const server = guardedServer({ db, boundNote });

  const create = await server.dispatch({
    actionId: randomUUID(), type: 'Note.create', payload: { id: 'n1', title: 'v1' },
  });
  assert.equal(create.ok, true);
  assert.equal(revisionOf(db, 'Note:n1'), 1);

  const edit = await server.dispatch({
    actionId: randomUUID(), type: 'Note.update',
    payload: { id: 'n1', title: 'v2', expectedRevision: 1 },
  });
  assert.equal(edit.ok, true);
  assert.equal(edit.events[0].data.title, 'v2');
  assert.equal(revisionOf(db, 'Note:n1'), 2);
  assert.equal(db.prepare('SELECT title FROM Note WHERE id = ?').get('n1').title, 'v2');

  const stale = await server.dispatch({
    actionId: randomUUID(), type: 'Note.update',
    payload: { id: 'n1', title: 'v3', expectedRevision: 1 },
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.failure.category, 'conflict', 'a stale expectedRevision is a safe conflict classification');
  // No blind last-write-wins: the row and revision are untouched.
  assert.equal(db.prepare('SELECT title FROM Note WHERE id = ?').get('n1').title, 'v2');
  assert.equal(revisionOf(db, 'Note:n1'), 2);
  assert.equal(logRows(db).length, 0);
  db.close();
});

test('a malformed expectedRevision fails closed as invalid-input', async () => {
  const { db, boundNote } = setup();
  const server = guardedServer({ db, boundNote });
  const outcome = await server.dispatch({
    actionId: randomUUID(), type: 'Note.create',
    payload: { id: 'n1', title: 'v1', expectedRevision: 'nope' },
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failure.category, 'invalid-input');
  assert.equal(revisionOf(db, 'Note:n1'), 0, 'nothing was applied');
  db.close();
});

// ---- 5. concurrent write settlement ----------------------------------------

test('concurrent writes through the write coordinator settle in order (no lost update)', async () => {
  const { db, boundNote } = setup();
  const writeQueue = createWriteQueue();
  const server = liveRoutedServer({ db, liveConsumers: [boundNote.projection], handlers: commonHandlers });

  const dispatch = (payload) => writeQueue.run(() =>
    server.dispatch({
      actionId: randomUUID(), type: 'Note.update', payload,
    }));

  // Seed the row at revision 1.
  await writeQueue.run(() => server.dispatch({
    actionId: randomUUID(), type: 'Note.create', payload: { id: 'n1', title: 'seed' },
  }));
  assert.equal(revisionOf(db, 'Note:n1'), 1);

  // Two concurrent edits, both blind (no expectedRevision): the coordinator
  // serializes them and neither is lost.
  const [one, two] = await Promise.all([
    dispatch({ id: 'n1', title: 'from-one' }),
    dispatch({ id: 'n1', title: 'from-two' }),
  ]);
  assert.equal(one.ok, true);
  assert.equal(two.ok, true);
  assert.equal(revisionOf(db, 'Note:n1'), 3, 'two serialized bumps on top of the seed');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM Note').get().count, 1, 'one row, last write wins the cells');
  assert.equal(receiptRows(db).length, 3, 'every settled write has its own receipt');
  assert.equal(logRows(db).length, 0);
  await writeQueue.close();
  db.close();
});

test('a concurrent write carrying a now-stale expectedRevision is rejected, not clobbered', async () => {
  const { db, boundNote } = setup();
  const writeQueue = createWriteQueue();
  const server = guardedServer({ db, boundNote });

  const edit = (payload) => writeQueue.run(() =>
    server.dispatch({
      actionId: randomUUID(), type: 'Note.update', payload,
    }));

  await writeQueue.run(() => server.dispatch({
    actionId: randomUUID(), type: 'Note.create', payload: { id: 'n1', title: 'seed' },
  }));
  assert.equal(revisionOf(db, 'Note:n1'), 1);

  // Both edits optimistically assume revision 1; the second to run must fail.
  const [one, two] = await Promise.all([
    edit({ id: 'n1', title: 'first', expectedRevision: 1 }),
    edit({ id: 'n1', title: 'second', expectedRevision: 1 }),
  ]);
  const okCount = [one, two].filter((o) => o.ok === true).length;
  const conflictCount = [one, two].filter((o) => o.ok === false && o.failure.category === 'conflict').length;
  assert.equal(okCount, 1, 'exactly one optimistic edit commits');
  assert.equal(conflictCount, 1, 'the stale optimistic edit is rejected with a safe conflict');
  assert.equal(revisionOf(db, 'Note:n1'), 2);
  await writeQueue.close();
  db.close();
});

// ---- 6. live variant construction guard ------------------------------------

test('createServer fails closed when a live pipeline is misconfigured', () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  assert.throws(
    () => createServer({
      db, handlers: commonHandlers,
      pipeline: durableMutationVariant(),
      livePipeline: durableMutationVariant(), // wrong variant name
      authorize: async () => true,
    }),
    /live createServer requires the 'live.mutation' pipeline variant/,
  );
  assert.throws(
    () => createServer({
      db, handlers: commonHandlers,
      pipeline: durableMutationVariant(),
      livePipeline: liveMutationVariant(),
      authorize: async () => true,
    }),
    /tierOfEvent/,
  );
  // A valid live server composes cleanly (variant option validation still runs).
  const valid = createServer({
    db, handlers: commonHandlers,
    pipeline: durableMutationVariant(),
    livePipeline: liveMutationVariant(),
    tierOfEvent: () => 'live',
    authorize: async () => true,
  });
  assert.ok(valid);
  assert.throws(() => liveMutationVariant({ maxEffectDepth: -1 }), /maxEffectDepth/);
  db.close();
});

test('live and durable mutation variants retain the same pipeline interface', () => {
  const durable = durableMutationVariant();
  const live = liveMutationVariant();
  assert.deepEqual(Object.keys(live).sort(), Object.keys(durable).sort());
  for (const key of Object.keys(durable)) assert.equal(typeof live[key], typeof durable[key]);
});

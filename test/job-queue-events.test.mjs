// Job-queue _Log event emission (W3 live visibility).
// Every state-changing mutation on a scoped job appends a _Log row so job boards
// ride the normal live path. Jobs with NULL scope emit nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { executeFrameworkDDL } from '../src/ddl.mjs';
import { createJobQueue } from '../src/job-queue.mjs';

const SECRET = 's3cret-shared-deployment-key';

function freshQueue(opts = {}) {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const queue = createJobQueue({ db, sharedSecret: SECRET, ...opts });
  return { db, queue };
}

function logRows(db) {
  return db.prepare('SELECT * FROM _Log ORDER BY scope, seq').all();
}

test('enqueue: emits a _Log row with seq 1 under the job scope, type _Job.created', () => {
  const { db, queue } = freshQueue({ now: () => 1000 });
  const job = queue.enqueue({ kind: 'k', payload: { n: 1 }, scope: 'project:p1' });
  const rows = logRows(db);
  assert.equal(rows.length, 1, 'exactly one _Log row');
  const r = rows[0];
  assert.equal(r.scope, 'project:p1');
  assert.equal(r.seq, 1);
  assert.equal(r.eventType, '_Job.created');
  assert.equal(r.actionId, `job:${job.id}`);
  assert.ok(r.committedAt, 'committedAt present');
  const data = JSON.parse(r.eventData);
  assert.equal(data.id, job.id);
  assert.equal(data.kind, 'k');
  assert.equal(data.status, 'queued');
  assert.equal(data.transition, 'enqueued');
  db.close();
});

test('enqueue: unscoped job emits zero _Log rows', () => {
  const { db, queue } = freshQueue();
  queue.enqueue({ kind: 'k', payload: {} });
  assert.equal(logRows(db).length, 0, 'unscoped job writes no _Log rows');
  db.close();
});

test('full lifecycle: enqueue→claim→heartbeat→progress→complete yields ordered events', () => {
  let t = 1000;
  const now = () => t;
  const { db, queue } = freshQueue({ now, leaseMs: 60000, maxAttempts: 5, backoffMs: 1000 });
  const w = queue.registerWorker(SECRET);

  queue.enqueue({ kind: 'k', payload: {}, scope: 'project:lifecycle' });
  t += 1000;
  const claimed = queue.claim(w.workerId);
  assert.ok(claimed, 'job claimed');
  t += 1000;
  assert.ok(queue.heartbeat(claimed.id, w.workerId, { now }), 'heartbeat accepted');
  t += 1000;
  const progressed = queue.updateProgress({ jobId: claimed.id, workerId: w.workerId, progress: 50, stage: 'halfway' });
  assert.ok(progressed, 'progress accepted');
  t += 1000;
  assert.ok(queue.submitResult(claimed.id, w.workerId, { status: 'completed', output: { ok: true } }).accepted, 'result accepted');

  const rows = logRows(db);
  assert.equal(rows.length, 5, 'five events total');
  const transitions = rows.map((r) => JSON.parse(r.eventData).transition);
  assert.deepEqual(transitions, ['enqueued', 'claimed', 'running', 'progress', 'completed']);

  for (let i = 0; i < rows.length; i++) {
    assert.equal(rows[i].seq, i + 1, `seq ${i + 1} at position ${i}`);
    assert.equal(rows[i].scope, 'project:lifecycle');
  }
  db.close();
});

test('repeated heartbeats yield exactly one running event', () => {
  let t = 1000;
  const now = () => t;
  const { db, queue } = freshQueue({ now, leaseMs: 60000 });
  const w = queue.registerWorker(SECRET);
  queue.enqueue({ kind: 'k', payload: {}, scope: 'project:hb' });
  const job = queue.claim(w.workerId);
  // First heartbeat: claimed→running
  t += 100; assert.ok(queue.heartbeat(job.id, w.workerId, { now }));
  // Second and third heartbeats: already running, no event
  t += 100; assert.ok(queue.heartbeat(job.id, w.workerId, { now }));
  t += 100; assert.ok(queue.heartbeat(job.id, w.workerId, { now }));

  const rows = logRows(db);
  // enqueued + claimed + running = 3, NOT 5
  assert.equal(rows.length, 3, 'repeated heartbeats produce no extra events');
  const transitions = rows.map((r) => JSON.parse(r.eventData).transition);
  assert.deepEqual(transitions, ['enqueued', 'claimed', 'running']);
  db.close();
});

test('onEvent: listener receives events; throwing listener does not break enqueue', () => {
  const { db, queue } = freshQueue({ now: () => 1000 });
  const received = [];
  const unsub = queue.onEvent((ev) => {
    received.push({ type: ev.type, transition: ev.data.transition, scope: ev.scope, seq: ev.seq });
  });

  // Register a throwing listener — must not break anything
  queue.onEvent(() => { throw new Error('boom'); });

  const j1 = queue.enqueue({ kind: 'k', payload: {}, scope: 'project:listener' });
  assert.ok(j1, 'enqueue succeeded despite throwing listener');

  assert.equal(received.length, 1, 'listener received one event');
  assert.equal(received[0].type, '_Job.created');
  assert.equal(received[0].transition, 'enqueued');
  assert.equal(received[0].scope, 'project:listener');
  assert.equal(received[0].seq, 1);

  unsub();
  queue.enqueue({ kind: 'k', payload: {}, scope: 'project:after-unsub' });
  assert.equal(received.length, 1, 'unsubscribed listener not called again');
  db.close();
});

test('unscoped job: no _Log rows and no listener invocation', () => {
  const { db, queue } = freshQueue();
  const received = [];
  queue.onEvent((ev) => { received.push(ev); });
  queue.enqueue({ kind: 'k', payload: {} });
  assert.equal(logRows(db).length, 0, 'no _Log rows');
  assert.equal(received.length, 0, 'listener not invoked for unscoped job');
  db.close();
});

test('failed-result retry emits retried; final failure emits deadLettered', () => {
  let t = 1000;
  const now = () => t;
  const { db, queue } = freshQueue({ now, maxAttempts: 3, backoffMs: 500 });
  const w = queue.registerWorker(SECRET);
  queue.enqueue({ kind: 'k', payload: {}, scope: 'project:retry' });
  const job = queue.claim(w.workerId);
  t += 500;

  // Fail once — retried
  let r = queue.submitResult(job.id, w.workerId, { status: 'failed', output: { error: 'e1' } });
  assert.ok(r.retried, 'first failure retried');
  t += 500;
  queue.claim(w.workerId);
  t += 500;

  // Fail twice — retried
  r = queue.submitResult(job.id, w.workerId, { status: 'failed', output: { error: 'e2' } });
  assert.ok(r.retried, 'second failure retried');
  t += 500;
  queue.claim(w.workerId);
  t += 500;

  // Third fail at maxAttempts — deadLettered
  r = queue.submitResult(job.id, w.workerId, { status: 'failed', output: { error: 'e3' } });
  assert.ok(r.deadLettered, 'third failure dead-lettered');

  const rows = logRows(db);
  const transitions = rows.map((r) => JSON.parse(r.eventData).transition);
  // enqueued, claimed, retried, claimed, retried, claimed, deadLettered
  assert.deepEqual(transitions, ['enqueued', 'claimed', 'retried', 'claimed', 'retried', 'claimed', 'deadLettered']);
  db.close();
});

test('reap: emits reassigned for scoped jobs only', () => {
  let t = 1000;
  const now = () => t;
  const { db, queue } = freshQueue({ now, leaseMs: 100, heartbeatGraceMs: 99999 });
  const w = queue.registerWorker(SECRET);

  queue.enqueue({ kind: 'k', payload: {}, scope: 'project:reap' });  // scoped
  queue.enqueue({ kind: 'k', payload: {} });                        // unscoped
  const sJob = queue.claim(w.workerId);
  assert.ok(sJob, 'claimed scoped job');
  t += 500;

  const r = queue.reap({ now });
  assert.equal(r.reassigned, 1, 'one job reassigned (scoped only — unscoped not claimable)');
  const rows = logRows(db);
  const transitions = rows.map((r) => JSON.parse(r.eventData).transition);
  // enqueued (scoped), claimed, reassigned = 3
  assert.equal(rows.length, 3);
  assert.equal(transitions[2], 'reassigned');
  assert.equal(rows[2].scope, 'project:reap', 'reassigned event has the right scope');
  db.close();
});

test('list: empty results when no jobs match', () => {
  const { queue, db } = freshQueue();
  const results = queue.list({ scope: 'project:nonexistent' });
  assert.deepEqual(results, []);
  db.close();
});

test('list: returns all jobs sorted by enqueuedAt when no filters', () => {
  let t = 1000;
  const now = () => (t += 1000);
  const { queue, db } = freshQueue({ now });
  queue.enqueue({ kind: 'k', payload: { n: 1 } });
  queue.enqueue({ kind: 'k', payload: { n: 2 }, scope: 'project:p1' });
  queue.enqueue({ kind: 'k', payload: { n: 3 }, scope: 'project:p2' });
  queue.enqueue({ kind: 'x', payload: { n: 4 }, scope: 'project:p1' });

  const all = queue.list();
  assert.equal(all.length, 4);
  assert.equal(all[0].payload.n, 1);
  assert.equal(all[3].payload.n, 4);
  db.close();
});

test('list: filters by scope, kind, and status', () => {
  let t = 1000;
  const now = () => (t += 1000);
  const { queue, db } = freshQueue({ now });
  const w = queue.registerWorker(SECRET);
  queue.enqueue({ kind: 'k', payload: { n: 1 }, scope: 'project:p1' });
  queue.enqueue({ kind: 'x', payload: { n: 2 }, scope: 'project:p1' });
  queue.enqueue({ kind: 'k', payload: { n: 3 }, scope: 'project:p2' });
  queue.enqueue({ kind: 'k', payload: { n: 4 }, scope: 'project:p1' });
  queue.claim(w.workerId, { scope: 'project:p1' }); // claims job n:1

  // filter by scope — returns all p1 jobs (n:1 still visible although claimed)
  const p1 = queue.list({ scope: 'project:p1' });
  assert.equal(p1.length, 3, 'three p1 jobs (n:1 still visible, just claimed)');

  // filter by kind
  const ks = queue.list({ kind: 'k' });
  assert.equal(ks.length, 3, 'three k jobs (n:1, n:3, n:4)');

  // filter by status
  const queued = queue.list({ status: 'queued' });
  assert.equal(queued.length, 3, 'three queued jobs');

  const claimed = queue.list({ status: 'claimed' });
  assert.equal(claimed.length, 1, 'one claimed job');

  // combined filter
  const p1k = queue.list({ scope: 'project:p1', kind: 'k' });
  assert.equal(p1k.length, 2, 'two p1 k jobs');
  // n:1 (claimed) and n:4 (queued) in enqueuedAt order

  db.close();
});

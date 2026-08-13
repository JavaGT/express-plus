// Job-queue progress, cancellation, and scoping (W3 census BUILD items).
// Substrate tests (unit-level against the queue functions) + HTTP integration
// tests (framework-owned routes with bearer auth).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { executeFrameworkDDL } from '../build/ddl.mjs';
import { createJobQueue } from '../build/job-queue.mjs';
import { text, grant, read } from '../build/index.mjs';
import workbench, { entity } from '../build/internal.mjs';

const SECRET = 's3cret-shared-deployment-key';

function freshQueue(opts = {}) {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const queue = createJobQueue({ db, sharedSecret: SECRET, ...opts });
  return { db, queue };
}

// ── Substrate tests ──────────────────────────────────────────────────────────

test('updateProgress: valid update sets progress + stage on a claimed job', () => {
  const { db, queue } = freshQueue();
  const w = queue.registerWorker(SECRET);
  queue.enqueue({ kind: 'k', payload: {} });
  const job = queue.claim(w.workerId);
  const updated = queue.updateProgress({ jobId: job.id, workerId: w.workerId, progress: 42, stage: 'transcoding' });
  assert.ok(updated, 'updateProgress returned a row');
  assert.equal(updated.progress, 42, 'progress set');
  assert.equal(updated.stage, 'transcoding', 'stage set');
  const row = db.prepare('SELECT progress, stage FROM _Job WHERE id = ?').get(job.id);
  assert.equal(row.progress, 42, 'progress persisted');
  assert.equal(row.stage, 'transcoding', 'stage persisted');
  db.close();
});

test('updateProgress: clamps progress at 0 (floor)', () => {
  const { db, queue } = freshQueue();
  const w = queue.registerWorker(SECRET);
  queue.enqueue({ kind: 'k', payload: {} });
  const job = queue.claim(w.workerId);
  const updated = queue.updateProgress({ jobId: job.id, workerId: w.workerId, progress: -5 });
  assert.equal(updated.progress, 0, 'clamped to 0');
  const row = db.prepare('SELECT progress FROM _Job WHERE id = ?').get(job.id);
  assert.equal(row.progress, 0);
  db.close();
});

test('updateProgress: clamps progress at 100 (ceiling)', () => {
  const { db, queue } = freshQueue();
  const w = queue.registerWorker(SECRET);
  queue.enqueue({ kind: 'k', payload: {} });
  const job = queue.claim(w.workerId);
  const updated = queue.updateProgress({ jobId: job.id, workerId: w.workerId, progress: 150 });
  assert.equal(updated.progress, 100, 'clamped to 100');
  db.close();
});

test('updateProgress: rejected for wrong worker', () => {
  const { queue } = freshQueue();
  const w1 = queue.registerWorker(SECRET);
  const w2 = queue.registerWorker(SECRET);
  queue.enqueue({ kind: 'k', payload: {} });
  const job = queue.claim(w1.workerId);
  const updated = queue.updateProgress({ jobId: job.id, workerId: w2.workerId, progress: 50 });
  assert.equal(updated, null, 'non-owner progress update rejected');
});

test('updateProgress: rejected for completed job', () => {
  const { queue } = freshQueue();
  const w = queue.registerWorker(SECRET);
  queue.enqueue({ kind: 'k', payload: {} });
  const job = queue.claim(w.workerId);
  queue.submitResult(job.id, w.workerId, { status: 'completed', output: {} });
  const updated = queue.updateProgress({ jobId: job.id, workerId: w.workerId, progress: 50 });
  assert.equal(updated, null, 'terminal job cannot accept progress');
});

test('cancelJob: queued → cancelled', () => {
  const { db, queue } = freshQueue();
  const w = queue.registerWorker(SECRET);
  // Enqueue a job; it has no owner yet (workerId is NULL).
  const job = queue.enqueue({ kind: 'k', payload: {} });
  const result = queue.cancelJob({ jobId: job.id, workerId: w.workerId });
  assert.ok(result, 'cancelJob returned a row');
  assert.equal(result.status, 'cancelled', 'status is cancelled');
  const row = db.prepare('SELECT status FROM _Job WHERE id = ?').get(job.id);
  assert.equal(row.status, 'cancelled');
  db.close();
});

test('cancelJob: claimed → cancelled (by owning worker)', () => {
  const { db, queue } = freshQueue();
  const w = queue.registerWorker(SECRET);
  queue.enqueue({ kind: 'k', payload: {} });
  const job = queue.claim(w.workerId);
  const result = queue.cancelJob({ jobId: job.id, workerId: w.workerId });
  assert.ok(result, 'cancelJob returned a row');
  assert.equal(result.status, 'cancelled');
  const row = db.prepare('SELECT status FROM _Job WHERE id = ?').get(job.id);
  assert.equal(row.status, 'cancelled');
  db.close();
});

test('cancelJob: completed → cannot cancel (terminal)', () => {
  const { queue } = freshQueue();
  const w = queue.registerWorker(SECRET);
  queue.enqueue({ kind: 'k', payload: {} });
  const job = queue.claim(w.workerId);
  queue.submitResult(job.id, w.workerId, { status: 'completed', output: {} });
  const result = queue.cancelJob({ jobId: job.id, workerId: w.workerId });
  assert.equal(result.terminal, true, 'terminal job cannot be cancelled');
});

test('cancelJob: wrong worker → forbidden', () => {
  const { queue } = freshQueue();
  const w1 = queue.registerWorker(SECRET);
  const w2 = queue.registerWorker(SECRET);
  queue.enqueue({ kind: 'k', payload: {} });
  const job = queue.claim(w1.workerId);
  const result = queue.cancelJob({ jobId: job.id, workerId: w2.workerId });
  assert.equal(result.forbidden, true, 'non-owner cannot cancel a claimed job');
});

test('cancelJob: not found → null', () => {
  const { queue } = freshQueue();
  const w = queue.registerWorker(SECRET);
  const result = queue.cancelJob({ jobId: 'nonexistent', workerId: w.workerId });
  assert.equal(result, null, 'nonexistent job returns null');
});

test('scoped claim: claim with scope filter only returns matching scope', () => {
  const { queue } = freshQueue();
  const w = queue.registerWorker(SECRET);
  queue.enqueue({ kind: 'k', payload: { n: 1 }, scope: 'project:p1' });
  queue.enqueue({ kind: 'k', payload: { n: 2 }, scope: 'project:p1' });
  queue.enqueue({ kind: 'k', payload: { n: 3 }, scope: 'project:p2' });
  // Claim with scope p1 — should only get jobs from project:p1
  const a = queue.claim(w.workerId, { scope: 'project:p1' });
  assert.ok(a, 'claim returned a job');
  assert.equal(a.payload.n, 1, 'first p1 job claimed');
  assert.equal(a.scope, 'project:p1');
  const b = queue.claim(w.workerId, { scope: 'project:p1' });
  assert.ok(b, 'second p1 job claimed');
  assert.equal(b.payload.n, 2);
  // No more p1 jobs
  const c = queue.claim(w.workerId, { scope: 'project:p1' });
  assert.equal(c, null, 'no more p1 jobs');
  // Claim without scope gets the p2 job
  const d = queue.claim(w.workerId);
  assert.ok(d, 'unscoped claim gets p2 job');
  assert.equal(d.payload.n, 3);
});

test('scoped claim: unscoped jobs are claimable without scope filter', () => {
  const { queue } = freshQueue();
  const w = queue.registerWorker(SECRET);
  queue.enqueue({ kind: 'k', payload: { n: 1 } }); // no scope
  const job = queue.claim(w.workerId, { scope: 'project:p1' });
  assert.equal(job, null, 'unscoped job not claimed with scope filter');
  // But claimable without scope filter
  const j2 = queue.claim(w.workerId);
  assert.ok(j2, 'unscoped job claimable by unfiltered claim');
  assert.equal(j2.payload.n, 1);
});

test('enqueue: scope is persisted', () => {
  const { db, queue } = freshQueue();
  const job = queue.enqueue({ kind: 'k', payload: {}, scope: 'project:alpha' });
  assert.equal(job.scope, 'project:alpha', 'scope returned in parsed job');
  const row = db.prepare('SELECT scope FROM _Job WHERE id = ?').get(job.id);
  assert.equal(row.scope, 'project:alpha', 'scope persisted');
  db.close();
});

test('enqueue: scope is optional (null when omitted)', () => {
  const { db, queue } = freshQueue();
  const job = queue.enqueue({ kind: 'k', payload: {} });
  assert.equal(job.scope, null, 'scope is null when omitted');
  db.close();
});

// ── HTTP route tests ─────────────────────────────────────────────────────────

function makeApp() {
  const db = new DatabaseSync(':memory:');
  const app = workbench({
    db,
    jobs: { sharedSecret: SECRET, leaseMs: 60_000, heartbeatGraceMs: 60_000, reapIntervalMs: 1_000_000 },
  });
  app.mount('/notes', entity('Note', { body: text(), grant: () => [grant(read)] }));
  return { db, app };
}

async function ready(app) {
  app.listen(0, { principalOf: () => ({ id: 'u1' }) });
  await app.ready;
  return `http://127.0.0.1:${app.httpServer.address().port}`;
}

function bearer(workerId, token) {
  return { authorization: `Bearer ${workerId}.${token}` };
}

test('HTTP: POST /jobs/:id/progress — sets progress and stage', async (t) => {
  const { db, app } = makeApp();
  const base = await ready(app);
  t.after(() => { app.httpServer.close(); db.close(); });
  app.jobs.enqueue({ kind: 'k', payload: {} });
  const w = await (await fetch(`${base}/workers/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret: SECRET }),
  })).json();
  const job = await (await fetch(`${base}/jobs/claim`, { method: 'POST', headers: bearer(w.workerId, w.token) })).json();
  const res = await fetch(`${base}/jobs/${job.id}/progress`, {
    method: 'POST',
    headers: { ...bearer(w.workerId, w.token), 'content-type': 'application/json' },
    body: JSON.stringify({ progress: 75, stage: 'merging' }),
  });
  assert.equal(res.status, 200, 'progress route accepted');
  const body = await res.json();
  assert.equal(body.id, job.id);
  assert.equal(body.progress, 75);
  assert.equal(body.stage, 'merging');
});

test('HTTP: POST /jobs/:id/progress — rejects missing auth', async (t) => {
  const { db, app } = makeApp();
  const base = await ready(app);
  t.after(() => { app.httpServer.close(); db.close(); });
  const res = await fetch(`${base}/jobs/some-id/progress`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ progress: 50 }),
  });
  assert.equal(res.status, 401, 'no auth → 401');
});

test('HTTP: POST /jobs/:id/cancel — cancels a claimed job', async (t) => {
  const { db, app } = makeApp();
  const base = await ready(app);
  t.after(() => { app.httpServer.close(); db.close(); });
  app.jobs.enqueue({ kind: 'k', payload: {} });
  const w = await (await fetch(`${base}/workers/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret: SECRET }),
  })).json();
  const job = await (await fetch(`${base}/jobs/claim`, { method: 'POST', headers: bearer(w.workerId, w.token) })).json();
  const res = await fetch(`${base}/jobs/${job.id}/cancel`, {
    method: 'POST',
    headers: bearer(w.workerId, w.token),
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 200, 'cancel route accepted');
  const body = await res.json();
  assert.equal(body.id, job.id);
  assert.equal(body.status, 'cancelled');
});

test('HTTP: POST /jobs/:id/cancel — completed job returns 400', async (t) => {
  const { db, app } = makeApp();
  const base = await ready(app);
  t.after(() => { app.httpServer.close(); db.close(); });
  app.jobs.enqueue({ kind: 'k', payload: {} });
  const w = await (await fetch(`${base}/workers/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret: SECRET }),
  })).json();
  const job = await (await fetch(`${base}/jobs/claim`, { method: 'POST', headers: bearer(w.workerId, w.token) })).json();
  await fetch(`${base}/jobs/${job.id}/result`, {
    method: 'POST',
    headers: { ...bearer(w.workerId, w.token), 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'completed', output: {} }),
  });
  const res = await fetch(`${base}/jobs/${job.id}/cancel`, {
    method: 'POST',
    headers: bearer(w.workerId, w.token),
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400, 'terminal job → 400');
});

test('HTTP: POST /jobs/:id/cancel — wrong worker returns 403', async (t) => {
  const { db, app } = makeApp();
  const base = await ready(app);
  t.after(() => { app.httpServer.close(); db.close(); });
  app.jobs.enqueue({ kind: 'k', payload: {} });
  const w1 = await (await fetch(`${base}/workers/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret: SECRET }),
  })).json();
  const w2 = await (await fetch(`${base}/workers/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret: SECRET }),
  })).json();
  const job = await (await fetch(`${base}/jobs/claim`, { method: 'POST', headers: bearer(w1.workerId, w1.token) })).json();
  const res = await fetch(`${base}/jobs/${job.id}/cancel`, {
    method: 'POST',
    headers: bearer(w2.workerId, w2.token),
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 403, 'non-owner → 403');
});

test('HTTP: POST /jobs/:id/cancel — rejects missing auth', async (t) => {
  const { db, app } = makeApp();
  const base = await ready(app);
  t.after(() => { app.httpServer.close(); db.close(); });
  const res = await fetch(`${base}/jobs/some-id/cancel`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 401, 'no auth → 401');
});

test('HTTP: POST /jobs/claim?scope= — scoped claim only returns matching jobs', async (t) => {
  const { db, app } = makeApp();
  const base = await ready(app);
  t.after(() => { app.httpServer.close(); db.close(); });
  app.jobs.enqueue({ kind: 'k', payload: { n: 1 }, scope: 'project:p1' });
  app.jobs.enqueue({ kind: 'k', payload: { n: 2 }, scope: 'project:p2' });
  const w = await (await fetch(`${base}/workers/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret: SECRET }),
  })).json();
  // Claim with scope filter
  const res = await fetch(`${base}/jobs/claim?scope=project:p1`, {
    method: 'POST',
    headers: bearer(w.workerId, w.token),
  });
  assert.equal(res.status, 200, 'scoped claim returned a job');
  const job = await res.json();
  assert.equal(job.payload.n, 1, 'returned p1 job, not p2');
  assert.equal(job.scope, 'project:p1');
  // No more p1 jobs
  const empty = await fetch(`${base}/jobs/claim?scope=project:p1`, {
    method: 'POST',
    headers: bearer(w.workerId, w.token),
  });
  assert.equal(empty.status, 204, 'no more p1 jobs → 204');
});

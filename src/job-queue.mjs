// job-queue.mjs — the job-queue substrate (eng-review spec #5, Walk 2, §3.3).
//
// A job is a unit of work with its own lifecycle (queued→claimed→running→
// completed/failed, + reassigned→queued by the reaper). It is NOT a derived read
// model — so the queue is a SEPARATE seam from the projection registry (deletion
// test: folding job lifecycle into the projection registry would only RELOCATE
// the claim/lease/heartbeat/reaper concept, same net code). The two compose at the
// enqueue edge: a post-commit consumer may call `enqueue()`; the queue owns the
// lifecycle from there.
//
// Auth (§5): worker registration uses a shared secret (constant-time compared);
// job operations use a per-worker bearer token (constant-time compared, revocable
// by the reaper). The shared secret is NEVER used for job operations. Fail-closed
// on unknown/revoked. A bearer is `<workerId>.<token>`; the workerId is a PK
// lookup (not a timing oracle), the token is compared as sha256(token) vs the
// stored hash via timingSafeEqual (constant-time on the secret bytes).
//
// Atomicity of claim: a single `UPDATE _Job SET status='claimed'… WHERE id =
// (SELECT … WHERE status='queued' ORDER BY enqueuedAt LIMIT 1) RETURNING *` is
// one statement — SQLite's per-statement atomicity + node's single-threaded sync
// DB make concurrent claims race-safe (the second claimant sees status='claimed',
// gets zero rows). No write-queue mutex needed for the single statement; the
// reaper's reassign is the same shape.
//
// Idempotency: result submission is idempotent by job id — a retried result for an
// already-terminal job is a no-op ack (first terminal result wins; the derived
// write the app projects from a result is never double-applied).

import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';

const STATES = { QUEUED: 'queued', CLAIMED: 'claimed', RUNNING: 'running', COMPLETED: 'completed', FAILED: 'failed' };
const TERMINAL = new Set([STATES.COMPLETED, STATES.FAILED]);

function sha256hex(s) {
  return createHash('sha256').update(s).digest('hex');
}

// Constant-time comparison of two hex digest strings. Hashes are fixed-width, but
// we guard length regardless so a mismatched-length input never reaches
// timingSafeEqual (which throws on unequal lengths).
function ctEqualHex(a, b) {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}

export function createJobQueue({
  db,
  sharedSecret,
  leaseMs = 30_000,
  heartbeatGraceMs = 90_000,
  reapIntervalMs = 15_000,
  now = () => Date.now(),
} = {}) {
  if (!db) throw new Error('createJobQueue: db is required');
  if (sharedSecret == null || sharedSecret === '') {
    throw new Error('createJobQueue: sharedSecret is required (fail-closed — worker registration needs a secret)');
  }
  // Store only the hash — the plaintext never persists past construction.
  const secretHash = sha256hex(sharedSecret);
  let timer = null;

  function parseJob(row) {
    if (!row) return null;
    return { ...row, payload: row.payload != null ? JSON.parse(row.payload) : null };
  }

  // Worker registration: shared secret → per-worker bearer token. The secret is
  // compared constant-time; a mismatch returns null (fail-closed). On success a
  // Worker row is inserted with tokenHash = sha256(token) + lastHeartbeat=now.
  function registerWorker(presentedSecret) {
    if (typeof presentedSecret !== 'string' || !ctEqualHex(sha256hex(presentedSecret), secretHash)) {
      return null;
    }
    const workerId = randomUUID();
    const token = randomBytes(32).toString('hex');
    const t = now();
    db.prepare(
      'INSERT INTO _Worker (id, tokenHash, lastHeartbeat, revoked, registeredAt) VALUES (?, ?, ?, 0, ?)',
    ).run(workerId, sha256hex(token), t, t);
    return { workerId, token };
  }

  // Bearer authentication: `<workerId>.<token>`. Look up the worker by PK (not a
  // timing oracle), reject if unknown or revoked, then constant-time compare
  // sha256(token) to the stored hash. Returns the workerId or null.
  function authenticate(bearer) {
    if (typeof bearer !== 'string') return null;
    const dot = bearer.indexOf('.');
    if (dot <= 0) return null;
    const workerId = bearer.slice(0, dot);
    const token = bearer.slice(dot + 1);
    const row = db.prepare('SELECT tokenHash, revoked FROM _Worker WHERE id = ?').get(workerId);
    if (!row || row.revoked) return null;
    if (!ctEqualHex(sha256hex(token), row.tokenHash)) return null;
    return workerId;
  }

  // Enqueue a job. A post-commit consumer (or an imperative handler) calls this;
  // the queue owns the lifecycle from here. Mints an id when absent; preserves a
  // caller-supplied id (caller-owned, like entity ids).
  function enqueue({ kind, payload = null, id } = {}) {
    if (!kind) throw new Error('enqueue: kind is required');
    const jobId = id ?? randomUUID();
    const t = now();
    db.prepare(
      'INSERT INTO _Job (id, kind, payload, status, enqueuedAt, workerId, claimedAt, leaseUntil) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)',
    ).run(jobId, kind, payload != null ? JSON.stringify(payload) : null, STATES.QUEUED, t);
    return parseJob(db.prepare('SELECT * FROM _Job WHERE id = ?').get(jobId));
  }

  // Claim the oldest queued job for a worker. Atomic single-statement
  // UPDATE…RETURNING: a racing claim sees status='claimed' and gets zero rows.
  // Returns the claimed job (status 'claimed', leaseUntil set) or null.
  function claim(workerId) {
    const t = now();
    const row = db.prepare(
      `UPDATE _Job
         SET status = ?, workerId = ?, claimedAt = ?, leaseUntil = ?
       WHERE id = (SELECT id FROM _Job WHERE status = ? ORDER BY enqueuedAt LIMIT 1)
       RETURNING *`,
    ).get(STATES.CLAIMED, workerId, t, t + leaseMs, STATES.QUEUED);
    return parseJob(row) ?? null;
  }

  // Heartbeat: the owning worker extends its lease; the first heartbeat flips
  // claimed→running. Non-owner or terminal → false. Best-effort: a dropped
  // heartbeat is fine within the lease window (the reaper reconciles).
  function heartbeat(jobId, workerId, { now: nowFn = now } = {}) {
    const t = (typeof nowFn === 'function' ? nowFn : now)();
    const res = db.prepare(
      `UPDATE _Job
         SET status = ?, leaseUntil = ?
       WHERE id = ? AND workerId = ? AND status IN (?, ?)`,
    ).run(STATES.RUNNING, t + leaseMs, jobId, workerId, STATES.CLAIMED, STATES.RUNNING);
    if (res.changes > 0) {
      // Keep the OWNING worker alive too: the reaper revokes workers by
      // _Worker.lastHeartbeat, not by job lease. A heartbeat that extended
      // only the job lease would let an active worker be revoked
      // (heartbeatGraceMs after registration) → its bearer rejected → the
      // in-flight job reassigned to another worker (duplicate execution).
      db.prepare('UPDATE _Worker SET lastHeartbeat = ? WHERE id = ?').run(t, workerId);
    }
    return res.changes > 0;
  }

  // Submit a result. Idempotent by job id: a retried result for an already-terminal
  // job is a no-op ack ({accepted:true, noop:true}) — the first terminal result
  // wins, the stored output is NOT overwritten (no double-apply of the derived
  // write). Non-owner / not-found → {accepted:false}.
  function submitResult(jobId, workerId, { status, output = null } = {}) {
    if (status !== STATES.COMPLETED && status !== STATES.FAILED) {
      throw new Error('submitResult: status must be completed or failed');
    }
    const current = db.prepare('SELECT status, payload, workerId FROM _Job WHERE id = ?').get(jobId);
    if (!current) return { accepted: false };
    if (TERMINAL.has(current.status)) {
      // Idempotent retry: only the OWNING worker gets the no-op ack. A non-owner
      // probing someone else's terminal job is rejected — no accepting ack and no
      // confirmation that the job is terminal.
      return current.workerId === workerId ? { accepted: true, noop: true } : { accepted: false };
    }
    const res = db.prepare(
      `UPDATE _Job SET status = ?, payload = ?
       WHERE id = ? AND workerId = ? AND status IN (?, ?)`,
    ).run(status, output != null ? JSON.stringify(output) : null, jobId, workerId, STATES.CLAIMED, STATES.RUNNING);
    return res.changes > 0 ? { accepted: true, noop: false } : { accepted: false };
  }

  // Reaper sweep. (1) Reassign jobs whose lease expired (claimed/running → queued,
  // workerId cleared) so another worker may claim them. (2) Revoke workers whose
  // lastHeartbeat is older than the grace window — their bearer is rejected after.
  // The worker's work must be idempotent (documented) because a reassigned job is
  // re-run from scratch by the new claimant.
  function reap({ now: nowFn = now } = {}) {
    const t = (typeof nowFn === 'function' ? nowFn : now)();
    const reassigned = db.prepare(
      `UPDATE _Job SET status = ?, workerId = NULL, claimedAt = NULL, leaseUntil = NULL
       WHERE status IN (?, ?) AND leaseUntil < ?`,
    ).run(STATES.QUEUED, STATES.CLAIMED, STATES.RUNNING, t).changes;
    const revoked = db.prepare(
      `UPDATE _Worker SET revoked = 1
       WHERE revoked = 0 AND lastHeartbeat < ?`,
    ).run(t - heartbeatGraceMs).changes;
    return { reassigned, revoked };
  }

  // Periodic reaper, owned by the framework (the listen() layer registers the
  // stop() with onShutdown). No-op if already started.
  function startReaper() {
    if (timer) return;
    timer = setInterval(() => {
      try { reap(); } catch (err) { process.stderr.write(`job-queue reap failed: ${err.message}\n`); }
    }, reapIntervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { registerWorker, authenticate, enqueue, claim, heartbeat, submitResult, reap, startReaper, stop };
}

// job-queue.mjs — the job-queue substrate (eng-review spec #5, Walk 2, §3.3).
//
// WRITE-COORDINATOR RED-LINE (S1/A5): every state-changing entry point
// (enqueue/claim/heartbeat/submitResult/updateProgress/cancelJob/reap) routes
// through the platform write coordinator (write-queue.ts) when one is provided
// — an app passes its single-writer mutex via `createJobQueue({ writeQueue })`,
// and a nested call (e.g. a post-commit consumer inside a dispatch turn)
// joins the current turn instead of interleaving. This is NOT a second mutex:
// no BEGIN/COMMIT, no rollback, no held transaction.
//
// Why the queue is NOT the old "single-statement exception": most entry points
// are multi-statement read-then-write sequences (claim's UPDATE…RETURNING
// claims atomically, but submitResult/cancelJob/heartbeat/updateProgress read
// the row to decide the outcome, reap sweeps multiple predicates, and every
// scoped mutation appends a live-visibility _Log/_Cursor event afterwards).
// Only worker registration (registerWorker) is a genuinely single-statement
// INSERT and stays outside the mutex. Routing the rest through the coordinator
// keeps every platform write inside the one mutex; claim's per-statement
// UPDATE…RETURNING remains as the race-safe core (belt and suspenders).
//
// Without a writeQueue (a standalone queue), entry points run synchronously
// and return their value directly; with one, they return a Promise of it —
// `await` works for both.
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
// gets zero rows). The claim statement stays single-statement even inside the
// coordinator; the reaper's reassign is the same shape.
//
// Idempotency: result submission is idempotent by job id — a retried result for an
// already-terminal job is a no-op ack (first terminal result wins; the derived
// write the app projects from a result is never double-applied).
//
// Live visibility (W3 slice 2): the queue mutates _Job with raw SQL, bypassing the
// committed log — so a job board subscribed to _Log never saw a claim/progress/
// completion. Every state-changing mutation on a job whose `scope` is NON-NULL now
// appends exactly one event to _Log (via committed-log.mjs's appendEvents — the
// canonical write surface, never a hand-rolled INSERT), scoped to the job's own
// `scope` string (the scope IS the live stream key a board subscribes to). Per-scope
// seq is allocated the SAME way pipeline.mjs's nextSeq does (readSeq(scope)+1, then
// an INSERT…ON CONFLICT DO UPDATE into _Cursor) — one seq grammar, not a second one
// invented here. The _Job write and the _Log/_Cursor writes are plain back-to-back
// synchronous statements, not wrapped in an explicit BEGIN/COMMIT: db.mjs (the
// ambient db binding) exposes no transaction helper, and node's single-threaded
// synchronous DB means nothing else can interleave between the two statements
// within one call — race-safe in practice, though not crash-atomic across the pair.
// A job with NULL scope has no stream key, so it emits nothing — it is invisible to
// live boards by construction, the same way an unscoped entity would be. Listeners
// register via `onEvent(fn)` (returns an unsubscribe) and are invoked synchronously,
// after the write, with the finalized event; a throwing listener is caught per-call
// so it can never break the mutation or a sibling listener.

import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { getLog } from './log.mjs';
import { appendEvents, readSeq,                    } from './committed-log.mjs';
                                            
                                        
import { rawRow } from './entity/query.mjs';
import { operationCategory } from './operation.mjs';
import { machineAllows, isMachinePrincipal,                       } from './machine-principal.mjs';

const STATES = { QUEUED: 'queued', CLAIMED: 'claimed', RUNNING: 'running', COMPLETED: 'completed', FAILED: 'failed', CANCELLED: 'cancelled' }         ;

                                                      

const TERMINAL = new Set           ([STATES.COMPLETED, STATES.FAILED, STATES.CANCELLED]);

                         
             
               
                   
                    
                     
                          
                           
                            
                          
                             
                          
                       
                       
 

                                  
               
                       
                                                                               
                                                                         
                                                                            
                   
                                     
                   
                            
                          
                       
                     
                          
                     
                
 

// Structural write-queue surface (the app's single-writer coordinator). Type-only
// shape, deliberately not imported: the queue only needs `run`.
                       
                                               
  

                    
               
                       
              
                                
                   
                      
 

                                          

                   
                                      
                                                       
                                                            
                        

                                                                                

function sha256hex(s        ) {
  return createHash('sha256').update(s).digest('hex');
}

// Constant-time comparison of two hex digest strings. Hashes are fixed-width, but
// we guard length regardless so a mismatched-length input never reaches
// timingSafeEqual (which throws on unequal lengths).
function ctEqualHex(a        , b        ) {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}

// Normalize a handler's declared operations (the handler/context allowlist,
// S5/A5 spec item 2) to closed-vocabulary names. Unknown vocabulary is a
// construction-time error (fail closed loudly at setup), and an empty list is a
// misconfiguration — a handler that performs work must declare it.
function normalizeDeclaredOperations(operations                   , context        )                    {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new Error(`${context}: operations must be a non-empty array (the handler's declared allowed operations)`);
  }
  return Object.freeze(
    operations.map((operation, index) => {
      if (typeof operation !== 'string' || operation.length === 0) {
        throw new Error(`${context}: operations[${index}] must be a non-empty operation name`);
      }
      return operationCategory(operation).operation;
    }),
  );
}

export function createJobQueue({
  db,
  sharedSecret,
  writeQueue = null,
  leaseMs = 30_000,
  heartbeatGraceMs = 90_000,
  reapIntervalMs = 15_000,
  maxAttempts = 5,
  backoffMs = 5_000,
  pollIntervalMs = 1_000,
  now = () => Date.now(),
  clock,
}                 ) {
  if (!db) throw new Error('createJobQueue: db is required');
  if (sharedSecret == null || sharedSecret === '') {
    throw new Error('createJobQueue: sharedSecret is required (fail-closed — worker registration needs a secret)');
  }
  // Store only the hash — the plaintext never persists past construction.
  const secretHash = sha256hex(sharedSecret);
  let timer                                        = null;
  let reaperWatcher                            = null;
  // Machine attribution (S5/A5): a job enqueued with a machine principal is
  // attributed to it (the attributable operational identity for audit). The
  // allowlist ENFORCEMENT is the handler/context check in work() — this map is
  // the attribution record, not a second enforcement seam.
  const attributedJobs = new Map                          ();

  // Run a mutation through the write coordinator when one is configured; a
  // standalone queue runs synchronously. The result is the body's value, or a
  // Promise of it when coordinated — `await` flattens both uniformly.
  function coordinated   (fn         )                 {
    return writeQueue ? writeQueue.run(fn) : fn();
  }

  // ---- event emission (W3 live visibility) ----

  const listeners             = [];

  function onEvent(fn          )             {
    listeners.push(fn);
    return () => {
      const idx = listeners.indexOf(fn);
      if (idx !== -1) listeners.splice(idx, 1);
    };
  }

  function nextSeq(scope        ) {
    const seq = readSeq(db, scope) + 1;
    db.prepare(
      'INSERT INTO _Cursor (scope, lastSeq) VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET lastSeq = ?',
    ).run(scope, seq, seq);
    return seq;
  }

  function emit(event          )       {
    appendEvents(db, [event                            ]);
    for (const fn of listeners) {
      try { fn(event); } catch { /* per-listener isolation */ }
    }
  }

  function buildEvent(job        , transition        , nowTime        )           {
    return {
      type: transition === 'enqueued' ? '_Job.created' : '_Job.updated',
      scope: job.scope,
      seq: nextSeq(job.scope ?? ''),
      data: {
        id: job.id,
        kind: job.kind,
        status: job.status,
        progress: job.progress ?? 0,
        stage: job.stage ?? null,
        attempts: job.attempts ?? 0,
        transition,
      },
      actionId: `job:${job.id}`,
      committedAt: new Date(nowTime).toISOString(),
    };
  }

  function parseJob(row                                     )                {
    if (!row) return null;
    return {
      id: String(row.id ?? ''),
      kind: String(row.kind ?? ''),
      payload: row.payload != null ? JSON.parse(row.payload          ) : null,
      status: row.status             ,
      enqueuedAt: row.enqueuedAt          ,
      workerId: row.workerId                 ,
      claimedAt: row.claimedAt                 ,
      leaseUntil: row.leaseUntil                 ,
      attempts: row.attempts                 ,
      availableAt: row.availableAt                 ,
      progress: row.progress                 ,
      stage: row.stage                 ,
      scope: row.scope                 ,
    };
  }

  // Worker registration: shared secret → per-worker bearer token. The secret is
  // compared constant-time; a mismatch returns null (fail-closed). On success a
  // Worker row is inserted with tokenHash = sha256(token) + lastHeartbeat=now.
  function registerWorker(presentedSecret        )                                             {
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
  function authenticate(bearer        )                {
    if (typeof bearer !== 'string') return null;
    const dot = bearer.indexOf('.');
    if (dot <= 0) return null;
    const workerId = bearer.slice(0, dot);
    const token = bearer.slice(dot + 1);
    const row = db.prepare('SELECT tokenHash, revoked FROM _Worker WHERE id = ?').get(workerId);
    if (!row || row.revoked) return null;
    if (!ctEqualHex(sha256hex(token), String(row.tokenHash))) return null;
    return workerId;
  }

  // Enqueue a job. A post-commit consumer (or an imperative handler) calls this;
  // the queue owns the lifecycle from here. Mints an id when absent; preserves a
  // caller-supplied id (caller-owned, like entity ids). Routes through the write
  // coordinator when one is configured. `principal` is the optional machine
  // attribution (S5/A5): the attributable machine principal this job runs under.
  // Fail closed: a non-machine principal is rejected at construction.
  function enqueue({ kind, payload = null, id, scope, principal }                                                                                                  = {})                                         {
    return coordinated(() => {
      if (!kind) throw new Error('enqueue: kind is required');
      if (principal != null && !isMachinePrincipal(principal)) {
        throw new Error('enqueue: principal must be an attributable machine principal (machinePrincipal({ id, operations })) — a raw system or human principal is never a job attribution');
      }
      const jobId = id ?? randomUUID();
      const t = now();
      db.prepare(
        'INSERT INTO _Job (id, kind, payload, status, enqueuedAt, scope, workerId, claimedAt, leaseUntil) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL)',
      ).run(jobId, kind, payload != null ? JSON.stringify(payload) : null, STATES.QUEUED, t, scope ?? null);
      if (principal) attributedJobs.set(jobId, principal);
      const job = parseJob(rawRow(db, '_Job', jobId));
      if (job && job.scope != null) {
        emit(buildEvent(job, 'enqueued', t));
      }
      return job;
    });
  }

  // Claim the oldest available queued job for a worker. The claim itself is an
  // atomic single-statement UPDATE…RETURNING (a racing claim sees
  // status='claimed' and gets zero rows), but the entry point routes through the
  // write coordinator because a scoped claim also appends a live-visibility
  // event afterwards. `availableAt` is the backoff gate: a retried job is not
  // claimable until now. `{ kind }` restricts the claim to one kind (an
  // in-process worker runs one kind's handler). Returns the claimed job (status
  // 'claimed', leaseUntil set) or null.
  function claim(workerId        , { kind, scope }                                    = {})                                         {
    return coordinated(() => {
      const t = now();
      const clauses = ['status = ?', '(availableAt IS NULL OR availableAt <= ?)'];
      const params                      = [STATES.QUEUED, t];
      if (kind != null) { clauses.push('kind = ?'); params.push(kind); }
      if (scope != null) { clauses.push('scope = ?'); params.push(scope); }
      const where = clauses.join(' AND ');
      const row = db.prepare(
        `UPDATE _Job
           SET status = ?, workerId = ?, claimedAt = ?, leaseUntil = ?
         WHERE id = (SELECT id FROM _Job WHERE ${where} ORDER BY enqueuedAt LIMIT 1)
         RETURNING *`,
      ).get(STATES.CLAIMED, workerId, t, t + leaseMs, ...params);
      const job = parseJob(row) ?? null;
      if (job && job.scope != null) {
        emit(buildEvent(job, 'claimed', t));
      }
      return job;
    });
  }

  // Heartbeat: the owning worker extends its lease; the first heartbeat flips
  // claimed→running. Non-owner or terminal → false. Best-effort: a dropped
  // heartbeat is fine within the lease window (the reaper reconciles). Routed
  // through the write coordinator: the _Job update, the _Worker lastHeartbeat
  // touch, and the possible live-visibility event are separate statements.
  function heartbeat(jobId        , workerId        , { now: nowFn = now }                         = {})                             {
    return coordinated(() => {
      const t = (typeof nowFn === 'function' ? nowFn : now)();
      const pre = db.prepare('SELECT status, scope FROM _Job WHERE id = ?').get(jobId);
      if (!pre) return false;
      const wasClaimed = pre.status === STATES.CLAIMED;
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
        if (wasClaimed && pre.scope != null) {
          const job = parseJob(rawRow(db, '_Job', jobId));
          if (job && job.scope != null) {
            emit(buildEvent(job, 'running', t));
          }
        }
      }
      return res.changes > 0;
    });
  }

  // Submit a result. Idempotent by job id: a retried result for an already-terminal
  // job is a no-op ack ({accepted:true, noop:true}) — the first terminal result
  // wins, the stored output is NOT overwritten (no double-apply of the derived
  // write). Non-owner / not-found → {accepted:false}. Routed through the write
  // coordinator: the guard read, the result UPDATE, and the possible
  // live-visibility event are separate statements (the UPDATE itself is the
  // atomic result write).
  //
  // Failure policy (substrate-owned, singular): a `failed` result is NOT
  // terminal while attempts < maxAttempts — the job is re-queued with backoff
  // (availableAt = now + backoffMs) and the ack carries {retried, attempts}. At
  // maxAttempts it becomes a terminal dead-letter ({deadLettered, attempts}).
  // A completed result is always terminal.
  function submitResult(jobId        , workerId        , { status, output = null }                                                                              )                                       {
    return coordinated(() => {
      if (status !== STATES.COMPLETED && status !== STATES.FAILED) {
        throw new Error('submitResult: status must be completed or failed');
      }
      const current = db.prepare('SELECT status, payload, workerId, attempts, scope FROM _Job WHERE id = ?').get(jobId);
      if (!current) return { accepted: false };
      if (TERMINAL.has(current.status             )) {
        // Idempotent retry: only the OWNING worker gets the no-op ack. A non-owner
        // probing someone else's terminal job is rejected — no accepting ack and no
        // confirmation that the job is terminal.
        return current.workerId === workerId ? { accepted: true, noop: true } : { accepted: false };
      }
      if (status === STATES.COMPLETED) {
        const res = db.prepare(
          `UPDATE _Job SET status = ?, payload = ?
           WHERE id = ? AND workerId = ? AND status IN (?, ?)`,
        ).run(status, output != null ? JSON.stringify(output) : null, jobId, workerId, STATES.CLAIMED, STATES.RUNNING);
        if (res.changes > 0) {
          if (current.scope != null) {
            const job = parseJob(rawRow(db, '_Job', jobId));
            if (job) emit(buildEvent(job, 'completed', now()));
          }
          return { accepted: true, noop: false };
        }
        return { accepted: false };
      }
      // FAILED: retry while under maxAttempts, else terminal dead-letter.
      const ownerGuard = 'AND workerId = ? AND status IN (?, ?)';
      const attempts = Number(current.attempts ?? 0) + 1;
      if (attempts < maxAttempts) {
        const res = db.prepare(
          `UPDATE _Job SET status = ?, workerId = NULL, claimedAt = NULL, leaseUntil = NULL, attempts = ?, availableAt = ?
           WHERE id = ? ${ownerGuard}`,
        ).run(STATES.QUEUED, attempts, now() + backoffMs, jobId, workerId, STATES.CLAIMED, STATES.RUNNING);
        if (res.changes > 0) {
          if (current.scope != null) {
            const job = parseJob(rawRow(db, '_Job', jobId));
            if (job) emit(buildEvent(job, 'retried', now()));
          }
          return { accepted: true, retried: true, attempts };
        }
        return { accepted: false };
      }
      const res = db.prepare(
        `UPDATE _Job SET status = ?, payload = ?, attempts = ?
         WHERE id = ? ${ownerGuard}`,
      ).run(status, output != null ? JSON.stringify(output) : null, attempts, jobId, workerId, STATES.CLAIMED, STATES.RUNNING);
      if (res.changes > 0) {
        if (current.scope != null) {
          const job = parseJob(rawRow(db, '_Job', jobId));
          if (job) emit(buildEvent(job, 'deadLettered', now()));
        }
        return { accepted: true, deadLettered: true, attempts };
      }
      return { accepted: false };
    });
  }

  // Update progress: the owning worker reports progress (0–100) and an
  // optional stage label while the job is claimed/running. Non-owner,
  // not-found, or terminal → null. Routed through the write coordinator (the
  // guard read, the UPDATE, and the live-visibility event are separate
  // statements).
  function updateProgress({ jobId, workerId, progress, stage }                                                                           = {})                                         {
    return coordinated(() => {
      if (typeof progress !== 'number' || !Number.isFinite(progress)) return null;
      const clamped = Math.max(0, Math.min(100, Math.round(progress)));
      const current = db.prepare('SELECT id, workerId, status, scope FROM _Job WHERE id = ?').get(jobId);
      if (!current) return null;
      if (current.workerId !== workerId) return null; // only the owning worker may report progress
      if (current.status !== STATES.CLAIMED && current.status !== STATES.RUNNING) return null;
      db.prepare(
        'UPDATE _Job SET progress = ?, stage = ? WHERE id = ?',
      ).run(clamped, stage ?? null, jobId);
      const job = parseJob(rawRow(db, '_Job', jobId));
      if (job && job.scope != null) {
        emit(buildEvent(job, 'progress', now()));
      }
      return job;
    });
  }

  // Cancel a job. A queued job can be cancelled without owner check (no worker
  // owns it yet); a claimed/running job must be cancelled by its owning worker.
  // Terminal jobs (completed/failed/cancelled) cannot be cancelled. Routed
  // through the write coordinator (the guard read, the UPDATE, and the
  // live-visibility event are separate statements).
  function cancelJob({ jobId, workerId }                                        = {})                                             {
    return coordinated(() => {
      const current = db.prepare('SELECT id, status, workerId, scope FROM _Job WHERE id = ?').get(jobId);
      if (!current) return null;
      if (TERMINAL.has(current.status             )) return { terminal: true };
      // If the job has an owner, validate the caller owns it; queued jobs (no
      // owner) are cancellable without ownership check.
      if (current.workerId != null && current.workerId !== workerId) return { forbidden: true };
      db.prepare('UPDATE _Job SET status = ? WHERE id = ?').run(STATES.CANCELLED, jobId);
      const job = parseJob(rawRow(db, '_Job', jobId));
      if (job && job.scope != null) {
        emit(buildEvent(job, 'cancelled', now()));
      }
      return job;
    });
  }

  // Reaper sweep. (1) Jobs whose lease expired: a lease loss COUNTS as an attempt
  // — the same counter and maxAttempts cap as a worker-reported failure. Under the
  // cap the job is re-queued with the standard retry backoff (NOT immediately
  // available: instant reclaim by the same stuck worker is the tight-loop shape —
  // a worker whose heartbeats silently fail would otherwise re-claim and re-lose
  // the job forever, which is how one transcription ran 529×). At the cap it
  // dead-letters (terminal failed, `deadLetterReason: 'lease-expired'` merged into
  // the payload; workerId kept for forensics, matching submitResult's dead-letter).
  // (2) Revoke workers whose lastHeartbeat is older than the grace window — their
  // bearer is rejected after. The worker's work must be idempotent (documented)
  // because a reassigned job is re-run from scratch by the new claimant. Routed
  // through the write coordinator: the sweep is several separate statements.
  function reap({ now: nowFn = now }                         = {})                                                                                                                                         {
    return coordinated(() => {
      const t = (typeof nowFn === 'function' ? nowFn : now)();
      // Dead-letter first, then requeue: any expired row matches exactly one
      // predicate, and the back-to-back synchronous statements cannot interleave
      // with anything else (single-threaded sync DB, and this runs inside the
      // coordinated turn when one is configured).
      const deadRows = db.prepare(
        `UPDATE _Job SET status = ?, attempts = attempts + 1, leaseUntil = NULL
         WHERE status IN (?, ?) AND leaseUntil < ? AND attempts + 1 >= ${Number(maxAttempts)}
         RETURNING *`,
      ).all(STATES.FAILED, STATES.CLAIMED, STATES.RUNNING, t);
      for (const row of deadRows) {
        const payload = row.payload != null ? JSON.parse(row.payload          ) : {};
        db.prepare('UPDATE _Job SET payload = ? WHERE id = ?').run(
          JSON.stringify({ ...payload, deadLetterReason: 'lease-expired' }), row.id,
        );
        if (row.scope != null) {
          const job = parseJob(row);
          if (job) emit(buildEvent(job, 'deadLettered', t));
        }
      }
      const reassignedRows = db.prepare(
        `UPDATE _Job SET status = ?, workerId = NULL, claimedAt = NULL, leaseUntil = NULL, attempts = attempts + 1, availableAt = ?
         WHERE status IN (?, ?) AND leaseUntil < ?
         RETURNING *`,
      ).all(STATES.QUEUED, t + backoffMs, STATES.CLAIMED, STATES.RUNNING, t);
      for (const row of reassignedRows) {
        if (row.scope != null) {
          const job = parseJob(row);
          if (job) emit(buildEvent(job, 'reassigned', t));
        }
      }
      if (deadRows.length > 0 || reassignedRows.length > 0) {
        getLog().warn('system', 'job-queue reaper: lease-expired jobs', {
          reassigned: reassignedRows.map((r) => ({ id: r.id, kind: r.kind, attempts: r.attempts })),
          deadLettered: deadRows.map((r) => ({ id: r.id, kind: r.kind, attempts: r.attempts })),
        });
      }
      const revoked = db.prepare(
        `UPDATE _Worker SET revoked = 1
         WHERE revoked = 0 AND lastHeartbeat < ?`,
      ).run(t - heartbeatGraceMs).changes;
      return { reassigned: reassignedRows.length, deadLettered: deadRows.length, revoked };
    });
  }

  // Periodic reaper, owned by the framework (the listen() layer registers the
  // stop() with onShutdown). No-op if already started. When a `clock` is provided
  // to the constructor, the reaper schedules via the shared clock (single timer,
  // nearest-deadline) instead of starting its own setInterval. A coordinated
  // reap resolves on a microtask, so both paths surface failures through a
  // caught promise rather than an uncaught throw.
  function startReaper()       {
    if (timer) return;
    const sweep = () => {
      try {
        const ran = reap();
        if (ran && typeof (ran                    ).then === 'function') {
          return (ran                    ).then(() => undefined).catch((err) => getLog().warn('system', 'job-queue reap failed', { err }));
        }
      } catch (err) {
        getLog().warn('system', 'job-queue reap failed', { err });
      }
      return undefined;
    };
    if (clock) {
      reaperWatcher = clock.add({ name: 'job-queue-reaper', intervalMs: reapIntervalMs, fn: sweep });
      return;
    }
    timer = setInterval(sweep, reapIntervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stop()       {
    if (reaperWatcher) { reaperWatcher.remove(); reaperWatcher = null; }
    if (timer) { clearInterval(timer); timer = null; }
  }

  // List jobs with optional filters. All filters are bound parameters (never
  // string interpolation). Ordered by enqueuedAt ASC.
  function list({ scope, kind, status, limit = 100 }                                                                     = {})           {
    const clauses           = [];
    const params            = [];
    if (scope != null) { clauses.push('scope = ?'); params.push(scope); }
    if (kind != null) { clauses.push('kind = ?'); params.push(kind); }
    if (status != null) { clauses.push('status = ?'); params.push(status); }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db.prepare(
      `SELECT * FROM _Job ${where} ORDER BY enqueuedAt ASC LIMIT ?`,
    ).all(...params, limit);
    return rows.map((row) => parseJob(row)          );
  }

  // In-process worker: run jobs of `kind` by claiming+executing+submitting
  // them in this process — the INTERNAL shortcut to the HTTP /jobs routes'
  // EXTERNAL worker. One process may both enqueue (post-commit consumer) AND
  // run jobs without standing up a separate worker + bearer auth. The internal
  // worker is a privileged path: a synthetic workerId, no _Worker row, no bearer
  // (the same trust boundary as enqueue()).
  //
  // S5/A5 machine attribution: the worker runs under an attributable machine
  // principal (`principal`, required — operational work never runs unattributed),
  // and the handler declares its allowed operations via `operations` (the
  // handler/context API). Dispatch validates the executing principal against
  // that context and denies on mismatch: if any declared operation is not in the
  // principal's allowlist (or in the job's enqueue-time attribution allowlist,
  // when one was attached), the job FAILS CLOSED — the fn is never invoked and
  // the job is recorded as failed with a denial reason. "Internal" is never an
  // implicit grant.
  //
  // `once()` runs one claim→fn→submit cycle and returns the result (or null when
  // nothing claimable) — awaitable for deterministic tests. The poll loop calls
  // once() on `pollIntervalMs`. `stop()` halts the loop. The fn's thrown error →
  // failed result → substrate retry/dead-letter policy; its return value →
  // completed result.
  function work(kind        , fn                                             , { principal, operations, pollIntervalMs: intervalMs = pollIntervalMs }                                                                                         )                                                                                                                     {
    if (!kind) throw new Error('work: kind is required');
    if (typeof fn !== 'function') throw new Error('work: fn must be a function');
    if (!isMachinePrincipal(principal)) {
      throw new Error('work: an attributable machine principal is required (machinePrincipal({ id, operations })) — operational work never runs unattributed');
    }
    const declared = normalizeDeclaredOperations(operations, 'work');
    const workerId = `in-process:${kind}:${randomUUID()}`;
    let pollTimer                                        = null;
    let pollWatcher                            = null;
    let stopped = false;

    // Fail-closed allowlist-via-context check: the executing principal (and, when
    // present, the job's enqueue-time attribution) must be granted every operation
    // the handler's context declares. Returns the first ungranted operation, or
    // undefined when everything is granted.
    function deniedOperation(principalLike                  )                     {
      return declared.find((operation) => !machineAllows(principalLike, operation));
    }

    async function once() {
      const job = await claim(workerId, { kind });
      if (!job) return null;
      await heartbeat(job.id, workerId);
      let denied = deniedOperation(principal);
      if (denied === undefined) {
        const attributed = attributedJobs.get(job.id);
        if (attributed) denied = deniedOperation(attributed);
      }
      if (denied !== undefined) {
        // Fail closed: the fn is never invoked. Record the denial as a failed
        // result so the job cannot linger claimed (the substrate's uniform
        // retry/dead-letter policy applies to the recorded failure).
        const result = await submitResult(job.id, workerId, {
          status: STATES.FAILED,
          output: { denied: true, operation: denied, error: `machine operation '${denied}' not granted to the executing principal` },
        });
        getLog().warn('system', 'job worker denied: operation not in the executing machine principal allowlist', {
          kind, jobId: job.id, operation: denied,
        });
        return { job, result, denied };
      }
      let result              ;
      try {
        const output = await fn(job);
        result = await submitResult(job.id, workerId, { status: STATES.COMPLETED, output: output ?? null });
      } catch (err) {
        result = await submitResult(job.id, workerId, { status: STATES.FAILED, output: { error: err instanceof Error ? err.message : String(err) } });
        getLog().warn('system', 'job worker fn failed', { err, kind, jobId: job.id });
      }
      return { job, result };
    }

    function start() {
      if (pollTimer || pollWatcher || stopped) return;
      if (!Number.isFinite(intervalMs)) return;
      if (clock) {
        pollWatcher = clock.add({ name: `job-worker-${kind}`, intervalMs, fn: () => void once() });
        return;
      }
      pollTimer = setInterval(() => { void once().catch((err) => getLog().warn('system', 'job worker poll failed', { err, kind })); }, intervalMs);
      if (typeof pollTimer.unref === 'function') pollTimer.unref();
    }
    function stop() {
      stopped = true;
      if (pollWatcher) { pollWatcher.remove(); pollWatcher = null; }
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    start();
    return { once, stop, workerId };
  }

  return { registerWorker, authenticate, enqueue, claim, heartbeat, submitResult, updateProgress, cancelJob, reap, startReaper, stop, work, onEvent, list };
}

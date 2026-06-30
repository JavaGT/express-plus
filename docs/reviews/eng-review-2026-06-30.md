# Engineering Architecture Review — express+ Foundation Build Phase (2026-06-30)

**Scope:** lock the technical architecture for the next major build phase — the seven
priorities that replace the majority of scope's backend infrastructure and turn
express+ from a demo into a real collaborative backend.

**Method:** plan-eng-review (the 7-step skill). This is PLANNING ONLY — no source code
or tests are written here. Every design choice obeys the hard constraints in
`AGENTS.md` and the decisions already recorded in `DECISIONLOG.md` (#1–#58). It
extends established patterns; it does not relitigate them.

**Inputs read (in order):** `AGENTS.md`, `SCOPE-FINDINGS.md`, `SPEC.md` (esp. §13),
`DECISIONLOG.md` (#26–#58 recent), retired `FEATURES.md`/`CONTEXT.md`, and the
`src/*.mjs` modules (`pipeline.mjs`, `live.mjs`, `serve.mjs`, `field-strategy.mjs`,
`field.mjs`, `entity.mjs`, `scope-sql.mjs`, `db.mjs`, `ddl.mjs`, `middleware.mjs`,
`row-grant.mjs`, `index.mjs`).

---

## 0. The two load-bearing findings that shape everything

Reading the current source surfaced two architectural facts the review must account
for. They are not new problems to design around; they are the seams the seven
priorities unify.

### Finding A — the pipeline kernel is latent; the live HTTP path is a second path

`pipeline.mjs createServer({ handlers, authorize })` owns the spec'd kernel: an
in-memory `log[]`, an in-memory `sequences` Map (per-scope monotonic seq), an
in-memory `dispatched` Map (action-id dedupe), and a `dispatch()` that authorizes →
dedupes → runs handler → assigns seq → appends → returns events. **No HTTP path
calls it.** `serve.mjs dispatch()` is the actual mutation path: it runs `bindReadScope`
+ `mayVerb`, then does a **raw `INSERT`/`UPDATE`/`DELETE`** against `app.db`, then
calls `live.emit(...)` directly. The kernel and the HTTP path are two parallel
mutation paths that agree by luck, not by construction.

AGENTS.md is explicit and outranks "don't touch working code": *"A new general
mechanism retires the special-case it generalizes, in the same change."* Priority
#1 (the durable log) is the general mechanism; the raw-SQL-then-emit path in
`serve.mjs` is the special case. **Priority #1 migrates the HTTP CRUD dispatch onto
the pipeline kernel in the same change that lands the durable log.** The end state has
one mutation path: `serve.mjs` resolves scope → authorizes (outside txn) → calls
`server.dispatch(...)` (which, with persistence engaged, opens one serialized write
transaction, runs the handler as events, assigns per-scope seq, appends to the
durable `Log` table, commits) → the committed events fan out to live + projections.
The raw SQL in `serve.mjs` is deleted, not left beside the new path.

### Finding B — `live.mjs` keeps a second sequence counter

`live.mjs` carries its own `sequences` Map and assigns seq on `emit()`, independent
of `pipeline.mjs`'s `sequences`. This is exactly the debt SCOPE-FINDINGS §5 names:
*"two monotonic counters on one row labeled `seq`… inviting 'which seq?'
confusion."* Priority #1 collapses them: **there is one per-scope sequence, assigned
once at commit in the pipeline kernel, stamped on the committed event.** `live.emit`
reads seq from the committed event; it no longer mints one. The live `dispatchedActions`
dedupe map is likewise retired onto the kernel's action-id dedupe (one dedupe, not
two).

These two findings together define the spine of the new foundation: **one mutation
pipeline, one durable log, one sequence per scope, one dedupe, one post-commit
fan-out.** Everything else hangs off it.

---

## Step 1 — Architecture diagram

Every component the seven priorities introduce is a named box. `★N` marks a
priority's first-class contribution. Components already shipped (Phase 1 + Phase 2
slices 1–4) are marked `[shipped]`.

```
                          ┌─────────────────────────────────────────────┐
                          │                 CLIENT                       │
                          │  LiveChannel ★7  ←── WS ──→  /events        │
                          │  LiveList ★7 (boot-snapshot-then-stream)     │
                          │  createClient [shipped] (ingest+cursor core) │
                          │  dispatch(type,payload) → one result shape   │
                          └───────────────┬─────────────────────────────┘
                                          │ HTTP (REST + WS upgrade)
                                          ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                          express+  SERVER PROCESS                          │
│                                                                            │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ HTTP transport  serve.mjs [shipped: socket, gate, body, err, static]│  │
│  │  + ops bundle ★4: rateLimit · csrfOrigin · nonceCSP · hsts · cors    │  │
│  │    · requestLog · metrics · /health(/stats) · envGate · onShutdown   │  │
│  │  + writeQueue ★1/★4 (single-writer mutex over node:sqlite)           │  │
│  │  + migrations ★4 (versioned schema, beyond CREATE TABLE IF NOT EXISTS)│  │
│  └───────────────┬────────────────────────────────────────┬─────────────┘  │
│                  │ admitted request                         │ WS upgrade     │
│                  ▼                                          ▼                │
│  ┌─────────────────────────────────┐   ┌──────────────────────────────────┐ │
│  │  ROUTE GATE [shipped]            │   │  LIVE SERVER  live.mjs [shipped] │ │
│  │  requireUser/allowAnonymous      │   │  + interest ★6 (field-keyed     │ │
│  │  (1st default-on auth layer)     │   │    subscribe {fields,pace})     │ │
│  └───────────────┬─────────────────┘   │  + pace/coalescer ★6 (2-layer)  │ │
│                  ▼                      │  + latched re-auth cache ★6    │ │
│  ┌─────────────────────────────────┐   │  + per-field-type delta ★6     │ │
│  │  PIPELINE KERNEL  pipeline.mjs   │   │  re-auth via SAME mayVerb       │ │
│  │  [shipped: shape] ★1 durable     │   │  (no 2nd auth path)            │ │
│  │   ─ resolve scope (pure)         │   └──────────────▲─────────────────┘ │
│  │   ─ authorize (OUTSIDE txn)      │                  │ committed event   │
│  │   ─ open WRITE TXN (serialized   │                  │ (seq stamped)     │
│  │     by writeQueue)               │                  │                   │
│  │   ─ dedupe by actionId           │   ┌──────────────┴─────────────────┐ │
│  │   ─ run handler → emit EVENTS    │   │  POST-COMMIT FAN-OUT ★3         │ │
│  │   ─ assign per-scope seq ★1      │   │  (one registry of consumers)    │ │
│  │   ─ append to durable LOG table  │───│  ├─ liveFanOut (sync, in-proc)   │ │
│  │     (node:sqlite) ★1             │   │  ├─ enqueueJobs (→ job-queue)  │ │
│  │   ─ BLOB ADOPT in same txn ★2    │   │  ├─ webhook/email (async, retried)│
│  │   ─ commit                       │   │  ├─ ftsIndex (plugin seam) ★3   │ │
│  │   ─ row GRANT (.can) [shipped]   │   │  └─ projected.async fields ★3   │ │
│  │     runs on every verb (2nd      │   │  each consumer: independently   │ │
│  │     default-on auth layer)       │   │  durable, own retry, own        │ │
│  └───────────────┬─────────────────┘   │  watermark; never rolls origin  │ │
│                  │ committed events    └──────────────▲──────────────────┘ │
│                  ▼                                     │                   │
│  ┌─────────────────────────────────┐                   │                   │
│  │  DURABLE LOG  ★1                 │───────────────────┘                   │
│  │  Log table (scope, seq, event,   │   (consumers READ the committed log;  │
│  │  actionId, committedAt)          │    a bounded projection principal     │
│  │  Cursor table (scope, lastSeq) ★1│    writes derived read models through  │
│  │  Snapshot endpoint ★1            │    the TARGET's own grant — no 2nd    │
│  │  Resync endpoint ★1 (hard-fail   │    write path)                        │
│  │   on stale cursor)               │                                       │
│  └───────────────┬─────────────────┘                                         │
│                  │ reads/writes                                              │
│                  ▼                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  node:sqlite  (ONE handle, app.db [shipped], ambient via db.mjs)   │    │
│  │   Entity tables [shipped] · Side-tables (map/log/presence) [shipped]│    │
│  │   Log ★1 · Cursor ★1 · BlobStore (pending→adopted) ★2              │    │
│  │   Job table ★5 · Worker table ★5 · Projection watermark ★3        │    │
│  │   Migration meta ★4                                                │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                            │
│  ┌───────────────────────────┐        ┌──────────────────────────────────┐  │
│  │  BLOB STORE ★2             │        │  JOB QUEUE ★5 (separate seam)    │  │
│  │  disk BlobStore (node:fs)  │        │  claim/lease/heartbeat/reaper    │  │
│  │  pending→adopted (2-phase) │        │  per-worker bearer tokens        │  │
│  │  in-flight md5+sha256      │        │  reaper reassigns stale jobs      │  │
│  │  range reads               │        │  shared-secret registration      │  │
│  │  path-containment guard    │        │  (the WORK is app domain; the     │  │
│  │  reaper: orphan .pending + │        │   SUBSTRATE is framework)         │  │
│  │  dangling durable blobs    │        └──────────────▲───────────────────┘  │
│  └──────────────▲────────────┘                        │ claim/result POST   │
│                  │ upload stream                       │ (bearer-authed)     │
│                  │                                     │                     │
│  ┌───────────────┴─────────────┐              ┌─────────┴──────────────┐      │
│  │  FIELD-TYPE PLUGINS ★6       │              │  WORKER (app domain)   │      │
│  │  crdt/store/ordered/struct   │              │  transcription,         │      │
│  │   apply+diff (replace throw) │              │  embeddings, …          │      │
│  │  list (fractional index)     │              └────────────────────────┘      │
│  │  log (:appended event)       │                                              │
│  │  presence (per-conn coalesce)│              ┌──────────────────────────┐   │
│  │  state (transitions + auto)  │              │  PROJECTION PLUGINS ★3   │   │
│  │  EFFECTS grammar ★6          │              │  (seam only; engines     │   │
│  │   inc/dec/append/push/       │              │   deferred — FTS, geo,   │   │
│  │   insertAt/move, when,       │              │   embeddings are app/)   │   │
│  │   effectSource/principalFrom,│              └──────────────────────────┘   │
│  │   cycle detect, many(...),   │                                              │
│  │   anyOf(...)                  │                                              │
│  └──────────────────────────────┘                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Cross-cutting composition (the decisions the diagram encodes):**

- **Durable log ★1 is the substrate.** Every committed mutation appends to one
  `Log` table with one per-scope seq. Projections ★3 read it; live ★6 broadcasts
  from it; resync ★1 replays it. No second write path.
- **WriteQueue ★1/★4 serializes the pipeline's write transaction** so a flood of
  requests (or a handler that `await`s between `BEGIN` and `COMMIT`) cannot
  interleave on single-writer node:sqlite. This is scope's `withSqliteWriteLock`
  over the node:sqlite synchronous handle.
- **Blob adopt ★2 is IN-transaction with the dispatch commit**, not a projection.
  The atomicity boundary: a blob reference must be atomic with the row that points
  at it. Pending on upload, adopted in the same commit that appends the referencing
  event. A rolled-back dispatch leaves the blob `.pending` for the reaper.
- **Live fan-out is a SYNCHRONOUS projection consumer** of the committed log (it
  reads committed events and pushes to WS subscribers in-process, post-commit). It
  is one entry in the projection registry ★3, not a separate fan-out path. This is
  "subtract before add" applied to the post-commit seam: one fan-out, many
  consumers.
- **Job-queue ★5 is a SEPARATE seam, not a projection.** A job is a unit of work
  with its own lifecycle (claimed/leased/heartbeat/reaped), not a derived read
  model. A projection consumer may *enqueue* jobs; the queue's lifecycle is its
  own. Justification by the deletion test: folding the job-queue into the
  projection registry would *relocate* the claim/lease/heartbeat/reaper concept
  into a projection-shaped config without deleting it — net ceremony, rejected.
  The two compose at the enqueue edge, not by merger.
- **Phase-2 field machinery ★6 and live §8 are CONSUMERS of the log + projection
  seam.** A field plugin's `diff` produces per-element deltas → events in the log →
  the live projection consumer broadcasts field-keyed deltas to interested
  subscribers. Building ★1 + ★3 first is what makes ★6 a pure extension, not a
  parallel system.

---

## Step 2 — Data flow (end-to-end walks)

### Walk 1 — a dispatched action that engages persistence + projection + live + blob

A user uploads a profile photo: `PATCH /users/:id` with a `photo` blob field, which
also triggers a thumbnail projection (`projected.async`) and live subscribers.

1. **Client** `dispatch('updateUser', { id, photo: <blob bytes> })`. The client
   library ★7 derives the URL `/users/:id` from the declared entity name (no
   hand-passed URL). Optimistic apply shows the photo immediately (visible
   placeholder).
2. **HTTP transport** `serve.mjs` receives the request. Ops bundle ★4 runs first:
   rateLimit (per-IP fixed window) → csrfOrigin (mutation must originate same-origin)
   → body-parse (capped). `applySecurityHeaders` [shipped]. A 429/403/413 fails
   closed here before any work.
3. **Route gate** [shipped] `route.gate(principal)` — first auth layer. Anonymous →
   401. (Session→principal hydration [shipped] built the principal server-side from
   the cookie.)
4. **Resolve scope + authorize (OUTSIDE the transaction)** — `pipeline.mjs`.
   `resolveScope` is pure (no I/O), so a forbidden request never enters the write
   queue. `authorize` runs the grant's `scope`+`.can`. Deny → 403, log nothing.
5. **WriteQueue ★1/★4 acquires the single-writer mutex.** The dispatch transaction
   is now serialized; no other write interleaves until commit.
6. **Open transaction, dedupe by actionId** — a re-sent action returns its stored
   events without re-running the handler (idempotent). The dedupe map is the
   durable `Log` table keyed by `(scope, actionId)`, not the in-memory Map (so it
   survives restart).
7. **Run handler → emit events.** The handler runs against the entity row; the
   field-type plugin ★6 (`blob` value-kind with two-phase pending→adopt) writes the
   blob to disk under a `.pending/<id>` path during upload (step pre-1, see Walk 1b
   below), and the handler's event carries the blob id.
8. **Assign per-scope seq + append to `Log` table ★1** — `nextSeq(scope)` reads the
   persisted `Cursor` row, increments, stamps each event, inserts into `Log`. One
   sequence, one dedupe, one log (Finding B resolved).
9. **Blob adopt ★2 in the SAME transaction** — `UPDATE BlobStore SET status='adopted'
   WHERE id=? AND status='pending'`. If the txn commits, the blob is adopted; if it
   rolls back, the blob stays `.pending` and the reaper sweeps it later. Atomic.
10. **Row grant `.can` [shipped]** runs on the materialized row (second auth layer)
    — if the principal lacks `write`, the txn rolls back (blob stays pending, no
    event committed, 403). No second auth path.
11. **Commit.** The writeQueue releases the mutex. The HTTP response `200` with the
    updated row is sent.
12. **Post-commit fan-out ★3** fires (after the response is flushed, in-process):
    - **liveFanOut** (sync projection consumer): reads the committed event's seq,
      finds subscribers of `(User, id)` with field-keyed interest ★6 in `photo`,
      re-auths each via `mayVerb('subscribe', row, principal)` through the
      **latched re-auth cache** ★6 (invalidated on roster/role/ownership change —
      not per-emit uncached as today), applies the **two-layer pace/coalescer** ★6,
      sends field-typed delta frames. The client `LiveList` ingests through the
      existing `createClient.ingest` → cursor advances.
    - **enqueueThumbnail** (async projection consumer): sees the `photo` event,
      enqueues a ★5 job to render a thumbnail. Its own durability + retry; a
      failure does not roll back the photo upload.
    - (no webhook consumer registered for this entity — skipped.)
13. **Projected.async field** `thumbnailUrl` is updated by the thumbnail job's result
    submission, admitted by the User entity's own grant via a bounded projection
    principal (no second write path).

**Failure analysis for Walk 1 (each arrow):**

| Arrow | Failure | Impact | Mitigation |
|---|---|---|---|
| Client→server upload | network drop mid-blob | `.pending` orphan on disk | Blob reaper ★2 sweeps `.pending` older than TTL; the dispatch never committed so no dangling row |
| 2→3 rate limit | over-limit | 429 | Fixed window; client backs off. No state touched. |
| 5 writeQueue | another txn holds the mutex | request waits | Bounded wait + timeout → 503 (fail closed, do not pile unbounded). |
| 7 handler throws | exception | txn rolls back | Blob stays `.pending` (reaper); no event committed; 500 via `renderError`. |
| 8 Log insert | SQLite error (disk full) | txn rolls back | Blob stays pending; 500; disk alert via metrics ★4. |
| 9 blob adopt | row already adopted (race) | idempotent | `WHERE status='pending'` makes adopt a no-op if already adopted; the blob was uploaded fresh so this is fine. |
| 11 commit | crash before commit | nothing persisted | On restart, the `.pending` blob is reaped; the user retries; dedupe by actionId makes the retry idempotent. |
| 12 liveFanOut | a subscriber's socket closed | one client misses event | Its cursor is behind; on reconnect it bootstraps/resyncs ★1 (the log retained the event). |
| 12 enqueueThumbnail | job-queue insert fails | thumbnail not rendered | Projection consumer retries on its own schedule; never rolls back the photo. |

### Walk 1b — the blob upload sub-flow (two-phase)

The blob upload is a *separate* HTTP request that precedes the dispatch, because
the dispatch's event must reference a blob id that already exists on disk:

1. `POST /blobs` (or a per-field upload route) with the bytes. Ops bundle applies.
2. **BlobStore ★2** streams to `<root>/<id>.pending`, computing **md5 + sha256
   in-flight** as bytes arrive (one pass, no double read). A **path-containment
   guard** rejects any id that escapes `<root>` (no `../`, no absolute path).
3. On upload complete: insert a `BlobStore` row `{id, status:'pending', md5, sha256,
   size, mime, createdAt}` in a *short* transaction (serialized by the writeQueue).
   Return `{id}` to the client.
4. The client's subsequent `dispatch` carries `{photo: blobId}`.
5. At commit (Walk 1 step 9), the blob is **adopted**: `UPDATE BlobStore SET
   status='adopted' WHERE id=?` AND the entity row's `photo` cell stores the blob id.
   Both in one txn → atomic.
6. The **reaper ★2** periodically: deletes `.pending` files whose `BlobStore` row is
   `pending` older than the TTL (orphaned uploads), and deletes durable blobs whose
   row is `adopted` but referenced by no entity row (dangling, after a delete cascade
   — handled by a reference-count sweep over entity columns of blob type).

### Walk 2 — a worker job lifecycle (priority #5)

1. **Enqueue.** A projection consumer (Walk 1 step 12) or an imperative handler or a
   `schedule` inserts a row into `Job`: `{id, kind, payload, status:'queued',
   enqueuedAt}`. (The job *work* — transcription, embeddings — is the app's domain;
   express+ only stores the row.)
2. **Worker registers.** A worker process starts, `POST /workers/register` with a
   **shared secret** (constant-time compared) → server issues a per-worker **bearer
   token** and inserts a `Worker` row `{id, tokenHash, lastHeartbeat}`. The shared
   secret is a deployment env var validated at startup by envGate ★4.
3. **Claim.** Worker `POST /jobs/claim` with its bearer (constant-time compared,
   fail-closed on unknown/revoked). In the writeQueue-serialized txn, the server
   selects the oldest `queued` job, atomically sets `status='claimed',
   workerId=<w>, claimedAt, leaseUntil=now+lease`, returns the job. **At most one
   worker claims a given job** — the claim is an `UPDATE … WHERE status='queued'
   RETURNING *` inside the mutex; a racing claim gets zero rows.
4. **Heartbeat.** Worker `POST /jobs/:id/heartbeat` every `lease/3` with its bearer.
   Server extends `leaseUntil` only if `workerId` matches and `status='running'`.
5. **Progress/result.** Worker `POST /jobs/:id/result` with `{status:'completed',
   output}` (or `failed`). Bearer-authed. Server updates the `Job` row; if completed,
   the result feeds the projection principal that writes the derived read model
   (e.g., the `thumbnailUrl` field) admitted by the target's grant.
6. **Reaper.** A periodic sweep: for each `claimed`/`running` job whose
   `leaseUntil < now`, set `status='queued', workerId=NULL` (reassign). For each
   `Worker` whose `lastHeartbeat < now−grace`, revoke its bearer token. A reassigned
   job is claimable by another worker; the stalled worker's bearer is now rejected.
7. **Idempotency.** A worker may retry `POST /jobs/:id/result` after a network drop.
   The result submission is idempotent by job id (a re-submitted result for an
   already-completed job is a no-op ack), so a retry never double-applies the
   derived write.

**Failure analysis for Walk 2:**

| Arrow | Failure | Impact | Mitigation |
|---|---|---|---|
| 3 claim race | two workers claim same job | double execution | claim is `UPDATE…WHERE status='queued' RETURNING` in the writeQueue mutex — second worker gets zero rows. |
| 4 heartbeat drop | lease expires | reaper reassigns | Heartbeat is best-effort; losing some is fine within the lease window. |
| worker crash mid-job | lease expires | job reassigned | Reaper re-queues; the new worker re-runs. **Job work must be idempotent** — the framework documents this; non-idempotent work is the app's responsibility to guard (a `state`-style "processing" flag the app sets). |
| 5 result drop | job marked running forever | reaper re-queues | If the worker did finish but the result POST dropped, the re-run redoes the work and re-posts. Idempotent result write prevents double-apply. |
| bearer stolen | impersonation | — | Bearer is per-worker, revocable; constant-time compare; rotated on reaper revocation. Shared secret only for registration, never for job operations. |

### Walk 3 — client bootstrap + live-stream + resync (priority #7 + #1)

1. Page loads `LiveList.open(User, id)` ★7. The library derives two URLs from the
   declared entity name: `GET /snapshot/User/:id` ★1 and `ws://host/events` [shipped].
2. **Bootstrap ordering enforced structurally** (the SCOPE-FINDINGS §2.6 foot-gun):
   `LiveList.open` performs the snapshot fetch FIRST, sets the cursor to the
   snapshot's sequence, and ONLY THEN opens the WS and sends `subscribe`. The WS
   is not opened before the cursor is set. A `LiveList` that has not bootstrapped
   refuses to ingest live events (it queues them behind an internal gate that opens
   on snapshot completion) — the developer cannot get the ordering wrong.
3. **Snapshot endpoint ★1** `GET /snapshot/User/:id`: reads the current materialized
   row (the entity table IS the snapshot — scope's proven shape; the log is the
   resync source, not the snapshot source) + the current `Cursor.lastSeq` for the
   scope. Authorizes at the `viewer` bar (lower than dispatch's `editor`) — same
   auth engine, different capability (no second auth path). Returns `{snapshot, seq}`.
4. Client `bootstrap(scope, snapshot, seq)` [shipped in `createClient`], then opens
   WS, sends `{type:'subscribe', entity:'User', id, fields:{photo:...}, pace:...}`
   ★6.
5. **Live stream.** Committed events for the scope fan out (Walk 1 step 12). The
   client `ingest` [shipped] classifies each by seq vs cursor+1: duplicate → skip,
   next → fold + advance, **gap → do NOT apply, signal resync**.
6. **Resync ★1.** On a gap, the client `GET /events-since/User/:id?cursor=N` ★1.
   The server reads the `Log` from `N+1` onward for the scope. If `N+1` is still
   within the retained log → return the missing events; the client folds them in
   order (the reducer fold is the source of truth — never a wholesale snapshot
   replace, except at bootstrap). **If `N` is older than the oldest retained event
   (the log was trimmed past the cursor) → HARD-FAIL**: the server returns
   `{resync:'stale', reason:'cursor-behind-retention'}` and the client forces a full
   re-bootstrap (re-fetch snapshot, reset cursor). **Never a silent truncate.**
7. **Reconnect.** WS drops; `LiveChannel` ★7 auto-reconnects with backoff, re-sends
   `subscribe`, and if the server's current seq > cursor+1, immediately resyncs
   before live ingestion resumes.

**Failure analysis for Walk 3:**

| Arrow | Failure | Impact | Mitigation |
|---|---|---|---|
| 2 ordering race | dev opens WS manually before snapshot | permanent event loss (the foot-gun) | `LiveList` structurally forbids it — no public "open WS" API separate from bootstrap; the library owns the order. |
| 3 snapshot authz | viewer not admitted | 403 | Fail closed; client shows error, no stream. |
| 6 gap→resync | log trimmed past cursor | silent data loss | HARD-FAIL → forced re-bootstrap. This is the single most important correctness property (SCOPE-FINDINGS §2.6). |
| 6 resync fetch | network drop | client behind | `LiveChannel` retries the fetch; idempotent by cursor (re-fetching the same range re-folds duplicates — `ingest` skips them by seq). |
| snapshot vs live race | event commits between snapshot read and subscribe | client misses it | On subscribe, server reports `currentSeq`; if `currentSeq > clientCursor`, client resyncs the gap before going live. |

---

## Step 3 — State machines

### 3.1 Durable event (priority #1)

```
                 handler emits
   (none) ──────────────────────► PENDING(in-txn)
                                   │
                                   │ append to Log + assign seq + blob adopt
                                   ▼
                                 COMMITTED
                                   │
                                   │ post-commit fan-out delivers
                                   ▼
                                 PROJECTED (per consumer: live=delivered,
                                            fts=indexed, job=enqueued)
```

- **States:** `PENDING` (exists only inside the open transaction; never observable),
  `COMMITTED` (durable in `Log`), and per-consumer `PROJECTED` (tracked by each
  projection consumer's own watermark, not on the event row).
- **Transitions:** PENDING→COMMITTED on commit; COMMITTED→(delivered/indexed/...) per
  consumer, asynchronously. A rollback cancels PENDING (no event ever exists).
- **Who sees each state:** COMMITTED is observable by all projection consumers and
  resync. PENDING is observable by nothing outside the txn.
- **Idempotency key:** `(scope, actionId)` — a re-dispatch returns the stored
  committed events without re-running. This is the durable form of the in-memory
  `dispatched` Map; it survives restart (Finding A).
- **Timeout:** none on the event itself; projection consumers carry their own.

### 3.2 Blob (priority #2)

```
   (none) ──upload──► PENDING(.pending file on disk + BlobStore row status=pending)
                          │
                          │ dispatch commit adopts (same txn as referencing event)
                          ├──► ADOPTED (file renamed .pending→final, row status=adopted)
                          │
                          │ dispatch rolls back / upload orphaned
                          └──► REAPED (reaper deletes .pending file + row after TTL)
```

- **Transitions:** `PENDING→ADOPTED` (in the dispatch txn) or `PENDING→REAPED`
  (reaper after TTL). `ADOPTED→REAPED` (reaper deletes a durable blob whose
  reference count drops to zero — after an entity delete cascade).
- **Idempotency:** adopt is `UPDATE BlobStore SET status='adopted' WHERE id=? AND
  status='pending'` — re-adopting is a no-op. Upload by content hash can dedupe
  (two uploads of identical bytes → one blob, refcount 2) — **opt-in, not required
  for the spine**; flag in dashboard.
- **Timeout:** pending TTL (configurable; default e.g. 1h). Reaper interval
  separate.
- **Who sees:** PENDING is server-internal; ADOPTED is the only state a client
  reference resolves to.

### 3.3 Job (priority #5)

```
   QUEUED ──claim──► CLAIMED ──heartbeat──► RUNNING ──result──► COMPLETED
     ▲                   │                      │                  ▲
     │                   │ lease expired        │ result=failed    │
     │                   ▼                      ▼                  │
     └──────────── REASSIGNED              FAILED ◄─────────────────┘
              (reaper)                  (terminal)
```

- **States:** `QUEUED`, `CLAIMED` (claimed, not yet heartbeating), `RUNNING`
  (first heartbeat received), `COMPLETED`, `FAILED` (terminal), `REASSIGNED`
  (transient — back to QUEUED).
- **Transitions:** QUEUED→CLAIMED (claim, atomic), CLAIMED→RUNNING (first
  heartbeat), RUNNING→COMPLETED/FAILED (result), CLAIMED/RUNNING→REASSIGNED→QUEUED
  (reaper on lease expiry).
- **Idempotency key:** job id. Result submission is idempotent — a second
  `POST /jobs/:id/result` for an already-terminal job is a no-op ack.
- **Timeout:** lease duration (configurable per job kind, default e.g. 60s).
  Reaper sweeps leases + worker heartbeats on a fixed interval.
- **Who sees:** the enqueuing projection/handler sees QUEUED; the worker sees
  CLAIMED→RUNNING; the server sees all. A client never sees a job row directly (it
  sees the derived read model the job produces).

### 3.4 Projection consumer (priority #3)

```
   ┌──► CAUGHT-UP (watermark == log tail)
   │       │ a new committed event arrives
   │       ▼
   │   CATCHING-UP (processing events between watermark and tail)
   │       │ success
   └───────┘
           │ failure (retry exhausted / consumer error)
           ▼
         FAILED (consumer-local; origin never rolls back; alertable via metrics ★4)
           │ operator fix + replay from watermark
           ▼
         CATCHING-UP
```

- **States:** `CAUGHT-UP`, `CATCHING-UP`, `FAILED`.
- **Watermark:** each consumer tracks its last-processed `(scope, seq)`. On
  restart, it resumes from its watermark — independently durable (a consumer crash
  does not lose the origin; it just falls behind). This is the
  `projected.async` sequence-watermark ADR #12 already names.
- **Idempotency:** a consumer re-processing an event it already consumed must be
  idempotent (FTS re-index the same doc → same index state; webhook receiver must
  dedupe by event id). The framework stamps each event with a stable id; consumers
  key dedupe on it.
- **Timeout:** per-consumer retry policy (own schedule). The origin is already
  committed; retrying a projection never touches the origin.

### 3.5 Sequence cursor (priority #1) — the realtime correctness core

```
   BOOTSTRAPPING ──snapshot+seq set──► LIVE
                                          │ event seq > expected
                                          ▼
                                        GAP ──resync fetch──► RESYNCING
                                          │                       │
                                          │ missing events folded  │
                                          │ in order               ▼
                                          │                  LIVE (cursor advanced)
                                          │
                                          │ resync finds cursor < oldest retained
                                          ▼
                                       HARD-FAIL ──forced re-bootstrap──► BOOTSTRAPPING
```

- **States:** `BOOTSTRAPPING` (loading snapshot, cursor not yet set), `LIVE`
  (cursor set, ingesting in order), `GAP` (a missing event detected),
  `RESYNCING` (fetching the missing range), `HARD-FAIL` (cursor is behind
  retention — the dangerous state; forces full re-bootstrap).
- **Valid transitions** are exactly the above. A `LIVE→HARD-FAIL` transition is the
  fail-closed substitute for the forbidden `LIVE→silent-truncate`. There is **no**
  transition that silently resets the cursor.
- **Idempotency:** `ingest` skips duplicates by seq (already implemented in
  `createClient`). Resync re-fetches by cursor; re-folding a duplicate is a skip.
- **Who sees:** the client owns its cursor; the server owns the `Cursor` table row
  (the source of truth for `lastSeq` per scope, used to assign the next seq and to
  serve snapshot+resync).

---

## Step 4 — Failure mode analysis (implementation gate)

Every boundary has a concrete failure, an impact, and a mitigation. **No code until
this table is complete.**

| # | Boundary | Concrete failure | Impact | Mitigation |
|---|---|---|---|---|
| 1 | Single-writer node:sqlite | Two dispatches interleave (a handler `await`s between `BEGIN`/`COMMIT`, yielding the loop; another request's `BEGIN` hits "transaction already open" / `SQLITE_BUSY`) | corrupted txn, 500 storm | **WriteQueue ★1/★4** mutex serializes the entire dispatch txn (begin→handler→log append→commit). A handler's internal `await` is safe because no other write acquires the mutex. Bounded queue wait → 503 if starved (fail closed, no unbounded pile). |
| 2 | Projection failure vs origin commit | FTS index insert throws | if it rolled the origin, a search-index bug would undo a committed post — forbidden | Projection is post-commit, independently durable (§3.4). Retries on its own schedule; origin stays committed. Alertable via metrics ★4. |
| 3 | Blob orphan window | upload completes, `.pending` row written, dispatch never comes (client abandons) | disk leak of `.pending` files | Reaper ★2 sweeps `.pending` older than TTL + deletes the BlobStore row. Bounded disk growth. |
| 4 | Blob dangling durable | entity row deleted; blob row stays `adopted` | disk leak of durable blobs | Reaper refcount-sweeps: a blob `adopted` and referenced by no entity column of blob type → delete file + row. (Requires the entity metadata to know which columns are blob-typed — available from the compiled entity record.) |
| 5 | **Stale cursor / silent truncate** (THE foot-gun) | client offline a week; log trimmed; client reconnects with old cursor | if server silently reset cursor → permanent silent data loss | **HARD-FAIL** ★1: resync detects `cursor < oldest retained seq` → returns `{resync:'stale'}` → client forces full re-bootstrap. Never a silent reset. This is the single non-negotiable correctness property. |
| 6 | Bootstrap ordering race | WS opens before snapshot; foreign event folds into empty state; snapshot then overwrites; cursor advanced → event loss | permanent, silent | `LiveList.open` ★7 structurally enforces snapshot-then-stream; no public "open WS first" API. |
| 7 | Worker offline mid-job | worker crashes after claim, before result | job stuck in RUNNING | Reaper re-queues on lease expiry (§3.3). **Job work must be idempotent** — documented framework contract; the app guards non-idempotent work (e.g., a `processing` state flag). |
| 8 | Re-auth cache staleness ★6 | a collaborator is removed but the latched cache still admits them → one event delivered to a revoked subscriber | confidentiality leak (brief, single event) | Latched cache **invalidated by roster/share/role/ownership change** — any mutation that could change the verdict invalidates the cache for the affected (entity, id). Conservative: invalidate on ANY grant-relevant mutation to the entity, accept a small over-invalidation cost. TTL backstop for safety. |
| 9 | Resync fetch partial | network drops mid-range | client behind | `LiveChannel` retries; `ingest` idempotent by seq — re-fetched duplicates skip. |
| 10 | Dedupe across restart | server restarts; in-memory `dispatched` Map (current `pipeline.mjs`) is gone; a retried action re-runs | duplicate state change | Dedupe moves to the durable `Log` keyed by `(scope, actionId)` ★1 (Finding A). Survives restart. |
| 11 | Sequence counter across restart | in-memory `sequences` (current) gone after restart; next seq resets to 0 → collisions | corrupted replay | `Cursor` table ★1 persists `lastSeq` per scope; `nextSeq` reads it at txn open. |
| 12 | Blob upload + adopt split-brain | upload succeeds on node A, dispatch commits on node B (multi-process) | **single-process deployment assumed** (node:sqlite is local) | Document single-process constraint; the writeQueue is in-process. Multi-process is out of scope for this phase (flag in dashboard). |
| 13 | CSRF / Origin spoof | cross-site POST | state mutation by a foreign origin | csrfOrigin ★4 on all mutations: `Origin`/`Referer` must match the allowed origin (same-origin default). Missing Origin on a mutation → reject (fail closed). |
| 14 | Rate-limit bypass via IP rotation | attacker rotates IPs | effective limit weakened | per-session limit supplements per-IP; both are fixed-window. Defense-in-depth, not a single line. |
| 15 | Env var missing at startup | `SESSION_SECRET`/`WORKER_SHARED_SECRET` unset | insecure defaults if guessed | envGate ★4 validates required env at startup → fail closed (process refuses to start), not a silent insecure default. |
| 16 | onShutdown deadline | a projection consumer / worker hangs on SIGTERM | process hangs, container kill -9 | onShutdown registry ★4 runs each hook with a deadline; on timeout, force-close and exit. Logged. |
| 17 | Migration mid-flight crash | schema ALTER runs, process crashes before meta bump | half-migrated schema | Migrations ★4 run inside the writeQueue txn with the meta-version bump in the same txn → atomic. On restart, the unfinished migration re-runs (idempotent ALTER guards). |
| 18 | Projection double-apply | consumer retries an already-processed event (e.g., after its own crash) | double webhook, double FTS index row | consumer-side idempotency keyed on stable event id; webhook receivers dedupe by event id; FTS re-index is idempotent. Documented contract. |

---

## Step 5 — Trust boundaries

```
   USER INPUT ──► API (validate · sanitize · rate-limit · NEVER trust client file metadata)
        │
        ▼
   API ──► EXTERNAL (PII? encrypt? rate-limit outbound? validate response shape)
        │
        ▼
   EXTERNAL ──► API (validate response shape; never exec untrusted)
        │
   WORKER ◄──► SERVER (shared secret for register + per-worker bearer for ops;
                        constant-time compare; bearer revocable)
        │
        ▼
   PROJECTION PRINCIPAL ──► TARGET (bounded to declared target entity + template fields;
                                    admitted by the TARGET's own grant; no second write path)
```

- **User input → API.** Body parsed + capped [shipped]. `validateMutation` [shipped]
  rejects undeclared keys, readonly writes, type-mismatches. **Blob metadata is
  never trusted**: the client supplies `mime`/`size` in the upload, but the server
  computes md5/sha256/size from the bytes itself and may sniff content type
  server-side; client-supplied mime is advisory only. Rate-limit ★4 gates auth +
  dispatch. CSRF Origin-check ★4 on mutations.
- **API → external.** A webhook projection sends out; PII consideration: webhook
  payloads are app-defined (the app's projection consumer composes them), so the
  framework's job is to give the consumer the committed event, not to police PII —
  that's the app's domain responsibility (documented). Outbound HTTP from a
  projection is retried, time-bounded, and its response shape is the consumer's to
  validate (a malformed webhook ack is a logged projection failure, not a crash).
- **External → API.** Worker result submissions and webhook receiver callbacks (if
  any) are validated as JSON; a worker result carrying an unexpected shape is a
  logged projection failure, never an exec'd blob.
- **Worker ↔ server.** Registration: shared secret (env var, constant-time
  compared). Operations (claim/heartbeat/result): per-worker bearer token,
  constant-time compared, revocable by the reaper. A bearer is per-worker, never
  the shared secret. This is scope's pattern.
- **Projection principal admission.** A projection that WRITES a derived read model
  (`projected.async` field, FTS index) runs as a **bounded projection principal**
  admitted by the **target's own grant** via `effectSource(handle)` /
  `principalFrom(handle)` [ADR #8/#12, already decided]. There is no
  framework-reserved internal write path (that would be the second write path
  AGENTS forbids). The projection principal is `{ type:'system',
  attributes:{ projection:<consumerId> } }`, bounded to the declared target +
  template fields — the same discipline as the in-transaction effect principal
  (ADR #6), split on the atomicity boundary.

---

## Step 6 — Test matrix

Project convention: `node --test`, zero-dependency, 49 files currently, all GREEN.
Tests are written FIRST (TDD iron law — every decision in DECISIONLOG landed
RED-GREEN). Each priority specifies the test files and the cases that must fail
before the code exists.

### Priority 1 — durable log + cursors + snapshot/resync (★1)

**`test/durable-log.test.mjs`**
- RED: append an event to a real `:memory:` node:sqlite `Log` table; read it back;
  seq is per-scope monotonic across two scopes independently.
- RED: dedupe by `(scope, actionId)` — re-dispatch returns stored events, handler
  NOT re-run (assert handler-call count).
- RED: restart simulation — close the `DatabaseSync`, reopen, `nextSeq` resumes
  from persisted `Cursor` row (no reset to 0).
- RED: `createServer` without persistence engaged stays ephemeral (in-memory log)
  — the engaged seam decides durability, no class field.

**`test/pipeline-durable-integration.test.mjs`**
- RED: a full dispatch through the durable kernel appends to `Log`, assigns seq,
  and the live consumer receives the SAME seq (collapses Finding B — one counter).
- RED: the raw-SQL path in `serve.mjs` is GONE — a create/update/remove flows
  through `server.dispatch` and produces a committed `Log` row (the migration gate
  of Finding A).

**`test/snapshot-resync.test.mjs`**
- RED: `/snapshot/:scope` returns materialized row + `Cursor.lastSeq`, authorized
  at `viewer` (lower bar than dispatch).
- RED: `/events-since/:scope?cursor=N` returns events `>N` in seq order.
- RED: **hard-fail on stale cursor** — trim the log past N; resync returns
  `{resync:'stale'}`; the client forces re-bootstrap. (The single most important
  test — guards the silent-truncate foot-gun.)
- RED: gap → resync folds missing events in order, cursor advances correctly.
- RED: duplicate (seq < expected) → idempotent skip; next (seq == expected) → fold
  once.

**`test/bootstrap-ordering.test.mjs`**
- RED: `LiveList.open` fetches snapshot and sets cursor BEFORE opening WS — assert
  ordering via instrumentation (a WS message arriving pre-snapshot is buffered, not
  folded into empty state).

### Priority 2 — blob store (★2)

**`test/blob-store.test.mjs`**
- RED: upload streams to `.pending`, computes md5+sha256 in one pass (assert hashes
  match a known fixture).
- RED: path-containment guard rejects `../`, absolute paths, null bytes in id.
- RED: range read `[start,end)` returns the right slice.
- RED: adopt in the SAME txn as the referencing event — commit → blob `adopted`,
  file renamed `.pending`→final; rollback → blob stays `.pending`, row stays
  `pending`.
- RED: reaper sweeps `.pending` older than TTL (inject a stale row → deleted).
- RED: reaper refcount-sweeps an `adopted` blob referenced by no entity row →
  deleted (after a delete cascade).

**`test/blob-atomicity.test.mjs`**
- RED: a dispatch that adopts a blob AND fails the row-grant `.can` → txn rolls
  back → blob stays pending → no adopted row. (Atomicity boundary test.)

### Priority 3 — projection fan-out (★3)

**`test/projection-fanout.test.mjs`**
- RED: register two consumers; commit an event; both fire with the event, each
  receives its own watermark.
- RED: one consumer throws → the OTHER still completes; the origin stays committed
  (assert no rollback).
- RED: consumer retries on its own schedule (inject a transient failure → retried →
  caught up).
- RED: consumer idempotency — re-deliver an already-processed event id → no
  double-apply (consumer dedupes by event id).
- RED: a projection that writes a derived read model runs as the bounded projection
  principal admitted by the target's grant — a target deny blocks the derived write
  (no second write path).

**`test/live-as-projection.test.mjs`**
- RED: live fan-out is a projection consumer — committed event → subscriber receives
  it with the committed seq (not a separately-minted seq). Retires the `live.mjs`
  separate `sequences` Map.

### Priority 4 — ops bundle (★4)

**`test/write-queue.test.mjs`**
- RED: two dispatches that each `await` mid-txn do NOT interleave (assert serial
  execution via an instrumentation hook that would detect interleaving).
- RED: bounded wait → 503 when starved (no unbounded pile).

**`test/rate-limit.test.mjs`**
- RED: per-IP fixed window overflows → 429 on the Nth+1 request within the window;
  resets after the window.
- RED: per-session limit supplements per-IP.
- RED: applied to auth + dispatch routes (a flood of forbidden requests never holds
  the write lock — they're rejected before the queue).

**`test/csrf-origin.test.mjs`**
- RED: a mutation with a foreign `Origin` → 403.
- RED: a mutation with no `Origin`/`Referer` → 403 (fail closed).
- RED: same-origin mutation passes.

**`test/ops-defaults.test.mjs`** (CSP/HSTS/CORS/logging/metrics)
- RED: same-origin CORS default — a cross-origin request is denied unless the app
  declares an allowlist.
- RED: nonce-CSP — a nonce is generated per request; a script without the nonce is
  blocked (assert the header carries the nonce).
- RED: HSTS only set when the app declares it (default off — it's an app
  declaration, per DECISIONLOG #38's reconciliation).
- RED: `/health` → 200; `/health/stats` → metrics JSON.
- RED: envGate — missing required env at startup → process refuses to start.
- RED: onShutdown registry — registered hooks run with a deadline; a hanging hook
  is force-closed after the deadline.

**`test/migrations.test.mjs`**
- RED: a migration ALTER runs inside the writeQueue txn with the meta-version bump;
  a mid-flight crash (simulated) re-runs idempotently on restart.

### Priority 5 — job-queue (★5)

**`test/job-queue.test.mjs`**
- RED: claim race — two workers `POST /jobs/claim` for the same queued job; exactly
  one gets it (`UPDATE…WHERE status='queued' RETURNING`).
- RED: heartbeat extends the lease only for the owning worker.
- RED: reaper re-queues a job whose lease expired (inject a stale `claimedAt`).
- RED: reaper revokes a worker whose heartbeat is stale (bearer rejected after).
- RED: worker registration requires the shared secret; constant-time compare; a
  wrong secret → 401.
- RED: result submission idempotent by job id — a retried `POST /jobs/:id/result`
  for a completed job is a no-op ack (no double-apply of the derived write).

### Priority 6 — Phase-2 field + live + effects (★6)

**`test/field-merge.test.mjs`** (crdt/store/ordered/struct apply+diff)
- RED: `crdt` apply+diff produces per-element deltas (replaces the `phase2Merge`
  throw) — a text insert yields a `{insert}` delta, not a whole-value set.
- RED: `store` (map) diff — a member add yields an `added` delta; a role change
  does NOT fire `onAdded` (idempotent re-share, per DECISIONLOG #57).
- RED: `ordered` (list) `insertAt`/`move` produce fractional-index deltas without
  renumbering siblings.
- RED: `struct` (link) per-sub-cell diff.

**`test/list-field.test.mjs`**
- RED: `insertAt(i)` mints a fractional key between neighbors; `move(id, i)`
  re-keys without touching unaffected elements; `reorder` is sugar over move.

**`test/log-field.test.mjs`**
- RED: `log` append mutation appends an entry and emits `:appended:<id>` (the
  event handle already reserved, per DECISIONLOG #50).
- RED: per-entry query returns entries for the owning entity only.

**`test/presence-field.test.mjs`**
- RED: per-connection broadcast — a cursor update from connection A is seen by B,
  not persisted (volatile, per DECISIONLOG #51).
- RED: volatile coalescing — rapid updates within a window collapse to the latest.

**`test/state-field.test.mjs`**
- RED: a transition not in the legal graph → rejected (fail closed, per
  DECISIONLOG #52).
- RED: `state.auto` schedules a transition via the time-source (ADR #10) — sugar
  over `schedule.after`.

**`test/effects-grammar.test.mjs`** (ADR #13)
- RED: `inc`/`dec`/`append`/`push`/`insertAt`/`move` operators in `with`.
- RED: `when` guard rejects the effect when the predicate fails (load-time
  non-compilable `when` is a load-time error).
- RED: `effectSource(handle)`/`principalFrom(handle)` admission — a missing admit
  on the target is a load-time error (never a silent runtime rollback).
- RED: structural cycle (A→B→A) is a load-time error.
- RED: `mutate: many(Target, { over: Origin.collection })` fan-out traverses typed
  FKs with depth-capped cardinality.
- RED: `effect.anyOf(hA,hB,hC)` compound trigger fires on any of the three.

**`test/live-advanced.test.mjs`** (ADR #5/#11/#14)
- RED: `subscribe(Entity, id, { fields, pace })` — a field not listed is
  pass-through; a `name:changed` event is NOT tested against a `chunks` interest.
- RED: interest grammar — `range(lo,hi)`, `.in([a,b,c])`, `.is(v)`; cross-dimension
  OR → subscribe-time validation error; closure → subscribe-time error.
- RED: two-layer pace — a position field coalesces within a window; a block-edit
  field does not (lawful per the plugin's published coalescer).
- RED: latched re-auth cache — a subscriber is re-authed once per emit batch;
  invalidation on roster change drops a revoked subscriber before the next emit.
- RED: per-field-type delta broadcast — a `crdt` delta is broadcast as a delta, not
  a whole-value replacement.

### Priority 7 — client library (★7)

**`test/client-library.test.mjs`**
- RED: `LiveChannel` derives the WS URL and the snapshot URL from the declared
  entity name — no hand-passed URL strings (the deletion-test concentration).
- RED: `dispatch` returns one framework-owned result shape; a `{ok:false,reason}`
  is decoded through the one shared decoder (two call sites cannot drift).
- RED: `LiveList` bootstrap-then-stream ordering (covered by
  `bootstrap-ordering.test.mjs` above).
- RED: auto-reconnect re-sends `subscribe` and resyncs if the server's seq jumped
  past the cursor.

**`test/url-derivation.test.mjs`**
- RED: a declared `app.doc('User', …)` derives `/snapshot/User/:id` and the
  `/events` subscribe target — the declaration owns the URL (concentration, not
  relocation — deleting the hand-passed URL strings drops net lines).

### Acceptance (whole-foundation)

**`test/foundation-acceptance.test.mjs`**
- The end-to-end Walk 1 + Walk 2 + Walk 3 against a real `:memory:` node:sqlite:
  upload a blob → dispatch adopts → live subscriber receives the committed seq →
  projection enqueues a thumbnail job → a (stub) worker claims, completes → the
  `thumbnailUrl` projected field updates → a second client bootstrapping late
  resyncs without silent loss. This is the deletion-test for the whole foundation
  at once, in the spirit of `blog-acceptance.test.mjs`.

---

## Step 7 — Review readiness dashboard

| # | Priority | Status | Notes |
|---|---|---|---|
| 1 | Durable log + cursors + snapshot/resync | ✓ designed | Unifies the latent kernel with `serve.mjs` (Finding A) and collapses the second sequence (Finding B). Hard-fail-on-stale-cursor is the gate. |
| 2 | Blob store | ✓ designed | Two-phase pending→adopt atomic with the dispatch commit. Reaper for both orphans and danglers. |
| 3 | Projection fan-out | ✓ designed | One registry; live is a synchronous consumer; jobs/webhooks/fts/`projected.async` are async consumers. Bounded projection principal, no second write path. |
| 4 | Ops bundle | ✓ designed | Framework-owns-mechanism / app-declares-policy reconciliation for CSP/HSTS/CORS; everything else is a framework default. WriteQueue is shared with ★1. |
| 5 | Job-queue | ✓ designed | Separate seam from projections (deletion-test justified); enqueued by a projection consumer. Per-worker bearer + shared-secret register. |
| 6 | Phase-2 fields + live + effects | ✓ designed | Extends ADRs #5/#9/#11/#13/#14; consumers of the ★1 log + ★3 fan-out. |
| 7 | Client library | ✓ designed | Derives URLs from declared names (concentration); wraps the existing `createClient` replay core. |

### Open questions for the lead (lead-confirm, not blocking)

These are decisions I made on the best evidence; flagging them so the lead can
ratify or redirect before implementation. None blocks the architecture.

1. **Snapshot source = materialized entity rows, not a log replay.** SCOPE-FINDINGS
   §2.6 establishes the reducer fold is the source of truth for *resync*, and scope's
   snapshot endpoint serves materialized state. I designed `/snapshot` to read
   current entity rows + `Cursor.lastSeq`. Confirm this matches intent (the
   alternative — snapshot via full log replay — is cheaper to implement but slower
   at runtime and diverges from scope's proven shape).

2. **Log retention default = retain all events** (no trimming) until an app opts
   in. Rationale: the `projects/*` apps are small; disk is cheap; retaining
   everything makes the hard-fail-on-stale-cursor a true last-resort (it only fires
   if the app *chose* to trim). Confirm, or set a default retention window now.

3. **Live fan-out runs post-commit, in-process, after the HTTP response is flushed**
   (non-blocking to the mutating client's ACK, but synchronous enough for ~ms
   latency). Confirm this is the intended latency profile, vs. blocking the
   response until live delivery completes.

4. **Single-process deployment assumption** for the writeQueue and blob store
   (node:sqlite is local; the in-process mutex serializes writes). Multi-process /
   horizontal scaling is out of scope for this phase. Confirm this is the target
   deployment shape.

5. **Blob content-hash dedup (refcount > 1 for identical uploads) is opt-in, not
   spine.** The nine stress-test apps don't require it. Confirm deferral.

6. **Job work idempotency is a documented app contract, not enforced by the
   framework.** The framework guarantees an idempotent *result submission*; it
   cannot make arbitrary app *work* idempotent. Confirm this line is correct (the
   app guards non-idempotent work with e.g. a `processing` state flag).

### VERDICT: **READY**

The architecture is coherent across all seven priorities: one mutation pipeline,
one durable log, one per-scope sequence, one dedupe, one post-commit fan-out; blob
adopt atomic with the commit; the writeQueue serializes the single writer;
projections and the job-queue compose at clean edges; Phase-2 field machinery and
the client library are consumers of the same spine. Every design choice obeys the
hard constraints (one reconciliation path, deletion test, fail closed, auth is
functions, persistence by engaged seam, named-whole pipeline variants, no magic
strings, zero-dependency). The two load-bearing findings (latent kernel + second
sequence counter) are retired onto the new mechanism in the same change, per the
"retire the special-case" rule. The failure-mode table covers every boundary with a
concrete mitigation, including the non-negotiable hard-fail-on-stale-cursor. The
test matrix names the files and the RED-first cases in the project's `node --test`
convention.

The six open questions are lead-confirm refinements, not architectural blockers —
each has a recommended default grounded in SCOPE-FINDINGS or DECISIONLOG. The
foundation is ready to build behind a TDD iron law.
---

## 8. Council Verdict (2026-06-30) — confirmed plan

A multi-model council (DeepSeek V4 Pro, GLM-5.2, DeepSeek V4 Flash — the three
returned source-grounded reviews) evaluated the 11 load-bearing decisions above.
The judge (Opus 4.8) verified disputed claims against the actual source
(`pipeline.mjs`, `live.mjs`, `serve.mjs`, `row-grant.mjs`) and rendered:

> **Verdict: Modified winner.** The architecture is sound and doctrinally
> compliant — **no proven hard-rule violation**. But it is **not ready to build as
> written**: the three reviewers surfaced silent-data-loss holes and one
> hard-rule-boundary the eng-review's own "READY" verdict did not stress. Adopt the
> Authoritative Specifications below; the Confirmed Architecture (D1–D11) stands
> unchanged.

### 8.1 Authoritative Specifications (REQUIRED before/during build)

Ordered by severity. Each is required-before-build unless flagged deferrable.

**TIER 1 — Silent-data-loss / hard-rule compliance (REQUIRED before build)**

1. **Subscribe carries a `since` cursor; the server replays the committed Log
   before streaming.** The subscribe message becomes
   `{type:'subscribe', entity, id, since}`. On subscribe, the live server reads
   `Log WHERE scope=? AND seq > since` and delivers those committed events *before*
   any new fan-out. Closes the snapshot-to-subscribe window where an event
   committed after the snapshot read but before subscription registers is never
   delivered (and, if it is the last write to that scope, is never detected as a
   gap — permanent silent staleness). *Confirmed in code: `live.mjs` subscribe
   carries only `{entity, id}`; `createClient.ingest` only detects a gap when a
   later event arrives.*
2. **The snapshot endpoint reads the materialized row AND the cursor (`lastSeq`)
   in ONE sqlite read transaction.** Non-atomic reads skew: row reflects commit N,
   then N+1 lands, then cursor reads N+1 → client bootstraps (state pre-N+1, cursor
   N+1) and silently loses event N+1. RED test that commits between the two reads.
   *Composes with #1: the atomic read yields the trustworthy `since` that #1
   replays from.*
3. **Resolve the materialized-row vs reducer-fold dual-write invariant — pick one
   and gate it.** D5 makes the entity row the snapshot source and the reducer fold
   the resync source; after migration the handler writes the row (SQL) AND emits an
   event the client folds — two expressions of one change that can drift, so a
   re-bootstrap (row read) and a resync (log fold) can disagree. **(preferred) make
   the entity table a projection of the log** — the row is derived, never directly
   written, retiring the dual-write and satisfying "one reconciliation path";
   **OR** accept dual-write but add a round-trip agreement test (handler write ==
   reducer fold) for every field type. The plan currently picks dual-write silently
   without naming the invariant. *(See §8.3 fork — this is a lead/user decision.)*
4. **A projection-principal write re-enters `server.dispatch` (→ handler → event →
   Log → commit); it never issues a direct `UPDATE`.** A direct write of a derived
   read model is a SECOND WRITE PATH and violates the one-mutation-path rule
   regardless of D11 admission. Admission (target's grant via
   `effectSource`/`principalFrom`) governs *whether*; the write *path* governs
   compliance. Pin the wording: a projection write is a dispatch as the projection
   principal, producing an event in the same Log. *The one place a hard-rule
   violation can actually hide; confirmed in code as the loose seam.*
5. **Add the in-transaction, post-handler row-grant hook to the kernel.** The
   second default-on auth layer (`mayVerb`/`rowCapabilities`, which are async and
   need the materialized row) has no home in the unified pipeline: the kernel's
   `authorize({type, payload, principal})` runs outside the txn with no row.
   Specify where `bindReadScope` (pure, runs outside txn, fine) and `.can`-on-row
   (needs the post-handler row, must run inside the txn and roll back on deny) each
   execute. Do not scatter auth into per-handler bodies — keep it framework-owned.
   The hook must be async-aware.

**TIER 2 — Blocking implementation (REQUIRED before build)**

6. **Specify the handler signature change and its SQL write contract.** Today the
   handler is pure `({payload, principal}) => events`; the durable handler must
   receive a txn-scoped db handle `(payload, principal, { db }) => events` and
   write entity rows INSIDE the writeQueue transaction (or, if spec #3 takes the
   "entity-as-projection" option, emit events only — the row is derived).
7. **Specify how CRUD verbs map onto the kernel.** State the single chosen form:
   either auto-generate per-entity CRUD action/event types at compile time, OR a
   generalized `dispatchVerb({verb, entity, payload, principal})` entry that runs
   CRUD internally — one kernel, one log/seq/dedupe, no bifurcation. State the
   event payload shape appended to the Log for create/update/remove. *(See §8.3
   fork.)*
8. **Pick and state the dedupe-vs-authorize ordering; flag that it reverses the
   current kernel.** `pipeline.mjs` checks dedupe BEFORE authorize (a retried
   action returns committed events without re-auth); the plan's Walk 1 authorizes
   first (a retry by a since-revoked principal now 403s). Either is defensible; the
   flip must be intentional and documented. *(See §8.3 fork.)*
9. **State migrations run at startup, before the server accepts traffic —
   stop-the-world for writes.** Migrations run inside the writeQueue txn (atomic),
   but a long backfill holds the single-writer mutex and blocks all writes; gating
   it to pre-traffic startup makes that acceptable. Specify the DDL strategy for
   statements that don't roll back cleanly (CREATE UNIQUE INDEX on dirty data,
   VACUUM).

**TIER 3 — Correctness edges (REQUIRED before build)**

10. **The reaper acquires the writeQueue mutex for both pending-reap and
    adopted-refcount-reap.** The reaper is a writer; unserialized, it can delete a
    blob a concurrent dispatch just adopted/referenced → row points at a deleted
    file. Single-process: run the reaper through the writeQueue (or `BEGIN
    IMMEDIATE`).
11. **Define live fan-out as strictly post-commit; no socket I/O inside the
    transaction.** writeQueue owns BEGIN→handler→Log append→COMMIT; on commit
    success, committed events are handed to the projection registry (live is one
    consumer). A slow/throwing `socket.write` must never block or poison the commit.
12. **Bound the bootstrap gate.** A snapshot fetch that stalls while the WS is up
    buffers events unboundedly. Specify a max-buffered-events cap or a
    snapshot-fetch timeout that forces hard-fail/re-bootstrap. Scope the
    "developer can't get ordering wrong" claim to client-library users — raw-WS
    users can still misuse it.
13. **Re-auth staleness is re-auth against a structurally stale captured row, not a
    cache miss.** `live.emit` re-auths each subscriber against the `row` captured
    at emit time; a concurrent commit that revokes access between commit and
    fan-out delivers one event to a now-revoked subscriber. The accepted "brief
    single-event leak" tolerance is fine — but justify it on its real basis (stale
    captured row), and base any mitigation (TTL backstop, conservative
    invalidation, or no-cache-on-landing) on that. *Recommended: land with NO
    cache (re-auth every emit); add a cache only when measurement proves it
    expensive.*
14. **Projection idempotency is independent of log dedupe.** A projection that
    writes its derived model then crashes before committing its watermark replays
    on restart. Make either the cursor advance atomic with the derived write (same
    txn) or the writes replay-tolerant (UPSERT / INSERT OR REPLACE). Job-enqueue
    from a projection keys on `(consumerId, eventId)` for idempotent re-enqueue. The
    projection dedupe key is `(scope, seq)` — no separate stable-id column (the
    Log PK already is `(scope, seq)`).
15. **Document and enforce handler transaction discipline.** Handlers must not run
    `BEGIN`/`COMMIT`/`SAVEPOINT` on the shared single connection. Enforce by
    handing the handler a txn-scoped db wrapper that throws on
    transaction-control statements (or maps to SAVEPOINT).

**TIER 4 — Operational / explicit-trade-off (REQUIRED to state, may defer the
mechanism)**

16. **Specify writeQueue bounds:** max queue depth and/or max wait → 503, with an
    aggressive ceiling (≤ ~5s), reinforced by #15 forbidding non-sqlite awaits
    inside the txn.
17. **State deleted-entity snapshot semantics explicitly** (soft-delete column /
    tombstone / or the explicit "reconnecting client that missed the remove sees it
    vanish" trade-off). Defensible to defer the mechanism, but the trade-off must
    be named, not an oversight.
18. **Specify the worker↔blob access path:** shared-disk (consistent with D10
    single-process) or an HTTP `GET /blobs/:id` if workers are remote.
19. **State that projection denial behavior is explicit** — load-time error
    (preferred: "entity X has no projection because its grant denies the system
    principal") rather than a silent skip that drifts the derived model.
20. **State the Log table schema explicitly:** `(scope, seq, eventType, eventData,
    actionId, committedAt)`, PRIMARY KEY `(scope, seq)`, index on `actionId` for
    dedupe. Per-scope seq assigned inside the txn.
21. *(Deferrable, state the deferral)* **Blob ref-counting across entity deletes**
    — orphaned-blob handling when a referencing row is deleted. Explicitly defer
    with a stated decision rather than leave silent.
22. *(Clarify, not a bug)* **Job-queue state is native persistence, not
    log-derived.** Acknowledge the second persistent table (job rows) is enqueued
    from a projection edge and is NOT reconstructable by log replay, so no one
    later tries to "fix" it into the log.

### 8.2 Confirmed Architecture (unchanged)

The council confirms D1–D11 are correct and must not change (subject to the
specs above making edge cases explicit):

- **D1** — retire raw SQL + land the durable log in ONE change (not staged across
  ships). "Same change" = the change that lands the general mechanism also retires
  the special case; sequence behind TDD within that change. Either wrong staging
  (durability-without-migration = two write paths; migration-without-durability =
  ephemeral regression) is worse.
- **D2** — collapse `live.mjs`'s second sequence counter onto the kernel's single
  per-scope seq, assigned once at commit.
- **D3** — live fan-out is a post-commit projection consumer; no realtime property
  lost (seq still monotonic, assigned before fan-out; in-process, no broker hop).
  *(Subject to spec #11 making post-commit explicit.)*
- **D4** — job-queue is a SEPARATE seam from projections (passes the deletion
  test).
- **D5** — snapshot = materialized rows, reducer fold = resync source. *(Spec #3
  must gate the dual-write it implies.)*
- **D6** — hard-fail on stale cursor, retain-all default.
- **D7** — structural bootstrap ordering (snapshot-then-stream; no public
  WS-first API), scoped to client-library users (spec #12).
- **D8** — blob adopt in-transaction with the dispatch commit.
- **D9** — writeQueue serializes the whole dispatch txn; bounded wait → 503
  *(spec #16).*
- **D10** — single-process deployment assumption (made explicit).
- **D11** — projection principal admitted by the target's own grant; no
  framework-reserved internal write path. *Correct as long as spec #4 pins the
  write to re-enter the pipeline.*

### 8.3 Open forks requiring a lead decision before implementation — RESOLVED 2026-06-30

The council resolved most edge cases but left three genuine architectural forks
that the eng-review under-specified. The lead + user resolved all three
(see PLANS.md "Fork resolutions"); the implementer starts from these decisions:

- **Fork A (spec #3) — materialized-row vs reducer-fold invariant.** Either (i)
  make the entity table a PROJECTION of the log (rows derived, never directly
  written — the event-sourcing-purist position; retires the dual-write and
  satisfies one-reconciliation-path most cleanly; handlers emit events only), or
  (ii) keep dual-write (handler writes the row AND emits the event) and gate it
  with a per-field-type round-trip agreement test. Council preferred (i).
- **Fork B (spec #7) — CRUD→kernel mapping.** Either auto-generate per-entity
  CRUD action/event types at compile time, or a generalized
  `dispatchVerb({verb, entity, payload, principal})` entry. One kernel, one
  log/seq/dedupe either way.
- **Fork C (spec #8) — dedupe-vs-authorize ordering.** Dedupe-first (current
  kernel: a retried action returns committed events without re-auth — a revoked
  user can still replay a committed action's result) vs authorize-first (plan's
  Walk 1: a retry by a since-revoked principal now 403s). Both defensible;
  different UX.

Plus the six original eng-review open questions (§7 open questions) — all with
recommended defaults the lead has ratified: snapshot = materialized rows; log
retention = retain all; live fan-out post-commit in-process; single-process
deployment; blob content-hash dedup deferred; job-work idempotency is a documented
app contract.

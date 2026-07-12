# W3 Job Queue Parity Census

**Date:** 2026-07-06 | **Agent:** explore-flash | **Source:** Scope `~/Development/scope`

## Section 1: Scope's Job model columns vs workbench equivalent

| Scope `Job` column | Workbench `_Job` column | Match? |
|---|---|---|
| `id` (cuid) | `id` (TEXT PK) | Equivalent |
| `type` (String, e.g. "transcode") | `kind` (TEXT NOT NULL) | Equivalent |
| `status` (String, default "pending"; values: pending/running/failed/completed/cancelled) | `status` (TEXT, default "queued"; values: queued/claimed/running/completed/failed) | **GAP** — Scope: 5 states including `cancelled`, uses `pending`; workbench: 5 states including `claimed`+`queued`, NO `cancelled`. Scope starts `pending`, workbench starts `queued`; workbench has an explicit `claimed` intermediate state before `running` |
| `payload` (String?, JSON blob) | `payload` (TEXT, JSON stringified) | Equivalent |
| `inputFileId` (String?) | — | **GAP** — Scope tracks which media file a job processes; workbench has no file concept (generic queue) |
| `retryCount` (Int, default 0) | `attempts` (INT, default 0) | Equivalent (different name, same semantics) |
| `claimedBy` (String?) | — | **THIN WRAP** — Scope duplicates worker identity; workbench uses single `workerId` for ownership |
| `workerId` (String?, FK to Worker) | `workerId` (TEXT) | Equivalent |
| `progress` (Int, default 0) | — | **GAP** — workbench has no progress column |
| `stage` (String?) | — | **GAP** — workbench has no stage column |
| `outputLog` (String?, JSON array of `{time, progress, stage, message}`) | — | **GAP** — workbench has no detailed log |
| `profile` (String?, e.g. "interactive") | — | **GAP** — Scope-specific transcription profile reference |
| `createdAt` (DateTime) | `enqueuedAt` (INTEGER, ms epoch) | Equivalent (different type: SQLite TEXT vs INTEGER) |
| `updatedAt` (DateTime @updatedAt) | — | Workbench relies on job-status transitions; no updatedAt |
| `projectId` (String, FK to Project) | — | **GAP** — workbench has no project scoping (generic queue) |
| — | `claimedAt` (INTEGER) | Scope derives from `updatedAt`; workbench tracks claim time explicitly |
| — | `leaseUntil` (INTEGER) | **GAP** — Scope has no lease mechanism; uses worker `lastSeenAt` staleness instead |
| — | `availableAt` (INTEGER, backoff gate) | **GAP** — Scope has no backoff gating; retry resets to `pending` immediately |
| — | `attempts` (INT, workbench name) | Scope calls it `retryCount` — equivalent |

## Section 2: Scope's Worker model columns vs workbench equivalent

| Scope `Worker` column | Workbench `_Worker` column | Match? |
|---|---|---|
| `id` (cuid) | `id` (TEXT PK) | Equivalent |
| `hostname` (String?) | — | **GAP** — workbench has no hostname/site metadata |
| `site` (String?) | — | **GAP** — workbench has no site concept |
| `capabilities` (String?) | — | **GAP** — workbench has no capability advertisement |
| `status` (String, default "active"; values: active/stale/offline) | `revoked` (INTEGER, 0/1) | **GAP** — Scope has 3-state lifecycle (active→stale→offline); workbench has binary revoked/not-revoked |
| `secretHash` (String?, sha256 of per-worker bearer) | `tokenHash` (TEXT NOT NULL) | Equivalent (Scope allows null for legacy workers) |
| `secretPrefix` (String?) | — | **GAP** — workbench doesn't store display prefix |
| `lastSeenAt` (DateTime @updatedAt) | `lastHeartbeat` (INTEGER) | Equivalent (different type) |
| `createdAt` (DateTime @default(now())) | `registeredAt` (INTEGER) | Equivalent |

## Section 3: Behavior diff

### 1. Progress reporting
**Scope: YES, rich progress.** Worker calls `POST /api/jobs/:id/progress` every few seconds during transcode and transcribe jobs. Handler stores accumulated `outputLog` (JSON array of `{time, progress, stage, message}`) and broadcasts `job:progress` SSE events.
- Worker `reportProgress()`: `worker/index.ts:194-204`
- Progress handler: `src/server/handlers/jobs.ts:71-91`
- SSE event type: `src/lib/server/sse.ts:8`

**Workbench: NO progress reporting.** `createJobQueue` has no progress column, no progress endpoint, no heartbeat payload extension. Heartbeat (`job-queue.mjs:147-163`) only extends lease — no progress data.

**Gap: BUILD**

### 2. Priorities/ordering
**Both: Strict FIFO.** Scope: `atomicClaimJob` in `workers.ts:223` → `orderBy: { createdAt: 'asc' }`. Workbench: `claim()` in `job-queue.mjs:138` → `ORDER BY enqueuedAt LIMIT 1`. **No gap.**

### 3. Per-kind concurrency caps
**Both: None.** Simple while-true claim→process→claim loops. No per-kind throttle in either system. **No gap.**

### 4. Large results
**Scope:** Inline via separate HTTP calls. Transcription → `POST /api/worker/transcripts`. Transcode → `POST /api/files/:id/upload-result` (multipart). Job result payload is small ack.
**Workbench:** Inline JSON payload in `_Job.payload`. Blob store exists but not used by queue.
**Gap: THIN-WRAP.** Current pattern (large artifacts via app endpoints, job result = small ack) is compatible. Document the convention.

### 5. Job chaining
**Both: App-side effects, not queue-native.** Scope chains transcode→transcribe→index via post-commit side effects. Workbench header explicitly says "composition at the enqueue edge." **No gap.**

### 6. Cancellation
**Scope: YES.** `POST /api/projects/:id/jobs/:jobId/cancel` (`projects.ts:1360-1381`) → status:'cancelled', broadcasts SSE. Worker polls cancellation via `checkJobCancelled()` (`worker/index.ts:206-219`).
**Workbench: NO.** States only: queued/claimed/running/completed/failed. No `cancelled` state, no cancel API. **Gap: BUILD**

### 7. Per-project scoping
**Scope: YES.** `projectId` is required FK on every job. All queries scoped by project. SSE broadcast per-project.
**Workbench: NO.** `_Job` has no project/scope column. Queue is a global singleton.
**Gap: BUILD**

### 8. Retry/backoff policy
**Scope:** 3 retries, no backoff. `MAX_RETRIES = 3` (`job-freshness.ts:14`). Reaper reassigns immediately.
**Workbench:** 5 retries, 5s backoff gate. `availableAt` column gates re-claim time.
**Gap: THIN-WRAP.** Configure `maxAttempts: 3, backoffMs: 0` or let Scope adopt the richer substrate.

### 9. Dead-letter handling
**Both: Implicit.** Both keep failed jobs as ordinary `failed` rows. No separate DLQ. Workbench's `deadLettered` return flag is a minor extra — not a structural gap. **MINOR gap.**

## Section 4: Gap summary

### BUILD (new substrate work needed) — ALL CLOSED

| Gap | Why | Spec ref | Closed by |
|---|---|---|---|
| **Progress reporting** | Workbench has no progress column/endpoint/SSE; Scope has rich `{progress, stage, outputLog}` system with real-time SSE broadcast | Council item #1 | Slice 1: `updateProgress({ jobId, workerId, progress, stage })`; live broadcast via slice 2 `_Job.updated` events (one path, no SSE sidecar) |
| **Cancellation** | Workbench has no `cancelled` state, no cancel API, no in-process cancellation mechanism | Must-add state + API | Slice 1: `cancelled` terminal state + `cancelJob({ jobId, workerId })` |
| **Per-project scoping** | Workbench `_Job` has no scope column; every Scope query is scoped by `projectId` | Required for live visibility | Slice 1: `_Job.scope` + `enqueue({ scope })` / `claim(workerId, { scope })` / `list({ scope })`; slice 2 makes the scope the live stream key |

### THIN-WRAP

| Gap | Why |
|---|---|
| Status vocabulary | Scope uses `pending`/`cancelled`; workbench uses `queued`/`claimed`. Configure mapping in app layer. |
| Column naming | `type` ↔ `kind`, `retryCount` ↔ `attempts`. Thin mapping layer. |
| Large results convention | Scope uses app-specific endpoints; workbench's opaque `payload` works for references. Document convention. |
| Worker metadata | Scope stores `hostname`, `site`, `capabilities`, `secretPrefix`; workbench stores only auth essentials. App layer extends. |
| Retry counts | Configure via `maxAttempts`/`backoffMs` in `createJobQueue`. |
| Dead-letter | Both keep failed jobs as `failed` rows. Minor. |

### DEFER-CANDIDATE

| Gap | Why defer |
|---|---|
| `inputFileId` on Job | Scope-specific; generic queue shouldn't carry file metadata |
| `profile` on Job | Scope-specific transcription profile |
| `outputLog` | Rich structured logging; could fold into heartbeat-payload extension later |
| `site`/`capabilities`/`hostname` on Worker | Scope-specific fleet management |
| Job chaining | Already app-side effects in both systems. No queue-native DAG needed |
| Worker 3-state lifecycle (active→stale→offline) | Workbench has binary revoked/not-revoked; Scope's nuanced lifecycle is fleet-management |
| Transformation relation on Job | Scope-specific media processing audit trail |

## Section 5: Scope's three kinds as pure plug-ins (census closure)

The done criterion: each of Scope's job kinds is expressible against the
generic queue as **worker + kind name + payload/result contract** — no
substrate change, no kind-shaped column. The only queue surface any of them
touches is `enqueue` / `claim(workerId, { kind })` / `heartbeat` /
`updateProgress` / `submitResult`. Verified against the shipped API
(`src/job-queue.mjs`, post slices 1–2).

### 1. Whisper transcription

- **Kind:** `'transcribe'`
- **Payload:** `{ inputFileId, profile, language? }` — the blob-store id of the
  media file plus Scope's transcription profile. Opaque JSON to the queue;
  `inputFileId`/`profile` live HERE, never as `_Job` columns (they were
  DEFER-CANDIDATE columns above — the payload contract is why they stay out).
- **Result:** `{ transcriptBlobId, durationMs, model }` — the transcript goes to
  the blob store (large-results convention, Section 4 THIN-WRAP); the result row
  carries the reference, not the text.
- **Worker:** Scope's local whisper process, registered via
  `registerWorker(sharedSecret)` and polling `claim(workerId, { kind: 'transcribe' })`.
  The local-only red line (no cloud transcription) is a property of WHERE Scope
  runs this worker — the queue already assumes workers are neither co-located
  nor trusted (per-worker revocable bearers), so nothing changes substrate-side.
- **Progress:** `updateProgress({ progress, stage: 'decoding' | 'transcribing' | … })`
  on long runs; a `Project:<id>` scope makes progress visible on the live board.

### 2. Media transcode

- **Kind:** `'transcode'`
- **Payload:** `{ inputFileId, targetProfile, container? }`.
- **Result:** `{ outputFileId, codec, sizeBytes }` — output rides the blob
  store by reference, same convention.
- **Worker:** Scope's ffmpeg-driving worker process, same registration/claim
  shape, `claim(workerId, { kind: 'transcode' })`.
- **Chaining:** transcode → transcribe → index is composition at the enqueue
  edge: the app's result handling (or a post-commit consumer) enqueues the
  follow-on kind. No queue-native DAG (Section 3 item 5 stands).

### 3. Search indexing

- **Kind:** `'search-index'`
- **Payload:** `{ postId }` (or Scope's document id) — nothing else.
- **Result:** `{ accepted: true }`; the worker's side effect is the derived
  index row, not the result payload.
- **Worker:** in-process `app.jobs.work('search-index', fn)` — no separate
  fleet needed for cheap derived-data kinds.
- **Proven in-repo:** this exact plug-in shape ships as the non-media
  genericity proof — `projects/blog-platform/entities.mjs`
  (`SEARCH_INDEX_KIND`, `enqueueSearchIndex`, `searchIndexWorkerFn`) with
  acceptance tests in `test/blog-platform-search-jobs.test.mjs` asserting the
  payload is exactly `{ postId }` and no media-shaped key exists.

All three kinds fit the split with zero substrate edits: the census is
**closed**.

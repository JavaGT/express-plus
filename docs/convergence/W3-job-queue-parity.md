# W3 — Job queue parity

**Goal:** the job queue is the programme's genericity exemplar. Workbench owns
the generic board (post/claim/heartbeat/result/retry/reaper); Scope plugs in
whisper transcription, media transcode, and search indexing as job kinds.

## Binding rulings

- The pattern-vs-plug-in split here is the **template for every Scope-driven
  feature**: if a Scope need doesn't fit the split, the feature is redesigned —
  workbench is not bent.
- Whisper transcription stays local-only forever (Scope red line: no cloud
  transcription). That's a property of Scope's worker, not of the queue — the
  queue must simply not assume workers are co-located or trusted.

## Current workbench state (verified 2026-07-06; paths checked 2026-07-10)

`src/job-queue.mjs` already ships: queued→claimed→running→completed/failed
lifecycle, reaper reassignment (`reap` / `startReaper` on the queue itself),
atomic single-statement claim with kind filter, worker registration via shared
secret, per-worker revocable bearer tokens (constant-time compared), idempotent
result submission. Lease expiry is owned by the job-queue module (not a
separate `reaper.mjs` — that schedule-deadline file was deleted when Schedule
clock-dispatch collapsed into `startClockTriggers`). Blob orphan/refcount sweep
is `blob-store.mjs` `reap`, not the job queue. This packet is **gap-closing, not
greenfield**.

## Scope parity surface

Prisma `Job` (640) and `Worker` (672) models plus Scope's job handlers and the
worker processes (whisper/transcode). `Transformation`/`Source` may or may not
be queue-adjacent — census decides.

## Stage 0 — census (Flash, read-only)

Produce `docs/convergence/census/W3-jobs.md`: diff Scope's `Job`/`Worker`
columns and job-handler behaviour against `createJobQueue`'s actual API. Check
specifically: progress reporting (does Scope surface % progress on long
whisper runs?), priorities/ordering beyond FIFO, per-kind concurrency caps,
large results (transcripts → blob store vs inline row?), job chaining
(transcode → transcribe → index: app-side effects or queue-native?),
cancellation, per-project scoping of job visibility, retry/backoff policy
differences, dead-letter handling.

## Expected design decisions (council items)

1. **Progress**: piggyback on heartbeat payload vs a queue event — which keeps
   one path? (Heartbeat already exists; a second progress channel must pass
   the deletion test.)
2. **Chaining**: post-commit effects enqueue follow-on jobs (composition at the
   enqueue edge, per the module's own header comment) vs queue-native DAGs.
   Presumption: composition; council confirms or refutes with Scope's real
   chains.
3. **Large results**: result-by-blob-reference convention vs opaque result rows.

## Slices

1. Close census gaps in the substrate (each gap = one slice, one branch, full
   gate green).
2. Live visibility: job rows as a subscribable entity surface (if not already)
   so apps get realtime job boards through the normal live path — no bespoke
   polling channel.
3. Genericity proof: a `projects/*` app uses the queue for a **non-media**
   kind (e.g. blog-platform search indexing or library thumbnail metadata) in
   an acceptance test — the proof that nothing whisper-shaped leaked in.

## Done criteria

- Census closed; Scope's three kinds are expressible as pure plug-ins (worker
  + kind name + payload/result contract), demonstrated by a written mapping in
  the census doc.
- `projects/*` non-media proof green.
- Queue API documented in SPEC (it currently lives mostly in module comments).

## Contention

Owns: `job-queue.mjs` (including its lease reaper). Blob lifecycle reaping is
`blob-store.mjs` — coordinate with W2 if a slice touches that path. Schedule
deadline/tick clocks are `schedule.mjs` `startClockTriggers` (not job-queue).

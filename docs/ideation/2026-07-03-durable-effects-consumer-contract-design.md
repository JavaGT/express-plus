# Durable effects: the projected-async consumer contract — design

**Parent:** `2026-07-03-workbench-improvements-ideation.md` survivor #1 · **Scope:** first design slice (recovery cursor + catch-up + failure observability). The job-queue "bottom half" (`effect.durable`) is sketched at the end and deferred.

## The problem, grounded

`_ProjectedCursor(entity, field, lastSeq)` is one table doing two jobs that need
opposite shapes:

1. **Staleness signal** — `serve.mjs:95` reads it per entity and sets
   `x-workbench-projected-<field>=lastSeq` so the client can compare and refetch.
   This wants a **monotonic counter that bumps on every successful compute.**
   The self-incrementing count (`next = last + 1`) is *correct* for this job.
   Two tests depend on count semantics: "compute counter advances" (1→2→3 across
   three events on different rows) and the staleness-header test (`>= 1`).
2. **Recovery cursor** — "where did the projection get to, so it can catch up
   after a crash." This wants the **real per-scope log seq**, keyed **per scope**
   (not per field globally), with a **startup catch-up pass.** None of this exists
   today: the cursor reads its own row (never `ev.seq`), the key is global per
   field, and there is no boot reconcile. If the process dies between `COMMIT`
   and the post-commit consumer, the projected field stays stale **forever** —
   nothing reconciles it.

So the doc's "fix the self-referential cursor" is reframed: **there is no cursor
bug; there is a role overload.** Stop using one cursor for two jobs. Keep the
staleness counter as-is; give recovery its own cursor with the right shape.

Two more verified facts that set the design:

- `compute` reads the **current row**, not event data (`projected-async.mjs:43`:
  `SELECT * FROM ${entity} WHERE id = :id`, then `compute(filteredRow, {db})`).
  The row is materialized **in-transaction** by the projection consumer, so by
  post-commit time the row already reflects every committed event. **Catch-up
  therefore does not need to replay events — it re-runs `compute` once per
  lagging scope; the row already holds the final state.**
- `ev.seq` is the real per-scope log seq, available on every event the
  post-commit consumer receives (`pipeline.mjs:168,173`).

## The split

**Keep `_ProjectedCursor(entity, field, lastSeq)`** as the staleness version
counter. Behavior unchanged: bump on every successful compute. Header and both
tests keep working. This is *not* the recovery cursor and never was.

**Add `_ProjectedRecovery(consumer, scope, lastSeq)`** — the recovery cursor.
`PK(consumer, scope)`. `consumer` is a stable name for the post-commit consumer
(`'projected.async'` today; the named-consumer slot the full survivor #1 vision
wants). `scope` is the event scope (`Post:abc`). `lastSeq` is the **real
`ev.seq`** of the last event whose projection this consumer applied successfully
for that scope. Defaults to 0.

Why per-`(consumer, scope)` and not per-field: a single scope can carry several
projected fields (`hotRank`, `preview`) that all recompute on the same events.
One cursor per scope is simpler and correct *if* it advances only when **all
triggered fields** for that event succeed. On catch-up we recompute **all
fields** for a lagging scope — over-computing fields whose `from` trigger didn't
fire for the missed event is harmless (compute is a pure function of current row
state). Catch-up is a rare post-crash path; the wasted computes are acceptable.
(Alternative if the partial-failure recompute cost ever matters:
per-`(consumer, scope, field)`; noted, not chosen now.)

## Boot-time catch-up

On `app.ready`, after the kernel is built and **before** serving, run one
reconcile sweep:

```
for each entity with projected.async fields:
  for each scope S in _Log (DISTINCT scope prefix = entity name):
    head = SELECT MAX(seq) FROM _Log WHERE scope = S
    applied = SELECT lastSeq FROM _ProjectedRecovery WHERE consumer='projected.async' AND scope=S
    if applied is null or applied < head:
      row = SELECT * FROM entity WHERE id = <S's rowId>
      if row exists: recompute every projected.async field, write back, advance recovery cursor to head
      if row gone (removed): delete the recovery cursor row
```

Because compute reads current row state, one recompute per lagging scope brings
the field fully up to date regardless of how many events were missed. The sweep
runs under the write-queue mutex (same as the log-retention reaper) so it cannot
race a live dispatch. It is idempotent: running it twice is a no-op once cursors
reach head.

This closes the crash-stale gap: a projected field can no longer be stale
forever — the next process start reconciles it.

## Failure path

The bare `catch {}` is already replaced with a structured `warn` on the
`projected` channel (done this session). The recovery design adds the missing
**observability of stuck scopes**:

- On a compute failure, the recovery cursor for that scope **does not advance**
  (the event was not successfully applied). The scope will surface as lagging on
  the next catch-up sweep — a stuck scope is therefore self-healing on restart,
  and visible between restarts as `_ProjectedRecovery.lastSeq < _Log.MAX(seq)`.
- A future `workbench projected status` (cheap follow-on) can list lagging
  scopes by joining `_ProjectedRecovery` against `MAX(_Log.seq)`. No new table
  needed — the cursor gap *is* the signal.

Full **dead-letter with retry** belongs to the job-queue bottom half below and is
deferred. The first slice's contract is: **failures are logged, never silent;
a stuck scope is detectable as a cursor gap and self-heals on restart.**

## Migration

`_ProjectedRecovery` is a new table added to the framework DDL (`ddl.mjs`),
`CREATE TABLE IF NOT EXISTS` — additive, no migration of existing rows. On first
boot after the change, every existing projected scope looks "lagging"
(`applied is null < head`), so the catch-up sweep recomputes all of them once.
That is the correct one-time backfill and is idempotent. `_ProjectedCursor`
rows are untouched; staleness headers keep working throughout.

## First implementation slice (bounded, testable)

1. Add `_ProjectedRecovery` to framework DDL.
2. In `createProjectedAsyncConsumer`, on **successful** compute+writeback of all
   triggered fields for an event, `INSERT OR REPLACE` the recovery cursor for
   `(consumer, ev.scope)` = `ev.seq`. On failure, leave it (cursor gap marks the
   scope lagging).
3. Add `reconcileProjectedRecovery(db, entities)` and call it once in
   `app.ready` under the write queue. Recompute lagging scopes; advance cursors.
4. Tests:
   - simulate a crash (dispatch, then **kill the post-commit consumer** by
     throwing before writeback / by not awaiting `afterCommit`) → field stale →
     run reconcile → field correct, cursor at head.
   - reconcile is idempotent (run twice → no change).
   - a removed row's recovery cursor is cleaned up.
   - staleness header + "compute counter advances" still pass (regression).

This slice delivers the recovery half of survivor #1's first step without
touching the staleness contract or the job-queue substrate.

## Deferred: the bottom half (`effect.durable` → job-queue)

The full survivor #1 vision: in-transaction effects stay the "top half"; a
declared `effect.durable(...)` enqueues a `_Job` carrying the committed event
**post-commit** (bottom half), with the committed `_Log` row as a transactional
outbox and dedupe-by-`actionId` for exactly-once handoff. The `_Job`/`_Worker`
substrate (`job-queue.mjs`) already has lease/heartbeat/reaper but is not
connected to effects. The recovery-cursor contract above is the prerequisite:
the same per-consumer cursor + catch-up shape generalizes to named durable
consumers over `_Log`, so `effect.durable` consumers reuse this machinery
rather than getting a second path (AGENTS.md → singular system). **Not built in
this slice** — sketched here so the recovery cursor is shaped to generalize.

## Open questions for review

1. **Per-scope vs per-(scope, field) recovery cursor.** I chose per-scope
   (advances on all-triggered-fields-success; catch-up recomputes all fields).
   Simpler, correct, rare-path waste. Acceptable, or do you want per-field from
   the start?
2. **Catch-up trigger.** I run it once at `app.ready`. Should a slow/lagging
   scope also re-trigger catch-up on a timer (e.g. piggyback the log-retention
   reaper), or is on-boot + on-failure-cursor-gap enough?
3. **Consumer naming.** I use the literal `'projected.async'` as the
   `consumer` key. Fine for now, or name it per entity+field to leave room for
   app-declared named consumers later?

# PLANS.md — express+ backend rebuild (all 7 priorities)

Append-only ledger. The authoritative plan + council confirmation live in
`docs/reviews/eng-review-2026-06-30.md` (1085 lines). Re-read that for full
detail. This file is the restartable execution ledger.

## Starting state
- [2026-06-30] Repo: /Users/server/Code/express+. Zero-dependency (node:http/crypto/sqlite/fs only). Test: `node --test`. **321 tests, 0 fail** (lead-verified raw). TDD iron law: every decision lands RED-GREEN (DECISIONLOG #1-#58 convention).
- [2026-06-30] DECISIONLOG has 38 entries (#1-#58, mixing design ADRs + impl decisions). Recent progress (#56-58): two-phase app assembly (resolveRoutes/listen), ambient db handle + unscoped query API (findOne/findAll/findById/getOrFail/create/delete), map handle .set/.toArray with FK population, req.<entity> auto-loading, findAll predicate query builder (.sort/.limit/.select), literal-beats-parametric routing, field-level capability authz for map handles (mayFieldOp reuses the check registry — no second auth path).
- [2026-06-30] Despite that progress, the eng-review confirmed the two load-bearing gaps still stand: (A) `pipeline.mjs` Action/Event kernel is LATENT — `serve.mjs dispatch()` does raw SQL INSERT/UPDATE/DELETE + `live.emit()` directly (a second mutation path); (B) `live.mjs` keeps its own per-scope seq Map (live.mjs:199) independent of pipeline.mjs's (pipeline.mjs:58) — scope's "two seq counters" debt. Priority #1 unifies both.

## Council-confirmed plan (2026-06-30)
- [2026-06-30] plan-eng-review wrote docs/reviews/eng-review-2026-06-30.md (architect subagent). council-review (DS Pro + GLM-5.2 + DS Flash, judged by Opus 4.8) confirmed D1-D11 architecture UNCHANGED, added 22 Authoritative Specifications (4 tiers) — see eng-review §8. No proven hard-rule violation. Modified winner (Response B / GLM-5.2, absorbing Response C's snapshot-to-subscribe catch-up gap).

## Fork resolutions (2026-06-30, lead + user decided)
- [2026-06-30] **Fork A (spec #3) → Entity-as-projection.** The materialized entity row is a PROJECTION of the committed event log: rows are derived, never directly written. Handlers EMIT EVENTS ONLY; the entity table is a projection consumer that folds committed events into rows. Retires the dual-write, satisfies one-reconciliation-path most cleanly (council preferred). Consequence: spec #6 handler signature emits events only (no `{db}` row-writing) — the projection consumer writes the row. CRUD auto-gen reducers fold into rows.
- [2026-06-30] **Fork B (spec #7) → Auto-gen CRUD action types per entity.** `entity('Note',{...})` auto-generates `Note.create/.update/.remove` action+event types at compile time with a generic append-to-row reducer. Each CRUD verb is a real pipeline action dispatched through the same `handlers[type]` lookup as custom actions. Most uniform; CRUD and custom actions identical to the kernel.
- [2026-06-30] **Fork C (spec #8) → Authorize-first.** Authorize BEFORE dedupe. A retried action by a since-revoked principal returns 403 (mutation already happened but retry refused). Matches eng-review Walk 1. REVERSES current kernel (pipeline.mjs:70-78 checks dedupe before authorize) — flag the flip.

## The 22 Authoritative Specifications ( REQUIRED before/during build)
See eng-review §8.1. Tier 1 (silent-data-loss/hard-rule, before build): #1 subscribe carries `since` + server replays Log WHERE seq>since; #2 snapshot reads row+Cursor.lastSeq in ONE txn; #3 entity-as-projection (resolved Fork A); #4 projection-principal write re-enters server.dispatch (→event→Log), NEVER direct UPDATE; #5 in-txn post-handler row-grant hook in kernel (mayVerb async, needs post-handler row, runs in txn, rolls back on deny; bindReadScope pure outside txn). Tier 2 (blocking impl): #6 handler signature; #7 CRUD→kernel mapping (resolved Fork B); #8 dedupe-vs-authorize order (resolved Fork C); #9 migrations startup pre-traffic stop-the-world. Tier 3 (correctness edges): #10 reaper takes writeQueue mutex; #11 live fan-out strictly post-commit (no socket I/O in txn); #12 bound bootstrap gate; #13 re-auth = stale captured row (land NO cache first); #14 projection idempotency independent of log dedupe (cursor atomic w/ derived write OR replay-tolerant; job-enqueue keys (consumerId,eventId); dedupe key=(scope,seq)); #15 handler txn discipline (no BEGIN/COMMIT/SAVEPOINT). Tier 4 (state, may defer mechanism): #16 writeQueue bounds (≤~5s→503); #17 deleted-entity snapshot semantics; #18 worker↔blob access path; #19 projection denial = load-time error; #20 Log table schema (scope,seq,eventType,eventData,actionId,committedAt), PK (scope,seq), index actionId; #21 blob ref-count deferral; #22 job-queue state is native persistence not log-derived.

## Execution order (7 priorities)
- P1 Durable event log + persistent seq cursors + snapshot/bootstrap endpoint + gap-resync/hard-fail + UNIFY serve.mjs CRUD onto kernel (retire raw SQL) + collapse live's 2nd seq. [in_progress]
- P2 Blob field + disk BlobStore (pending→adopt, hashing, reaper) + in-txn adopt with commit.
- P3 Projection fan-out registry over committed log (live=sync consumer; jobs/webhooks/fts=async consumers; entity-as-projection IS a consumer).
- P4 Operational defaults (rate limiting, CSRF/CSP/HSTS, request logging+metrics, env gate, shutdown registry, write-queue, migrations).
- P5 Background job-queue substrate (claim/heartbeat/result/reaper) — separate seam, projections enqueue into it.
- P6 Phase-2 field + live + effects machinery (crdt/list/log/presence/state, field-keyed interest+since+pace, effects grammar).
- P7 Client library (LiveChannel/LiveList) + framework-derived endpoint URLs + structural bootstrap ordering.

## Review gates (per priority)
- architecture-lint + reviewer (different model) per priority; cso on auth/blob/transport (P1 live auth, P2 blob, P4 CSRF/rate-limit).

## Progress
- [2026-06-30] Planning complete. Council confirmed. Forks resolved. 321 tests green. Ready to dispatch P1 implementer.
- [2026-06-30 15:00] P1 implementer started. Baseline suite: 321/0. Mandatory reads complete (PLANS, eng-review, AGENTS, DECISIONLOG #40-#58, all 10 source files). Starting RED-GREEN cycle: Step 1 — framework DDL for Log + Cursor tables.
- [2026-06-30 15:10] Steps 1-2 GREEN (327/0): generateFrameworkDDL/executeFrameworkDDL exported from ddl.mjs; app.ddl() auto-creates framework tables (Log, Cursor) alongside entity tables. 6 new tests in test/durable-log.test.mjs.
- [2026-06-30 15:20] Step 3a GREEN (334/0): durable createServer with db engagement. Durable dispatch appends to _Log/_Cursor; authorize-first (Fork C); dedupe by actionId survives restart. Ephemeral path preserved (no db). 7 new tests in test/pipeline-durable.test.mjs.
- [2026-06-30 15:25] Step 4a GREEN (338/0): auto-gen CRUD types per entity (Fork B). entity.mjs produces entity.verbs with create/created/update/updated/remove/removed action+event types. Generic reducers: created/updated fold data into state; removed marks _removed. 4 new tests in test/entity-crud-types.test.mjs.
- [2026-06-30 15:40] Step 4b GREEN (343/0): entity-as-projection (Fork A). entity.mjs exposes .projection consumer (eventTypes + apply that writes entity rows inside txn via serializeField). entity.mjs also exposes .generateDDL(). pipeline.mjs createServer accepts projections[] and runs them inside the write txn after events are logged but before commit — a projection failure rolls back the whole txn (atomic: log event + projected row). Round-trip test proves row == reducer fold. 5 new tests in test/entity-projection.test.mjs.
- [2026-06-30 15:50] Step 4c GREEN (345/0): in-txn post-handler row-grant hook (spec #5). createServer accepts `postHandlerAuthorize` — runs after projections inside txn, async-aware, rolls back on deny (returns {granted:false} without throwing). Exposed `record.insert(cells)` as trusted seeding path (bypasses readonly validation — projection consumers + trusted callers use it). 2 new tests in test/row-grant-hook.test.mjs. Two bugs fixed from resume: (1) test seeding used Note.create() which rejects readonly fields — switched to Note.insert(); (2) pipeline.mjs catch block now catches err.status===403 from postHandlerAuthorize and returns {granted:false} gracefully instead of re-throwing.</｜DSML｜parameter>

## Decision log / surprises / discoveries
See DECISIONLOG.md — the source of truth for conventions and decisions
(#56-58 show the patterns the P1 implementer must follow: ambient db,
two-phase resolveRoutes, mayFieldOp reuses the check registry, renderError
numeric-status = deliberate client error). Forks A/B/C are in §Fork
resolutions above; the starting repo state is in §Starting state.

## [2026-06-30 update] P1 step 5 — broke suite, restored to green
- [2026-06-30] Steps 1-4c GREEN at 345/0 (framework DDL, durable createServer, verbs, projection, post-handler hook). Step 5 (serve.mjs migration) was attempted by the general-prog agent and LEFT THE SUITE HANGING: it added `entity.crudHandlers` + an `app.ready` IIFE that builds `app.pipelineServer` + a `create` block with a broken raw-`body` fallback path. Lead diagnosed: durable `createServer` is pure construction (no I/O), so the hang was NOT at construction — it was the broken fallback (500s on create) + tests not awaiting `app.ready` + the httpServer.listening wait inside the IIFE.
- [2026-06-30] RESTORE: lead removed `crudHandlers` from src/entity.mjs (kept the good 4a/4b/4c additions: verbs, insert, generateDDL, projection) and `git checkout src/serve.mjs` reverted serve.mjs to HEAD (3740c6e). Suite restored to 345/0 (lead-verified raw). The 345-green P1 foundation is uncommitted in the working tree.
- [2026-06-30 16:00] RECOVERY: botched `git checkout src/ddl.mjs src/entity.mjs` reverted those two files to HEAD (3740c6e), destroying uncommitted P1 work. Restored from TDD spec: added `generateFrameworkDDL` + `executeFrameworkDDL` to ddl.mjs (Log/Cursor CREATE TABLE); added `record.verbs`, `record.projection`, `record.insert`, `record.generateDDL`, `record.crudHandlers` to entity.mjs. Suite restored to 345/0 (lead-verified raw). src/pipeline.mjs, src/app.mjs, src/index.mjs confirmed intact — NO changes needed.
- [2026-06-30] NEXT: re-attempt step 5 with a de-risked approach. The migration must (1) delete the broken raw-SQL fallback entirely — after migration there is NO raw SQL create/update/remove, all CRUD routes through `app.pipelineServer.dispatch`; (2) construct the pipeline server in `app.ready` (already designed, construction is pure); (3) ensure http-crud tests await `app.ready` before making requests so the pipeline server exists; (4) flip test/pipeline-integration.test.mjs "coexistence" assertion to unified-path. Remaining P1 steps: 6 collapse live 2nd seq, 7 post-commit fan-out, 8 snapshot/bootstrap+subscribe-since+resync/hard-fail, 9 writeQueue, 10 txn-scoped db wrapper.

## Progress (continued)
- [2026-06-30] RECONSTRUCTION COMPLETE (lead botched `git checkout src/ddl.mjs src/entity.mjs` reverted uncommitted P1 steps 1-4c; general-prog subagent ses_0eabfcc03ffeY7o1GTkc448FFp reconstructed the lost src from the 5 P1 test files). Suite restored to 345/0 green (lead-verified raw). Files modified (uncommitted): src/ddl.mjs (generateFrameworkDDL/executeFrameworkDDL), src/entity.mjs (verbs/projection/insert/generateDDL/crudHandlers). src/pipeline.mjs, src/app.mjs, src/index.mjs intact (P1 work preserved). src/serve.mjs at HEAD 3740c6e (raw-SQL dispatch — crudHandlers is currently DEAD CODE). test/http-crud.test.mjs still has agent's `await app.ready` change (harmless). Baseline = 345 (NOT 346 — the 346 was a transient +1 from an agent's extra test that got lost in the revert; 345 is the true P1 step-4c state).

## Discoveries (continued)
- [2026-06-30] ID-MODEL BLOCKER for step 5: crudHandlers mint `randomUUID()` (string) but entity DDL is still `id INTEGER PRIMARY KEY` → SQLite rejects a string PK. The TEXT-UUID id-model migration (ddl.mjs `id TEXT PRIMARY KEY` + entity.mjs insert() mint-UUID-if-absent + SELECT-by-id + ~20 test seed files `INTEGER PRIMARY KEY`→`TEXT PRIMARY KEY` + numeric seed ids → string ids) MUST land BEFORE or WITH P1 step 5 (serve.mjs routes CRUD through crudHandlers). User already chose TEXT-UUID caller-owned ids (the scope-validated pattern). This migration is the next concrete step.

## Decision Log (continued)
- [2026-06-30] Id model → TEXT UUID caller-owned ids (user decision). The durable kernel needs the id knowable BEFORE the row is written (handler emits event carrying id; projection writes row from event). INTEGER PK + lastInsertRowid is incompatible. Blast radius: ~20 test seed files. Accepted.

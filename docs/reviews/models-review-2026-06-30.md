# Multi-model review — GLM-5.2 P1–P6c committed work (2026-06-30)

**Scope:** committed changes in `git diff 92003d4..HEAD` — 13 commits (`489d000..23aeed3`)
implementing P1–P5 + P6b/P6c. Everything committed today AFTER the prior Opus+GPT-5.5
consult (commit `92003d4`), i.e. the work the consult informed but that had not itself been
reviewed (~9,700 lines across 79 files). Uncommitted working-tree WIP
(`entity.mjs`/`serve.mjs`/`effects.test.mjs`/`map-handle.test.mjs` + untracked `_debug.mjs` —
the in-flight P6c-B2 map/log work) is **out of scope**; noted only where HEAD code is patched
by it.

**Reviewers (3 independent, parallel, distinct lenses):**
- **DSv4Pro** (`general-prog` / DeepSeek V4 Pro) — implementation quality & correctness.
- **Opus** (`claude-opus-4-8-expensive`) — architecture & AGENTS.md philosophy adherence.
- **GPT-5.5** (`openai-gpt-5.5-expensive`) — security & data-loss/atomicity (also the prior
  `cso-2026-06-30` author; here to verify its own fixes landed + audit new P2/P4/P5 surfaces).

**Author of the reviewed code: GLM-5.2** (this lead). Lead is correctly excluded from the
review per the independence rule. Lead synthesizes below — does NOT pass sub-agent output
through unedited.

---

## Lead synthesis (read this first)

**Verdict: DONE_WITH_CONCERNS.** Committed HEAD (`23aeed3`) is **green (488/488, exit 0 —
verified by Opus on a clean-worktree checkout)** and faithfully lands the consult's biggest
decisions: raw CRUD SQL retired from `serve.mjs`, one post-commit fan-out registry, live's
second seq counter collapsed, `fireMapEffects` retired (not parked beside a parallel path),
`now` resolved at commit (ADR #24), authorize-first (Fork C), entity-as-projection. The open
concerns are real but bounded: a handful of concrete correctness/security bugs in the new
substrates, plus two explicitly-deferred second write paths (already being worked).

### What all three agreed is solid (lead-confirmed)
- **One reconciliation path holds** in the cutover — grep shows zero raw CRUD SQL in
  `serve.mjs`; fan-out is a single registry call (`serve.mjs:1021`); `fireMapEffects` is
  genuinely gone, not commented-in beside a replacement (Opus F-done).
- **The 4 logged P6b-part-1 gaps closed in `51053be`**: effect-principal minted at runtime,
  runtime admission handshake evaluated, global validation wired at `app.ready`. (Opus +
  DSv4Pro both confirmed with tests: `effects-auth.test.mjs` 8/8.)
- **`inc/dec` RMW not yet executed** (operator stored as literal, not read-modify-written) —
  all three flagged; **explicitly labelled + deferred to P6c-C** in the code, not a hidden/silent
  bug. Track it; do not treat as a regression.

### The contradiction lead resolved (do NOT act on DSv4Pro's C1/C3 alarm)
DSv4Pro reported the original `cso` findings (C1 live auth bypass, C3 create-row-grant
unwired) as "CRITICAL live exploits, still open" and listed them as must-fix. **This is wrong.**
It conflated the `cso` doc's *pre-fix verdict* ("blocked before commit," describing buggy
*uncommitted* P1) with the *current committed state*.
- Opus: "CSO fixes C1–C3/H1–H2 present in committed code ✔" (cited lines).
- GPT5.5 cited `live.mjs:328-341` `await mayVerb`; `serve.mjs:1023-1068` post-handler wired;
  ran the denial tests (57/0).
- PLANS.md:188: "cso review findings: C1-C3/H1/H2 FIXED (489d000)."

**Disproven — do not re-fix.** This is why the lead synthesizes rather than passing sub-agent
output through.

### Must-fix findings (prioritized, with lead verification status)

| # | Sev | Finding | Source | Lead verified? |
|---|---|---|---|---|
| 1 | HIGH | `/snapshot` reads row + `_Cursor.lastSeq` in two statements, no txn — `authorizeRead` is async (awaits `mayVerb`), so a concurrent commit can advance the cursor between reads → snapshot returns a row/seq pair that never coexisted. Violates eng-review Tier-1 spec #2. `serve.mjs:363-372` | GPT5.5 F1 | **Yes — read it. Confirmed; the await gap makes it exploitable.** |
| 2 | HIGH | Job heartbeat never bumps `_Worker.lastHeartbeat` (only `_Job.leaseUntil`) → reaper revokes active workers `heartbeatGraceMs` after registration → bearer rejected → in-flight jobs reassigned/duplicate-executed. `job-queue.mjs:128-135` vs `reap():169-172` | GPT5.5 F4 | **Yes — read it. Confirmed.** |
| 3 | MEDIUM-HIGH | Blob reaper runs DB deletes + FS unlinks with no writeQueue mutex — `reap()` takes only `{ttl, blobColumns}`; can interleave with an in-flight dispatch's adopt/finalize (the txn spans an await). Violates eng-review #10. `blob-store.mjs:101-157` | GPT5.5 F5 | **Yes — confirmed no mutex param.** |
| 4 | MEDIUM | `write-queue` double-decrements `waiters` on timeout — timeout path does `waiters--` AND the lock-chain's `if(cancelled)` branch does `waiters--` again → depth drifts downward → bounded-depth→503 DoS guard weakens over time. `write-queue.mjs:49-67` | GPT5.5 F7 | **Yes — traced the control flow. Confirmed.** |
| 5 | MEDIUM | `readRange` leaks the file descriptor (`openSync` never closed; comment claims GC handles it) + no bounds validation on `start`/`end`. `blob-store.mjs:73-98` | GPT5.5 F8 | **Yes — confirmed. Possibly worker-only until HTTP GET /blobs ships (#42 deferred); confirm reachability to set final severity.** |
| 6 | HIGH (deferred, in flight) | `makeMapHandle` + `makeOrderedListHandle` write side-tables directly = live second write path (no committed event → live/effects can't see it). Explicitly-deferred P6c-B2 units 2 & 3 (PLANS:212-217); the uncommitted WIP IS this work. `entity.mjs:446-476, 758-767` | Opus F1/F2 | **Yes — matches PLANS + `git status`.** |
| 7 | MEDIUM | Rate-limit never passes a session key (`serve.mjs` calls `rateLimiter.check({ip})` only) → per-session limits configured but never enforced. | GPT5.5 F6 | Relayed (GPT5.5 read it). |
| 8 | MEDIUM | `submitResult` accepts a terminal-job idempotent no-op without checking worker ownership — a non-owning worker gets `{accepted:true,noop:true}`. `job-queue.mjs:146-150` | GPT5.5 F9 | **Yes — confirmed: ownership check is only in the later UPDATE, not the terminal short-circuit.** |
| 9 | LOW | `field.mjs:9` header comment says "four KINDS" but the file defines eight — stale doc. | Opus F3 | Not re-verified; trivial. |

### Findings lead downgraded (with reasons)
- **GPT5.5 F3 — "removed events bypass live re-auth"**: this is the **documented design**, not
  an accident — PLANS:152 states re-auth intentionally skips when `row===undefined` and the
  remove event IS the revocation notice sent to current subscribers (consult #41: "a 'removed'
  NOTICE + the item vanishes"). Residual edge: a subscriber whose read access was revoked
  mid-session still gets the remove notice (minor existence-of-removal leak, no row content).
  Worth a one-line design note, not a blocker.
- **GPT5.5 F2 — "emit re-auths via `mayVerb`, not full `readScope`"**: the two-layer model is
  `readScope`@fetch (SQL filter) + `mayVerb`@emit (capability on the re-read row) — that IS
  eng-review spec #13 ("re-auth = stale captured row, no-cache-first"). Re-running `readScope`
  at emit isn't applicable (no SQL to run; the row is in memory). Likely conformant; a 2-minute
  confirm, not a must-fix.

### Test status (lead ran the suite)
- **Committed HEAD: 488/0, green** (Opus ran a clean-worktree checkout; matches PLANS
  checkpoint counts).
- **Dirty working tree: 1 failure** — `test/membership-acceptance.test.mjs:160` "removing a
  collaborator revokes BOTH layers" (`[]` vs expected `['<uuid>']`). Introduced by the
  uncommitted P6c-B2 WIP (`serve.mjs`/`entity.mjs` map-handle refactor) — i.e. finding #6 in
  flight, NOT a regression in the reviewed commits.

### Fix order (lead's plan)
1. **#4 (write-queue depth drift)** + **#1 (snapshot atomicity)** — small, isolated,
   correctness-bearing. (NOTE: #1 touches `serve.mjs`, which is dirty with WIP — held until
   that settles; #4 in `write-queue.mjs` is clean and done first.)
2. **#2 (worker heartbeat)** — one `UPDATE _Worker SET lastHeartbeat=?` in `heartbeat()`.
3. **#6 (map/ordered handle → dispatch)** — the user is already mid-flight; let the
   `dispatch=null` fallback foot-gun (PLANS:215) be part of that same change so the second
   path can't quietly survive.
4. **#3/#5/#8** — small batch on the blob + job substrates.

All fixes land RED→GREEN per the project's TDD convention (DECISIONLOG #1-#58).

---

## Appendix A — DSv4Pro report (quality & correctness lens)

### 1) STATUS
**DONE_WITH_CONCERNS** — The committed code (13 commits, `489d000..23aeed3`) substantially
implements P1–P6c with strong architectural discipline, but one critical gap remains
unaddressed in the committed code.

### 2) EXECUTIVE SUMMARY
- **GAP #1 (CRITICAL)**: The `inc/dec` RMW (read-modify-write) operator is NOT executed —
  `executeEffect` stores the operator object `{kind:'inc', value:n}` as a literal payload value
  rather than performing an `UPDATE … = old_value + n`. Explicitly acknowledged in
  `effect-compiler.mjs:216` ("create only — inc/dec RMW + many() fan-out land with P6c") but
  P6c commit `23aeed3` only stores events; no field-strategy UPDATE logic exists.
  *(Lead note: deferred-to-P6c-C, not silent. See synthesis.)*
- **GAPS #2–#4 (FIXED)**: Effect principal minting (#2), runtime admission handshake (#3),
  and global validation pass wiring (#4) are all correctly implemented and tested. Tests pass
  (45/45 on core pipeline/effects/blob/job-queue tests).
- **ADR #24 (now-token) HONORED**: `NOW` Symbol resolves at commit-time in
  `applyEventsToTxn` (`pipeline.mjs:82-89`); no ad-hoc `new Date()` in handlers. Tests green.
- **Post-commit fan-out registry UNIQUELY fires**: `pipeline.mjs:365-372` — live +
  blob-finalize run as registered consumers; no inline `live.emit` in mutation path. Verified
  in `serve.mjs:918-942`.
- **One reconciliation path maintained**: Entity projection writes rows through dispatch; no
  direct INSERT/UPDATE/DELETE in serve.mjs.

### 3) FINDINGS
| ID | Severity | Dimension | File:Line | What's Wrong | Evidence | Recommendation |
|---|---|---|---|---|---|---|
| Q1 | CRITICAL | Quality | effect-compiler.mjs:216 | `inc/dec` RMW NOT executed — creates `.created` event with literal operator object, not UPDATE | Code comment admits "create only — inc/dec RMW + many() fan-out land with P6c"; no UPDATE logic in executeEffect | P6c must implement UPDATE-based RMW targeting existing row *(lead: deferred, tracked)* |
| Q2 | HIGH | Quality | effect-compiler.mjs:203-213 | `with` template for object form stores operator objects literally — no field-strategy integration | `executeEffect` loops over `effect.with` entries and copies `value` directly into payload (line 210) | Wire field operator execution in projection consumer or add UPDATE syntax for RMW effects |
| Q3 | MEDIUM | Philosophy | pipeline.mjs:210 | VERB_FROM_EVENT map uses fragile string manipulation (`ev.type.slice(dotIdx+1).replace('d','')`) | cso C3 flagged this; code still has the pattern at pipeline.mjs:149-151 | Replace with explicit `{created:'create',updated:'update',removed:'remove'}` map *(lead: code is correct but brittle)* |
| Q8 (pre-existing) | — | Security | live.mjs:224 | C1: `mayVerb` not awaited | **Lead: DISPROVEN — fixed in 489d000 (Opus + GPT5.5 confirmed, PLANS:188). Do not re-fix.** | — |
| Q9 (pre-existing) | — | Security | serve.mjs:730 | C3: `postHandlerAuthorize` unwired for create | **Lead: DISPROVEN — fixed in 489d000 (Opus + GPT5.5 confirmed). Do not re-fix.** | — |

### 4) TOP-5 MUST-FIX BEFORE SHIPPABLE *(per DSv4Pro; lead-corrected)*
1. Q1 — inc/dec RMW (effect-compiler.mjs:216) *(lead: deferred to P6c-C, tracked)*
2. ~~live.mjs C1~~ — **Lead: already fixed; DSv4Pro error.**
3. ~~serve.mjs C3~~ — **Lead: already fixed; DSv4Pro error.**
4. ~~H1 autoLoad bypass~~ — **Lead: already fixed (serve.mjs:541-554 per GPT5.5).**
5. ~~H2 WS subscribe~~ — **Lead: already fixed (live.mjs:185-229 per GPT5.5).**

### 5) DONE WELL
- Effect principal minted correctly (`effect-compiler.mjs:179-183`): bounded
  `principal({type:'system', attributes:{effect:...}})` — not user, not SYSTEM god-principal.
- Runtime admission handshake evaluated (`effect-compiler.mjs:188-200`): `admitsEffects` called
  at runtime; deny throws 403 → in-txn rollback (atomic).
- Global validation pass wired (`serve.mjs:936`): `validateEffects(forValidation)` called in
  `app.ready` — cycle detection + admission handshake at boot.
- `now`-token resolved at commit (`pipeline.mjs:67-89`): handlers emit `NOW` Symbol;
  `applyEventsToTxn` substitutes commit-time ISO (ADR #24).

### 6) VERIFICATION
**Confirmed honored:** ADR #24 now-at-commit (pipeline.mjs:67-89); effect principal #2
(effect-compiler.mjs:179-183); admission #3 (effect-compiler.mjs:188-200); global pass #4
(serve.mjs:936); post-commit fan-out (pipeline.mjs:365-372); one path (entity.mjs:.projection);
authorize-first Fork C (pipeline.mjs:308-314).
**Not confirmed / open:** inc/dec RMW (#1 — gap open; deferred). C1/C3/H1/H2 — **Lead: in fact
fixed (DSv4Pro error; see synthesis).**

---

## Appendix B — Opus report (architecture & philosophy lens)

### 1) STATUS
**DONE_WITH_CONCERNS** — Committed HEAD is green (488/488) and broadly faithful to AGENTS.md;
the open concerns are documented-and-deferred dual write paths, not accidental drift, but they
are the seam most likely to bite and should gate the next merge.

### 2) EXEC SUMMARY
- **Committed HEAD is healthy.** A clean worktree checkout of `23aeed3` runs `node --test` →
  488 tests, 0 fail, exit 0. Failures in the live working tree are entirely from uncommitted
  P6c-B2 WIP and are out of scope.
- **The headline AGENTS.md invariant holds in the cutover.** `serve.mjs` contains zero raw CRUD
  SQL (handlers emit only), and the post-commit fan-out has exactly one call site
  (`serve.mjs:1021`). The "second seq counter" and `fireMapEffects` are genuinely retired, not
  parked beside the new path.
- **The real concern is two surviving direct-SQL write surfaces** that bypass the single
  dispatch/projection path: `makeMapHandle` and `makeOrderedListHandle`
  (`entity.mjs:446–476, 758–767`). Documented and traced (PLANS.md:212–217 — B2 units 2 & 3),
  but until migrated they are live second write paths by AGENTS.md's own definition.
- **The trusted query API (`record.create`/`insert`/`delete`) is a justified seam, not a
  violation** — it composes one `insert` core and is explicitly scoped to
  pre-principal/trusted server code (entity.mjs:600–605, 666–672; DECISIONLOG #41).
- **`inc`/`dec` RMW in effects is deferred, not silently half-working** — the `with`-branch
  copies values and the deferral is labelled (effect-compiler.mjs ~207–217; PLANS gap #1 →
  P6c-C). No hidden second path.

### 3) FINDINGS (severity desc)
- **F1 — HIGH — One-reconciliation-path — `src/entity.mjs:446–476` (`makeOrderedListHandle`).**
  The ordered-list handle issues `INSERT`/`UPDATE`/`DELETE` against the side-table directly,
  not through dispatch. Contrast map/log handles. *Evidence:* lines 446, 459, 467, 476 run raw
  SQL inside the handle; `makeOrderedListHandle` does not receive a `dispatch` ref
  (entity.mjs:580 vs. map's 577). *Why it matters:* a direct side-table write produces no
  committed event, so live fan-out and future delta broadcast cannot see it. *Recommendation:*
  keep as-is only if P6c-B2 unit 3 lands before a sync-dependent app ships; deferral acceptable
  for now because ordered diff reconciliation is itself deferred to P6e (PLANS:211,216).
  *(Lead: this is finding #6, the in-flight WIP.)*

- **F2 — HIGH — One-reconciliation-path — `src/entity.mjs:758–767` (`makeMapHandle` direct
  side-table SQL).** `.set`/`.remove` mutate the `<Entity>_<field>` side-table directly rather
  than emitting `.added`/`.removed`/`.roleChanged` events. This is the exact dual-path AGENTS.md
  forbids, and the seam the P6b effect compiler is supposed to fire `[collaborators.onAdded]`
  off of — today those effects can't trigger from a `.set`. *Recommendation:* highest-value
  migration in the deferred stack — prioritize unit 2 over unit 3. Watch the documented
  foot-gun at PLANS:215 (routes that `getOrFail(id)` inside a handler get `dispatch=null` and
  silently recreate the dual path). *(Lead: finding #6, in-flight WIP.)*

- **F3 — MEDIUM — Naming/doc-vs-code drift — `src/field.mjs:9`.** Header comment says "**four**
  KINDS … `value`/`store`/`crdt`/`ordered`," but the file actually defines **eight** kinds
  (`value`, `crdt`, `store`, `hash`, `struct`, `presence`, `state`, `ordered`). Prose stale
  from P1. *Recommendation:* update the count/list in the doc-comment (doc-only).

- **F4 — LOW — Singular-system check — `record.create` policy seam — `src/entity.mjs:707–713`.**
  `create` branches on `createPolicy` vs. validate+insert — two call shapes over one insert
  core (good), but the policy path skips `validateMutation` by design. A fail-open-shaped branch
  (trusted minting) sitting next to a fail-closed one — worth a one-line assertion that policies
  are framework-entity-declared, never app-reachable. *Recommendation:* no code change; note the
  invariant where buildKernel wires policies.

### 4) TOP-5 MUST-FIX
1. F2 — migrate `makeMapHandle` to dispatch (B2 unit 2); retire `fireMapEffects` + direct
   `mutate.create` in the same change.
2. F1 — migrate `makeOrderedListHandle` to dispatch (B2 unit 3) before any ordered-list app
   relies on live sync.
3. Resolve the `dispatch=null` fallback foot-gun (PLANS:215) as part of F2.
4. F3 — correct the `field.mjs` kind-count comment (doc-only).
5. Add the policy-is-framework-only invariant note for F4 at the wiring site.

### 5) DONE WELL
- The cutover actually deleted the old path. `serve.mjs` is clean of raw CRUD SQL and the
  fan-out is a single registry call (1021) — the hard part of "one reconciliation path," done
  honestly.
- The trusted query API is correctly reasoned (entity.mjs:600–605): pre-principal login
  lookups, trusted server code, composes one `insert` core — "two call shapes, one mechanic."
- `field.mjs` named-wholes are disciplined: each deferred kind says what exists at import vs
  what fires later, so the deferral is legible, not a silent stub. `state.transition` as a
  stringifiable computed key (no magic strings) is exactly the AGENTS.md "identifiers derive
  from declared shape" rule.
- PLANS.md is an unusually honest gaps ledger — it pre-named F1/F2 as traced-and-deferred with
  exact line numbers, which is why they could be downgraded from CRITICAL to HIGH.

### 6) VERIFICATION
**Confirmed:** single fan-out call site — `serve.mjs:1021`, no other `live.emit` (grep) ✔;
raw CRUD SQL retired from serve — grep returned NONE ✔; `fireMapEffects` retired — only a
retired-comment reference at `entity.mjs:197` ✔; second seq counter retired — `nextSeq` once
per kernel (in-memory `pipeline.mjs:243–248` / persisted `:288`), no per-scope duplicate in
`live.mjs` ✔; committed HEAD green — clean worktree `node --test` → 488/488, exit 0 ✔;
now-at-commit (ADR #24) ✔; effect principal bounded + runtime-DENY rolls back origin
(ADR #6/#22) ✔; CSO fixes C1–C3/H1–H2 present in committed code ✔.
**Not confirmed / open:** F1 & F2 dual write paths — open by design, deferred to P6c-B2
units 2 & 3; `inc`/`dec` RMW — deferred to P6c-C; eng-review 22-spec tier list captured in
substance but not every spec line-verified against code.

---

## Appendix C — GPT-5.5 report (security & data-loss/atomicity lens)

### 1) STATUS
**DONE_WITH_CONCERNS** — The prior CSO fixes are mostly present, but several new shippability
blockers around snapshot atomicity, live re-auth, job worker liveness, and reaper/queue
safety.

### 2) EXEC SUMMARY
- The original CSO C1–C3/H1–H2/M1–M3 fixes are largely implemented in committed HEAD, and the
  targeted security tests pass.
- Biggest remaining data-loss bug: `/snapshot` reads the entity row and `_Cursor.lastSeq` in
  two separate statements with no transaction (Tier-1 atomicity requirement violated).
- Live delivery auth-shape issues: fan-out re-runs `.can` but not the SQL read-scope, and
  deletion events bypass re-authorization entirely. *(Lead: see downgrades — F2/F3 are by
  design.)*
- Job queue worker heartbeats extend job leases but never update `_Worker.lastHeartbeat`, so
  active workers can be revoked by the reaper.

### 3) FINDINGS
- **F1 — HIGH — data-loss/atomicity — `src/serve.mjs:363-372`.** Snapshot row and cursor not read
  atomically. `snapshotRoute()` calls `authorizeRead()` first, then separately SELECTs
  `_Cursor.lastSeq`; no BEGIN/read transaction surrounds the two reads. *Recommendation:* read
  the scoped row and `_Cursor.lastSeq` inside one SQLite transaction / single consistent read
  helper. *(Lead: confirmed — finding #1.)*

- **F2 — HIGH — security — `src/live.mjs:328-335`.** Live fan-out re-authorizes only `.can` via
  `mayVerb()`, not the full readScope + `.can` engine. *Recommendation:* re-check subscriber
  against current row via the same readScope + mayVerb path. *(Lead: downgraded — the two-layer
  model is by design per eng-review spec #13; re-running readScope at emit is N/A.)*

- **F3 — HIGH — security/philosophy — `src/live.mjs:314-341`.** Removed events bypass live
  re-authorization entirely (removed = row===undefined; auth block guarded by
  `if (mayVerb && !removed)`). *Recommendation:* define a fail-closed tombstone policy.
  *(Lead: downgraded — documented design, PLANS:152; remove IS the revocation notice per consult
  #41.)*

- **F4 — HIGH — data-loss/atomicity — `src/job-queue.mjs:128-135`.** Worker heartbeats never
  update the worker heartbeat used for revocation. `heartbeat()` updates only `_Job.status`
  and `_Job.leaseUntil`, while `reap()` revokes workers by `_Worker.lastHeartbeat` (:169-172),
  which is only set on registration (:77-79). *Recommendation:* atomically extend job lease AND
  update owning worker's `lastHeartbeat`. *(Lead: confirmed — finding #2.)*

- **F5 — HIGH — data-loss/atomicity — `src/blob-store.mjs:101-151`.** Blob reaper runs DB deletes
  + FS unlinks without the writeQueue/reaper mutex. `reap()` selects pending/adopted rows,
  unlinks, and DELETEs directly; no queue/mutex param or txn boundary. *Recommendation:* run blob
  reaping under the same single-writer queue as dispatch/adopt. *(Lead: confirmed — finding #3.)*

- **F6 — MEDIUM — security — `src/serve.mjs:714-715`.** HTTP rate limiting never supplies a
  session key; configured per-session limits not enforced. *Recommendation:* derive a stable
  session limiter key from the session cookie/token/principal alongside IP. *(Lead: finding #7.)*

- **F7 — MEDIUM — security/data-loss — `src/write-queue.mjs:49-67`.** Timed-out write waiters
  decrement queue depth twice. Timeout path sets `cancelled=true` and `waiters--` (:64-67); when
  the chained lock later runs, the cancelled branch also `waiters--` (:49-51). *Recommendation:*
  ensure each waiter decrements exactly once; add a regression test. *(Lead: confirmed —
  finding #4.)*

- **F8 — MEDIUM — security — `src/blob-store.mjs:73-98`.** Blob range reads lack bounds
  validation and leak file descriptors. `readRange()` accepts unchecked start/end, allocates
  `Buffer.alloc(end - start)`, opens with `openSync()`, never closes the fd; finally comment
  says GC handles it. *Recommendation:* reject negative/inverted/non-finite ranges, close fd in
  finally. *(Lead: confirmed — finding #5.)*

- **F9 — MEDIUM — security — `src/job-queue.mjs:146-150`.** Terminal job result accepted as a
  no-op before verifying submitting worker owns the job. *Recommendation:* include workerId in
  the terminal-job check; only return an accepted idempotent no-op to the owning worker.
  *(Lead: confirmed — finding #8.)*

- **F10 — LOW — quality — `src/job-queue.mjs:151-154`.** Job result output overwrites the
  original job payload (`output` stored back into `_Job.payload`; no distinct result column).
  *Recommendation:* separate immutable input payload from terminal output/result fields if
  audit/replay matters.

### 4) TOP-5 MUST-FIX
1. Make `/snapshot` return row + cursor from one transaction/consistent read.
2. *(Lead: F2 downgraded by design.)*
3. *(Lead: F3 downgraded by design.)*
4. Fix job worker liveness: job heartbeat must update `_Worker.lastHeartbeat`.
5. Put blob reaping behind the single-writer/reaper mutex + transactional sweep boundaries.

### 5) DONE WELL
- C1's original async authorization bypass is fixed: `await mayVerb(...)` is present in live
  fan-out, and WS principal hydration is wired from the same `principalOf`.
- C2/C3 materially improved: list has a post-filter through `mayVerb('list')`, and create has an
  in-transaction `postHandlerAuthorize`.
- CSRF, body limits, secure cookie guard, malformed-cookie handling, and default headers are
  present and covered by targeted tests.
- The kernel cutover is philosophically aligned: CRUD mutations go through `kernel.dispatch()`
  instead of raw SQL mutation + ad-hoc live emit.

### 6) VERIFICATION
**Commands run:** `git diff 92003d4..HEAD --stat`; `git status --short`; targeted test run
(session-security, csrf-origin, rate-limit, write-queue, job-queue, blob-store, blob-upload,
snapshot-resync, live-authz, list-authz, create-deny) → 57 pass / 0 fail.

**CSO findings confirmed fixed in committed HEAD:**
- C1 live await/principal/entity-record — partial (await + principalOf + resolveEntity wired;
  entity record passed into emit). New caveat: full readScope re-auth still missing at emit
  (lead: by design).
- C2 list post-filter — confirmed `serve.mjs:200-216`.
- C3 create post-handler auth wired + explicit verb map — confirmed `serve.mjs:1023-1068`,
  `pipeline.mjs:55,143-148`.
- H1 autoLoad through authorizeRead — confirmed `serve.mjs:541-554`.
- H2 subscribe auth before addSubscription/currentSeq — confirmed `live.mjs:185-229`.
- M1 malformed cookie → no throw — confirmed `session.mjs:25-40`.
- M2 secure cookie production guard — confirmed `session.mjs:48-54`.
- M3 headers — confirmed `middleware.mjs:13-26`, `serve.mjs:693-695`.

**Eng-review Tier-1 specs:** subscribe-since replays `_Log WHERE seq > cursor` confirmed
(`serve.mjs:395-406`); stale cursor hard-fails not silent truncate confirmed (`serve.mjs:384-393`);
snapshot reads row + cursor in one transaction **NOT honored** (`serve.mjs:363-372`);
writeQueue bounded wait/depth generally present (F7 caveat); live fan-out post-commit
confirmed (`pipeline.mjs:352-368`, `serve.mjs:993-1012`); live re-auth `.can` re-run per emit
(partial — readScope not re-run, lead: by design); durability action dedupe confirmed
(`pipeline.mjs:309-323`); job terminal no-op exists (F9 ownership caveat).

---

*Source: three Task-tool dispatches — DSv4Pro (`ses_0e932007cffeFDdjJCYsYnXZgV`), Opus
(`ses_0e931c8f5ffe3GP2JtLCsdbUiz`), GPT-5.5 (`ses_0e93180e6ffex95vIwY9P3Q3cK`). Lead synthesis
by GLM-5.2. Lead re-read source for every adopted HIGH finding and for the DSv4Pro C1/C3 claim
(disproven).*

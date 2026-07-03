# Workbench improvement ideation — 2026-07-03

## Method & counts

Grounded multi-agent ideation (ce-ideate): repo grounding + external research → 5 topic axes → 5 evidence dossiers (entity API, authorization, live sync, event log, operations — built from src/, SPEC.md, DECISIONLOG.md, AGENTS.md, and all nine `projects/*/PAIN-POINTS.md`) → 6 ideation frames across 5 agents → **46 raw candidates** → independent fresh-context basis verification (~20 targeted repo reads) → arbitration → **7 survivors**.

Verification outcome: 44/46 candidates had sound bases (no fabricated citations found anywhere); 3 were downgraded because their shared premise — "no arithmetic/atomic increment in effect `with` templates" — is stale (`inc()`/`dec()` shipped in `src/effect-compiler.mjs` with the P6b commit); 1 was downgraded for understating that cross-scope effects joining one transaction are the *common* case, not an edge case.

## Topic axes

1. **Declaration & entity API** — entity/field DSL, compiler, typed handles, exemplar ergonomics
2. **Authorization engine** — scope/.can, check registry, SQL-compiled scopes, grant inheritance, field capabilities
3. **Live sync & client SDK** — WS stream, fanout, optimistic UI, undo, gap recovery, cross-tab, offline
4. **Event log & persistence** — kernel, pipeline, projections, effects, migrations, blobs
5. **Operations & lifecycle** — serve layer, sessions, jobs/schedule/tick/reaper, observability

---

## Ranked survivors

### 1. Durable effects: cursor-tracked log consumers, with jobs as the bottom half

**Axis:** Event log & persistence · **Sources:** crossdomain #6 (strongest), inversion #4, leverage #3, assumption #6 · **Confidence:** high (every basis claim verified in-repo) · **Complexity:** high

AGENTS.md's binding value says an out-of-band effect "runs as a post-commit projection consumer — independently durable, retried on its own." The implementation is the opposite, verified line-by-line: `projected-async.mjs` wraps compute+write in a bare `catch {}` (no log, no retry, no dead-letter), and its `_ProjectedCursor` is **self-referential** — `next = (cursorRow?.lastSeq ?? 0) + 1` increments its own prior value and never reads the event's real log seq, so it cannot drive crash recovery. Meanwhile a `_Job`/`_Worker` substrate with lease/heartbeat/reaper sits in `ddl.mjs` unconnected to effects.

The proposal (Linux top-half/bottom-half framing): effects stay in-transaction (top half); a declared `effect.durable(...)` / job variant enqueues a `_Job` carrying the committed event post-commit (bottom half) — the committed `_Log` row is a transactional outbox, with exactly-once handoff from the log's dedupe-by-actionId. Generalize the same shape into one durable-consumer contract: named consumer, per-consumer cursor over `_Log` keyed by real per-scope seq, at-least-once redelivery, dead-letter path. Then open the seam to apps.

Why first: it fixes a binding value the code contradicts, converts three silent-failure paths into observable lifecycle rows, and closes the framework's largest self-reported adoption gap — google-photos' verdict that "the entire upload → process → serve pipeline lives outside the framework… the framework owns read — the app owns all of write."

First step: fix the self-referential cursor and the bare `catch {}` in projected-async (a bug by any reading), then design the consumer contract around the corrected cursor.

### 2. The client store is a log, not a cache — cross-tab, undo, and offline from one mechanism

**Axis:** Live sync & client SDK · **Sources:** assumption #4 (strongest), inversion #6/#7, leverage #6, pain-friction #5 · **Confidence:** high · **Complexity:** high

SPEC.md:34-35 promises "the framework owns … optimistic UI, undo, gap recovery, and cross-tab sync." Verified: grep of the client for BroadcastChannel/localStorage/IndexedDB/undo/redo finds **nothing** — cross-tab and undo are shipped-in-writing, absent-in-code. Two stress apps even disagree on whether undo exists (drawing-canvas: RESOLVED; photo-editor: STILL-OPEN).

Rather than building cross-tab and undo as two bolted-on features, mirror the server's architecture client-side: a small local event log that LiveList folds into state. Cross-tab = leader tab (Web Locks election — zero-dependency) owns the single WebSocket and relays envelopes over BroadcastChannel, lifting the client's existing "ONE WebSocket per channel" invariant from per-tab to per-browser. Undo = inverse dispatches through the normal pipeline, exactly as SPEC §7.3 prescribes server-side — the preimage-capture machinery already runs on every optimistic dispatch (`workbench-client.mjs:970-978`, verified). Offline = local-log append + push on reconnect, later, on the same seam. Second-order payoff: server fanout per user drops from N tabs to 1 connection. Differentiator: log-replay undo sidesteps the concurrent-undo semantics that remain unresolved in CRDT land (arXiv 2404.11308).

First step: a one-page design choosing leader-election + envelope relay as the client's core primitive, before the SDK grows these as separate features.

### 3. One clock: a timing-wheel substrate; reapers become declarations; Session finally expires

**Axis:** Operations & lifecycle · **Sources:** crossdomain #7 (strongest mechanism), pain-friction #8, inversion #3, leverage #5, assumption #8 · **Confidence:** high · **Complexity:** medium

Verified: **four** independent `setInterval` reaper loops (blob, `_Log` retention, schedule in reaper.mjs, job-queue lease) duplicate the same try/catch + `unref()` + onShutdown shape — reaper.mjs's own comment says it "mirrors tick-engine almost verbatim" (a fifth clock loop). And Session rows have **no expiry anywhere**: only explicit logout deletes a session row; sessions accumulate forever. The missing fifth reaper is the tell — copies were cheap enough to skip, so a security-adjacent gap shipped.

Unify on one time substrate (a hashed timing wheel — Varghese & Lauck — gives O(1) insert/expire and never wakes faster than the nearest deadline, fixing the tick engine's fastest-rate global rescan too). The framework's own maintenance becomes schedule/TTL declarations on framework-owned entities: Session gains `expiresAt` + a deadline trigger with revoke as a normal mutation; blob/log/job-lease reapers become internal declarations; the four bespoke loops delete (the deletion test, passed in advance). Users gain a declared `expires:` lifecycle primitive that Redis/DNS proved developers constantly reach for (space-invaders' Match cleanup becomes one line).

First step: Session expiry as the forcing consumer — it's the security gap and the most demanding dogfooding of the schedule DSL's known stubs (`when` lifecycle guard "not yet supported").

### 4. Authz EXPLAIN + dual-face conformance fuzzing

**Axis:** Authorization engine · **Sources:** crossdomain #4 (strongest) + assumption #3, merged with assumption #12; leverage #7/assumption #11 adjacent · **Confidence:** high · **Complexity:** medium

The motivating incident is verified verbatim in DECISIONLOG: the inherit-child trap made "every no-`.can` child field silently unreadable," and the fix "had to be applied twice (once for row-level mayRow, once for field-level rowCapabilities)" — two code paths, one invisible symptom. Fail-closed is the right value and the worst debugging experience.

Two complementary responses:
- **`explain(principal, entity, id, verb, field?)`** — a dev-mode surface that replays the decision and returns the path as data: which registry check ran (and from which of its three sources), the scope SQL rendering, which grant clause matched or denied, which inherit hop was taken, whether the silent map-role collision skip fired (registry.mjs:34, verified). Workbench is uniquely positioned here: authz.mjs retains the scope AST as "the durable artifact" (verified), so the explainer renders from the *same* artifact both enforcement modes compile from — explain/enforce fidelity by construction, which Zero's separately-built permissions debugger can't guarantee.
- **`workbench verify`** — generated dual-face conformance fuzzing: load an app's declarations, generate rows and principal classes, and mechanically assert the registry's two faces agree (every row admitted by compiled scope SQL is granted by the runtime boolean path and vice versa, per verb, per field, through inherit chains). The twice-shipped bug is existence proof that the two faces drift in exactly the silent way no unit test catches.

First step: `explain` for row-level read/write on a flat entity, then inherit chains, then field capabilities — each layer directly retiring a class of past bugs.

### 5. Un-defer DECISIONLOG #75: authoritative simulation entities + reducer-aware compaction

**Axes:** Declaration & entity API / Event log & persistence · **Sources:** assumption #13 + crossdomain #5 (verifier rated both "sound, strong"; two halves of one decision) · **Confidence:** high · **Complexity:** high

DECISIONLOG #75 defers the durable-coalesced log pending "a REAL high-frequency persisted consumer" — quoted verbatim and verified. That consumer already exists in-repo: space-invaders' authoritative game loop "writes to DB every frame — catastrophic at 30 Hz," and its PAIN-POINTS notes the tick-as-primary-author pattern "has no API form. Without tick, the game collapses to setInterval outside the framework (second pathway, violating the singular-system principle)."

- **Simulation entities**: a declared `simulation: { hz, step(state, inputs) => events }` slot — the framework owns the loop under a system principal, holds working state as an ephemeral in-memory projection, broadcasts through the paced fanout, and persists coalesced checkpoint rows at a declared cadence (Figma's model: ephemeral per-tick state, periodic checkpoints).
- **Reducer-aware compaction**: the policy question #75 leaves open has a principled answer the codebase already legislated — #189 rules coalesced snapshots lawful "ONLY when the field kind's reducer IS replace." So compact replace-reducer events per (scope, field), retain full op history for CRDT/log kinds, and write periodic keyframe rows so recovery replays from the nearest keyframe instead of origin. The lawfulness rule becomes the compaction engine's type system.

First step: this is literally the reopening decision #75 asks a future meeting to make — schedule it, arriving with the in-repo consumer and the reducer-dispatch policy shape.

### 6. `workbench types` — index.d.ts as a projection of the declaration

**Axis:** Declaration & entity API · **Sources:** leverage #4 (evidentiary depth) + assumption #14 (forcing argument), inversion #2 folded in · **Confidence:** high · **Complexity:** medium

Verified: index.d.ts (156 lines) types only the imperative handler chain — "NO type surface at all for `entity()`, field constructors, typed field handles, grant/scope/checks, or effects." The declarative DSL — the product — is invisible to the majority-TypeScript audience. The forcing argument: because the DSL is fields-less and field names are app data, static ambient typing is *structurally impossible*; per-app generation is the only honest path. And the compiler already holds the complete model — `entity/compile.mjs` validates every field name, type, check name, and reserved collision at load time.

Emit a per-app `.d.ts` from compiled declarations: typed field handles (`Todo.owner.is(...)`), per-verb dispatch payloads, grant/check name unions, typed client store. Zero-dependency holds (string emission from data in hand). Side effect: SPEC-vs-impl drift becomes mechanically detectable, because the generated surface *is* the implementation (the existing drift — SPEC promises `enum`/`set`/`derived`; none ship — would have been caught).

First step: decide build-artifact vs boot-artifact emission; prototype on the todo exemplar.

### 7. Field strategies declare their algebra — undo, coalescing, and merge become derivations

**Axis:** Declaration & entity API · **Sources:** leverage #2 (standalone; verifier: "best-argued idea in this file") · **Confidence:** medium-high · **Complexity:** medium

Three verified facts, one missing contract: `field-strategy.mjs` self-describes as "a CLOSED set… SPEC §5.1's 'open registry' is aspirational"; DECISIONLOG #75/#189 make coalescing lawful only for replace-reducers; SPEC §7.3 reserves an `inverse` slot on field plugins — reserved, unused. Undo needs invertibility, durable coalescing needs replace-law, CRDT merge needs commutativity, pace needs coalescibility — all algebraic properties of a field strategy, currently encoded as scattered special cases and deferred stubs.

Extend the STRATEGIES contract so each kind declares its laws (invertible / coalescible / commutative-merge / idempotent), and *derive* undo (feeding survivor 2), the #75 durability slice (feeding survivor 5), delta broadcast, and CRDT admission from the declared laws. This is also the honest road to the promised open registry: a plugin registers by declaring its algebra, and everything downstream already knows what to do with it. Completes the binding value — fields owning not just persistence/sync/events but their *laws*. (Small rider absorbed here: the genuinely-missing `append`/`push` template operators for log/array fields — the surviving half of the refuted arithmetic pain point.)

First step: write the law declarations for the existing closed set descriptively (no behavior change), then make undo the first derivation consumer.

---

## Rescoped or rejected by verification

- **Effect-template arithmetic / counter-as-ledger** (pain-friction #2, inversion #5, crossdomain #1): shared premise refuted — `inc()`/`dec()` already ship in `src/effect-compiler.mjs` (P6b), doing read-modify-write against the target's current value; single-writer serialization already makes increments race-free. Surviving remnant (append/push for log/array) folded into survivor 7.
- **The scope is the shard** (assumption #10): weak — verified that effects routinely target a *different* scope than their trigger and join the same transaction (the common case for effect-bearing apps), so per-scope DB files would need cross-shard atomicity for the majority path, not the edge case the idea treats it as.

## Sound but not selected (recorded for later)

Quick wins worth filing independently of this ranking: **WS close-handshake server fix** (pain-friction #6 — the client ships a permanent watchdog for our own server bug; verified verbatim) and **PAIN-POINTS as an executable ledger** (assumption #16 — the verifier *independently* caught live drift: google-photos claims no `json` field type exists while `field.mjs:91` implements it).

Held for after survivors land: declarative grants/capability maps (pain-friction #1, inversion #1 — revisit after the explain/conformance work maps the territory), macaroon share links (crossdomain #8), tile decomposition for raster/polyline (crossdomain #2), credit-based flow control (crossdomain #3) and cursor-race delivery (assumption #5 — both feed the same backpressure decision), scope-AST lowerings to fanout/client (leverage #1, assumption #11, leverage #7), isomorphic client pipeline (assumption #1 — enabled by survivor 2), declaration-diff migrations (assumption #2), one-writer-N-followers (assumption #9), admin-surface-as-workbench-app (assumption #15), mayRow/rowCapabilities unification (pain-friction #4 — subsumed by conformance fuzzing), check combinators (pain-friction #3), consumer-failure observability (pain-friction #7 — subsumed by survivor 1).

## Working artifacts

Full evidence trail (dossiers, per-frame idea files, verifier report, checkpoints) in the session scratchpad `ce-ideate-run/`; the verifier's ~20 targeted repo reads and per-candidate verdicts are in `verifier-report.md` there.

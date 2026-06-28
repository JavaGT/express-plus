# express-plus — Implementation Plan

The roadmap for closing the stress-test gaps surfaced by the 9-domain v2
implementer reports (`projects/*/PAIN-POINTS.md`; see
`projects/STRESS-TEST-FINDINGS.md`) and adjudicated by a two-model judge
council (Opus + GPT-5.5, ~80% structural convergence; see DECISIONLOG.md
ADRs #9–#16). This is the authoritative, dependency-ordered plan.

All code in this repo is **idealized design exemplar** — files import from
`express-plus`, a package that does not exist as runnable code. The plan
describes the design surfaces the framework must provide so the exemplars
are honest about the API they assume.

---

## Headline

The lead's original six-item to-do list was sound in substance but
**under-grouped in structure**: the six items are four designs plus
vocabulary. Three collapse into one primitive (the mutation pipeline owned by
the field-type plugin); two more collapse into one (the principal model +
grant compilation). The lead's `findAll`-before-principal ordering was
**inverted**: a compiled `WHERE` cannot be expressed without a principal to
express it in terms of.

Re-testing the plan against the original pain points surfaced a **fifth
unifying abstraction** (typed-FK traversal in the authorization compiler)
and reversed one deferral (per-subscriber delivery scoping). Both are
non-optional: each is an early decision that, left wrong, poisons a later
phase.

---

## The five unifying abstractions

1. **The mutation pipeline, owned by the field-type plugin.**
   `validate → access → apply → diff → persist|ephemeral → emit`. Every
   mutation *source* — REST, WebSocket, `tick`, `.batch()`, a `state`
   transition, a `state.effect`, a stored-derived recompute — feeds the SAME
   pipeline, attributed to a principal, re-authorizable, emitting through the
   normal event grammar. This collapses the plugin mutation contract,
   `validate`, batch, tick, `state.effects`, ephemeral persistence, and
   stored-derived into one primitive. No `on(app)`, no `afterSave`, no second
   live path.

2. **The uniform principal**, feeding `grant` / `queryScope` / latched-auth.
   One principal shape `{ id, type: 'user'|'link'|'system'|'anonymous',
   attributes }`. The union is **closed** — domain identities (Patron, Reader,
   Player) are sub-account entities owned by `User` via a typed FK, not new
   principal types. A `User` may own multiple sub-accounts. Collapses
   `findAll` grant, non-user principals (link-share), anonymous public-read,
   and latched subscribe-time auth into one design.

3. **Declarative reactions** = mutations triggered by mutations. `state.effects`
   and stored-derived are the SAME primitive — "when X mutates, mutate Y
   through the pipeline" — declared, not callback'd. The engine compiles
   them; the app never mounts them. One primitive `{ mutate: <target>, with:
   <data-template> }` (target = self or a typed entity handle; the engine
   decides set vs create from whether the target row exists). Typed handles
   throughout (trigger, target, path-refs) — a prerequisite for static cycle
   detection. Reentrancy is BOUNDED (structural cycle = load-time error; runtime
   depth cap = fail-closed backstop). A cross-entity effect re-enters the one
   pipeline in the SAME transaction + composed event as the origin (target
   grant/validation failure rolls back the origin); it runs as a bounded
   EFFECT PRINCIPAL authorized against the target's own grant. Composed event
   is atomic for commit, per-fragment per-subscriber for delivery (re-auth-at-
   emit, ADR #5). See DECISIONLOG.md.

4. **Scheduled mutation** = a timer feeding the pipeline. Two public nouns —
   `schedule.at(dateField)` / `schedule.after(anchor, delay)` for one-shot
   deadlines (library overdue, blog scheduled-publish) and `tick.hz(n)` /
   `tick.every(...)` for recurring loops (the 20–30Hz game loop) — because a
   deadline and a recurring loop are different things. `state.auto` and entity
   TTL are sugar over them. Both attribute mutations to a bounded scheduler/tick
   principal (not the ambient SYSTEM god) through the pipeline, admitted by the
   target's own grant via `effectSource(handle)`. The `while` discovery
   predicate MUST be indexed (non-compilable = load-time error); empty `while`
   is forbidden for row-set ticks.

5. **Typed-FK traversal in the authorization compiler.** The queryScope/grant
   compiler follows typed foreign-key *paths*, not just direct-column
   equality. This single machinery serves three of the original pain points:
   principal→domain-identity binding (User↔Patron), parent-grant inheritance
   (Post→Comment), and keyed-member uniqueness (`map(ref('User'), value)`).
   The authorization-side analog of the mutation pipeline: one compiler, one
   traversal mechanism, never hand-rolled.

---

## Load-bearing guards (reject at entity-load)

Each of these is the `on(app)` second path reborn. The framework rejects them
at entity-load time, not as a style preference.

- **Tick mutates THROUGH the pipeline, never bypasses it.** Ephemeral
  persistence is a field-type *property* the pipeline respects, not an
  out-of-band diff.
- **`queryScope` is DERIVED from `grant`, never separately declared.** A
  second declaration drifts from `grant` → leaks + broken pagination.
- **`effects` are declarative `{ mutate, with }` only.** No
  `async () => sendEmail()`, no `afterSave`/`onCreate`. Cross-entity targets are
  allowed — they re-enter the one pipeline as a bounded effect principal in the
  same transaction, not an imperative callback. `with` carries field-plugin
  operators (`inc`/`append`/`insertAt`/`move` — no new effect grammar); `when`
  guards are typed predicates (non-compilable = load-time error). Every declared
  cross-entity effect must have a matching `effectSource(handle)` admitting check
  on its target, verified at load time (missing admit = load-time error, not
  runtime rollback). A structural effect cycle is a load-time error; a runtime
  depth cap aborts the batch. (A cross-store effect target is a load-time error
  — it cannot share one DB transaction.)
- **`is.*` thenable + runtime unawaited-call guard.** Awaitable alone is
  insufficient: `is.author() || is.blogOwner()` on two pending promises returns
  the first truthy promise (both are truthy objects) → silently grants to
  everyone. The engine throws if `grant`/`access` returns while an `is.*` call
  is unawaited (static analysis cannot catch `a || b` on thenables).
- **`batch()` is the pipeline run in a transaction emitting one composed
  event**, NOT a new "batch emit" code path.
- **Split ephemeral-FIELD from ephemeral-ENTITY.** Ephemeral is a field
  persistence strategy (a persisted Match can host ephemeral fields — exactly
  what games need); TTL/ephemeral-entity is an entity-lifecycle concern.
- **Live delivery is NOT a grant axis.** Grant is exactly `scope(...).can(...)`
  — two halves on a performance boundary, no third sibling method. Delivery is
  (1) re-authorization via the *same* scope+can engine re-run at emit (hard gate,
  latched for scale, no second auth path), then (2) subscriber **interest** as a
  narrowing-only post-filter. Interest is data-not-code (a typed constraint over
  plugin-published event coordinates, validated at subscribe time, indexable),
  runs only after re-auth, and is structurally incapable of widening the
  authorized set. If the app filters post-delivery with free-form code, the
  second live path ships permanently.
- **Grant inheritance is declared** (`inherit`/`via`) and compiled through
   typed FKs; never hand-copied parent read-scope logic in child `checks`.
- **Prefer keyed-field membership** (uniqueness-by-construction) over a join
  entity + compound constraint, when a collection is owned by one side.

---

## The grant halves (Design B, refined)

`grant` decides two distinct things, split on a *performance* boundary — not on
a visibility axis. There is no third method.

- **`scope(...)` — read admission** (may this principal *read* this row?) — the
  ONLY grant compiled to SQL. Declares read *intent* by calling plain-function
  checks; the compiler *derives* whether those checks are SQL-compilable.
  Built from owner-FK equality (incl. typed-FK traversal), `state`/`enum`
  equality, and membership in an on-entity `set`. Read intent is **declared,
  never derived from compilability** ("can compile" must not auto-admit a read —
  an `archived` fact compiles but must not be world-readable). A check used in
  `scope` that cannot compile is a **load-time error**, never a warning, never a
  silent JS fallback.
- **`.can(...)` — every other capability** (write / admin / subscribe / …) —
  may be **async**, may consult cross-entity checks (`is.projectManager()`).
  Decided per-row at runtime; post-filters the rows `scope` already admitted. May
  call non-compilable checks freely.

Live delivery does **not** add a third method here. See DECISIONLOG.md.

---

## Roadmap

### Phase 0 — Auth-safety gate (~1 wk, blocks all auth)
- `is.*` thenable + unawaited-call runtime guard.

### Phase 1 — Spine, blog end-to-end (~4–6 wk; correctness, low frequency)
Prove right before fast. Blog exercises the correctness surface across all
six original items: state machine, scheduled publish, `findAll` leak,
async-`is.*`, anonymous public-read, compound uniqueness, subscriber-notify-as-effect,
plus parent-grant inheritance (Blog→Post→Comment).

1. **Field-type plugin contract + mutation pipeline.** `[LARGE — the
   irreversible design]` The plugin declares persistence strategy
   (`persisted`|`ephemeral`), scope (`entity`|`connection`), authority
   (`user`|`server`), mutation operators + their diffs, optional `inverse`
   (undo reservation), optional `validate(value, ctx)` hook, and a published
   event-coordinate schema (so subscriber interest can be validated/indexed).
2. **Principal model** `{ user|link|system }`. `[small]`
3. **`queryScope` derivation from `grant` + typed-FK traversal compilation.**
   `[narrow compiler change, depends on 2]` Compiles owner-FK equality,
   `state`/`enum` equality, `set` membership, AND typed-FK traversal paths
   (P4: User↔Patron) AND grant inheritance (P5: Post→Comment) into an exact
   WHERE. A check used in `scope` that cannot compile is a **load-time
   error**, not a warning.
4. **`state` + `enum` + `boolean` + valued-set (`map`) built-in plugins.**
   `[medium]` `state` owns transitions + `effects` (declarative mutations) +
   `auto` (field-level scheduler for scheduled publish / overdue). The `map`
   plugin dissolves the separate-Vote-entity pattern (keyed-member
   uniqueness-by-construction).
5. **`validate` as a pipeline stage.** `[free — falls out of the contract]`
6. **`anonymous` principal + `everyone()` + per-verb route gate**
   (`r.resource({ gate: { list: allowAnonymous(), create: requireUser() } })`)
   `[~10 lines]`; **`unique`** single-field constraint `[~1 wk]`;
   **`.and`/`.not`/`.is`/`.in`/`.isNull`** predicate operators
   `[~1 wk, declared per plugin]`; **`grant: inherit(Parent)`** /
   `owner: via(Parent.owner)` compiled through typed FKs. (`publicRead` entity
   flag is dead — replaced by `anonymous` + `everyone()` + per-verb gate.)

### Phase 2 — Realtime, space-invaders end-to-end (performance)
Prove the abstractions are fast, not just right.

7. **Live delivery** — `subscribe(Entity, id, { fields, pace })` + field-keyed
   interest (AND across dimensions; per-dim `range`/`.in`/`.is`; no cross-dim OR)
   + two-layer pace (plugin publishes lawful coalescer; subscriber selects within
   bounds) + re-authorization at emit (latched). `[must precede delta-broadcast]`
8. **Ephemeral persistence + scope/authority** in the contract (already
   reserved in step 1; now exercised).
9. **`tick.hz` / `tick.every`** — recurring loops, through the pipeline, as a
   bounded scheduler/tick principal admitted by the target grant. NOT
   lifecycle-bound to `state` transitions (the always-on entity foot-gun); gated
   by an indexed `while` predicate instead. `schedule.at`/`schedule.after`
   one-shot deadlines also land here (library overdue, blog scheduled-publish).
10. **Latched subscribe-time auth** — cached `grant`, invalidated by
    subscription-invalidating events (roster change, share revocation).
11. **Per-field-type delta broadcast** — diff-driven, not full-value.
12. **`blob` + `list` (ordered) + `json` built-in plugins; batched mutation**
    (pipeline transaction, single composed event). `list` uses a fractional-
    index keyspace for atomic `insertAt`/`move`/`reorder` (deletes the
    map-as-ordered-array fake 5 apps hand-roll).

### Phase 3 — Round-out
13. **`.gte`/`.lte`/`.lt`/range + cursor pagination** (needs exact queryScope
    from step 3; rank index + cursor token — narrow but non-trivial).
14. **Stored computed fields** — TWO named modes (ADR #12):
    `projected.inline` (in-transaction, transactionally consistent — `hotRank`,
    covered by ADR #6) and `projected.async` (post-commit projection —
    thumbnails, search-index embeddings for scope; explicitly stale, never
    rolls back the origin, written through a bounded projection principal
    admitted by the target grant). `derived` stays pure read-time pull.
15. **Tree traversal** — `findTree()` on self-referential `ref`s, compiled to a
    recursive CTE (FK-aware, row `scope` in the WHERE). NOT a query-language
    extension.
16. **Compound uniqueness** (for cases that genuinely can't be a keyed field);
    **`.isNull()`** query predicate (distinct from `.is(undefined)`=FALSE);
    **`ephemeral({...})` with commit-semantics** (accumulate-then-promote via
    a declarative commit-reaction — dissolves the active-construction case,
    e.g. drawing-canvas in-progress stroke); **entity TTL** (sugar over
    `schedule.at`).
17. **Ergonomic modifiers**: `setOnce`, `role: author` auto-populate
    (generalized `from: principal.user` beyond `role:'owner'`),
    `entryCan(entry, principal)` on collection fields, `ownerOnly({caps})`
    shorthand, `inherit(...).through(...)` multi-hop chains.

### Deferred / plugin territory
- **Geo / full-text search engines** — the predicate-plugin SEAM ships now
  (`.near()`/`.match()` index-gated, never raw SQL); the rtree/FTS engines
  defer until google-photos is the active spine (build the seam, not the
  subsystem).
- **Arbitrary-query fan-out + `recomputeFrom(query)` in effects** — beyond
  ADR #6's "data interpolated only from trigger delta + origin row" bound
  (cardinality becomes a runtime query result = unbounded-fixpoint door);
  deferred until an app proves it needs it AND a safety case extends the ADR.
- **Custom CRDT-authoring toolkit** — ship `text.crdt`/`polyline`/`raster` as
  proof; do not build a CRDT-authoring DSL (proactive ≠ exhaustive).
- **Spatial event scoping** (game-specific; needs a framework-level go/no-go
  before design begins).
- **Batch-load endpoints** (dissolve into the plugin registry — a custom field
  type owns its loading protocol).

---

## Pain-point adjudication (P1–P7)

The plan was re-tested against 7 selected pain points from the original
implementer reports. Ranked by threat to the plan:

1. **P1 — Spatial/delivery scoping (minecraft BLOCKER #2).** ADD — overturn
   the deferral. Deferring forces a second live path *today*. Delivery is NOT
   a third grant axis (grant stays `scope(...).can(...)`); reserve the
   emit-stage re-auth + interest hooks in Phase 1, implement Phase 2 before
   delta-broadcast.
2. **P4 — User↔Patron identity binding (library CONCERNING).** MODIFY Phase 1
   — queryScope must compile typed-FK traversal paths, not just direct-column
   equality, or pagination silently breaks for indirect-ownership apps.
3. **P5 — Parent-grant inheritance (blog SHOULD-FIX).** ADD Phase 1 —
   declarable `grant: inherit(Post)` compiled through the same FK-traversal
   machinery as P4. Needed by the blog spine. Reject hand-copied parent
   read-scope at entity-load.
4. **P3 — Valued sets + compound uniqueness (reddit BLOCKER #2).** ADD small —
   a `map` plugin (valued set, keyed-member uniqueness-by-construction)
   dissolves the separate-Vote-entity pattern. Standalone compound uniqueness
   demoted (Phase 3) because the plugin dissolves the common case.
5. **P7 — presence→ephemeral active construction (drawing-canvas BLOCKER #1).**
   REFRAME → MODIFY — not two constructs; one `ephemeral` field with declarable
   **commit-semantics** (accumulate-then-promote via a declarative reaction).
   Folded into Design A (scope) + Design C (commit reaction). Phase 3.
6. **P2 — RPC/intent vs mutation (space-invaders).** REFRAME → KEEP — intents
   are mutations with a **server-authored `apply`** that may reject. Already
   covered by `authority: 'server'` operators. Reject the `commands: log()`
   workaround as the `on(app)` smell. Strengthens the singular-system claim.
7. **P6 — Undo/redo (photo-editor, drawing-canvas SHOULD-FIX).** KEEP
   deferred — per-client undo is a client-SDK concern; shared undo is inverse
   mutations through the pipeline (operators optionally declare an `inverse`).
   Reserve the `inverse` slot in the Phase 1 operator contract; do not build a
   pipeline-level undo log (competing truth = singular-system violation).

---

## Spine-app selection

- **Phase 1 spine: blog-platform.** Correctness, low frequency. Exercises the
  state machine, scheduled publish, `findAll` leak, async-`is.*`, anonymous
  public-read, compound uniqueness, subscriber-notify-as-effect, AND parent-grant
  inheritance — the full Phase-1 surface at human speed.
- **Phase 2 spine: space-invaders.** Performance. Exercises ephemeral
   persistence, 30Hz `tick.hz`, latched-auth, delta-broadcast, live delivery.

Prove right before fast.
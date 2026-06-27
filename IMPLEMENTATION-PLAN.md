# express-plus — Implementation Plan

The roadmap for closing the stress-test gaps surfaced by 8 implementer
reports (`projects/*/PAIN-POINTS.md`) and adjudicated by a council review
(DS Pro / DS Flash / GLM-5.2, judged by Opus 4.8, then re-tested against the
original pain points). This is the authoritative, dependency-ordered plan.

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
   One principal shape `{ id, type: 'user'|'link'|'system', attributes }`.
   Collapses `findAll` grant, non-user principals (link-share), and
   latched subscribe-time auth into one design.

3. **Declarative reactions** = mutations triggered by mutations. `state.effects`
   and stored-derived are the SAME primitive — "when X mutates, mutate Y
   through the pipeline" — declared, not callback'd. The engine compiles
   them; the app never mounts them.

4. **Scheduled mutation** = a timer feeding the pipeline. `state.auto`
   (field-level, conditional) and entity `tick` (recurring) are the same
   mechanism at two granularities. Both attribute mutations to a system
   principal through the pipeline.

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
- **`state.effects` are declarative mutations only.** No
  `async () => sendEmail()`, no `afterSave`/`onCreate`.
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
- **Delivery scope is a THIRD grant axis** (visibility / capability /
  delivery), evaluated at emit, never outside the entity. If the app filters
  post-delivery, the second live path ships permanently.
- **Grant inheritance is declared** (`inherit`/`via`) and compiled through
  typed FKs; never hand-copied parent-visibility logic in child `checks`.
- **Prefer keyed-field membership** (uniqueness-by-construction) over a join
  entity + compound constraint, when a collection is owned by one side.

---

## The grant axes (Design B, refined)

`grant` decides three distinct things. The plan originally named two; the
pain-point re-test added the third.

- **Visibility** (row-visible-at-all?) — must be **compilable** to an exact
  `WHERE` so pagination is exact. Built from owner-FK equality (incl. typed-FK
  traversal), `state`/`enum` equality, and membership in an on-entity `set`.
  Non-compilable visibility → entity-load warning that exact pagination is
  impossible.
- **Capability** (read vs write vs subscribe vs admin?) — may be **async**,
  may consult cross-entity checks (`is.projectManager()`). Post-filters the
  rows visibility already admitted.
- **Delivery** (which admitted subscriber receives which event?) — a
  per-subscriber, per-event predicate evaluated at emit. Distinct from
  visibility (a player may *eventually* see a far chunk if they walk there)
  and capability (they have read). The subscriber supplies an interest
  declaration; the field-type plugin declares which event coordinates the
  predicate may filter on. Reserved in Phase 1's emit-stage contract;
  implemented in Phase 2 *before* delta-broadcast.

---

## Roadmap

### Phase 0 — Auth-safety gate (~1 wk, blocks all auth)
- `is.*` thenable + unawaited-call runtime guard.

### Phase 1 — Spine, blog end-to-end (~4–6 wk; correctness, low frequency)
Prove right before fast. Blog exercises the correctness surface across all
six original items: state machine, scheduled publish, `findAll` leak,
async-`is.*`, `publicRead`, compound uniqueness, subscriber-notify-as-effect,
plus parent-grant inheritance (Blog→Post→Comment).

1. **Field-type plugin contract + mutation pipeline.** `[LARGE — the
   irreversible design]` The plugin declares persistence strategy
   (`persisted`|`ephemeral`), scope (`entity`|`connection`), authority
   (`user`|`server`), mutation operators + their diffs, optional `inverse`
   (undo reservation), optional `validate(value, ctx)` hook, and an
   emit-stage per-subscriber delivery-predicate hook (reserved).
2. **Principal model** `{ user|link|system }`. `[small]`
3. **`queryScope` derivation from `grant` + typed-FK traversal compilation.**
   `[narrow compiler change, depends on 2]` Compiles owner-FK equality,
   `state`/`enum` equality, `set` membership, AND typed-FK traversal paths
   (P4: User↔Patron) AND grant inheritance (P5: Post→Comment) into an exact
   WHERE. Non-compilable visibility → entity-load warning.
4. **`state` + `enum` + `boolean` + valued-set (`map`) built-in plugins.**
   `[medium]` `state` owns transitions + `effects` (declarative mutations) +
   `auto` (field-level scheduler for scheduled publish / overdue). The `map`
   plugin dissolves the separate-Vote-entity pattern (keyed-member
   uniqueness-by-construction).
5. **`validate` as a pipeline stage.** `[free — falls out of the contract]`
6. **`publicRead`** entity flag `[~10 lines]`; **`unique`** single-field
   constraint `[~1 wk]`; **`.and`/`.not`/`.is`/`.in`** predicate operators
   `[~1 wk, declared per plugin]`; **`grant: inherit(Parent)`** / `owner:
   via(Parent.owner)` compiled through typed FKs.

### Phase 2 — Realtime, space-invaders end-to-end (performance)
Prove the abstractions are fast, not just right.

7. **Delivery scoping** — per-subscriber emit predicate (P1). `[must precede
   delta-broadcast]`
8. **Ephemeral persistence + scope/authority** in the contract (already
   reserved in step 1; now exercised).
9. **Entity-level `tick`** — recurring, lifecycle-bound to `state`
   transitions, through the pipeline, system principal.
10. **Latched subscribe-time auth** — cached `grant`, invalidated by
    subscription-invalidating events (roster change, share revocation).
11. **Per-field-type delta broadcast** — diff-driven, not full-value.
12. **`blob` + `array` built-in plugins; batched mutation** (pipeline
    transaction, single composed event).

### Phase 3 — Round-out
13. **`.gte`/`.lte`/`.lt`/range + cursor pagination** (needs exact queryScope
    from step 3; rank index + cursor token — narrow but non-trivial).
14. **Stored-derived** = `state.effects` primitive (source-triggered recompute,
    persisted + indexed). `[the genuinely large async-pipeline design —
    deferred deliberately]`
15. **Tree traversal** — a single `loadTree()` helper on self-referential
    `ref`s. NOT a query-language extension.
16. **Compound uniqueness** (for cases that genuinely can't be a keyed field);
    **`ephemeral({...})` with commit-semantics** (accumulate-then-promote via
    a declarative commit-reaction — dissolves the active-construction case,
    e.g. drawing-canvas in-progress stroke); **entity TTL**.
17. **Ergonomic modifiers**: `setOnce`, `role: author` auto-populate.

### Deferred / plugin territory
- Full-text search; geo / spatial predicates.
- Spatial event scoping (game-specific; needs a framework-level go/no-go
  before design begins).
- Batch-load endpoints (dissolve into the plugin registry — a custom field
  type owns its loading protocol).

---

## Pain-point adjudication (P1–P7)

The plan was re-tested against 7 selected pain points from the original
implementer reports. Ranked by threat to the plan:

1. **P1 — Spatial/delivery scoping (minecraft BLOCKER #2).** ADD — overturn
   the deferral. Deferring forces a second live path *today*. Delivery is a
   third grant axis; reserve the emit-predicate hook in Phase 1, implement
   Phase 2 before delta-broadcast.
2. **P4 — User↔Patron identity binding (library CONCERNING).** MODIFY Phase 1
   — queryScope must compile typed-FK traversal paths, not just direct-column
   equality, or pagination silently breaks for indirect-ownership apps.
3. **P5 — Parent-grant inheritance (blog SHOULD-FIX).** ADD Phase 1 —
   declarable `grant: inherit(Post)` compiled through the same FK-traversal
   machinery as P4. Needed by the blog spine. Reject hand-copied parent
   visibility at entity-load.
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
  state machine, scheduled publish, `findAll` leak, async-`is.*`, `publicRead`,
  compound uniqueness, subscriber-notify-as-effect, AND parent-grant
  inheritance — the full Phase-1 surface at human speed.
- **Phase 2 spine: space-invaders.** Performance. Exercises ephemeral
  persistence, 30Hz tick, latched-auth, delta-broadcast, delivery scoping.

Prove right before fast.
# express-plus Findings — the reconciled synthesis

This is the single findings document for express-plus. It reconciles two bodies
of evidence:

- **The 9-app stress test** (post-grill): nine implementers, each with a
  project-aligned persona, attempting real apps against the grilled API. Per-app
  evidence stays in `projects/<name>/PAIN-POINTS.md` (linked per gap below); this
  document is the lead's synthesis across all nine.
- **The `scope` workbench mining** (`../SCOPE-FINDINGS.md`): what a real, shipped
  event-sourced collaboration framework proves is *buildable*, and which of its
  disciplines and debts express-plus inherits or avoids.

Every resolved gap maps to an ADR in `../DECISIONLOG.md` and is specified in
`../SPEC.md`. **There are 15 ADRs (#1–#15).** Earlier drafts of this document
cited "#9–#16" and mis-numbered subscribe-interest as #15 and the query engine as
#16; the correct numbers are used throughout below (subscribe-interest = **ADR
#14**, query predicates = **ADR #15**).

**Projects & lenses:** minecraft (Framework Extender), space-invaders (Game Loop
Engineer), photo-editor (Pixel Pusher), google-photos (Storage Architect),
library (Bureaucrat), reddit (Social Scale Engineer), drawing-canvas (Realtime
Artist), blog-platform (Publisher), todo (Pragmatist).

---

## Part A — The stress test proved the design holds

### The meta-finding

The grill **held**. Every domain confirmed the authorization model is sound where
it applied: `withheld` cleanly expresses the library's "patron sees `dueDate` but
not `currentHolder`" asymmetry; the two-questions model (read vs edit) absorbs
field-level confidentiality with no second axis; `scope` + `.can` scales to 60Hz
latched auth; undo-via-inverse-mutations works. ADR #7's no-default-grant is
honest ceremony, not a regression — `scope(is.owner())` is what you'd write
anyway.

What the grill left open were gaps it never touched — it was an **authorization**
grill. The open gaps are about **data shape, time, and delivery**, and reduce to
four load-bearing absences the judge council (Opus + GPT-5.5) resolved with ~80%
structural convergence:

1. **Field types were a closed catalog** — `text/number/boolean/state/map/set/log/ref`
   plus a privileged `text.crdt()` special case could not express a minecraft
   chunk (~4913 internally-keyed sub-records), a raster/polyline CRDT, or an
   atomic-reorder ordered list. → **ADR #9** (open registry, four named-whole
   kinds).
2. **There was no time-driven mutation source** — `state.auto` is a fixed
   duration from state-entry; it cannot express "overdue at `dueAt`" or a 20Hz
   game loop. → **ADR #10** (`schedule.*` + `tick.hz`, one pipeline source).
3. **Subscribe had no invocation surface** — ADR #5 defined interest as
   data-not-code narrowing, but no client `subscribe()` existed and backpressure
   was undesigned. → **ADR #14** (field-keyed interest, two-layer pace).
4. **Effects were set-only** — `{ mutate, with }` could not `inc`, `append`, or
   fan-out. → **ADR #13** (field-plugin operators, bounded fan-out).

The principal-model and query gaps (anonymous public-read, domain identities,
tree traversal, geo/full-text) round out the set — resolved at **ADRs #11 and
#15**.

### What the grill RESOLVED (confirmed by all 9 reports; did NOT recur)

These were v1 BLOCKERs that the grill + ADRs #1–#8 closed:

- **Hide/visibility axis** — gone (ADR #1). `withheld` + absent-vs-forbidden
  covers it. Library is the proof: field confidentiality needs no second axis.
- **`admits(...)` / list-query grant** — gone (ADR #2). `scope` compiles to a
  pagination-safe SQL `WHERE`; no JS fallback, no archived-row leak.
- **Async `is.*` foot-gun** — the Phase 0 guard catches it. No report tripped it.
- **High-frequency re-auth cost** — the latched grant cache (ADR #5) holds at
  60Hz (drawing-canvas) and 30Hz (space-invaders).
- **`inherit`** — typed-FK grant inheritance works for comments/todos.
- **Effects as in-transaction reactions** — `{ mutate, with }` is the right home
  for notify-subscribers / start-game-loop; the v1 "afterSave" instinct did not
  recur.

---

## Part B — Root-cause gaps (TIER 0, resolved this round)

### B.1 Field-type plugin contract — RESOLVED (ADR #9)

**Hit by:** minecraft (chunk BLOCKER), photo-editor (raster.crdt, blob),
drawing-canvas (polyline.crdt), space-invaders (grid), google-photos (blob, EXIF
json), + 5 apps needing ordered lists (minecraft layers, photo-editor layers,
drawing-canvas shapes, library holds queue, todo subtask order).
Evidence: [minecraft](minecraft/PAIN-POINTS.md), [photo-editor](photo-editor/PAIN-POINTS.md),
[drawing-canvas](drawing-canvas/PAIN-POINTS.md), [google-photos](google-photos/PAIN-POINTS.md).

**Resolution:** one open registry, **four named-whole contracts** distinguished
by genuinely distinct diff + index + inverse machinery: `fieldType.value`
(single value, incl. `blob`/`json`), `fieldType.store` (internally-keyed
collection with per-key diff + index + range query — what `map` could not be),
`fieldType.crdt` (custom merge — `text.crdt()` becomes one instance, deleting the
baked-in special case), `fieldType.ordered` (fractional-index keyspace for atomic
`insertAt`/`move`/`reorder` — earned by the deletion test; 5 apps hand-rolled the
"map-as-ordered-array fake"). **Coordinates are constructed from declared
indexes** (a coordinate takes `index.range([...])` as its constructor argument),
so an unbacked coordinate is *unrepresentable* — fail-closed one level early, no
hand-SQL trapdoor; the engine owns SQL. Custom CRDT-authoring toolkit deferred.
Specified in `../SPEC.md` §5.1.

### B.2 Scheduler / tick family — RESOLVED (ADR #10)

**Hit by:** minecraft (tick lifecycle conflated with `state.auto`), space-invaders
(BLOCKER: zero API for a recurring game loop), library (BLOCKER: overdue at
`dueDate`), blog (BLOCKER: scheduled publish), todo (reminders).
Evidence: [space-invaders](space-invaders/PAIN-POINTS.md), [library](library/PAIN-POINTS.md),
[blog-platform](blog-platform/PAIN-POINTS.md), [todo](todo/PAIN-POINTS.md).

**Resolution:** time-driven mutations are a typed **source** feeding the one
pipeline, with two public nouns (a deadline ≠ a recurring loop):
`schedule.at(dateField)` / `schedule.after(anchor, delay)` for one-shot deadlines;
`tick.hz(n)` / `tick.every(...)` for recurring loops. `state.auto` and entity-TTL
demote to sugar. Runs as a bounded scheduler/tick principal admitted by the target
grant via `effectSource(handle)` — the clock is a new trigger, never a new
authority. **Two scale guards both judges closed:** due-row discovery MUST be
indexed (a non-compilable `while` = load-time error, the tick-layer analog of a
non-compilable `scope`); tick durability is a field persistence-strategy decision
(ephemeral / coalesced-snapshot-with-seq-span / per-event). Empty `while` is
forbidden for row-set ticks (fail-closed). Specified in `../SPEC.md` §10.

---

## Part C — Structural gaps (TIER 1, resolved this round)

### C.1 Subscribe + interest + backpressure — RESOLVED (ADR #14)

**Hit by:** minecraft (BLOCKER: spatial interest, firehose), space-invaders,
drawing-canvas. Evidence: [minecraft](minecraft/PAIN-POINTS.md),
[drawing-canvas](drawing-canvas/PAIN-POINTS.md).

**Resolution:** `subscribe(Entity, id, { fields, pace })` is the client export.
Interest is field-keyed (a field not listed is pass-through); the grammar is AND
across dimensions, per-dimension one `range` OR one finite `.in([...])` (indexed
`IN` — categorically NOT the forbidden cross-dimension OR) OR `.is(v)`;
subscribe-time validation; reuses the sequence-cursor replay core. **Backpressure
is two-layer** (the one place Judge 2 beat Judge 1): the field-type plugin
publishes a lawful coalescer + seq-span reducer + named pace-profiles (data
semantics decide what's lawful to drop — position is loss-tolerant, block-edits
aren't); the subscriber selects `pace.coalesce({ window, by })` or a profile
within plugin-permitted bounds. Scalar fields default included; high-volume
collection fields OPT-IN (omission = not-subscribed, never a firehose). Specified
in `../SPEC.md` §8.

### C.2 Query engine — RESOLVED (ADR #15)

**Hit by:** reddit (tree, cursor + stored-rank), google-photos (geo, full-text),
library (compound unique), todo (tree). Evidence: [reddit](reddit/PAIN-POINTS.md),
[google-photos](google-photos/PAIN-POINTS.md), [library](library/PAIN-POINTS.md),
[todo](todo/PAIN-POINTS.md).

**Resolution:** `findTree` → recursive CTE over the declared self-FK (FK-aware,
row `scope` in the `WHERE`). Cursor pagination over compound keys. `.isNull()`
(query predicate, `IS NULL`) distinct from `.is(undefined)` (scope predicate, =
`FALSE`). `unique([f1,f2]).where(...)`. Geo/full-text as index-gated predicate
plugins — the seam ships now (no raw-SQL second path), engines defer until
google-photos is the active spine. Stored-derived splits into `projected.inline`
(transactionally consistent sort keys like `hotRank`) + `projected.async`
(post-commit projection — thumbnails, embeddings for the search index, the
build-now motivating case). Specified in `../SPEC.md` §11 and §5.3.

### C.3 Principal model — RESOLVED (ADR #11)

**Hit by:** reddit (anonymous), blog (anonymous + Reader identity), library
(Patron identity), space-invaders (spectator), todo. Evidence:
[reddit](reddit/PAIN-POINTS.md), [blog-platform](blog-platform/PAIN-POINTS.md),
[library](library/PAIN-POINTS.md), [space-invaders](space-invaders/PAIN-POINTS.md).

**Resolution (refined by the user's fork answer):** `anonymous` is a first-class
principal for unauthenticated public-read; `everyone()` is a compiled SQL `TRUE`
(NULL-safe); a per-verb route gate (`allowAnonymous()` / `requireUser()`) relaxes
only the route gate, the row grant always runs. **Domain identities**
(Patron/Reader/Player) are sub-account entities owned by `User` via a typed FK —
NOT new principal types (the union stays closed). A User may own MULTIPLE
sub-accounts (RuneScape: one sign-in → many character-accounts, each with own team
permissions). Every domain identity HAS an account (passwordless email-link login
is fine; no account-less "email user"). The framework hydrates the binding.
Specified in `../SPEC.md` §6.2.

### C.4 Effects grammar — RESOLVED (ADR #13)

**Hit by:** reddit (arithmetic, append, fan-out), blog (fan-out), photo-editor
(compute), space-invaders (conditional guard). Evidence:
[reddit](reddit/PAIN-POINTS.md), [blog-platform](blog-platform/PAIN-POINTS.md),
[photo-editor](photo-editor/PAIN-POINTS.md).

**Resolution:** `inc`/`dec`/`append`/`push`/`insertAt`/`move` are FIELD-PLUGIN
operators named in `with` (no new effect grammar — a deletion-test win). `when`
guards (typed predicate, non-compilable = load-time error). Explicit target-side
admission via `effectSource(handle)`, **verified at load time** (missing admit =
load error, not runtime rollback — the cycle-detector walks the typed graph).
Owned-collection fan-out NOW; typed `anyOf(...)` compound triggers NOW (finite,
cycle-detectable — NOT wildcards). DEFERRED: arbitrary-query fan-out +
`recomputeFrom(query)` (cardinality becomes a runtime query result =
unbounded-fixpoint door) and general arithmetic beyond inc/dec. Specified in
`../SPEC.md` §9.2.

---

## Part D — Sharp edges / maturity / ergonomics (TIER 2)

- **D.1 Typed-FK traversal in the scope compiler** — `is.staff()` /
  `is.blogOwner()` needs the compiler to follow principal→Patron→role /
  Post→Blog→owner chains → SQL JOINs. **Model sound; the gap is compiler
  maturity, not design.** Build now ([library](library/PAIN-POINTS.md) BLOCKER #1;
  without it, a separate `/catalog` route is a second auth path). Multi-hop via
  `inherit(...).through(...)` chains.
- **D.2 Per-entry field access** — `entryCan(entry, principal)` on collection
  fields (library holds: a patron sees their own entry). **Reject**
  `derived(row, principal)` — it confuses data derivation with authz/view shaping
  (both judges agreed).
- **D.3 `ownerOnly` shorthand** — `grant: ownerOnly({caps})` as an explicit
  declared function (never a magic default; no-grant is still a load-time error).
  [todo](todo/PAIN-POINTS.md) confirmed ADR #7's 5→20-line jump is honest ceremony
  for a privacy domain; the shorthand deletes boilerplate without universalizing.
- **D.4 `inherit` × field `.can`** — field `.can` OVERRIDES (not ANDs) the
  inherited row floor; multi-hop via `.through()`; add dev diagnostics for
  override-vs-additive.
- **D.5 Non-owner FK auto-populate** — generalize `from: principal.user` to
  `author`/`creator` (auto-derive the same-named check unless overridden).

---

## Part E — What `scope` proves is buildable (from SCOPE-FINDINGS.md)

The full mining is in `../SCOPE-FINDINGS.md`. The load-bearing conclusions:

- **The DX ceiling is reachable.** A realtime-collaborative feature page in scope
  is 30–80 lines, none of it event handling. express-plus, owning both the server
  routes and the client library, can absorb even the endpoint-URL ceremony scope
  could not (deriving URLs from the declared doc/room name).
- **The validated shape to build now:** branded Action/Event (non-optional
  reducer); the one dispatch pipeline (validate → resolve-scope → authorize →
  preimage → optimistic → dispatch → ingest); pure `resolveScope` so
  authorization runs *outside* the write transaction; sequence-cursor replay with
  a *hard-fail* on a stale cursor (never a silent truncate); bootstrap ordering
  (snapshot + cursor before the live stream) enforced structurally;
  preimage-restore undo plus inverse-event append (no second undo log);
  out-of-band effects as projections over the committed log (ADR #8). All
  specified in `../SPEC.md` §7–§9.
- **express-plus is already ahead on authorization.** scope's single biggest
  structural debt is *inline, per-handler ownership checks* (no `withOwnerOf`
  abstraction) — exactly what the `checks` + `scope(predicate).can(fn)` model
  eliminates. This is the strongest evidence the authorization model is worth its
  complexity. Do not regress into per-handler checks.
- **Debts NOT to carry over:** an identity wrapper that exists only to coax type
  inference; a no-op marker module that flips a persistence gate (make the engaged
  seam do real work — `../SPEC.md` §7.2); a dual source of identity (the server
  principal is the only identity); inconsistent event-name separators (pick one,
  lint it); two monotonic counters both labeled `seq` (name them distinctly).

---

## Part F — Genuinely deferred (no app needs it yet; proactive ≠ exhaustive)

- Custom CRDT-authoring toolkit (ship `text.crdt`/`polyline`/`raster` as proof).
- rtree/FTS engines (the predicate-plugin seam ships now; engines when
  google-photos is the spine).
- Arbitrary indexed-query fan-out + `recomputeFrom(query)` in effects (the ADR #6
  bound; deferred until an app proves it + a safety case extends the ADR).
- General arithmetic beyond `inc`/`dec`.
- Adaptive per-connection rate negotiation (fixed plugin coalescing ships first).

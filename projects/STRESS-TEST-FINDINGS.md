# express-plus Stress-Test Findings — v2 (9-domain synthesis, post-grill)

Nine implementers (each with a project-aligned persona) attempted real apps
against the **grilled** express-plus API — the design locked by ADRs #1–#8:
plain-function checks, `scope(...).can(...)` (two halves), field `.can`
strong-inherits the row grant, `withheld` markers, `{mutate,with}` bounded
effects, no default grant, and out-of-band effects as projections over the
committed log. This is the lead's synthesis across all nine reports — judged
for correctness and recurrence, grouped by LEVERAGE, citing the two-model judge
council (Opus + GPT-5.5) as evidence where their consensus resolved a gap.

**Projects & lenses:** minecraft (Framework Extender), space-invaders (Game
Loop Engineer), photo-editor (Pixel Pusher), google-photos (Storage Architect),
library (Bureaucrat), reddit (Social Scale Engineer), drawing-canvas
(Realtime Artist), blog-platform (Publisher), todo (Pragmatist).

Full per-project reports: `projects/<name>/PAIN-POINTS.md`. The judge council's
full R1 proposals + R2 mutual critique live in conversation history; the
resolved shapes are now ADRs #9–#16 in `DECISIONLOG.md` and glossary terms in
`CONTEXT.md`.

---

## The meta-finding (v2)

The grill **held**. Every domain confirmed the authorization model is sound
where it applied: `withheld` cleanly expresses the library's "patron sees
`dueDate` but not `currentHolder`" asymmetry; the two-questions model (read vs
edit) absorbs field-level confidentiality with no second axis; `scope`+`.can`
scales to 60Hz latched auth; undo-via-inverse-mutations works. ADR #7's no-
default-grant is honest ceremony, not a regression — `scope(is.owner())` is what
you'd write anyway.

What the grill left open were gaps it never touched — the grill was an
**authorization** grill. The v2 open gaps are about **data shape, time, and
delivery**, and they reduce to four load-bearing absences the judge council
resolved with ~80% structural convergence:

1. **Field types are a closed catalog** — `text/number/boolean/state/map/set/log/ref`
   plus the privileged `text.crdt()` special case cannot express a minecraft
   chunk (~4913 internally-keyed sub-records), a raster/polyline CRDT, or an
   atomic-reorder ordered list. → **ADR #9** (open registry, four named-whole
   kinds).
2. **There is no time-driven mutation source** — `state.auto` is fixed-duration
   from state-entry; it cannot express "overdue at `dueAt`" or a 20Hz game loop.
   → **ADR #10** (`schedule.*` + `tick.hz`, one pipeline source).
3. **Subscribe has no invocation surface** — ADR #5 defined interest as
   data-not-code narrowing but no client `subscribe()` existed; backpressure
   was undesigned. → **ADR #15** (field-keyed interest, two-layer pace).
4. **Effects are set-only** — `{mutate,with}` could not `inc`, `append`, or
   fan-out. → **ADR #13** (field-plugin operators, bounded fan-out).

The principal-model and query gaps (anonymous public-read, domain identities,
tree traversal, geo/full-text) round out the set — resolved at **ADRs #11, #16**.

---

## What the grill RESOLVED (confirmed by all 9 reports)

These were v1 BLOCKERs that the grill + ADRs #1–#8 closed. They did NOT recur:

- **Hide/visibility axis** — gone (ADR #1). `withheld` + absent-vs-forbidden
  (prod log / dev error) covers it. Library is the proof: field-level
  confidentiality asymmetry needs no second axis.
- **`admits(...)` / list-query grant** — gone (ADR #2). `scope` compiles to a
  pagination-safe SQL WHERE; no JS fallback, no archived-row leak.
- **Async `is.*` footgun** — Phase 0 guard. No report tripped it.
- **High-frequency re-auth cost** — latched grant cache (ADR #5) holds at 60Hz
  (drawing-canvas) and 30Hz (space-invaders).
- **`inherit`** — typed-FK grant inheritance works for comments/todos.
- **Effects as in-transaction reactions** — the declarative `{mutate,with}`
  primitive is the right home for notify-subscribers / start-game-loop; the
  v1 "afterSave" instinct did not recur.

---

## TIER 0 — the root-cause gaps (resolved this round)

### 0.1 Field-type plugin contract — RESOLVED (ADR #9)

**Hit by:** minecraft (chunk BLOCKER), photo-editor (raster.crdt, blob),
drawing-canvas (polyline.crdt), space-invaders (grid), google-photos (blob,
EXIF json), + 5 apps needing ordered lists (minecraft layers, photo-editor
layers, drawing-canvas shapes, library holds queue, todo subtask order).

**Resolution (judge council converged):** one open registry, **four named-whole
contracts** distinguished by genuinely distinct diff+index+inverse machinery:
`fieldType.value` (single value, incl. `blob`/`json`), `fieldType.store`
(internally-keyed collection with per-key diff + index + range-query — what
`map` could not be), `fieldType.crdt` (custom merge — `text.crdt()` becomes one
instance, deleting the baked-in special case), `fieldType.ordered` (fractional-
index keyspace for atomic `insertAt`/`move`/`reorder` — earned by the deletion
test; 5 apps currently hand-roll the "map-as-ordered-array fake").

**Key discipline:** coordinates are CONSTRUCTED FROM declared indexes (a
coordinate takes `index.range([...])` as its constructor argument), so an
unbacked coordinate is *unrepresentable* — fail-closed one level early, no
hand-SQL trapdoor. The plugin declares index capability; the entity/field
instantiation selects the backing index; the engine owns SQL. Custom CRDT-
authoring toolkit deferred (proactive ≠ exhaustive).

### 0.2 Scheduler / tick family — RESOLVED (ADR #10)

**Hit by:** minecraft (tick lifecycle conflated with `state.auto`), space-
invaders (BLOCKER: zero API for recurring game loop), library (BLOCKER: overdue
at `dueDate`), blog (BLOCKER: scheduled publish), todo (reminders).

**Resolution:** time-driven mutations are a typed **source** feeding the one
pipeline, two public nouns (a deadline and a recurring loop are different
things): `schedule.at(dateField)` / `schedule.after(anchor, delay)` for one-shot
deadlines; `tick.hz(n)` / `tick.every(...)` for recurring loops. `state.auto`
and entity-TTL demote to sugar. Runs as a bounded scheduler/tick principal
admitted by the target grant via `effectSource(handle)` — the clock is a new
trigger, never a new authority.

**Two scale risks both judges closed:** (a) due-row discovery MUST be indexed
(non-compilable `while` = load-time error, the tick-layer analog of a non-
compilable `scope`); (b) tick durability is a field persistence-strategy
decision (ephemeral / coalesced-snapshot-with-seq-span / per-event). Empty
`while` forbidden for row-set ticks (user's fork answer — fail-closed).

---

## TIER 1 — structural gaps (resolved this round)

### 1.1 Subscribe + interest + backpressure — RESOLVED (ADR #15)

**Hit by:** minecraft (BLOCKER: spatial interest, firehose), space-invaders,
drawing-canvas.

**Resolution:** `subscribe(Entity, id, { fields, pace })` is the client export.
Interest is field-keyed (a field not listed is pass-through); grammar is AND
across dimensions, per-dimension one `range` OR one finite `.in([...])` (indexed
IN — categorically NOT the forbidden cross-dimension OR) OR `.is(v)`;
subscribe-time validation; reuses the sequence-cursor replay core.

**Backpressure is two-layer** (the one place Judge 2 beat Judge 1): the
field-type plugin publishes a lawful coalescer + seq-span reducer + named
pace-profiles (data semantics decide what's lawful to drop — position is loss-
tolerant, block-edits aren't); the subscriber selects `pace.coalesce({window,by})`
or a profile within plugin-permitted bounds. Scalar fields default included;
high-volume collection fields OPT-IN (omission = not-subscribed, never firehose).

### 1.2 Query engine — RESOLVED (ADR #16)

**Hit by:** reddit (tree, cursor+stored-rank), google-photos (geo, full-text),
library (compound unique), todo (tree).

**Resolution:** `findTree` → recursive CTE over the declared self-FK (FK-aware,
row `scope` in WHERE). Cursor pagination over compound keys. `.isNull()` (query
predicate, `IS NULL`) distinct from `.is(undefined)` (scope predicate, = FALSE).
`unique([f1,f2]).where(...)`. Geo/full-text as index-gated predicate plugins —
seam ships now (no raw-SQL second path), engines defer until google-photos is
the active spine. Stored-derived split into `projected.inline` (transactionally
consistent sort keys like `hotRank`) + `projected.async` (post-commit
projection — thumbnails, **embeddings for scope's search index**, the
build-now motivating case).

### 1.3 Principal model — RESOLVED (ADR #11)

**Hit by:** reddit (anonymous), blog (anonymous + Reader identity), library
(Patron identity), space-invaders (spectator), todo.

**Resolution (refined by the user's fork answer):**
- **`anonymous`** is a first-class principal for unauthenticated public-read;
  `everyone()` is a compiled SQL `TRUE` (NULL-safe); per-verb route gate
  (`allowAnonymous()` / `requireUser()`) relaxes only the route gate, row grant
  always runs.
- **Domain identities** (Patron/Reader/Player) are sub-account entities owned by
  `User` via a typed FK — NOT new principal types (the union stays closed). A
  User may own MULTIPLE sub-accounts (RuneScape: one sign-in → many character-
  accounts, each with own team permissions). Every domain identity HAS an
  account (passwordless email-link login is fine; no account-less "email user").
  The framework hydrates the binding — must be easy for the developer.

### 1.4 Effects grammar — RESOLVED (ADR #13)

**Hit by:** reddit (arithmetic, append, fan-out), blog (fan-out), photo-editor
(compute), space-invaders (conditional guard).

**Resolution:** `inc`/`dec`/`append`/`push`/`insertAt`/`move` are FIELD-PLUGIN
operators named in `with` (no new effect grammar — deletion-test win). `when`
guards (typed predicate, non-compilable = load-time error). Explicit target-
side admission via `effectSource(handle)`, **verified at load time** (missing
admit = load error, not runtime rollback — the cycle-detector walks the typed
graph). Owned-collection fan-out NOW; typed `anyOf(...)` compound triggers NOW
(finite, cycle-detectable — NOT wildcards). DEFERRED: arbitrary-query fan-out +
`recomputeFrom(query)` (cardinality becomes runtime query result = unbounded-
fixpoint door) and general arithmetic beyond inc/dec.

---

## TIER 2 — sharp edges / maturity / ergonomics

- **2.1 Typed-FK traversal in the scope compiler** — `is.staff()` /
  `is.blogOwner()` needs the compiler to follow principal→Patron→role /
  Post→Blog→owner chains → SQL JOINs. **Model sound; gap is compiler maturity,
  not design.** Build now (library BLOCKER #1; without it, a separate `/catalog`
  route is a second auth path). Multi-hop via `inherit(...).through(...)` chains.
- **2.2 Per-entry field access** — `entryCan(entry, principal)` on collection
  fields (library holds: patron sees own entry). **Reject** `derived(row,
  principal)` — it confuses data derivation with authz/view shaping (both judges
  agreed).
- **2.3 `ownerOnly` shorthand** — `grant: ownerOnly({caps})` as an explicit
  declared function (never a magic default; no-grant still load-time error). todo
  confirmed ADR #7's 5→20 line jump is honest ceremony for a privacy domain; the
  shorthand deletes boilerplate without universalizing.
- **2.4 `inherit` × field `.can`** — field `.can` OVERRIDES (not ANDs) the
  inherited row floor; multi-hop via `.through()`; add dev diagnostics for
  override-vs-additive.
- **2.6 Non-owner FK auto-populate** — generalize `from: principal.user` to
  `author`/`creator` (auto-derive same-named check unless overridden).

---

## What did NOT recur from v1 (grill held)

The v1 meta-finding's three load-bearing gaps were: closed field catalog, no
timer source, single-row authenticated-only authz. v1's authz gap is closed
(ADRs #1–#8); v2 closes the other two (field catalog ADR #9, timer ADR #10) and
adds the delivery/effects/principal refinements the wider 9-app set surfaced.
No v1 BLOCKER recurred as a v1 BLOCKER — the regressions the grill was
defended against did not appear.

## What is NEWLY surfaced in v2

- The field-type plugin contract is the **single gate** for ~half the v2
  BLOCKERs; the grill gave it no shape (it was an authz grill). ADR #9 closes it.
- ADR #5's interest half had **no invocation surface** — designed but unusable.
  ADR #15 closes it.
- ADR #6's effects were bounded but `{mutate,with}` was too narrow (set-only).
  ADR #13 closes it via field-plugin operators.
- The closed principal union + no `everyone()` created a **public-read ceremony
  cluster** the grill (optimized for private-collab-docs) didn't anticipate.
  ADR #11 closes it; the user's sub-account refinement is the one shape both
  judges missed.
- **Typed-FK traversal in the compiler** is the load-bearing authz maturity gate
  (library BLOCKER #1) — the model is sound, the compiler is the work.

## Genuinely DEFERRED (no app needs it yet; proactive ≠ exhaustive)

- Custom CRDT-authoring toolkit (ship `text.crdt`/`polyline`/`raster` as proof).
- rtree/FTS engines (predicate-plugin seam ships now; engines when google-photos
  is spine).
- Arbitrary indexed-query fan-out + `recomputeFrom(query)` in effects (ADR #6
  bound; deferred until an app proves it + a safety case extends the ADR).
- General arithmetic beyond `inc`/`dec`.
- Adaptive per-connection rate negotiation (fixed plugin coalescing ships first).

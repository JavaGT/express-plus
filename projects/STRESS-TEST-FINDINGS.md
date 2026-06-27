# express-plus Stress-Test Findings — 8-domain synthesis

Eight implementers (each with a different lens) attempted real projects
against the current express-plus reactive-entity API and documented where it
fought them. This is the lead's synthesis across all eight reports — not a
concatenation. I judged each finding for correctness and recurrence, grouped
by LEVERAGE (what unblocks the most), and flagged where a report overreached
or where the answer is NOT what the reporter proposed.

**Projects & lenses:** minecraft (Framework Extender), space-invaders (Game
Loop Engineer), photo-editor (Pixel Pusher), google-photos (Storage
Architect), library (Bureaucrat), reddit (Social Scale Engineer),
drawing-canvas (Realtime Artist), blog-platform (Publisher).

Full per-project reports: `projects/<name>/PAIN-POINTS.md`.

---

## The meta-finding

The reactive-entity paradigm is **strong inside its design domain**
(collaborative text documents) and **structurally incomplete outside it**.
Every BLOCKER traces to one of three things the framework assumes:

1. **Field types are a closed catalog** — `text`, `text.crdt`, `number`,
   `date`, `ref`, `set`, `presence`, `log`, `hash`. Domains whose native data
   isn't a string/number/FK have nowhere to go.
2. **Mutations originate only from user REST calls** — there is no
   timer/self-driven mutation source. Games, schedulers, and time-based
   state machines cannot be expressed.
3. **Authorization is specified for single-row loads by an authenticated
   user** — list-query grant behavior is undefined, and there's no model for
   anonymous (link-share) principals or pre-authorized ephemeral channels.

These three are the load-bearing gaps. Everything else is vocabulary that
falls out of them.

---

## TIER 0 — the root cause (highest leverage)

### 0.1 No custom field-type extension point
**Hit by:** minecraft (BLOCKER #1), photo-editor (#1,#2), google-photos (#1),
drawing-canvas (#2,#3), space-invaders (#2).

The field-type catalog is hardcoded. A `registerFieldType` contract — where a
plugin supplies `serialize`/`deserialize`/`diff`/`merge`/`methods` and the
framework wires it into persistence, the WS stream (delta payloads), and
field-level `access` — would let domains supply `blob`, `raster.crdt`,
`chunk`, `queue`, `array`, `polyline`, `grid` WITHOUT the framework
pre-anticipating every domain.

This single design decision dissolves roughly half the BLOCKERs across the
eight projects. It is the difference between "a framework for documents" and
"a framework for live-sync apps." Per AGENTS.md "prefer a singular system" —
singular does not mean closed; it means ONE extension mechanism, not many
parallel ones. The plugin registry is that mechanism.

**Implication:** this is the first thing to design. It constrains everything
below — `blob`, `array`, `raster.crdt`, `state`, `queue` should all be
expressible as plugins (some shipped built-in, some user-supplied), not as
ad-hoc additions to the catalog.

---

## TIER 1 — structural gaps the reactive model has no answer for

### 1.1 No server tick / scheduler / timer / cron
**Hit by:** minecraft (BLOCKER #4), space-invaders (BLOCKER #1), blog
(BLOCKER #1, scheduled publish), library (#7, overdue).

The paradigm is "events derive from field mutations; mutations originate
from user actions." But games run physics at 20–30Hz, blogs auto-publish at
a scheduled time, libraries flip `overdue` when `dueDate` passes — all
**self-driven, timer-originated mutations**. The only workaround is
`setInterval` / external cron at app scope: a full framework leak with no
lifecycle integration (the interval keeps running after the entity is
deleted), no drift compensation, no backpressure.

**Implication:** the entity needs a framework-managed scheduler construct.
Reports propose `tick: { rate, handler }` (games) and `state.auto` transitions
with `when`/`poll` (business apps). These are two faces of one mechanism: a
declared, lifecycle-bound timer that mutates fields and emits events through
the normal pipeline. NOT a revival of the removed `on(app)` block —
declarative, not imperative wiring (AGENTS.md "declaration absorbs imperative
wiring").

### 1.2 List-query grant enforcement is UNDEFINED — leak + pagination break
**Hit by:** library (SHOULD-FIX #2), blog (#2, borderline BLOCKER).

`grant`/`hide()` is specified for single-row loads. `findAll` behavior is
**not specified**: does it post-filter by `grant`, or return all rows? Two
real consequences:
- **Security:** a public `GET /comments/post/:id` using `open` could leak
  pending/spam/deleted rows to anonymous visitors if `findAll` doesn't apply
  `grant`. (blog #2)
- **Pagination:** if `grant` post-filters AFTER the DB query, a page of 20
  with 15 hidden rows returns 5. (library #2)

The current exemplar sidesteps this by hand-writing `.and(state.is('published'))`
in every list handler — which is a **duplicate authorization path** that
drifts from the declarative `grant`. This directly tests the "no second auth
path" invariant: the invariant is only meaningful if `findAll` is IN the
engine.

**Implication:** the engine must push `grant` into the query (a `queryScope`
that compiles to WHERE), not post-filter. This makes grant both correct
(no leak) and pagination-safe. This is the most important authz spec gap
surfaced — it's not obvious from the gdocs example because there every list
is already owner-scoped by the predicate.

### 1.3 No model for non-user principals (link sharing) or latched auth
**Hit by:** google-photos (#5, link-share), space-invaders (#3),
drawing-canvas (#4), minecraft (#10).

Two distinct gaps that both strain the "no second auth path" invariant:
- **Anonymous principals:** `grant`/`checks` receive `{ user }` and assume a
  User exists. A link-share viewer has no session. Reports force `open` +
  custom middleware → a genuine second auth path. (google-photos #5)
- **Per-push re-auth at high frequency:** the invariant re-runs `grant` per
  push. At 30–60Hz × N players/cursors that's hundreds–thousands of evals/sec
  where the answer cannot change mid-stroke. (3 reports)

**Implication:** the invariant needs REFINEMENT, not weakening. One engine,
but the engine must model (a) principals that aren't logged-in users (a
`token`/`link` principal type), and (b) authorization LATCHED at subscribe
time and re-evaluated only on subscription-invalidating events (roster
change, share revocation). A cached result is not a second path; a separate
code path is. The blog #8 finding (below) shows the footgun this must avoid.

### 1.4 Async `is.*` is a silent auth-bypass footgun
**Hit by:** blog (#8).

`is.owner()` is sync; `is.projectManager()` is async. `is.author() ||
is.blogOwner()` WITHOUT `await` evaluates the Promise as truthy → grants to
everyone. The `is.*` naming implies a sync boolean. With mixed sync/async
checks and no lint rule, this is a real authz bypass with no framework
warning.

**Implication:** either all `is.*` return thenables uniformly (always
awaitable), or a naming suffix convention, or a framework-level guard. This
must be solved BEFORE the latched-auth optimization in 1.3, or the caching
amplifies the footgun.

---

## TIER 2 — field-type vocabulary gaps

Mostly dissolved by Tier 0's extension point, but the BUILT-INS should still
cover common cases so apps don't ship a plugin for table-stakes.

| Gap | Recurrence | Projects |
|-----|------------|----------|
| `blob`/`bytes` binary field | 3 | minecraft, photo-editor, google-photos |
| ordered mutable collection (`array`/`list` with delete+reorder) | 4 | photo-editor (layers), drawing-canvas (shapes), library (hold queue), reddit (thread order) |
| `boolean` | 3 | minecraft, photo-editor, google-photos |
| `enum` / `oneOf` | 3 | library, blog, drawing-canvas |
| `state` machine (transitions + effects) | 1 heavy + 2 light | library (BLOCKER), blog, drawing-canvas |
| CRDT beyond text (raster/region/polyline) | 2 | photo-editor, drawing-canvas |
| valued set / per-member metadata | 2 | reddit (votes ±1), google-photos (share tiers) |
| shared-ephemeral authoritative field | 1 | space-invaders (invader grid) |
| structured/JSON sub-object | 2 | minecraft (game rules), google-photos (EXIF) |
| `map`/dict field | 1 | minecraft (inventory) |

**Judgment:** `boolean`, `enum`, `blob`, `array` are table-stakes built-ins.
`state` (with declared transitions + effects, auto-emitting
`<Entity>:<field>:<from>→<to>`) collapses the library BLOCKER and the
blog/drawing enum-into-text pattern into one declarative construct — and its
`effects` block is the declarative home for the side-effects reports keep
asking for (1.5 below). CRDTs beyond text and the `grid`/`chunk`/`polyline`
types are plugin territory (Tier 0).

### 1.5 No declarative side-effect / reaction home
**Hit by:** blog (#5, subscriber notify), minecraft (#11, lifecycle), photo-editor (#6, render pipeline), reddit (#E, moderation log).

The design deliberately REMOVED `on(app)` and `hooks` (good — per AGENTS.md).
But that left NO home for "when X transitions, do Y on another entity"
(notify subscribers, start a game loop on create, append to a moderation
log). Reports propose restoring `afterSave`/`onCreate` — that's the wrong
direction (imperative wiring). The right home is **declarative**: a
`reactions:` block or transition `effects:` (e.g. `→ published: notify
Blog.subscribers`) that the engine compiles, not a callback the app mounts.
This pairs with the `state` machine in 2.

---

## TIER 2 — query-language gaps

The typed-handle predicate language has only `.is(val)` and `.has(id)`. Real
apps need far more, and the absence forces raw SQL → a second query path
(violates "singular system").

| Gap | Recurrence | Projects |
|-----|------------|----------|
| comparison / range (`.gte`/`.lte`/`.lt`/`.not`) | 3+ | google-photos, library, reddit |
| compound AND / multi-field `findOne` | 3 | reddit, library, blog |
| full-text search | 1 (but core to the domain) | google-photos |
| geo / spatial-radius | 1 | google-photos |
| tree traversal (recursive CTE / `loadTree`) | 1 (structural) | reddit (nested comments) |
| cross-entity aggregate / stored-derived (`counter(ref)`) | 2 | reddit (score), google-photos (thumbnails) |
| cursor pagination + stored rank index | 1 | reddit (front page) |
| compound uniqueness (`unique([f1,f2])`) | 2 | reddit (votes), library (holds) |
| `.in([...])` multi-value membership | 1 | reddit |

**Judgment:** `.gte`/`.lte`/`.not`/`.and`/`.in`/`unique` are table-stakes —
their absence is the clearest "designed for gdocs, not for apps" signal.
Full-text, geo, tree-traversal, and cross-entity aggregates are larger
designs: full-text and geo are field-index constructs (a `searchable()` /
`indexed()` field option backed by a real index); tree-traversal needs a
recursive-load query on self-referential `ref`s; cross-entity aggregates
need a **stored-derived** distinction (recompute on related mutation, write
back, indexed) vs the current sync recompute-on-read `derived` — a gap that
hits both reddit (score) and google-photos (async thumbnail derivation).

---

## TIER 3 — ergonomics / sharp edges

- **`presence` is closed + mis-named** (drawing-canvas BLOCKER #1, minecraft
  #7). The doc shows `presence({ cursor, selection })` — boolean toggles for
  predefined shapes. Is it extensible to arbitrary per-connection ephemeral
  state (an in-progress 60Hz stroke)? The API gives no way to declare the
  data shape. And "presence" reads as passive location, not active
  construction-in-progress. Needs clarification + likely an
  `ephemeral({...})` generalization.
- **`open` on every public route** (blog #3). Fail-closed default is right
  for docs; for public-by-default content (blogs, forums, link-shared
  photos), every GET needs `open` and `r.resource()` is unusable. Needs an
  entity-level `publicRead` or mount-time opt-out for the route-gate layer
  (the row-grant layer still applies). The inverse of invariant 8's strength
  — the same default that protects docs fights public content.
- **No batched/atomic multi-field mutation** (minecraft #8). Spawn sets 6
  fields sequentially → intermediate states emit visible-inconsistent
  events. A `.batch({...}).commit()` emitting one composed event.
- **No field-level `validate`** (minecraft #9). `access` gates WHO; nothing
  gates whether the VALUE is valid (anti-cheat position clamping). Validation
  must be reachable from every mutation path (REST, WS, tick, batch) → lives
  on the field, not the route.
- **Non-owner ref auto-populate** (drawing-canvas #6, blog #9). Only
  `role: owner` auto-fills `req.user.id`. `author`/`createdBy` must be
  hand-set in every create handler. Generalize to `ref('User', { from:
  req.user.id })` or a `role: author` marker.
- **No event priority / rate-limit / backpressure** (minecraft #10). The
  WS stream is a firehose; 100 players × 20Hz = 2000 events/sec with no
  per-subscriber throttling or priority. Ties to 1.3's latched-auth — both
  are "the live layer assumes document-scale, not game-scale."
- **No ephemeral entity / TTL** (space-invaders #4). Match rows linger in
  the DB after the game ends. An `ephemeral: true` or `ttl` entity flag.

---

## Cross-cutting identity friction (one to watch)

The library report surfaces a modeling friction no other project hit but
several would: the framework's `User` is the auth principal, but an app's
domain entity (library `Patron`, blog `Author`, reddit `Redditor`) is a
SEPARATE entity with a `account: ref('User')` mapping. Every "is the
requestor the owner/borrower/author?" check must do a cross-entity lookup to
resolve `User → Patron`. The gdocs `role: owner` FK sits directly on the
entity as a User FK and avoids this; any domain with a richer profile than
the auth User pays a per-check round-trip. Worth a first-class
"identity binding" so `is.owner` can resolve through a declared
`account: ref('User', { identity: true })` without a hand-written lookup.

---

## Prioritized recommendation

1. **Design the field-type plugin registry (Tier 0).** It is the gate for
   ~half the BLOCKERs and the structural answer to "designed for docs."
   Ship `boolean`, `enum`, `blob`, `array`, `state` as built-in plugins.
2. **Specify `findAll` grant behavior (1.2):** push grant into the query
   (queryScope → WHERE), not post-filter. Closes a leak and fixes pagination.
3. **Add the scheduler/tick construct (1.1):** declarative, lifecycle-bound,
   emitting through the normal pipeline. Pairs with `state` effects (1.5).
4. **Refine the auth invariant (1.3):** model non-user principals (link
   tokens) and latched subscribe-time auth — and solve the async-`is.*`
   footgun (1.4) FIRST so caching doesn't amplify it.
5. **Round out the query language:** `.gte`/`.lte`/`.not`/`.and`/`.in`,
   `unique`, cursor pagination, stored-derived vs computed-derived.
6. **Generalize `presence` → `ephemeral`** with declarable shapes; add
   `publicRead` opt-out, batched mutation, field-level `validate`.

The gdocs exemplar exercises ~20% of this surface. These eight projects
exercise the other 80% — and the framework currently has clean answers for
maybe a third of that. The reactive-entity spine is sound; the gaps are in
the catalog, the mutation sources, and the auth/query engines' edge cases.

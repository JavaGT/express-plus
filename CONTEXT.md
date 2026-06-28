# CONTEXT — express-plus ubiquitous language

The canonical name for each domain concept in express-plus. Glossary only — not a
spec, not a decision log. Terms are added as they resolve during design.

## Framework identity

- **express-plus** — the library's name. Never "express". A batteries-in,
  override-extensible framework for collaborative live-sync apps.

## The two floors and the override model

- **the floor** — the smallest working app. It is **not** "~3 lines": an entity
  with no `grant` is a **load-time error** (see Authorization). The floor is
  *declare an entity + declare a grant, however short* — because authorization is
  never magic and never defaulted to a guessed principal. The floor stays
  opinionated: authed and private by default, but the developer names *who*
  reads, explicitly. Reaching power does not mean leaving the floor; it means
  overriding a default in place.
- **override (not additive)** — the extension model. Power is reached by
  *replacing* a framework-derived default in the same slot with a more explicit
  declaration, never by mounting a second parallel mechanism. The explicit form
  *shadows* the derived one; it does not run beside it.
- **derived default** — any value the framework computes from the developer's
   declaration (e.g. a SQL WHERE from `scope`, a row grant inherited by a field).
  Every derived default is overridable one declarative level down, never via a
  lower-level trapdoor (no hand-edited SQL).

## Authorization

There is **no separate visibility axis**. A principal can **read** a row/field or
cannot; "invisible" is just the absence of a read grant, never a third outcome to
derive or reconcile. This collapses authorization to two questions: *can you read
it* and *can you edit it*.

- **no default grant** — an entity that declares **no `grant`** is a **load-time
  error**, never silently private-by-creator and never world-readable. Authorization
  is never magic and never guessed: the developer must name *who* reads. There is
  no zero-to-one "owner = all, else hide" default — `owner` is a *check the
  developer declares* (auto-derived only from an `owner` ref field they chose to
  add), never a universal the framework assumes. This is fail-closed at its purest,
  and the cost is the ~3-line floor (see *the floor*).

- **grant / deny** — the results an authorization function may return. Richer than
  a boolean; `deny(reason)` carries an error. (There is no `hide` — a denied read
  simply removes the row from the result set.)
- **absent vs forbidden** — without a hide axis, "row not in my list" and "row I'm
  forbidden to read" are the same observable state. In **production** the row is
  silently absent and the omission is **logged server-side**; in a **dev
  environment** the framework raises a "this exists, but you wouldn't know that in
  production" error. The dev-mode error is what recovers the distinction the
  collapsed hide axis gave up.
- **check** — a per-entity, named *fact* about a row (e.g. `owner`,
  `collaborator`, `editor`). A plain function, nothing more — never wrapped or
  marked. Schema-by-schema, never universalized across entity types. A check is
  just a fact; it grants nothing until a grant calls it. Awaitable as `is.*`.
- **scope(predicate).can(fn)** — the grant grammar, split on a *performance*
  boundary. `scope` is the **read** grant: it declares *intent* ("these rows are
  readable") by calling checks, and is the ONLY grant compiled to SQL (a `WHERE`
  so the database never returns forbidden rows). Compilability is *derived* from
  what the called checks touch — but it is a **hard contract**: a check used
  inside `scope` that cannot compile to SQL is a **load-time error** (move it to
  `.can` or rewrite it as a field-handle predicate), never a silent runtime scan.
  `.can` is every OTHER capability (write, admin, subscribe, …), decided per-row
  at runtime, and MAY call non-compilable checks freely. Grant is EXACTLY two
  halves — there is no third method.
- **read intent is never derived from compilability** — "this check happens to
  compile" must NOT auto-admit a read (e.g. an `archived` fact compiles but must
  not make archived rows world-readable). The compiler derives *whether* a check
  compiles; the developer declares *whether* it admits a read, by calling it in
  `scope`. Deriving the latter would be a confidentiality leak.
- **`never()` / `.is(undefined)` compile to SQL FALSE** — a deliberate fail-closed
  VALUE the developer wrote (e.g. a non-link principal on a `linkHolder` check;
  an anonymous link whose token is undefined must not match rows whose
  `linkShare.token` is null, so `.is(undefined)` never compiles to SQL `IS NULL`).
  This is **distinct from a non-compilable check** (a load-time error): `never()`
  is *intent* the developer expressed as a constant false; a non-compilable check
  is an *accident* the compiler refuses to silently degrade to a runtime scan.
  Same fail-closed destination, different disciplines — do not collapse them.
- **field `.can(fn, defaults)`** — a field's capability rule, fluent, ON the
  field. `defaults` is the inherited row grant. A field with no `.can`
  **strong-inherits** the row grant: it is **readable exactly when the row is
  readable**, and its edit floor is the row grant's write capabilities. There is
  ONE field floor (open-by-default, matching collaborative entities); a stricter
  field-read is an explicit override (`.can` on the field, or the entity-level
  `fieldAccess:{default:ownerOnly}` opt-in), never a competing default.
  Unlike a row grant, field access is **always runtime** — never a compiled
  `scope` — because the row is already materialized when a field rule evaluates.
  A field cannot filter rows in SQL; it can only refine read/edit on a row
  already admitted by the row scope.
- **withheld** — the typed marker a field's READ-denial returns. A field the
  principal may not read is NOT silently absent and does NOT fail the whole row
  fetch; it is replaced by an explicit `withheld` marker so the client/dev can
  tell "this field exists but you can't read it." (The field-level analogue of
  the row-level dev-error: an explicit signal, never silent invisibility.) Field
  EDIT-denial, by contrast, is a hard reject at write time.
- **fieldAccess: { default: ownerOnly }** — optional entity-level directive that
  flips the field floor to fail-closed for security-sensitive entities. Omitted
  by default (= inherit row grant). `ownerOnly` is an authz function, not raw
  `deny`.
- **anonymous** — a first-class principal type for UNAUTHENTICATED public-read
  (reddit front page, blog published posts): `{type:'anonymous', id:null}`,
  capability-bounded, admitted only by checks that don't reference identity
  (`published`). Never a `publicRead` flag.
- **`everyone()`** — a compiled SQL `TRUE` constant (NULL-safe, symmetric to
  `never()`=FALSE), a value the developer wrote — never the NULL-unsafe
  `entity.id.is(entity.id)` tautology, never a derived admission.
- **per-verb route gate** — `r.resource({ gate: { list: allowAnonymous(),
  create: requireUser() } })` relaxes ONLY the route gate (session→principal)
  for named verbs; the row grant runs on every verb regardless. Two default-on
  layers intact, fail-closed default-empty, no second auth path.
- **sub-account** — a domain identity (library Patron, blog Reader, game Player)
  modeled as an entity owned by `User` via a typed FK, NOT a new principal type.
  The principal-type union stays closed (`user | link | system | anonymous`); a
  Patron is a User wearing a domain hat. Every domain identity HAS an account
  (no account-less "email user" pseudo-identity; passwordless email-link login
  is fine). A `User` may own MULTIPLE sub-accounts (one-to-many: one sign-in →
  many character-accounts, each with own team permissions); the principal
  resolves to the active sub-account. The framework hydrates the binding from
  the declared identity FK — not app middleware.
- **`entryCan(entry, principal)`** — per-ENTRY access rule on a collection
  field (`map`/`list`/`store`), finer than the field-level `.can` (a patron can
  see their OWN hold entry while others are withheld). Principal-varying
  *derivation* is rejected — `derived(row, principal)` confuses data derivation
  with authz/view shaping; use `.can`/`entryCan`/serialization instead.

## Live delivery (subscriptions)

Live event delivery is **NOT a third grant axis**. "Delivery" was the plan's name
for two distinct concerns it had fused into one undesigned `.deliver()` method;
separating them dissolves the third-sibling-key the rest of the model rejects.

- **re-authorization (the hard gate)** — at emit, the framework re-runs the SAME
  `scope`+`.can` engine for the event's principal. This is "no second auth path"
  made structural: live events run through the *identical* authorization engine as
  REST, never a bypass. There is nothing new to author — it is the existing grant,
  evaluated at emit. (At scale this is **latched**: the grant decision is cached at
  subscribe time and invalidated by roster/share/role/ownership changes, so the
  30Hz path does a cheap cache check, not a full re-eval.)
- **subscriber interest (a narrowing filter, NOT authorization)** — the
  *connection* supplies a transient interest declaration when it subscribes (e.g.
  "only chunks in my viewport"). It is NOT a grant method: its input (camera
  position, open tab) is connection-transient, not principal-or-row, so it cannot
  live on `grant` without breaking `scope`'s SQL-compilable purity. It runs ONLY
  *after* re-authorization, and is structurally incapable of widening: it receives
  the already-authorized event and returns keep/drop only, may not fetch or
  reference other rows/entities, may not read the principal, and is a set
  intersection (AND), never an OR. Interest narrows; only `scope`+`.can` admits.
- **interest is data, not code** — interest is a typed constraint expression over
  a coordinate schema the field-type plugin publishes (typed handles), validated
  at subscribe time with a subscribe-time error on any unpublished coordinate —
  the same load-time-error discipline `scope` uses. A free-form `(event)=>boolean`
  closure is rejected (un-enforceable, un-indexable, can reach principal/row and
  widen). The data form is also indexable: a viewport interest becomes an indexed
  range scan over dirty chunks, so emit need not visit out-of-viewport rows.
- **`subscribe(Entity, id, { fields, pace })`** — the client export. Interest is
  field-keyed: a field NOT listed is pass-through (a `name:changed` event is not
  tested against a `chunks` viewport interest). Grammar is AND across
  dimensions; per dimension one `range(lo,hi)` OR one finite `.in([a,b,c])`
  (indexed IN — NOT the forbidden cross-dimension OR, a Cartesian union no
  composite index answers) OR `.is(v)`. Scalar fields default included;
  high-volume coordinate-published collection fields are OPT-IN (omission =
  not-subscribed, never unfiltered firehose).
- **pace** — backpressure, two-layer. The field-type plugin publishes a lawful
  coalescer + sequence-span reducer + named pace-profiles (the *data semantics*
  decide what's lawful to drop — position is loss-tolerant, block-edits aren't).
  The subscriber selects `pace.coalesce({window,by})` or a profile WITHIN the
  plugin-permitted bounds — data-not-code, runs after re-auth+interest,
  narrowing-only (a spectator and a player may want different temporal policy
  for the same field).

## Declarative reactions (effects)

`effects` are **bounded, in-transaction, effect-principal reentrancy** — declarative
mutations triggered by mutations, compiled by the engine, never mounted as callbacks
(that would be `afterSave` reborn). The stress-test requires a home for "when X
mutates, do Y on another entity" (notify subscribers, start a game loop, append a
moderation log); this is that home.

- **one primitive** — `{ mutate: <target>, with: <data-template> }`. `<target>` is
  `self` (default) or a typed entity handle. `{set}` (self-write) and `{create}`
  (cross-entity) collapse into one verb: the engine decides set vs create from
  whether the target row exists. No two-primitive grammar.
- **field-plugin operators in `with`** — `inc`/`dec`/`append`/`push`/`insertAt`/
  `move` are operators the FIELD-TYPE plugin owns (G0.1), named in the effect's
  `with` template. The effect layer borrows the field layer's operators instead
  of inventing a mutation grammar. `inc(delta.direction)` references the target's
  own current value (read-modify-write owned by the field operator) — NOT
  generalized into arbitrary target reads.
- **`when` guard** — a typed predicate over delta+origin (not I/O; non-compilable
  = load-time error) gating whether a trigger fires.
- **`effectSource(handle)` / `principalFrom(handle)`** — the EXPLICIT,
  load-time-verified admission check the TARGET declares for an effect principal.
  The load-time cycle-detector verifies every declared effect has a matching
  admitting check on its target — a missing admit is a load-time error, never a
  silent runtime rollback.
- **owned-collection fan-out** — `mutate: many(Target, { over: Origin.collection })`
  re-enters the pipeline once per element in the SAME batch (blog
  subscriber-notify). Traverses typed FKs from the origin row, staying inside the
  "data interpolated only from trigger delta + origin row" bound.
- **typed compound trigger** — `effect.anyOf(handleA, handleB, handleC)`: a finite,
  statically-known set of typed triggers, fully cycle-detectable (NOT a wildcard
  string-glob, which reintroduces fixpoint risk). Arbitrary indexed-query fan-out
  and `recomputeFrom(query)` are deferred (cardinality becomes a runtime query
  result — beyond ADR #6's bound).
- **typed handles, not magic strings** — the trigger is a typed event handle, the
  target is an entity handle, and template path-refs (`delta.member`, `entity.id`)
  are typed handles, not stringly-typed paths. Same no-magic-strings discipline as
  `checks`. (This is also the prerequisite for static cycle detection — without
  typed handles the effect graph is not statically knowable.)
- **bounded reentrancy, not unbounded fixpoint** — a declared-effect graph is
  statically analyzed at load; a structural cycle (A→B→A) is a **load-time error**
  (same discipline as a non-compilable `scope`). A runtime **depth cap** is the
  fail-closed backstop for data-dependent fan-out the static graph cannot bound;
  hitting it aborts the whole batch (never silently truncates).
- **same transaction, same composed event** — a cross-entity effect re-enters the
  one pipeline and folds into the *originating* mutation's `batch`: one transaction,
  one composed event. Target grant/validation failure **rolls back the origin**. A
  separate saga boundary would be a second pipeline with different failure
  semantics — forbidden. (A cross-store effect target is a load-time error: it
  cannot share one DB transaction and must not silently degrade to a separate one.)
- **effect principal, not the actor, not the ambient SYSTEM god** — the effect
  runs as a per-effect principal whose capability is bounded to *exactly* the
  declared (target entity + template fields), authorized against the **target's
  own grant** (the target stays sovereign — its deny rolls back the batch), with
  data interpolated *only* from the trigger delta + origin row. Not the triggering
  user (which would force widening the target's grant to admit the source's
  actors), and not the ambient SYSTEM principal (which, with interpolated
  `data:{recipient:delta.member}`, could write any field of any entity for an
  arbitrary recipient — an integrity/confidentiality risk).
- **atomic for commit, not for delivery** — the composed event is transaction-atomic,
  but delivery is per-subscriber per-fragment: re-auth-at-emit (see Live delivery)
  runs against each source-entity-tagged fragment, so a subscriber authorized for
  Doc but not Inbox sees only the Doc fragment. No new rule; no all-or-nothing
  delivery (which would leak). Unauthorized fragments are absent (denied-read =
  absent, no hide axis).

## The mutation pipeline (dispatch, sync, replay)

The single path every state change flows through. Validated against the scope
workbench (a shipped event-sourced collaboration framework); see
`SCOPE-FINDINGS.md`.

- **action** — an imperative client request that *may be rejected*. Branded
  distinct from an event so the type system refuses to treat a request as a fact.
- **event** — a past-tense fact the server emitted; it already happened. Branded
  distinct from an action. Every event type has a **non-optional reducer**
  (missing reducer = compile error) — the framework owns the event grammar, so an
  unreduced event is a hole, not a default.
- **the pipeline** — the one ordered path a mutation takes: *validate → resolve
  scope → authorize → preimage → optimistic → dispatch → ingest*. Every mutation
  source (REST, live, tick, batch, effect) feeds the same pipeline. No second
  write path.
- **stage** — one named step of the pipeline. A *variant* (durable vs live)
  selects a named, pre-validated whole; it never toggles individual stages with
  independent boolean flags (an incoherent lattice that can half-apply).
- **resolve scope** — a *pure* `(payload) => scopeRef` step, no I/O. Purity lets
  authorization run *before* any transaction opens, so an unauthorized request
  never takes the write lock. The scope is a typed handle derived from declared
  shape, never a runtime-parsed string.
- **preimage** — the captured pre-mutation value of every entity an action
  affects. A failed dispatch restores preimages exactly; client-local undo
  restores them too. Never persisted with sensitive content client-side.
- **ingest** — the *only* place an event becomes client state, for the client's
  own echoed events and for foreign live events alike. Folds each event through
  its reducer exactly once and advances the sequence cursor. There is no second
  "apply" path (see AGENTS.md, *one reconciliation path*).
- **sequence cursor** — the per-scope monotonic position the client has applied
  to. An incoming event is a **duplicate** (sequence < expected, idempotent
  skip), a **gap** (sequence > expected, do not apply, resync), or **next**
  (reduce once, advance). A stale cursor **hard-fails** into a forced
  re-bootstrap, never a silent truncate.
- **snapshot / snapshot sequence** — the app-supplied state blob for a scope, and
  the inclusive sequence it was read at (read atomically with the snapshot).
  Bootstrap loads the snapshot and sets the cursor to its sequence *before*
  starting the live stream — the reverse order loses events in the race.
- **projection** — a post-commit derived read model fed by the committed event
  log (a search index, an embeddings store, a webhook, an email). Independently
  durable: a projection failure is retried on its own and never rolls back the
  committed action. This is the home for out-of-band side effects (see
  *Declarative reactions* and DECISIONLOG.md).

## Field types

Field types are an open registry of named-whole plugin contracts — `text.crdt()`
is one instance of this registry, not a privileged built-in. A plugin picks
exactly one *kind*, distinguished by genuinely distinct diff+index+inverse
machinery (never a `kind` enum that could grow optional surfaces into a flag
lattice).

- **`fieldType.value`** — a single stored value per row-field (`vector3`,
  `blob`/`bytes`, `json(shape)` with typed path queries). Whole-value diff.
- **`fieldType.store`** — an internally-keyed owned collection with per-key diff
  + index + range-query (`chunk` = ~4913 sub-records). What `map` could not be:
  `map` is keyed-UNORDERED; a store publishes a sub-key index the compiler
  range-scans.
- **`fieldType.crdt`** — a custom-merge field with per-element, granular deltas
  (`text.crdt`, `polyline`, `raster`). Merge-ordered, not range-scannable.
- **`fieldType.ordered`** — a fractional-index keyspace giving atomic
  `insertAt`/`move`/`reorder` without renumbering (`list`). Earned by the
  deletion test: delete it and atomic reorder has nowhere to attach.
- **coordinate** — a typed handle a plugin publishes so the field is
  interest/query addressable (e.g. a chunk's `cx/cy/cz`). **A coordinate is
  CONSTRUCTED FROM a declared index** (it takes `index.range([...])` as its
  constructor argument), so a coordinate with no backing index is
  *unrepresentable* — a load-time type error, not detected-after-the-fact. This
  is fail-closed one level early, and it is what keeps the plugin out of
  hand-SQL: the plugin declares index *capability*, the entity/field
  instantiation selects the backing index, the engine owns materializing +
  compiling SQL. No plugin ever emits SQL.

## Time-driven sources

Time-driven mutations are a typed **source** feeding the one pipeline (alongside
REST, live, tick, batch, effect). Two public nouns because a deadline and a
recurring loop are different things.

- **`schedule.at(dateField)` / `schedule.after(anchor, delay)`** — one-shot
  deadlines (library overdue at `dueAt`, blog scheduled-publish, todo
  reminders). `state.auto` and entity-TTL are *sugar* over `schedule.after` /
  `schedule.at`.
- **`tick.hz(n)` / `tick.every(...)`** — recurring loops (the 20–30Hz game
  loop).
- **scheduler/tick principal** — the bounded principal a time-source runs as
  (not the ambient SYSTEM god), admitted by the target's own grant via an
  `effectSource(handle)` check. The clock is a new *trigger*, never a new
  *authority*.
- **`while` discovery predicate** — which rows a tick runs on. MUST be indexed
  (non-compilable = load-time error, the tick-layer analog of a non-compilable
  `scope`); an empty `while` is forbidden for row-set ticks (the "all rows
  forever" foot-gun), legal only for singleton/explicit-finite handles.

## Stored computed fields

Stored read-model fields have two named modes, split on the atomicity boundary
(the same boundary effects and projections split on). `derived` stays strictly
for pure synchronous read-time pull.

- **`derived`** — pure pull at read (a `wordCount`); not stored, not queryable
  unless inlined.
- **`projected.inline`** — updated inside the originating transaction when the
  dependency is in the same batch and the compute is cheap+synchronous (a post's
  `hotRank` — transactionally consistent so the visible-page sort key never
  mis-ranks). An in-transaction effect targeting a derived field (ADR #6).
- **`projected.async`** — a post-commit projection over the committed log with a
  sequence watermark and explicit staleness, for expensive/async/external
  compute that MUST NOT join the DB transaction: thumbnails, renders, and
  **embeddings for a search index** (scope requires this). Never rolls back the
  origin.
- **projection principal** — both projection writes go through a bounded
  principal admitted by the target's own grant. A "framework-reserved internal
  write path" is the second write path AGENTS.md forbids — rejected.

## Query predicates

Query predicates share the compiler with scope-predicates but never auto-admit a
read (compilability ≠ read intent — ADR #2 leak guard).

- **`findTree`** — typed-FK-aware tree traversal over a self-referential `ref`,
  compiled to a recursive CTE (with row `scope` in the WHERE). Deletes the
  fetch-all-then-build-tree-in-JS pattern (reddit 3000 comments, todo subtasks).
- **`.isNull()`** — a query predicate (read half) compiling to SQL `IS NULL`,
  DISTINCT from `.is(undefined)` (a scope predicate, authz half, = FALSE). Same
  fail-closed destination, different halves — do not collapse them.
- **`unique([f1,f2]).where(...)`** — compound-uniqueness constraint for the
  genuine compound-with-partial-predicate case a keyed field cannot dissolve
  (library: one active Checkout per item+patron).
- **`.near()` / `.match()`** — geo / full-text predicates, index-gated predicate
  plugins. The seam ships now so a query for them never degrades to raw SQL (no
  second query path); the actual rtree/FTS engines defer until google-photos is
  the active spine (build the seam, not the subsystem).
- **cursor pagination** — `range` over a compound key (reuses the interest
  `range`); `projected.inline` sort keys are cursor-paginable because they are
  materialized + indexed.

## Relations & data

- **typed foreign key** — a relation declared as an explicit, typed reference to
  its target entity, with auto-traversal and population. No opaque sugar that
  hides the FK target.
- **owned collection as a field** — when a collection is genuinely owned by one
  side of a relation, it is a field on that entity, not a standalone table.
- **inherit('Doc', { via: 'doc' })** — child grant inheritance carrying BOTH
  parent scope and parent `.can` through a typed FK.

## Live / sync

- **field as reactive primitive** — a field owns its persistence, sync strategy,
  and event emission. Events are *derived from field mutations*, not hand-emitted.
- **uniform transport** — one live transport (WebSockets). No per-feature
  transport mixing.
- **transport is decided; the pipeline is transport-agnostic.** The
  dispatch/sync/replay machinery above (action, event, sequence cursor, snapshot,
  ingest, projection) is mined from scope, which shipped on **SSE + POST**. None
  of it is SSE-specific: the sequence cursor, gap-resync, and snapshot-before-
  stream rules are properties of the *log*, not the wire. express-plus chooses
  **WebSockets** as that wire because the stress-test set needs symmetric,
  low-latency push (space-invaders 30Hz tick, drawing-canvas in-progress strokes,
  presence/CRDT) that SSE's half-duplex one-way shape serves awkwardly — this is
  the one place express-plus deliberately diverges from scope's SSE+POST, and the
  divergence is justified by an app in the set, not a speculative knob. The cursor
  and replay vocabulary therefore reads identically over either wire.

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

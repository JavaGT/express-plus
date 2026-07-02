# Fable 5 Review: workbench

A structural review and reimagining of **workbench** — a zero-dependency Node
framework for collaborative, persisted, realtime data. Written against the source
tree (not just the docs) with one live authorization probe. Suite was green
(`npm test` → fail 0) at review time.

---

## 1. Diagnosis — what workbench really is

Workbench is an **event-sourced collaboration kernel with a declarative entity
compiler bolted to an HTTP/WS transport**. Strip the vocabulary and there are
three real subsystems:

1. **A grant compiler** (`scope-sql.mjs`, `registry.mjs`, `authz.mjs`,
   `row-grant.mjs`) that lowers a per-entity predicate to a SQL `WHERE` (the read
   face) and runs a `.can` body per row at runtime (the capability face), from one
   check registry.
2. **A durable mutation pipeline** (`pipeline.mjs`) — one `applyInTxn` path:
   authorize → dedupe → handler emits events → append `_Log` with per-scope seq →
   project into rows → adopt blobs → post-grant → recurse effects → commit →
   post-commit fan-out. Everything (CRUD, effects, ticks, schedules, store
   mutations) is funneled through it.
3. **A field-descriptor system** (`field.mjs`, `field-strategy.mjs`,
   `entity.mjs`) that turns declared fields into columns, side-tables, hydration
   handles, projection reducers, and CRUD action/event types.

The honest summary: **the kernel is genuinely good and the design values are real,
but the entity layer has become the place where every concept is paid for in
code.** `entity.mjs` is 1509 lines because it is simultaneously the compiler, the
query API, five kinds of side-table handle factory, the projection reducer, the
DDL generator, and the CRUD handler map. The framework has *more* internal
coherence than its file layout admits and *less* API coherence than its docs
claim.

Two framings to push back on from the handoff:

- **"Is the realtime foundation too complex?"** No. The one-ingest-path /
  sequence-cursor / hard-fail-on-stale core is the most defensible thing in the
  codebase. It's the part to change *least* — every piece maps to a corruption bug
  it prevents.
- **"Is the auth model right?"** The *model* is right. The *implementation* has a
  fail-open seam for inherit-children, verified live (§6). That's a bug, not a
  design flaw — but it reveals that the scope/`.can` split has a hole the docs
  don't cover.

---

## 2. Preserve / change / delete

**Preserve (sacred — do not regress):**
- The one mutation pipeline + `durableMutationVariant` named-whole. `pipeline.mjs`
  is the best file in the repo.
- Sequence-cursor replay, bootstrap ordering, hard-fail on stale cursor
  (`createClient`, `LiveList`).
- `scope(...)` → SQL, `.can(...)` → runtime, from one check registry. The
  *concept* is the moat over Scope's inline-ownership debt.
- Fail-closed load-time errors: no-grant, non-compilable scope, two-scope-clauses,
  unawaited `is.*`.
- Persistence-by-engaged-seam (no class flag).

**Change (right idea, wrong shape):**
- Split `entity.mjs` and `serve.mjs` (§4).
- The subscribe/interest/pace surface exists in the server (`live-fanout.mjs`) but
  has **no client `subscribe(Entity, id, {fields, pace})` API** —
  `LiveChannel.subscribe` takes no interest at all. SPEC §8.1 describes an API that
  isn't wired end to end.
- `mayRow`'s `hasOwnCanGrant`-skip is load-bearing *and* fail-open for
  inherit-children (§6).
- Field `.can` for inherit-children: `defaults` is `{granted:false}`, so every
  child field needs an explicit `.can` or it's unreadable — the opposite of
  "strong-inherit." (DECISIONLOG #263 admits this.)

**Delete (ceremony / duplicate paths):**
- `presence()` — it's literally `ephemeral()` (`field.mjs:309`). AGENTS.md's own
  "retire the special-case" rule says delete it. Keep `ephemeral`.
- `open()` / `allowAnonymous()` — identical (`route-gate.mjs`). Keep one.
- `.use` / `.mount` aliases — keep `.mount`.
- `enum_` — fold into `text({ oneOf: [...] })`; the trailing underscore is a code
  smell the naming rule would reject.
- `app.ddl()` as a manual step — the framework owns the DB; DDL should run inside
  `app.ready`, not be a call the app remembers.
- The dead `onAdded`/`onRemoved` handles on `map` (entity.mjs re-keys them, comment
  says "dead below").

---

## 3. Ideal developer API

Changes: **derived defaults over ceremony, one owner concept, subscribe with
interest, and no manual DDL.**

### Todo (the floor)
```js
import workbench, { entity, text, boolean, date, owner, now } from 'workbench'

export const Todo = entity('Todo', {
  title:     text({ required: true }),
  done:      boolean({ default: false }),
  dueAt:     date({ optional: true }),
  owner:     owner(),            // replaces ref('User',{role:'owner',readonly:true})
  createdAt: date({ default: now }),

  // one-liner grant: owner does everything, nobody else sees the row
  grant: owner.only(),          // sugar; expands to scope(is.owner).can(all-if-owner)
})

workbench({ db }).mount('/todos', Todo)   // no .listen needed for tests; no .ddl()
```
Two moves: `fields:` is dropped (the non-reserved keys *are* the fields —
`grant`/`checks`/`routes`/`effects` are the reserved set), and `owner()` collapses
the `ref('User', { role:'owner', readonly:true })` triple the handoff flagged as
conflating relation + ownership + write-policy. `owner.only()` is an authorization
*function* (not a magic string) the compiler recognizes structurally — it deletes
the boilerplate every private entity writes today.

### Public blog
```js
export const Post = entity('Post', {
  title: text({ required: true }),
  body:  text.crdt(),
  published: boolean({ default: false }),
  publishAt: date({ optional: true }),
  author: owner(),

  grant: [
    scope(({ is, fields }) => anyOf(fields.published.is(true), is.author()))
      .can(({ is }) => is.author() ? all() : readOnly()),
  ],
  gate: { list: anyone(), read: anyone() },  // route-gate opt-out beside grant, not on .listen

  on: { [schedule.at('publishAt')]: set({ published: true }) },  // scheduled publish
})
```

### WhatsApp-style chat (one action model, three seams)
```js
export const Room = entity('Room', {
  name: text(),
  members: members(ref('User'), { role: ['member','admin'] }),   // durable side-table

  messages: log({ sender: owner.ref(), body: text() }),           // durable, replayed
  typing:   ephemeral({ userId: ref('User') }),                   // volatile, coalesced, no _Log
  presence: ephemeral({ lastSeen: date() }),                      // ephemeral heartbeat

  grant: [
    scope(({ is }) => is.member())
      .can(({ is }) => is.admin() ? all() : grant(read, write, subscribe)),
  ],
})
```
Durable / ephemeral / volatile differ only by which field kind is engaged, all
under one `grant`. The kernel already does this; the sketch names it cleanly.

### Scope-like media annotation
```js
export const Clip = entity('Clip', {
  media:   blob({ required: true }),
  thumb:   projected.async({ compute: makeThumb }),      // post-commit projection
  transcript: text.crdt(),
  annotations: list(ref('Annotation')),
  notes:   text().can(({ is }) => is.author() ? all() : withheld()),  // private field
  owner:   owner(),
  project: ref('Project', { required: true }),
  grant: inherit(Project, { via: 'project' }),
}, { subscribe: { annotations: true, transcript: true } })
```
Client:
```js
const store = createLiveStore({ name: 'Clip', path: '/clips' })
const clip = store.subscribe(id, { fields: { annotations: true }, pace: coalesce({ window: 50 }) })
clip.onRender(render)
await store.update(id, { title })   // optimistic; ingest resolves
```
The client `subscribe` **carries interest and pace** — today it doesn't, and that
gap blocks minecraft/canvas/invaders (the whole Phase 2 justification).

---

## 4. Internal architecture — module boundaries

**`entity.mjs` (1509 → ~5 modules).** It mixes six responsibilities. Split by
responsibility, not by field kind:

| New module | Owns | Pulled from |
|---|---|---|
| `entity/compile.mjs` | name/field validation, authz assembly call, write core (`create`/`insert`/`delete`), CRUD handler assembly, freeze/orchestration | entity.mjs top + write section + bottom |
| `entity/query.mjs` | `findOne/findAll/findById/getOrFail`, `hydrate` exposure, `deserializeRow`, `makeQueryBuilder` | query API section |
| `entity/hydrate.mjs` | `hydrate`, struct/hash/derived assembly, `deserializeStoredCells` | hydration section |
| `entity/handles.mjs` | typed field-handle Proxy registration | proxy/field handle bottom |
| `entity/projection.mjs` | `record.projection.eventTypes` and `record.projection.apply` | projection section |

The five handle factories and their matching projection-apply branches and their
matching `*MutateHandlers` are **three parallel switch statements over the same
field-kind set** (map/ordered/log/ephemeral). That's the real smell: adding a
field kind means editing three places. Concentrate them into **one per-kind
"side-table strategy" object** — `{ handle, mutateHandlers, projectionApply, ddl }`
keyed by kind, resolved the way `field-strategy.mjs` already resolves value
strategies. That is a genuine *concentration* (deletes the triplication), not a
relocation.

**`serve.mjs` (1315 lines).** Split transport from framework endpoints:
- `serve/http.mjs` — `makeRequestHandler`, `matchRoute`, body parsing, `runChain`,
  the res facade.
- `serve/endpoints.mjs` — snapshot / events-since / blobs / jobs / health
  interception (all "framework-owned, intercepted before matchRoute" — one concept).
- `serve/lifecycle.mjs` — `listen`, graceful shutdown, reaper/tick/log-retention
  timer wiring.
- `dispatch.mjs` — the CRUD-verb `dispatch()` (the second auth layer application).

The res-facade `stream()` and multipart parsing are ~250 lines that belong in their
own `serve/body.mjs` and `serve/response.mjs`.

---

## 5. Public API boundary — what `index.mjs` should expose

`index.mjs` currently re-exports **~90 symbols**, including deep internals:
`bindReadScope`, `compileInheritScope`, `resolveDecision`, `durableMutationVariant`,
`noBlobAdapter`, `parseEventType`, `discoverTickedRows`, `verifyAdmissionHandshake`,
`FrameSender`, `buildKernel`. An app author needs maybe 25 of them.

**Public (app-facing):**
- App: `default (workbench)`, `router`
- Entity + fields: `entity`, `text`, `number`, `boolean`, `date`, `ref`, `owner`,
  `blob`, `json`, `hash`, `map`/`members`, `list`, `log`, `ephemeral`, `state`,
  `projected`, `text.crdt`
- Grant: `scope`, `grant`, `deny`, `read`, `write`, `subscribe`, `admin`, `anyOf`,
  `everyone`, `never`, `inherit`, `owner.only`
- Gate: `requireUser`, `anyone` (rename of `allowAnonymous`)
- Effects/time: `effect`, `schedule`, `tick`, `inc`, `dec`, `set`, `many`, `now`
- Framework entities: `User`, `Session`, `Inbox`, `principal`, `anonymous`
- Client (separate entry `workbench/client`): `createLiveStore`, `LiveChannel`,
  `LiveList`

**Move to `workbench/internal`** (documented as unstable, for tests/extensions):
everything else — the SQL lowerer, the pipeline variant, the kernel builder, the
check `resolveDecision`, the websocket frame codec, DDL generators.

The test suite reaches into internals heavily, so a `workbench/internal` barrel
keeps the suite green while the public surface shrinks — a staged move, not a break.

---

## 6. Auth review — the model is right, but there's a live fail-open

Verified against running code (direct probe, not just reading). An `inherit`-child
entity has no own `.can` clause, so `hasOwnCanGrant` returns false, and `mayRow`
**short-circuits to `true` for every verb**:

```
Comment hasOwnCanGrant: false
mayRow(Comment, 'update', <alice's row>, mallory): true
mayRow(Comment, 'remove', <alice's row>, mallory): true
```

So on the todo/comment inheritance pattern the docs hold up as canonical
(`SharedTodo`, `comment.mjs`), **any principal who can *read* a row can *write and
delete* it.** The read scope filters visibility correctly, but write/remove
capability is not checked at all for inherit-children. `mayRow`'s own comment says
the skip exists because "an inherit child's capabilities follow its parent,
resolved upstream" — but for **write** there is no upstream resolution on the
child's HTTP dispatch path. `row-grant.mjs:140-147` returns `true`, and `serve.mjs`
update/remove call exactly that.

**This is the single highest-priority finding.** The fix is architectural, not a
patch: **`inherit` must lower the parent's `.can` the same way it lowers the
parent's scope.** `compileInheritScope` already re-lowers the parent's scope AST
under a join alias; the capability half needs the analogous move — the child's
`mayVerb` should load the parent row via the `via` FK and run the *parent's*
`.can`. Until then, inherit-children are read-scoped but write-open.

On the model itself, three judgments:

- **The scope/`.can` split is worth keeping.** The performance boundary
  (SQL-compilable read filter vs runtime capability) is real and Scope proves the
  alternative (inline per-handler ownership) rots. Don't collapse it.
- **The route-gate vs row-grant split is *not* arbitrary** — they answer different
  questions (may this principal reach the handler vs may they touch this row) and
  the row grant runs regardless of the gate. Keep both. But **move `gate:` off
  `.listen()`/routes and onto the entity declaration** next to `grant` — they're
  one authorization story and currently live in two places (the handoff's
  `principalOf`-on-`.listen` complaint is the same smell).
- **Field `.can` "strong-inherit" is half-built.** It works for own-`.can`
  entities but returns `granted:false` defaults for inherit-children (#263). Either
  make inherit propagate field defaults too, or document that inherit-children must
  declare field `.can` explicitly — right now it's a silent trap.

---

## 7. Realtime review

The strongest subsystem. One ingest path, sequence cursors, gap→resync,
stale→hard-fail, bootstrap-before-stream — all present and correctly structured
(`pipeline.mjs createClient`, `public/workbench-client.mjs LiveList`). Keep it.

Gaps, in priority order:
1. **Client interest/pace is not wired.** `LiveChannel.subscribe(entity, id,
   onEvent)` sends `{type:'subscribe', entity, id}` with no `fields`/`pace`. The
   server (`live-fanout.mjs`) *has* interest filtering and pace buffers, but they
   only trigger for ephemeral field events and the subscribe admission
   (`live-connection.mjs`) would need to accept and forward the interest spec.
   SPEC §8.1's `subscribe(Entity, id, {fields, pace})` is the documented API and
   it's the thing minecraft/canvas need. **Build this before any new field kinds.**
2. **`live-fanout.emit` re-reads + re-hydrates the row via `findById` for every
   subscriber batch** (`live-fanout.mjs:155`). At 30–60Hz with many subscribers
   this is a per-event full row read + hydrate. The delta projector caches shadow
   state but the authz row read isn't cached. Latch it per (scope, commit) like the
   re-auth is latched.
3. **`removed` events skip re-authorization entirely** and forward to all current
   subscribers (`live-fanout.mjs:150,176`). Comment justifies it as "the remove IS
   the revocation signal," which is defensible, but a subscriber who lost read
   access between the last event and the remove still learns the row was removed.
   Probably fine; worth an explicit ADR since it's a deliberate hole in
   "re-auth every delivery."

---

## 8. Effects / projections / time review

These **are** one coherent system already, and the code proves it better than the
docs claim: in-transaction effects, ticks, schedules, and store mutations all
re-enter `durableMutationVariant.applyInTxn`. Post-commit projections (blobs
finalize, live fan-out, projected.async, webhooks) all hang off `afterCommit`. The
atomicity boundary (in-txn rolls back origin; post-commit doesn't) is the correct
and only split.

Where it's *too many neighboring concepts on the surface*:
- `derived` vs `projected.inline` vs `projected.async` are three names for
  "computed field." Genuinely different (read-time pure / in-txn / post-commit) and
  the naming rule justifies distinct names — **but** `derived` and
  `projected.inline` are both "cheap synchronous compute," differing only in whether
  the result is stored. Consider `computed({ compute })` (read-time) and
  `computed.stored({ compute, async? })` — two names, one for "materialized or
  not," a boolean for "crosses the txn boundary." Deletes one top-level concept.
- `state.auto` is documented as sugar over `schedule.after` but the entity compiler
  still special-cases `state` transitions in the CRUD update handler
  (entity.mjs:1205-1239). Make `state.auto` actually *compile to* a `schedule`
  entry so there's one time-source path, per the ADR's own promise.
- Effects keyed by stringified transition handles
  (`state.transition('shared','archived')`) and by map `onAdded` handles are two
  keying conventions in one `effects` map. The re-keying dance in
  entity.mjs:200-216 (rewriting `map:onAdded` → `Doc.collaborators.added`) is
  exactly the "stringified keys, not one typed handle protocol" awkwardness the
  handoff named. Give every trigger one typed handle type.

---

## 9. Migration plan (staged, tests stay green)

1. **Fix the inherit-child write fail-open (§6).** Highest priority; a security
   bug. Add a RED test (Mallory updates Alice's comment on a published post → must
   403), then make `mayRow`/`inherit` resolve the parent `.can`. ~1 module.
2. **Delete the duplicates** (`presence`, `open`, `.use`, dead `onAdded`): pure
   subtraction, retire each in the same commit that removes its last caller.
3. **Split `serve.mjs`** into http/endpoints/lifecycle/dispatch. Mechanical; no
   behavior change.
4. **Concentrate the side-table field kinds** into one strategy object; split
   `entity.mjs` into the 5 modules. The big one — do it behind the suite, one kind
   at a time (map first, it has the most tests).
5. **Wire client `subscribe(entity, id, {fields, pace})`** end to end. Unblocks
   Phase 2 apps.
6. **Shrink `index.mjs`** to the public set; add `workbench/internal` for the rest;
   point tests at internal.
7. **Sugar layer** (`owner()`, `owner.only()`, `fields:`-less declaration, `gate:`
   on entity, DDL inside `app.ready`). Purely additive — old forms keep working
   until the exemplars migrate.
8. **Collapse `derived`/`projected.inline`; make `state.auto` compile to
   `schedule`.**

Steps 1–3 are safe and high-value; 4 is the large irreversible one (pay it
deliberately, like the DECISIONLOG's other big migrations); 5 is the feature
unblock; 6–8 are ergonomics.

---

## 10. Highest-risk decisions (most likely to hurt if wrong)

1. **The inherit-child capability hole (§6).** If shipped, it's a silent
   authorization bypass on the framework's flagship inheritance pattern. #1 by a
   wide margin.
2. **Splitting `entity.mjs` (step 4).** The Proxy, the frozen record, the
   projection reducers, and the query API are entangled. A bad split reintroduces a
   second write path. Do it kind-by-kind behind tests; never leave two side-table
   paths alive (AGENTS.md's own rule).
3. **Client subscribe interest.** If the wire protocol for `{fields, pace}` is
   designed wrong now, every Phase 2 app inherits it. Design the interest grammar
   (AND-only, indexed, data-not-code) into the protocol *before* building consumers.
4. **`owner()` / `owner.only()` sugar.** If it becomes a magic string or a hidden
   default grant, it violates the load-bearing "authorization is always a function,
   no default grant" value (ADR #7). Must expand to a visible, overridable function
   — sugar, never a trapdoor.
5. **The `hasOwnCanGrant` skip pattern generally.** Copied conceptually across
   list-filter, snapshot, create-hook, and live-fanout. It's the "drop it and
   admit/deny flips" landmine `row-grant.mjs` warns about. Any refactor touching
   capability resolution must treat this as one concept with one test battery, or
   the four call sites drift.
6. **Deferring the field-kind toolkit while shipping four CRDT instances.**
   `raster`/`polyline` are whole-value-replace stubs (DECISIONLOG #262). If an app
   ships on them expecting merge, the "CRDT" promise is false. Keep them clearly
   labeled as replace-not-merge until the toolkit lands.

---

## Net

The kernel and the design values are strong enough to build a serious framework on.
The work is not "rethink the foundations" — it's (a) close one real auth hole,
(b) break up two god-modules by concentrating the triplicated field-kind logic,
(c) finish the client subscribe surface the whole realtime story depends on, and
(d) shrink the public API to match the clean model the docs describe. The single
thing to fix first is the inherit-child write authorization.

**Caveat on the auth finding:** `mayRow` returning `true` for inherit-children was
verified via a direct probe, and the `serve.mjs` update/remove path that consumes
it was traced — but a full HTTP server was not stood up to observe an end-to-end
403-vs-200. An end-to-end test next to the fix would make the bug (and then the
fix) concrete.


---

## Decisions (Fable 5 review — settled direction)

The full review lives in `FABLE-5-REVIEW.md`. The ten sections there are analysis;
this section is the part that is now **decided**. Section 10 of the review named
the highest-risk forks; the calls below resolve each one so a future implementer
does not re-litigate them. Treat these as binding direction (same status as
AGENTS.md), overridable only by the user.

### D1 — Inherit-child write authorization: FIX, and it is the first task.

An `inherit`-child entity (`comment.mjs`, `SharedTodo`) has no own `.can`, so
`mayRow` short-circuits to `true` for every verb — verified live: any principal
who can *read* the row can *write and delete* it. This is a security bug on the
framework's flagship inheritance pattern, not a design tradeoff.

Decision: **`inherit` lowers the parent's capability half the same way
`compileInheritScope` already lowers the parent's scope.** The child's `mayVerb`
loads the parent row via the `via` FK and runs the *parent's* `.can`. Land it
RED-first: a test where a non-owner updates another user's comment on a published
post must 403, then GREEN. This ships before any refactor, sugar, or new feature.
Non-negotiable.

### D2 — Splitting `entity.mjs`: DO IT, incrementally, never big-bang.

Decision: **Concentrate the map/ordered/log/ephemeral triplication into one
per-kind side-table strategy object** (`{ handle, mutateHandlers, projectionApply,
ddl }`), resolved like `field-strategy.mjs` resolves value strategies — then split
`entity.mjs` into the five modules named in review §4. Do it **one field kind at a
time behind the green suite** (map first — most tests). At no point may two
side-table write paths coexist (AGENTS.md: a working second path is still a second
path). This is the large irreversible migration; pay it deliberately, not as a
rewrite. Sequence: after D1 and after the duplicate deletions (D-cleanup).

### D3 — Client subscribe interest/pace: DESIGN THE WIRE PROTOCOL NOW, wire end-to-end as one unit.

The server has interest filtering + pace buffers; the client `LiveChannel.subscribe`
sends none of it. Every Phase 2 app (minecraft, canvas, invaders) inherits whatever
protocol ships.

Decision: **Commit to SPEC §8.1's grammar as the wire contract before building any
consumer** — field-keyed interest, AND across dimensions, per-dimension one
`range` OR one finite `.in([...])` OR `.is(v)`, no cross-dimension OR, no closures,
data-not-code, indexed-or-subscribe-time-error. Implement `subscribe(entity, id,
{ fields, pace })` end to end (client `LiveChannel` → `live-connection` admission →
`live-fanout` filter) in one change; do not land a half-wired surface. This unblocks
Phase 2 and must precede any new field kind.

### D4 — `owner()` / `owner.only()` sugar: BUILD IT, as a transparent expansion.

Decision: **Ship the sugar, defined by what it expands to, recognized structurally
(never a magic string, never a hidden default grant).**
- `owner()` expands to `ref('User', { role: 'owner', readonly: true })` — one
  concept for the relation+ownership+write-policy triple the handoff flagged.
- `owner.only()` expands to
  `[ scope(({is}) => is.owner()).can(async ({is}) => (await is.owner()) ? grant(read, write, subscribe, admin) : deny('not the owner')) ]`
  — a visible, overridable authorization *function*, printable in a dev diagnostic.
An entity that writes `owner.only()` and an entity that writes the expansion by hand
must compile to the identical record. ADR #7 (no default grant, authorization is
always a function) stands: the sugar is a shorthand the developer chose to type, not
a default the framework injects when they typed nothing. A no-grant entity is still
a load-time error.

### D5 — The `hasOwnCanGrant` skip: ONE concept, ONE denial-coverage test battery.

The admit-when-no-own-`.can` skip is copied conceptually across list-filter,
snapshot, create-hook, and live-fanout — the "drop it and admit↔deny flips"
landmine `row-grant.mjs` warns about. D1 changes what "no own `.can`" means for
inherit-children, so this must move in lockstep.

Decision: **`mayRow` is the single home for the skip; the four transports call only
`mayRow`, never re-derive the skip.** Add one shared denial-coverage battery (a
readable-but-not-writable row, an inherit-child, a scope-only grant) run against
every transport, so the four sites cannot drift. Any future change to capability
resolution touches `mayRow` + this battery, nowhere else.

### D6 — CRDT stubs (`raster`/`polyline`): KEEP AS LABELED REPLACE-NOT-MERGE, defer the toolkit.

`raster.crdt()` / `polyline.crdt()` are whole-value-replace, not merging CRDTs
(DECISIONLOG #262). Building the merge toolkit now is speculative — no `projects/*`
app is the active spine for it, and "proactive ≠ exhaustive" (AGENTS.md).

Decision: **Do not build the CRDT-authoring toolkit yet.** Keep `text.crdt` (real
merge) as the shipped proof; keep `raster`/`polyline` as explicitly labeled
replace-not-merge stubs. Add a dev-mode diagnostic when a replace-stub field is
updated, warning that concurrent edits are last-write-wins and will not merge.
Revisit only when photo-editor / drawing-canvas becomes the active spine and proves
the need.

### Ordering of the settled work

1. **D1** — inherit-child write authz (security; RED-first).
2. **D-cleanup** — delete `presence`/`open`/`.use`/dead `onAdded`; `enum_` → `text({oneOf})`; DDL into `app.ready` (review §2).
3. **D5** — consolidate the skip + denial battery (rides on D1).
4. **serve.mjs split** (review §4) — mechanical, no behavior change.
5. **D2** — entity.mjs concentration + split, one kind at a time.
6. **D3** — client subscribe interest/pace, end-to-end.
7. **D4** — `owner()` / `owner.only()` sugar + the rest of the ergonomics layer (review §3), additive.
8. **index.mjs shrink** (review §5) + **D6 dev diagnostic** + effects/time simplification (review §8).

D1 is the only item that is urgent on its own merits; everything after is
quality/ergonomics/feature work that can land in the order above behind the green
suite.

## Progress log

- **D1 DONE** — `inherit`-child write authz fixed (`src/row-grant.mjs` `mayRow`):
  an inherit child loads the parent row via the `inherited.via` FK and recursively
  runs the parent's `.can`. RED-first test added. Committed `2338b97`.
- **D5 DONE** — `hasOwnCanGrant` skip consolidated in `mayRow` (single home); a
  shared denial-coverage battery (`test/row-auth-transport-battery.test.mjs`)
  runs against every transport (list-filter, snapshot, create-hook, live-fanout).
  Committed `192ad56`.
- **D-cleanup DONE** — retired duplicate public aliases; `enum_` → `text({oneOf})`;
  DDL prepared during `app.ready`. Commits `437fceb`, `6fc29c4`, `55e2111`.
- **serve.mjs split DONE** — extracted `http-body`, `http-handler-chain`,
  `http-response`, `http-route-match`, `http-row-read` (serve.mjs 1315 → 875).
  Commits through `c899488`.
- **D2 map-first DONE** — created `src/side-table-strategy.mjs` owning the map
  kind's `{ handle, mutateHandlers, projectionApply, eventTypes, ddl }`, resolved
  like `field-strategy.mjs`. Removed the map handle factory, map mutate handlers,
  map projection-apply branch, map eventTypes spread, and `mapTableDDL` from
  `entity.mjs`/`ddl.mjs`; both now call the strategy table. Suite green (948/0).
  entity.mjs 1484 → 1273. Committed `40e1c89`.
- **D2 ordered DONE** — migrated ordered handles, mutate handlers, projection apply,
  eventTypes, and DDL into the side-table strategy table. Removed the old ordered
  handle/projection/mutate/DDL path in the same change (no duplicate write path).
  Suite green (948/0). entity.mjs 1273 → 1043. Committed `e78c4df`.
- **D2 log + ephemeral DONE** — migrated the remaining side-table kinds into
  `src/side-table-strategy.mjs`. Removed `logFields`/`makeLogHandle`/
  `appendLogHandlers`/log projection/`logTableDDL` and `ephemeralFields`/
  `makeEphemeralHandle`/`ephemeralMutateHandlers`/ephemeral projection/
  `ephemeralTableDDL` from `entity.mjs`/`ddl.mjs`. `entity.mjs` now resolves all
  side-table behavior through one strategy table; `ddl.mjs` delegates every side
  table to `sideTableDDL`. Syntax checks and full suite green (948/0). Current
  line counts: entity.mjs 786, side-table-strategy.mjs 636, ddl.mjs 157.
- **D2 entity split DONE** — kept `src/entity.mjs` as the stable public import and
  moved the compiler body into `src/entity/compile.mjs`, with query, hydration,
  projection, and field-handle registration extracted to `src/entity/query.mjs`,
  `src/entity/hydrate.mjs`, `src/entity/projection.mjs`, and
  `src/entity/handles.mjs`. `compile.mjs` is now the orchestrator; side-table
  behavior remains owned by the strategy table. Syntax checks and full suite green
  (948/0). Current line counts: entity.mjs 1, entity/compile.mjs 472,
  entity/query.mjs 80, entity/hydrate.mjs 56, entity/projection.mjs 115,
  entity/handles.mjs 20.
- **D3 client subscribe interest/pace DONE** — wired SPEC §8.1's
  `subscribe(entity, id, { fields, pace })` through the SDK while preserving old
  calls. `LiveChannel.subscribe` now sends `fields`/`pace` and stores them for
  reconnect re-subscribe; `LiveList` and `createLiveStore().subscribe(id,
  options)` pass the same options through. Server admission/fanout already owned
  validation/filtering/pace, so no second delivery path was added. Focused
  client/live tests green (38/0); syntax checks, diff check, and full suite green
  (952/0).
- **D4 owner sugar DONE** — added public `owner()` / `owner.only()` as transparent
  expansion, not a hidden grant. `owner()` returns the ordinary owner ref-role field
  (`ref('User', { role: 'owner', readonly: true })`); `owner.only` is the explicit
  owner-only grant thunk and compiles through the same scope/can/static-guard path.
  Focused entity tests green (13/0); syntax checks, diff check, and full suite green
  (954/0).
- **index.mjs shrink DONE** — `src/index.mjs` now exports only the app-facing public
  surface, while the former full barrel moved to `src/internal.mjs` and the
  `workbench/internal` package subpath. Tests and exemplars that reach internal
  compiler/transport/auth/effect helpers now import the unstable internal barrel;
  no symbol was deleted. All `.mjs` files pass `node --check`; diff check and full
  suite green (954/0). Current line counts: index.mjs 14, internal.mjs 33.
- **D6 replace-stub diagnostic DONE** — kept `raster.crdt()` / `polyline.crdt()` as
  CRDT-kind field constructors but made their delta contract explicit whole-value
  `{ set }` replace rather than text-style insert/delete. In development,
  replace-stub updates emit a diagnostic warning that concurrent edits are
  last-write-wins and will not merge. Focused field-delta tests green (25/0).
- **Effects/time simplification DONE** (review §8; the hard version, no aliases):
  - **Typed effect handles** — entity effects are now array pairs `[[handle, { mutate,
    with, when }]]` (or `effects: (Self) => [...]`), not object keys; object keys
    silently stringified typed handles, which the compiler could not distinguish from
    literal strings. `effect.anyOf(...)` accepts branded event/state-transition handles
    only; `src/effect-compiler.mjs` no longer accepts strings or does colon→dot
    normalization. `src/entity/handles.mjs` exposes typed lifecycle handles
    (`Doc.created`/`.updated`/`.removed`); `src/scope-sql.mjs` map/ordered/log field
    handles expose typed native handles (`.added`/`.inserted`/`.appended`…).
    `state.transition(from,to)` is now a branded `state-transition-handle`. Reserved
    `created`/`updated`/`removed` as field names (lifecycle collision → load-time
    error). All in-repo entity-level effect declarations migrated to array pairs;
    state-field transition effects remain the separate `state({ effects: {
    [state.transition(...)]: ... } })` descriptor map. `native(...)` is internal-only
    (projection projector handles + `native()` unit tests).
  - **computed() / computed.stored()** — collapsed `derived` (read-time, unstored) and
    `projected.inline` (stored compute) into one `computed` concept: `computed({ compute })`
    (read-time pull, no column) and `computed.stored({ compute })` (stored, has a column,
    recomputed in projection). `projected.async` is unchanged. No aliases: the old
    `derived` option and `projected.inline` are gone. Hydrator, DDL, field-strategy,
    projection, and compile.mjs migrated to the new `kind:'computed'`/`mode` descriptors.
    Exemplars (`doc.mjs`, `gdoc.mjs`) and tests migrated.
  - **state.auto → schedule.after** — `state.auto({ when, after, to, from })` now lowers
    at compile time into a real `schedule.after` trigger on the update verb, keyed by an
    explicit declared anchor field `from` (date/number, e.g. `updatedAt` with `touch:true`).
    No hidden timestamp column. `record.schedule[verb]` is now array-capable so an
    explicit `schedule.update` and an auto-lowered trigger can coexist (stored scalar
    when a verb has exactly one trigger, to preserve existing `Entity.schedule.update.kind`
    test access). schedule discovery/admission, reaper, and tick-engine iterate trigger
    arrays and carry a stable `sourceName` per trigger. Removed the redundant special-case
    path: `state.auto` now fires through the same schedule mechanism as explicit schedules.
  - Decision notes: this was a risky slice (public field API + state runtime + effect
    keying, 5+ modules, exemplars) executed as three verified slices behind the green
    suite. No second path was left alive for any sub-goal. Added two new tests proving
    `state.auto` lowers to `schedule.after` and coexists with an explicit update schedule.
  - Verification: `node --check` on all touched src/test/exemplar files, full `.mjs`
    syntax sweep, `git diff --check` clean, full `npm test` → **957 pass / 0 fail**.


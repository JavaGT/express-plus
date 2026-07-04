# Fable 5 Handoff: workbench

You are reviewing **workbench**: a zero-dependency Node framework for collaborative, persisted, realtime data.

The user wants more than a code review. Reimagine the framework’s structure, developer interface, naming, and core abstractions. Be willing to challenge current decisions. Prefer concrete API sketches over abstract advice.

The user is a hobbyist programmer building a serious framework. Write plainly.

---

## What workbench is trying to be

Workbench should let a developer declare collaborative data once and get:

- REST CRUD
- persisted event log
- realtime WebSocket sync
- row/field authorization
- optimistic client updates
- sequence-cursor replay
- declarative effects/reactions
- scheduled and tick-driven mutations
- blob lifecycle
- background jobs
- a small browser client SDK

It is not an Express plugin, generic ORM, or generic WebSocket wrapper. It is the cleaner second cut of a framework the user already built inside **Scope**, their shipped multimedia research data-coding app.

In Scope, realtime collaborative feature pages are reportedly 30–80 lines with no hand-written event plumbing. That is the DX target.

---

## Read these first

These docs are partly AI-written but mostly represent the user’s current intent. They are strong direction, not holy text.

1. `AGENTS.md` — design values and constraints.
2. `SPEC.md` — current canonical spec.
3. `DECISIONLOG.md` — decisions and rejected paths.
4. `PLANS.md` — implementation history/status.
5. `SCOPE-FINDINGS.md` — evidence from the shipped Scope app.
6. `projects/STRESS-TEST-FINDINGS.md` — nine-app stress-test synthesis.
7. `src/index.mjs` — public API surface.
8. `src/entity.mjs` — central, too large, likely refactor target.
9. `src/serve.mjs`, `src/pipeline.mjs`, `src/kernel.mjs`, `src/live*.mjs`, `src/authz.mjs`, `src/row-grant.mjs`.
10. `public/workbench-client.mjs`.

---

## Current design bets to review hard

### Authorization

Current shape:

```js
scope(({ is }) => is.owner()).can(async ({ is }) => {
  if (await is.owner()) return grant(read, write, subscribe)
  return deny()
})
```

Design intent:

- authorization is always functions, never magic strings or flags
- no `publicRead`, `role: 'admin'`, or `grant: 'owner'`
- `scope(...)` is SQL-compilable row visibility
- `.can(...)` is runtime capability logic
- live delivery, HTTP, effects, schedules, and subscriptions must not have separate auth paths

User note: the current split between route gate vs row grant, and SQL `scope` vs runtime `.can`, may be arbitrary. Evaluate it from first principles. If you change it, preserve fail-closed behavior and avoid magic roles or hidden bypasses.

### Realtime/sync

Current bet:

- every client state change is resolved through one `ingest` path
- optimistic UI is a visible placeholder
- echoed local events and foreign live events fold through the same reducer
- sequence cursors detect duplicate/gap/stale replay
- subscriptions use interest filters and backpressure after re-authorization

Review whether this is the right foundation or too complex.

### Effects/projections/time

Current bet:

- in-transaction effects are declarative `{ mutate, with }`
- they re-enter the same mutation pipeline
- target grants still apply
- cycles fail at load time
- emails/webhooks/external work are post-commit projections, not transaction effects
- schedules and ticks feed the same pipeline as typed sources

Review whether effects, projected fields, schedules, and ticks are one coherent system or too many neighboring concepts.

### Persistence by seam

A WhatsApp-style app should not need three unrelated systems for:

- durable messages
- ephemeral presence
- volatile typing indicators

The current philosophy is: one action/event model, different persistence/sync seams.

---

## Current implementation status

The project is not just a spec. It has a large green implementation.

Implemented:

- real `node:http` server
- `node:sqlite` CRUD
- DDL/migrations
- row grants + route gates
- unified check registry for SQL and runtime checks
- entity table as event-log projection
- durable mutation pipeline variant
- sequence-cursor replay
- WebSocket live server
- live subscribe admission + delivery re-auth
- field delta projector
- blob upload/adopt/finalize lifecycle
- job queue
- schedule/tick engines
- projected async/inline fields
- browser client: `LiveChannel`, `LiveList`, `createLiveStore`
- security/body/session/CSRF/write-queue/health/shutdown defaults

At last run: `npm test` → 943 pass, 0 fail.

---

## Current API shape

Typical entity:

```js
const Todo = entity('Todo', {
  fields: {
    title: text({ required: true }),
    done: boolean({ default: false }),
    owner: ref('User', { role: 'owner', readonly: true })
  },
  grant: () => [
    scope(({ is }) => is.owner()).can(async ({ is }) => {
      if (await is.owner()) return grant(read, write, subscribe)
      return deny()
    })
  ]
})

workbench({ db }).mount('/todos', Todo).listen(3000)
```

Public surface currently includes many things: entity/field constructors, grants, route gates, app/router, framework `User/Session/Inbox`, principals, pipeline internals, live internals, effects, schedules/ticks, DDL, row-grant helpers, kernel consumers.

Please decide what belongs in the public API and what should become internal.

---

## Known awkwardnesses

These are likely places to improve:

- `src/entity.mjs` is ~1500 lines and mixes compiler, handles, CRUD, projection, DDL, hydration.
- `src/serve.mjs` is also large and mixes transport, dispatch, framework endpoints, defaults.
- `presence` is a wrapper over `ephemeral`.
- `.use` and `.mount` are aliases.
- `allowAnonymous()` and `open()` are identical.
- `enum_` is awkward.
- route gates use both object maps and positional varargs.
- gate peeling is security-sensitive vararg magic.
- `app.ddl()` is manual despite DB/migrations being framework-owned.
- `principalOf` lives on `.listen()` while other infrastructure lives in `workbench({ ... })`.
- effects sometimes force fields to be declared outside the entity just to reference handles.
- state transition handles are stringified keys, not obviously part of one typed handle protocol.
- `readonly` on `ref` mixes relation, ownership, and write policy.

---

## Stress-test apps

Do not optimize only for CRUD. The known targets are:

- todo — simplest floor
- blog — scheduled publishing, anonymous read, subscriber fan-out
- reddit — trees, votes, moderation, public reads
- library — state machines, deadlines, holds queue, confidentiality
- drawing canvas — 60Hz strokes, cursors, CRDT, backpressure
- space invaders — 30Hz game loop, spectators/players, server authority
- minecraft — chunks, spatial interest, ticks, custom fields
- photo editor — raster CRDT, blobs, ordered layers, render projections
- google photos — media blobs, thumbnails, EXIF, geo/full-text, link share

Also consider:

- **WhatsApp clone**: durable messages, ephemeral presence, volatile typing, attachments, membership auth.
- **Scope-like research coding app**: media files, transcripts, annotations, codebooks, comments, private notes, thumbnails, embeddings/search, live cursors/selections.

---

## What to produce

Please return a structured review with:

1. **Diagnosis** — what workbench really is.
2. **Preserve / change / delete** — name the key ideas.
3. **Ideal developer API** — show concrete code for todo, public blog, WhatsApp-style chat, and Scope-like media annotation.
4. **Internal architecture** — proposed module boundaries, especially for `entity.mjs` and `serve.mjs`.
5. **Public API boundary** — what `src/index.mjs` should expose.
6. **Auth review** — whether the current model is right or should collapse/reshape.
7. **Realtime review** — one ingest path, cursors, interest, backpressure.
8. **Effects/projections/time review** — whether these are one system or need simplification.
9. **Migration plan** — staged, tests stay green.
10. **Highest-risk decisions** — the 5–10 choices most likely to harm the framework if wrong.

Be aggressive but concrete. If you propose a new abstraction, say what old concept it deletes. If it only moves complexity behind a new name, reject it.

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
  `[ scope(({is}) => is.owner()).can(({is}) => is.owner() ? grant(read, write, subscribe, admin) : deny('not the owner')) ]`
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
mutated concurrently (last-write-wins is silent data loss otherwise). Revisit only
when photo-editor / drawing-canvas becomes the active spine and proves the need.

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

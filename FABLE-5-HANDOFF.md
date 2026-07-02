# Fable 5 Handoff: workbench

You are reviewing **workbench**, a zero-dependency Node framework whose intent is:

> Workbench for collaborative, persisted, realtime data.

This handoff is written for a very strong model. Do not just review local code quality. The user wants you to **reimagine the library’s structure, developer interface, and conceptual shape** so it can become the best possible version of itself while preserving the hard-won design constraints below.

The user is a hobbyist programmer building a serious framework. Prefer concrete API proposals and app examples over abstract architecture talk.

---

## 1. What this project is

`workbench` is a distinct framework, not a patch to Express. The package should always be called `workbench`, never `express`.

It aims to let a developer declare collaborative data once, then get:

- REST CRUD
- persisted event log
- realtime WebSocket sync
- row-level authorization
- field-level access control
- optimistic client updates
- sequence-cursor replay
- declarative reactions/effects
- scheduled/tick-driven mutations
- blob lifecycle
- background jobs
- a small browser client SDK

The important phrase is **collaborative, persisted, realtime data**. This is not just routing sugar.

The project is intentionally zero-dependency and targets modern Node with built-ins such as `node:http`, `node:sqlite`, `node:crypto`, and `node:fs`.

Tests run with:

```sh
node --test
```

At handoff time, the test suite is green, with roughly 646+ tests.

---

## 2. The user’s deeper intention

The user has already shipped a production app named **Scope**, a multimedia research data-coding app. Scope is not just an imagined target. It is evidence.

In the shipped Scope codebase, the user created an app-agnostic collaboration framework inside `src/lib/wb/`: event-sourced, realtime, domain-agnostic, and roughly 2600 LOC. A realtime collaborative feature page in Scope is reportedly around 30–80 lines with no hand-written event handling.

`workbench` is the cleaner second cut of that idea.

The user does **not** want a generic ORM, a generic WebSocket library, or an Express clone. They want the framework they wish had existed before building Scope: a tool where declaring the domain model and authorization gives you durable collaboration almost for free.

Your job is to help decide what this should become.

---

## 3. Canonical docs to read first

These are partially constructed by AI but mostly represent the views of the user. That is to say, they are strong direction intentions, but can be changed for the right reasons. 

1. `AGENTS.md` — binding design rules. 
2. `SPEC.md` — canonical product/design specification.
3. `DECISIONLOG.md` — append-only ADR ledger. Many ideas are already rejected there.
4. `PLANS.md` — execution history and completion status.
5. `SCOPE-FINDINGS.md` — evidence mined from the shipped Scope app.
6. `projects/STRESS-TEST-FINDINGS.md` — synthesis from the stress-test apps.
7. `src/index.mjs` — public API surface.
8. `src/entity.mjs` — currently too large, but central.
9. `src/pipeline.mjs`, `src/kernel.mjs`, `src/serve.mjs`, `src/live*.mjs`, `src/row-grant.mjs`, `src/authz.mjs`.
10. `public/workbench-client.mjs`.

---

## 4. Non-negotiable design laws

These constraints matter more than preserving current code shape.

### 4.1 Authorization is always functions

Never magic strings, static role labels, or boolean flags.

Good shape:

```js
scope(({ is }) => is.owner()).can(async ({ is }) => {
  if (await is.owner()) return grant(read, write)
  return deny()
})
```

Bad shape:

```js
grant: 'owner'
publicRead: true
role: 'admin'
```

### 4.2 There are exactly two auth layers

1. **Route gate** — can this principal reach this handler?
2. **Row grant** — can this principal read/edit this row?

Relaxing the route gate does not bypass the row grant.

Public blog posts, for example, require both:

- route list gate allows anonymous
- row read scope admits published posts

### 4.3 Row read is SQL scope; other capabilities are runtime `.can`

`scope(...)` means read visibility. It compiles to SQL.

`.can(...)` means runtime capabilities like write/subscribe/admin. It may be async.

A non-compilable check inside `scope(...)` is a load-time error. No JS fallback.

### 4.4 No second auth path

HTTP, WebSocket delivery, subscriptions, effects, scheduled jobs, and tick loops must all use the same authorization concepts.

Live events are re-authorized before delivery.

### 4.5 One reconciliation path

Client events become state in exactly one place: `ingest`.

Optimistic apply is a visible placeholder. The final state comes from folding events through the same reducer path used for echoed and foreign events.

No separate “apply my own edit” path.

### 4.6 Effects are bounded in-transaction mutations, not callbacks

Declarative effects look like:

```js
effects: {
  [Doc.collaborators.onAdded]: {
    mutate: Inbox,
    with: { recipient: self.value, kind: 'invite' }
  }
}
```

They re-enter the one mutation pipeline in the same transaction. Target grants still apply. Cycles are load-time errors.

Out-of-band work like emails/webhooks is not an effect. It is a post-commit projection over the event log.

### 4.7 Persistence is opt-in by engaged seam

There should not be three unrelated primitives for durable messages, ephemeral presence, and volatile typing. A WhatsApp-style app should express all three by engaging different seams of one action/event model:

- durable message history
- ephemeral online presence
- volatile typing indicator

### 4.8 Prefer one mechanism

The project strongly rejects two parallel paths that do the same thing. If you introduce a general mechanism, retire the special case it absorbs.

This is especially relevant because the current API still has some duplicate names and half-retired shapes.

---

## 5. Current mental model

A working entity currently stands on two declarations:

1. Declare the entity fields.
2. Declare its grant.

An entity with no grant is a load-time error.

Example shape:

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
```

An app mounts entities:

```js
const app = workbench({ db })
  .mount('/todos', Todo)
  .listen(3000)
```

The framework then owns the route table, transport, DB-backed CRUD, auth, event log, live fanout, and client sync.

---

## 6. Current implementation status

P1–P7 are complete in `PLANS.md`, plus several scope-support slices.

Important implemented pieces:

- real `node:http` server
- DB-backed CRUD over `node:sqlite`
- generated DDL and migrations
- row grants and route gates
- unified auth check registry for SQL + runtime
- entity table as projection consumer of events
- durable mutation pipeline variant
- sequence-cursor event replay
- WebSocket live server
- subscribe-time admission and delivery-time re-auth
- field delta projector
- blob upload/adopt/finalize lifecycle
- job queue and worker endpoints
- scheduled sources and tick sources
- projected async and inline fields
- client SDK with `LiveChannel`, `LiveList`, `createLiveStore`
- security headers, body parser, sessions, CSRF foreign-origin guard, write queue, health/stats, graceful shutdown

The suite is green.

---

## 7. Important source map

Approximate module roles:

- `src/index.mjs` — public API exports.
- `src/entity.mjs` — entity compiler, query handles, CRUD handlers, projection logic. Very large and awkward.
- `src/app.mjs` — app/router/mount resolution.
- `src/serve.mjs` — HTTP server, dispatch, framework endpoints. Also large.
- `src/pipeline.mjs` — action/event pipeline and durable variant.
- `src/kernel.mjs` — composition root for handlers, projections, effects, consumers.
- `src/authz.mjs` — unified check registry and read-scope compile harvesting.
- `src/scope-sql.mjs` — SQL predicate compiler.
- `src/row-grant.mjs` — runtime row/field grants.
- `src/field.mjs` — field constructors.
- `src/field-strategy.mjs` — kind-based validation/apply/diff/serialize strategies.
- `src/field-delta.mjs` — live delta projection.
- `src/effect-compiler.mjs` — declarative effects, admission handshake, cycle checks.
- `src/live.mjs` — live composition root.
- `src/live-fanout.mjs` — subscription registry, pacing, delivery.
- `src/live-admission.mjs` — subscribe-time validation/auth.
- `src/live-connection.mjs` — connection handling.
- `src/session.mjs` — server-side session principal hydration.
- `src/blob-store.mjs`, `src/blob-lifecycle.mjs` — blob lifecycle.
- `src/job-queue.mjs` — job queue.
- `src/schedule.mjs`, `src/tick-engine.mjs`, `src/reaper.mjs` — time-driven mutation sources.
- `public/workbench-client.mjs` — browser client SDK.

---

## 8. Current public API surface

The API includes:

- `entity(name, decl)`
- fields: `text`, `text.crdt`, `raster.crdt`, `polyline.crdt`, `boolean`, `enum_`, `date`, `number`, `json`, `hash`, `ref`, `blob`, `map`, `log`, `list`, `projected.async`, `projected.inline`, `ephemeral`, `presence`, `state`, `state.transition`, `link`
- capabilities: `read`, `write`, `subscribe`, `admin`
- grants: `grant(...)`, `deny()`, `scope(...).can(...)`
- scope helpers: `everyone`, `never`, `anyOf`, `inherit`, `bindReadScope`
- route gates: `requireUser`, `allowAnonymous`, `open`
- app/router: `workbench`, `router`, `.mount`, `.use`, `.get/post/patch/delete`, `r.resource`, `.ddl`, `.listen`, `.static`
- framework entities: `User`, `Session`, `Inbox`
- principals: `principal`, `anonymous`, `principalFrom`, `effectSource`
- pipeline: `action`, `event`, `createServer`, `createClient`, `durableMutationVariant`
- live/WS: `createLiveServer`, `upgradeWebSocket`, `FrameSender`, `FrameParser`
- effects: `inc`, `dec`, `self`, `many`, `effect`
- time: `now`, `schedule`, `tick`, `tickSource`, `startTickEngine`, `startReaper`
- field validation/deltas: `resolveStrategy`, `validateMutation`, `computeDelta`, `createDeltaProjector`
- row grant: `mayVerb`, `mayFieldOp`, `mayRow`
- DDL: `generateDDL`, `executeDDL`, `generateFrameworkDDL`, `executeFrameworkDDL`
- kernel consumers: `buildKernel`, `createProjectedAsyncConsumer`, `createBlobLifecycle`, `createJobQueue`

One likely task is deciding which of these are true user-facing API and which should be internal.

---

## 9. Known awkwardnesses worth reimagining

These are not necessarily bugs. They are seams where the design may want a stronger shape.

### 9.1 Duplicate names / unresolved special cases

- `presence` is a compatibility wrapper over `ephemeral`.
- `.use` and `.mount` are aliases; convention says mount entities and use routers, but code does not enforce it.
- `allowAnonymous()` and `open()` are identical admit-all gates with different names.
- `enum_` has a trailing underscore.

Ask whether these are necessary or should collapse.

### 9.2 Too many internals exported

`src/index.mjs` exports many compiler/kernel internals. This makes the package look less like a coherent framework and more like a parts bin.

Fable should propose a public/internal boundary.

### 9.3 Entity compiler is too large

`src/entity.mjs` is around 1500 lines and mixes:

- declaration validation
- field handle construction
- auth harvesting
- query builder handles
- CRUD handlers
- projection folding
- DDL helpers
- row hydration

This is the most obvious structural refactor target.

### 9.4 Route gates have two shapes

Entity CRUD gates use:

```js
r.resource({ gate: { list: allowAnonymous() } })
```

Imperative routes use positional branded gates:

```js
r.post('/x', open(), handler)
```

These are two syntaxes for similar admission concepts.

### 9.5 Gate peeling is vararg magic

The router peels branded gate functions from handler varargs. If several gates appear, last one wins silently.

This may be too magical for a security-sensitive seam.

### 9.6 `app.ddl()` is manual

DDL generation is exposed on app, but some exemplars bypass it and call lower-level DDL functions directly. If DB is supplied, migrations/DDL may need a singular framework-owned path.

### 9.7 Security-critical principal source placement

`db`, `blobs`, `jobs`, and `log` are app construction options, but `principalOf` is a `listen()` option. That may be inconsistent because principal construction is security-critical shared infrastructure.

### 9.8 Field declaration vs effect handle split

Some examples define a field outside the entity block just so its event handle can be used in effects. That suggests the declaration shape may not make handles available at the right time.

### 9.9 State transition handles are stringified

`state.transition(...)` and some map handles use stringification as keys. This looks like a hand-rolled per-kind protocol. There may need to be one typed handle protocol.

### 9.10 `readonly` on `ref` mixes concerns

`ref('User', { role: 'owner', readonly: true })` mixes field type, relation, role derivation, and access/write policy.

Maybe this is acceptable. Maybe ownership deserves a clearer declaration.

---

## 10. Stress-test apps the framework must support

The repo includes nine stress-test targets:

1. **todo** — simplest app; proves the floor is smooth.
2. **blog-platform** — scheduled publish, anonymous public read, Reader identity, subscriber fan-out.
3. **reddit** — comment trees, votes, moderation log, hot ranking, anonymous reads.
4. **library** — state machines, deadlines, holds queue, patron/staff tiers, withheld fields.
5. **drawing-canvas** — 60Hz strokes, cursor presence, polyline CRDT, z-layers, backpressure.
6. **space-invaders** — 30Hz game loop, ephemeral match state, spectator/player auth, server-authoritative fields.
7. **minecraft** — voxel chunks, spatial interest, tick, custom field types.
8. **photo-editor** — raster CRDT, blobs, ordered layers, render projections.
9. **google-photos** — media blobs, thumbnails, EXIF, geo/full-text search, link share.

Do not optimize only for CRUD. The hard cases are realtime collaboration, field-level deltas, authorization, and high-frequency updates.

---

## 11. Example target: WhatsApp clone

There is no full WhatsApp project in `projects/*`, but it is an important conceptual target.

A good workbench API should let a developer express WhatsApp roughly like this:

```js
const Chat = entity('Chat', {
  fields: {
    members: map(ref('User'), { role: enum_(['admin', 'member']) }),
    title: text()
  },
  grant: () => [
    scope(({ is }) => is.member()).can(async ({ is }) => {
      if (await is.member()) return grant(read, write, subscribe)
      return deny()
    })
  ]
})

const Message = entity('Message', {
  fields: {
    chat: ref(Chat, { required: true }),
    sender: ref('User', { from: 'req.user.id', readonly: true }),
    body: text(),
    attachments: list(blob({ accept: ['image/*', 'video/*'] })),
    sentAt: date({ default: now })
  },
  grant: inherit(Chat, { via: 'chat' })
})

const ChatPresence = entity('ChatPresence', {
  fields: {
    chat: ref(Chat),
    user: ref('User'),
    online: ephemeral(boolean()),
    typing: ephemeral(boolean(), { pace: 'volatile' })
  },
  grant: inherit(Chat, { via: 'chat' })
})
```

But this sketch may not be the optimal API. Fable should propose a better one if possible.

The key requirement is that durable messages, ephemeral presence, and volatile typing should feel like one model with different seams, not three unrelated frameworks.

---

## 12. Example target: Scope-like multimedia research coding app

The user’s real Scope app is a multimedia qualitative research/coding tool. workbench should make it easy to build something like:

- projects/studies
- media documents: video, audio, images, PDFs, transcripts
- annotations anchored to time ranges, spatial boxes, text spans, or document regions
- collaborative coding sessions
- codebooks/tags/categories
- comments/discussion threads
- derived/projected artifacts: thumbnails, transcripts, embeddings, search indexes
- field-level confidentiality: some notes/codes withheld from some collaborators
- live presence/cursors/selections
- offline-ish replay from event cursor

A plausible workbench shape might include:

```js
const Study = entity('Study', {
  fields: {
    title: text(),
    researchers: map(ref('User'), { role: enum_(['owner', 'coder', 'viewer']) })
  },
  grant: () => [
    scope(({ is }) => is.researcher()).can(async ({ is }) => {
      if (await is.owner()) return grant(read, write, admin, subscribe)
      if (await is.researcher()) return grant(read, write, subscribe)
      return deny()
    })
  ]
})

const Media = entity('Media', {
  fields: {
    study: ref(Study),
    file: blob({ accept: ['video/*', 'audio/*', 'image/*', 'application/pdf'] }),
    transcript: text.crdt(),
    thumbnail: projected.async(blob()),
    embedding: projected.async(json())
  },
  grant: inherit(Study, { via: 'study' })
})

const Annotation = entity('Annotation', {
  fields: {
    media: ref(Media),
    anchor: json(),
    code: ref('Code'),
    body: text.crdt(),
    privateMemo: text().can(async ({ is }) => {
      if (await is.owner()) return grant(read, write)
      return deny()
    })
  },
  grant: inherit(Media, { via: 'media' })
})
```

Again, this is illustrative, not final. The key question is whether the library’s primitives make this app small and obvious.

---

## 13. What Fable should produce

Please produce a structured review with these sections:

### A. One-paragraph diagnosis

What is workbench really trying to be?

### B. Preserve / change / delete

List:

- design ideas to preserve exactly
- ideas to preserve but rename/reshape
- ideas to delete or collapse

### C. Proposed ideal developer API

Show the API you think the user should want in 2026.

Include at least:

- simplest todo
- public blog post with anonymous read
- WhatsApp-style chat/presence/typing
- Scope-like media annotation/coding

### D. Proposed internal architecture

Suggest module boundaries. Especially address `entity.mjs` and `serve.mjs`.

Do not just say “split into smaller files.” Name the responsibilities and the seams.

### E. Public/internal export boundary

What should `src/index.mjs` expose? What should become internal?

### F. Authorization model review

Check whether the current two-layer, function-only auth model is right. If you propose changes, they must not reintroduce magic roles, `publicRead`, or a second auth path.

### G. Realtime/sync model review

Assess the one-ingest-path, sequence cursor, subscription interest, backpressure, and field delta design.

### H. Effects/projections/time review

Assess whether declarative effects, projected fields, schedules, and ticks are one coherent system or need reshaping.

### I. Migration plan

Give a staged plan that keeps tests green. The project is beta, so public API may change, but the plan should avoid breaking everything at once.

### J. Highest-risk decisions

Name the 5–10 decisions most likely to make the framework worse if chosen wrong.

---

## 14. Guidance for your review

Be aggressive but not careless.

The user wants the long-term best shape, not the smallest diff. But the project’s design philosophy is strict:

- one mechanism beats two
- functions beat magic strings
- fail closed
- declarations should absorb imperative wiring
- no hidden auth bypasses
- no second reconciliation path
- no special case kept beside the general mechanism
- build for the known stress-test apps, not infinite configurability

If you propose a new abstraction, apply the deletion test: what old code/concept does it remove? If it only relocates complexity behind a new name, reject it.

Use concrete code. The user can evaluate five lines of API shape better than a page of abstract prose.

# Domain Modules — reactive-entity design

> **SUPERSEDED IN PART (authorization model).** This is the original
> reactive-entity paradigm doc, written BEFORE the authorization grill. Its
> *structural* content — single `entity()` constructor, fields-own-everything,
> routes-home rule, progression ladder, no second API — is still current. Its
> *authorization* content is NOT: the grill removed `hide()` (DECISIONLOG ADR #1
> — no visibility axis; a denied read removes the row), removed the zero-to-one
> default grant (ADR #7/#9 — an entity with no `grant` is a load-time error), and
> replaced the per-field `access` block with field `.can()`. The check param is
> `principal`, not `user`. For the authoritative current model read
> **CONTEXT.md** and **FEATURES.md §6**; this file is kept for the paradigm
> history. Inline notes below flag the stale spots.

The reactive-entity paradigm: **one constructor (`entity()`)** whose typed
**fields** own persistence, sync, and event emission. Authorization lives with
the data. Grown additively from a minimal floor (declare entity + declare grant)
to the full bounded context. No second API. No `rooms` block, no `on(app)` block
— everything live is a field, and events are derived from field mutations.

This supersedes the earlier `module()` design (renamed: `module`→`entity`,
`schema`→`fields`, `predicates`→`checks`, `base`→`defaults`,
`crdt.text()`→`text.crdt()`). The single-constructor principle is preserved;
`entity()` is the same object growing, floor to ceiling.

---

## Final API surface

### `entity(name, config)`
Returns an entity class. Every key below `fields` is **optional**; omitting it
selects a sensible default.

```
entity('Doc', {
  fields:  { <field>: <fieldConstructor>, ... },        // PURELY fields
  checks:  { <name>: ({entity,principal,lookup,load}) => ... },   // peer of fields
  grant:   () => [ scope(({is}) => ...).can(async ({is}) => grant(read,...) | deny(reason)) ],
  routes:  (r, Entity) => { r.resource(); r.get(path, handler); r.use(path, sub) },
})
// NOTE (current model): `grant` is `scope(...).can(...)` — read admission
// compiled to SQL, plus every-other-capability per row. There is no `hide()`.
// The check param is `principal` (was `user`). See CONTEXT.md.
```

- **`fields` is the field listing.** Each field is a reactive primitive owning
  its storage strategy, sync transport, and emitted events:
  - `text` → LWW string, emits `:changed`
  - `text.crdt()` → CRDT-merged string, emits `:changed` + `:delta` (type-first, mechanism-second)
  - `number`, `date` → LWW, emit `:changed`
  - `ref('User')` → typed FK, auto-populates/traverses, emits `:changed`
  - `set(ref('User'))` → set-merge collection, emits `:added:<id>` / `:removed:<id>`
  - `presence({...})` → ephemeral per-connection state, emits `:joined`/`:moved`/`:left`
  - `log()` → append-only stream, emits `:appended:<id>`
  - `hash()` → one-way hashed field (passwords), exposes `verifyPassword(plain)`
- **The auth controls.** `checks` (named facts) and `grant` (`scope().can()`)
  are top-level peers; per-field authorization lives ON the field as fluent
  `.can(fn)` (current model — there is no separate top-level `access` block). A
  field with no `.can` strong-inherits the row grant.
- **Field `.can(fn)`** is always a function, authoritative for that field; a
  field read-denial returns a typed `withheld` marker, not a `hide()`.

### Capabilities — typed handles, not strings
Capabilities (`read`, `write`, `subscribe`, `admin`) are typed handles exported
from `express-plus`, passed to `grant(...)` as a set — **no string keys, no
string matching** in authorization decisions:

```
import { grant, deny, read, write, subscribe, admin, scope } from 'express-plus';

grant: () => [
  scope(({ is }) => anyOf(is.owner(), is.collaborator()))   // read admission → SQL WHERE
    .can(async ({ is }) => {
      if (await is.owner())        return grant(read, write, subscribe, admin);
      if (await is.banned())       return deny('account suspended');
      if (await is.collaborator()) return grant(read, write, subscribe);
      return deny('no capability for this principal');
    }),
]
```

A principal not admitted by `scope` never appears in the result set at all (no
`hide()`/404 — the row is simply absent, logged in prod, raised in dev). `deny`
inside `.can` refuses a capability on a row the principal CAN read.

- **`subscribe` is a peer of `read`, not folded into it.** `read` = one-shot
  REST fetch; `subscribe` = sustained WS push. They usually travel together
  but can legitimately differ (e.g. an anonymous public whiteboard grants
  `read` for a cheap snapshot but denies `subscribe` to bound the WS DoS
  surface). One auth engine, re-authorized per push — no second auth path.
- **`deny(reason)`** refuses a capability on a readable row. There is no
  `hide()`: a row the principal can't read is removed by `scope` from the result
  set, never surfaced as a 404. ALLOWLIST throughout.

### `role: owner` — FK marker (replaces `owner()` sugar)
`ref('User', { role: owner, readonly: true })` marks the ownership relation.
`owner` is a typed handle, not a string. ONE thing falls out of it
automatically — ONE source of truth for "who is the owner": an auto-derived
`checks.owner` (and thus `is.owner()`), so even the floor — which declares no
`checks` — gets the fact for free.

> STALE (corrected): earlier this section also claimed a *zero-to-one default
> grant* (owner ⇒ all, else `hide()`). That default no longer exists — an entity
> with no `grant` is a load-time error (ADR #9), and there is no `hide()` (ADR
> #1). The owner FK derives the *check*, not a grant; the floor declares its
> grant explicitly (see note.mjs).

The owner FK auto-populates from the request principal (`principal.id`);
do not hand-write it. Fully overridable: declare `checks.owner` yourself and
generation is suppressed.

### `app.mount('/prefix', Entity)` — explicit path, chainable
Express-style: you declare the endpoint path. Persisted product domains are
entities; cross-cutting concerns (auth) are plain routers (`app.use('/sessions', ...)`).
The live `/events` WS endpoint is framework-baked, not declared.

### `routes: (r, Entity) => { ... }` — verbs-as-methods, INSIDE the entity
`r` is the same `router()` used everywhere (invariant 6 native). The callback
receives the entity class as its 2nd arg so handlers use typed field handles and
class methods with **no magic strings and no circular imports**. `r.resource()`
opts into auto-CRUD (routed THROUGH grant/access) AND auto-surfaces `log`/
`presence` field reads as sub-resource GETs (`GET /:id/chat`, `GET /:id/presence`)
so a client can bootstrap history/roster before subscribing to live deltas.

**Param-binding rule:** the framework auto-binds `:<entity>Id` (e.g. `:docId`)
by loading the row through the route gate onto `req.<entity>` (`req.doc`). The
param name is derived from the entity, so sub-routers inherit it without
`mergeParams`.

### Omit-gets-defaults (transport)
- `routes` omitted → auto-CRUD + live-field reads at `/<prefix>` and `/<prefix>/:id`,
  routed **through** grant/access/checks (safe by construction). `routes` declared
  → auto-CRUD suppressed; opt back in with `r.resource()`.
- `grant` is **required** — omitting it is a load-time error (ADR #9). There is
  no default-grant fallback; the `role: owner` FK derives `checks.owner`, not a
  grant. (Stale: this line previously described a zero-to-one default.)
- No `rooms`/`on`/`hooks` blocks — presence/chat are fields; events derive from
  field mutations.

### `open` — opt out of the fail-closed gate (per route)
The route gate (`requireAuth`) is default-on for every route. A single route
opts out with the `open` middleware — the one legitimate unauthenticated
endpoint (it mints the session). Auth is cross-cutting, not a persisted entity,
so the Session domain is plain routers, not an `entity`.

---

## The semantic fork, decided: THE FLOOR IS ALWAYS AUTHED

The floor includes `owner: ref('User', { role: owner, readonly: true })` — one
field — and is authed by construction. The route gate (requireAuth) is default-on
too, so the smoothest path is the safe path. Two independent default-on layers:
**route gate** (`requireAuth`) and **row grant** (`grant` from the owner FK).

---

## Live events — derived from field mutations

No `on(app)` block, no hand-written `app.emit(...)`. Mutating a field emits:

```
Doc:<id>:<fieldPath>:<verb>[:<elId>]
  set         → :added:<id> / :removed:<id>
  text.crdt   → :changed + :delta
  text/number/date/ref → :changed
  presence    → :joined / :moved / :left
  log         → :appended:<id>
```

The baked-in WS `/events` stream re-authorizes every push through
`grant`/`access`/`checks` (no second auth path). `subscribe` is the capability
checked for sustained push.

### Invite-notification lifecycle (the two halves differ — deliberately)
- **`:added`** — the recipient subscribes to a **user-scoped pattern** across all
  Docs ("`shares:added` where target === me"), backed by the reverse membership
  index over the live stream. At delivery time the invitee IS now a collaborator
  (the granting mutation is its own auth), so re-auth passes.
- **`:removed`** — at delivery time the invitee has JUST been removed, so
  re-auth would block the push. Rather than add a second auth path to force it
  through, removal notifications are **deferred to the email-style inbox** and
  discovered by fetch. One auth engine, no bypass.

---

## Invariant audit

| # | Invariant | Status |
|---|-----------|--------|
| 1 | Authz always functions | ✅ unchanged |
| 2 | grant via `scope().can()`; `deny` refuses a capability | ✅ current model (no `hide()` constructor — ADR #1) |
| 3 | Per-entity checks; no universalizing | ✅ `checks.owner` auto-derived per-entity from that entity's own owner FK |
| 4 | request-scoped lookup / is.* memoization | ✅ unchanged |
| 5 | per-field `.can()` function, authoritative, dup errors | ✅ field `.can`, not a top-level `access` block |
| 6 | verbs-as-methods routing | ✅ native (`routes:(r,Entity)=>...`) |
| 7 | sensible defaults baked in | ✅ strengthened (omit-gets-defaults, `getOrFail`, `touch:true`) |
| 8 | grant is required; no default-grant fallback | ✅ entity with no `grant` = load-time error (ADR #9); the old "zero-to-one default owner=all else hide" is removed |

---

## Progression ladder (additive, never restructure)

| Tier | Lines | What you add | File |
|------|-------|--------------|------|
| 0 floor | declare entity + grant | `{ body: text.crdt(), owner: ref('User',{role:owner}) }` + an explicit owner `grant` → collaborative body, owner-only auth, auto-CRUD, live CRDT stream | `note.mjs` |
| 1 | +N | more fields + a custom check (grant refined) | — |
| 2 | +N | richer `grant` `scope().can()` (typed capability handles) | — |
| 3 | +N | per-field `.can()` + more checks | — |
| 4 | +N | custom `routes:(r,Doc)=>{ r.resource(); r.get('/feed',feed(Doc)); r.use('/:docId/shares',shareRoutes(Doc)) }` | — |
| 5 ceiling | full | `presence`/`chat` fields + `deny` path + cross-entity `projectManager` check | `domains/doc/index.mjs` |

Entry stays `app.mount('/notes', Note)` at every tier.

---

## Routes-home rule

- A route lives in the entity that **owns the resource it reads/mutates**.
- Sub-resources (`/docs/:docId/shares`) live in the owning entity via `r.use()`.
- An entity may be **fields-only, routes-only, or both**. Auth is cross-cutting,
  not a persisted entity, so the Session domain is plain routers with `open` on
  the login route.
- Truly cross-cutting routes that span no single resource (the `/` landing) live
  at **app level** in `app.mjs`.
- Growth is pure JS-module-resolution: `domains/doc.mjs` splits to
  `domains/doc/{index.mjs, routes/handlers.mjs, routes/shares.mjs}`; the
  framework treats both identically.

---

## Deliverable files
- `hello.mjs` — the 5-line floor.
- `app.mjs` — thin entry: `/` + `.use('/sessions',...)` + `.mount('/docs', DocEntity)`.listen().
- `domains/doc/index.mjs` — full power-user Doc (ceiling).
- `domains/doc/routes/handlers.mjs` — `/feed`, `/home` (typed-handle queries).
- `domains/doc/routes/shares.mjs` — `/:docId/shares` sub-resource (auto-emitting set field).
- `domains/session/routes.mjs` — auth boundary (plain routers, `open` login).
- `domains/session/handlers.mjs` — `userList`, `userPage` (entity API, `getOrFail`).

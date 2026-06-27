# express-plus — desired feature set

Goal: an idealized Express-style framework whose DX makes building a Google
Docs-style live-document app as close to declarative as possible. The framework
owns the collaboration plumbing (CRDT merge, presence, autosave, version
history, reconnect/replay); the developer declares doc shape, permissions,
room rules, and product hooks.

This is a DX design exercise, not a runnable implementation.

## 1. Sensible defaults, baked in (no applyDefaults step)

Security headers, body parsing (json + urlencoded, ~1mb cap), cookie sessions
(secure / httpOnly / sameSite=lax), `req.user` hydration from session, rate
limit, CORS same-origin, request logging, view engine, static file serving,
format-negotiated 404, four-arg JSON error handler (dev-only stack traces),
graceful shutdown on SIGTERM/SIGINT/unhandledRejection/uncaughtException.
`config.mjs` exposes env overrides (port, env, session, etc.).

## 2. One auth concept — `requireAuth`

A single framework export usable on both HTTP routes (`docs.use(requireAuth)`)
and WS rooms (`app.room(..., { require: requireAuth })`). No separate
`expressPlus.auth()`. `req.user` is hydrated from the session by default, so
there is no manual `loadUser` middleware.

## 3. Routing idiom

Verbs-as-methods with varargs handlers (Express / Fastify / Hono convention):
`users.get('/', requireAuth, userList)`. Mini-apps via `router()`, mounted bare
with `app.use(path, router)`. Subtrees chain verbs off `router()`. No nested
tree DSL, no array-of-handler combos.

## 4. `app.doc(name, schema)` — document type declaration

Declares a document type; the framework auto-generates REST CRUD + version
history + a CRDT realtime room from it. Field types carry semantics:

- `expressPlus.text({ max, default, readonly, required })` — last-write-wins string.
- `expressPlus.crdt.text()` — collaborative CRDT text (per-char merge like
  Yjs / Automerge); framework owns merge math, op transport, presence, replay.
- `expressPlus.number(...)` — numeric.
- `expressPlus.ref('User', { from, readonly, required })` — typed reference;
  `from: 'req.user.id'` auto-populates on create from request context (cannot
  be spoofed), paired with `readonly` to prevent reassignment.
- `expressPlus.date({ default, readonly })`.

- `derived: (doc) => ...` — pure-pull computed field (e.g. wordCount from body);
  recompute timed by the framework around CRDT merges. No imperative onChange.
- `access: (ctx, base) => Capability` — optional per-field authorization, see §6.

## 5. `app.room(path, opts)` — realtime mini-app (sibling to Router)

WebSocket upgrade, presence (cursor / selection / display name), chat, event
fan-out, reconnect + replay. `require` gate (auth), `load` (hydrate a resource
by path param), `events` (whitelist of broadcastable event names). Per-user
channels (e.g. `/me/inbox`) drive live UI updates with no polling.

## 6. Authorization model (the core design)

Always functions, never magic words or static values.

- **`grant(ctx)`** — doc-level function returning the BASE capability for every
  field. Fields without their own `access` inherit it.
- **Per-field `access: (ctx, base) => Capability`** — always a function. When
  present, it is AUTHORITATIVE for that field: the base no longer applies to it
  (no composing, no widen/narrow — dissolves the power-vs-safety question).
  `base` is passed in only as a convenience the function may return to mean
  "inherit." **A field declaring access two ways (e.g. a static capability AND
  an `access` function) errors at schema load — one mechanism per field.**
- **Schema-level `predicates:` block** inside `app.doc` — reusable helper
  functions (`owner`, `sharedWith`, `payer`, `projectManager`). Surfaced as
  `is.*` inside `grant` and field `access`. Per-schema: Doc's `owner` ≠
  Project's `owner`, never collide (no universalizing across object kinds).
- **Three return constructors** (not booleans):
  - `grant({ read, write, room, admin })` — allow, optionally partial.
  - `deny(reason)` — 403 with a human reason.
  - `hide()` — 404; existence not leaked (empty capability set).
- **Request-scoped promise memoization:**
  - `lookup(collection, query)` memoizes the in-flight PROMISE per
    `(collection, stableStringify(query))` across the whole request — so the
    same query from `grant` and from `body.access`, or across 50 docs in a
    list sharing a project, hits the DB once. Caching the promise (not the
    value) dedups concurrent in-flight callers. Request-scoped (lives on req,
    dies with the response) — no TTL, no staleness, no invalidation.
  - `is.*` additionally memoizes predicate results per doc-evaluation.
- **Zero-to-one default:** no `grant` + no field `access` → framework default
  (owner = all, else `hide()`), because `predicates.owner` exists.

Motivating cases the model must express:
- Payer funds a doc's storage but, by corporate privacy policy, may not view
  content → sees title + wordCount (metadata), never body. (Base grants
  `read:true`; `body.access` returns `deny('...')` → 200 with body stripped.)
- Cross-resource delegation: full rights to the project the doc lives in →
  full rights to the doc. (`is.projectManager()` does
  `load(doc.projectId).can('write', user)` — async, one load, memoized.)

## 7. Lifecycle hooks + targeted broadcast

- `app.on('Doc.share', ({ doc, invitee, by }) => ...)` — side-effect listeners,
  no `next()` ceremony.
- `hooks: { afterSave }` on a doc — side effects that LEAVE the document
  (notifications, audit rows, webhooks). Field-to-field derivation stays in
  `derived`, never here.
- `app.emitTo(userId, event, data)` — broadcast to a user's subscribed rooms
  without touching the raw socket layer.

Live-update loop: POST share → `Doc.share` hook → `emitTo` recipient's
`/me/inbox` room → client `LiveChannel` → `LiveList._upsert` → re-render, no
refresh/polling.

## 8. Client library (`public/express-plus-client.mjs`)

- `LiveChannel` — WS subscribe, auto-reconnect, event dispatch.
- `LiveList` — boot from JSON snapshot, apply realtime deltas, re-render via a
  `render(items)` callback.
Keeps the page declarative (`public/files.mjs`, `public/files.html`).

## 9. Package

`package.json` — `express` + `express-plus` deps, `type: module`,
`start: node app.mjs`.

---

## Current implementation surface (what we have today)

Live files: `app.mjs`, `config.mjs`, `errors.mjs`, `routes/{sessions,docs,shares}.mjs`,
`public/{express-plus-client.mjs,files.mjs,files.html}`, `package.json`.

`app.mjs` is the single wiring entry point. It does everything: defaults
implied, routes mounted, `app.doc('Doc', {...})` with fields + `predicates` +
`grant` + `body.access` override + `hooks.afterSave`, two `app.room()`
declarations, two `app.on` share hooks, `app.listen`, `trapProcess`.

The question being put to the council: **what are alternative implementation
shapes / entry-point patterns for this same feature set, and how do they
compare to the single-`app.mjs` shape we have now?**

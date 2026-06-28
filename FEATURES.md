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
- field `.can(fn)` — fluent per-field capability rule, ON the field (see §6). A
  field with no `.can` strong-inherits the row grant; the separate top-level
  `access:` block is gone (it drifted from the field it described).

## 5. `app.room(path, opts)` — realtime mini-app (sibling to Router)

WebSocket upgrade, presence (cursor / selection / display name), chat, event
fan-out, reconnect + replay. `require` gate (auth), `load` (hydrate a resource
by path param), `events` (whitelist of broadcastable event names). Per-user
channels (e.g. `/me/inbox`) drive live UI updates with no polling.

## 6. Authorization model (the core design)

Always functions, never magic words or static values. Two questions only: *can
you READ it* and *can you EDIT it*. There is **no separate "visibility" or
`hide()` axis** — a denied read removes the row from the result set (in
production the omission is logged server-side; in dev the framework raises "this
exists, but you wouldn't know that in production"). See DECISIONLOG.md.

- **`checks`** — a per-entity, named *fact* about a row (`owner`, `collaborator`,
  `editor`, `linkHolder`). A plain function; never wrapped or marked (the
  `admits(...)` wrapper is dead — it was a compiler marker, a leak). A check
  grants nothing until a grant CALLS it; awaitable as `is.*`. Per-schema: Doc's
  `owner` ≠ Project's `owner`, never universalized across entity types.
- **`scope(predicate).can(fn)`** — the grant grammar, split on a *performance*
  boundary, not a visibility one. `scope` declares READ intent by calling checks,
  and is the ONLY grant compiled to SQL (a `WHERE` so the DB never returns
  forbidden rows — you cannot filter a million rows in JS per request).
  Compilability is DERIVED from what the called checks touch; a check used in
  `scope` that cannot compile is a **load-time error** (never a silent JS scan,
  never a warning). `.can` is every OTHER capability (write/admin/subscribe),
  per-row at runtime, and MAY call non-compilable checks freely. Grant is
  EXACTLY two halves — there is no third method.
- **read intent is never derived from compilability** — a check that happens to
  compile (e.g. an `archived` fact) must NOT auto-admit a read (archived rows
  must not become world-readable). The developer declares read intent by calling
  a check in `scope`; the compiler only derives *whether* it compiles.
- **field `.can(fn, defaults)`** — fluent, ON the field. A field with no `.can`
  **strong-inherits** the row grant: readable exactly when the row is readable;
  edit floor = the row grant's write capabilities. Field access is **always
  runtime** (the row is already materialized), never a compiled `scope`. Field
  read-denial returns a typed `withheld` marker (prod) + a dev-mode diagnostic
  (field path + deny reason); field edit-denial is a hard write reject. A
  security-sensitive entity may flip the field floor with
  `fieldAccess:{default:ownerOnly}` (one field floor, an explicit override, never
  a competing default).
- **no default grant** — an entity that declares **no `grant`** is a **load-time
  error**, never silently private-by-creator and never world-readable.
  Authorization is never magic and never guessed: the developer must name *who*
  reads. There is no zero-to-one "owner = all, else hide()" default (that default
  is dead with `hide()`). The cost is the ~3-line zero-floor; see DECISIONLOG.md.
- **`never()` / `.is(undefined)` compile to SQL FALSE** — a deliberate
  fail-closed VALUE the developer wrote (e.g. a non-link principal on a
  `linkHolder` check; an anonymous link whose token is undefined must not match
  rows whose `linkShare.token` is null — never compile to SQL `IS NULL`). This is
  distinct from a non-compilable check (a load-time error): `never()` is intent
  the developer expressed; a non-compilable check is an accident the compiler
  refuses to silently degrade.

Motivating cases the model must express:
- Payer funds a doc's storage but, by corporate privacy policy, may not view
  content → sees title + wordCount (metadata), never body. (Row grant admits the
  row; `body.can` returns a `withheld` marker → 200 with body masked + dev
  diagnostic.)
- Cross-resource delegation: full rights to the project the doc lives in → full
  rights to the doc. (`is.projectManager()` does `load(doc.projectId).can('write',
  user)` — async, one load, memoized.)

## 7. Declarative effects + targeted broadcast

- **`effects`** — declarative reactions: `{ mutate: <target>, with: <template> }`.
  A cross-entity effect re-enters the one pipeline in the SAME transaction as the
  triggering mutation (target grant/validation failure rolls back the origin),
  runs as a bounded **effect principal** (not the triggering user, not the
  ambient SYSTEM god — its capability is exactly the declared target + template,
  authorized against the target's own grant), and composes into one event. The
  `{set}`(self) and `{create}`(cross-entity) primitives collapse into one; the
  engine decides set vs create from whether the target row exists. Bounded
  reentrancy: a structural cycle (A→B→A) is a load-time error; a runtime depth cap
  aborts the whole batch on overflow. Typed handles throughout (target, trigger,
  template path-refs) — the prerequisite for static cycle detection. Replaces
  `afterSave`/`onCreate`: no imperative uncompiled callbacks. See DECISIONLOG.md.
- **`app.emitTo(userId, event, data)`** — broadcast to a user's subscribed rooms
  without touching the raw socket layer. Live delivery is NOT a third grant
  method: it is re-authorization (the same `scope`+`.can` engine re-run at emit,
  latched for scale) + subscriber interest (a narrowing filter supplied at
  subscribe time, data-not-code, indexable). See DECISIONLOG.md.
- **Out-of-band side effects** (webhooks, emails, external HTTP) — **projections
  over the committed event log**, not a new effect primitive. The grilled
  `effects` cover in-transaction DB mutations only (atomic with the origin); a
  side effect that leaves the process cannot join the DB transaction, so it runs
  as a post-commit projection consumer — independently durable, retried on its
  own, never rolling back the origin. Validated against the scope workbench; see
  `SCOPE-FINDINGS.md` and DECISIONLOG.md.

Live-update loop: POST add collaborator → declarative effect
`{ mutate: Inbox, with: { recipient, doc, kind: 'invite' } }` → one composed
event → re-auth-at-emit per subscriber per source-entity-tagged fragment →
recipient's `/me/inbox` room → client `LiveChannel` → `LiveList._upsert` →
re-render, no refresh/polling.

## 8. Client library (`public/express-plus-client.mjs`)

- `LiveChannel` — WS subscribe, auto-reconnect, event dispatch.
- `LiveList` — boot from JSON snapshot, apply realtime deltas, re-render via a
  `render(items)` callback.
Keeps the page declarative (`public/files.mjs`, `public/files.html`).

## 9. Package

`package.json` — `express` + `express-plus` deps, `type: module`,
`start: node app.mjs`.

---

## Design status

The grilled design is recorded in `CONTEXT.md` (ubiquitous language) and
`DECISIONLOG.md` (architectural decisions). Idealized exemplars live in
`doc.mjs` (the Google-Docs ceiling) and `comment.mjs` (a child entity inheriting
its parent's grant via a typed FK). `note.mjs` is an earlier exemplar that still
reflects the pre-grill shape (admits/visibility/zero-to-one default) and is
awaiting the same rewrite.

`app.mjs` is the pre-grill single wiring entry point (`config`, routes mounted,
`app.doc('Doc', …)` with fields + `grant` + `body.access` override +
`hooks.afterSave`, rooms, share hooks). It predates the grill and has not yet
been rewritten against the model above; treat it as the legacy baseline the
grill was run against, not the target shape.

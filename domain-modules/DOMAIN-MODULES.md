# Domain Modules — final entry-point design

The judge's verdict: **modified winner = Response A's single-`module()` spine**,
adopting C's omit-gets-defaults semantics where they pay for themselves,
**rejecting** B's separate `entity()` function and B's array route DSL, and
**rejecting** C's public Tier 0 and C's auto-classified flat config.

One constructor (`module()`), grown additively from a 3-line floor to the full
bounded context. No second API. No invariant broken; one (invariant 3) is
*skirted and contained* via `owner()`, documented below.

---

## Final API surface

### `module(name, config)`
Returns a `DomainModule`. Every key below `schema` is **optional**; omitting it
selects a sensible default.

```
module('Doc', {
  schema:     { <field>: <fieldConstructor>, ... },   // PURELY fields
  predicates: { <name>: ({doc,user,lookup,load}) => ... },   // peer of schema
  grant:      async ({ is }) => grant(...) | deny(...) | hide(),
  routes:     (r) => { r.get(...); r.resource(); r.use(path, sub) },
  rooms:      [ { path, require, load, presence, chat, events } ],
  hooks:      { afterSave: (ctx, app) => ... },
  on:         (app) => { app.on(...) },
  require:    requireAuth (default) | null,           // module-level route gate
})
```

- **`schema` stays an explicit wrapper.** No auto-classification of top-level
  keys (rejected C). A field is a field only inside `schema`; reserved words
  (`rooms`, `on`, `routes`...) can never collide with a field name.
- **The auth triad are top-level peers.** `predicates`, `grant`, and per-field
  `access` (which stays ON the field) read as the three auth controls at a
  glance; `schema` is a clean field listing.
- **Per-field `access`** is always a function, authoritative for that field;
  declaring access two ways errors at schema load (invariant 5, unchanged).

### `owner()`  — field marker
Sugar for `ref('User', { from: 'req.user.id', readonly: true })` that ALSO marks
the ownership relation. When `predicates.owner` is **not** declared, it
auto-generates one **per-module, from this module's own field**, and (when
`grant` is also absent) selects the default grant `owner ⇒ all, else hide()`.

- **Explicit opt-in beats `ref('User',{from})` auto-detection** (rejected C):
  a Doc may ref a User as `reviewer`/`lastEditor` without that User being the
  *owner*. `owner()` says exactly "this is ownership"; no false positives.
- **Fully overridable.** Write `predicates.owner` yourself (as the full Doc
  does) and generation is suppressed.

### `app.mount(Module)` / `app.mount(Module, '/prefix')` / `app.mount(Module, { at, with })`
One argument flattens the baseline `app.mount(Domain, {routes:{...}})`. Infers
the prefix from the module name (`Doc → /docs`). Chainable. Name kept as
`mount` (rejected C's `app.module()`): minimal churn from baseline, and "mount"
is the verb-of-art for attaching a routable thing at a prefix.

### `routes: (r) => { ... }`  — verbs-as-methods, INSIDE the domain
`r` is the same `router()` used everywhere (invariant 6 native). Gains
`r.resource()` (explicit auto-CRUD), `r.use(path, sub)` (sub-resources).
**Rejected B's `{get:[[path,handler]]}` arrays** — that is the nested-object
route DSL invariant 6 forbids; there was nothing to "cautiously preserve."

### Omit-gets-defaults (transport)
- `routes` omitted → auto-CRUD at `/<prefix>` and `/<prefix>/:id`, routed
  **through** the schema's grant/access/predicates (safe by construction).
  `routes` declared → auto-CRUD suppressed; opt back in with `r.resource()`.
- `rooms` omitted → one default collaborative room at `/<prefix>/:id`
  (`requireAuth`, `load:<Module>`, presence + chat). `rooms` declared → yours.
- `hooks`/`on` omitted → no overhead.

### `require` — the fail-closed gate
Module-level `require` defaults to `requireAuth` (fail-closed). A single route
opts out with the `public` middleware; a whole module opts out with
`require: null` (used only by the auth-minting Session domain).

---

## The semantic fork, decided: THE FLOOR IS ALWAYS AUTHED

**Rejected C's public Tier 0.** "Omit owner ⇒ fully public, no auth" puts a
read/write-by-anyone app on the most-copied beginner path with zero auth code
and no mental model that auth was a question — a footgun in the exact spot
beginners cargo-cult. Invariant 8 already fixes the zero-to-one default at
"owner=all, else hide" (i.e. authed).

Consequence: the floor includes `owner: owner()` — one token — and is authed by
construction. Two independent default-on layers: **route gate** (`require`) and
**row grant** (`grant` from `owner()`).

---

## Invariant audit

| # | Invariant | Status |
|---|-----------|--------|
| 1 | Authz always functions | ✅ unchanged |
| 2 | grant/deny/hide constructors | ✅ unchanged |
| 3 | Per-schema predicates; no universalizing | ⚠️ **skirted, contained** — see below |
| 4 | request-scoped lookup / is.* memoization | ✅ unchanged |
| 5 | per-field access function, authoritative, dup errors | ✅ unchanged |
| 6 | verbs-as-methods routing | ✅ native (`routes:(r)=>...`); rejected B's arrays |
| 7 | sensible defaults, no applyDefaults | ✅ strengthened (omit-gets-defaults) |
| 8 | zero-to-one default owner=all else hide | ✅ honored by authed floor |

### Invariant 3, addressed
`owner()` auto-generation does **not** universalize. It generates `is.owner`
**per-module, from that module's own field**; Doc's generated `is.owner` and
Project's are different functions over different fields. There is no shared
global `owner` predicate. It is fully overridable (declare `predicates.owner`).
This satisfies both the letter (no cross-kind universalization) and the spirit
(per-schema, per-field) of invariant 3. Documented caveat, per Response A:
**"override `predicates.owner` if your ownership relation isn't
`field === req.user.id`."** This is the single point of derivation-over-literal
authoring, and it is contained and opt-out.

---

## Progression ladder (additive, never restructure)

| Tier | Lines | What you add | File |
|------|-------|--------------|------|
| 0 floor | ~5 | `{ body: crdt.text(), owner: owner() }` → collaborative body, owner-only auth, auto-CRUD, default room w/ presence+chat | `hello.mjs` |
| 1 | +N | more fields + a custom predicate (default grant still governs) | — |
| 2 | +N | override default with your own `grant` | — |
| 3 | +N | per-field `access` + more predicates | — |
| 4 | +N | custom `routes:(r)=>{ r.resource(); r.get('/feed',feed); r.use('/:docId/shares',shareRoutes) }` + `hooks` | — |
| 5 ceiling | full | multi-room + cross-domain `on(app)` | `domains/doc/index.mjs` |

Entry stays `app.mount(Module)` one-arg at every tier.

---

## Routes-home rule

- A route lives in the domain that **owns the resource it reads/mutates**.
- Sub-resources (`/docs/:docId/shares`) live in the owning domain via `r.use()`.
- A domain may be **schema-only, routes-only, or both**. The Session/Account
  domain (`domains/session/`) is **routes-only, schema-less, `require: null`** —
  it mints auth, so it cannot require auth.
- Truly cross-cutting routes that span no single resource (the `/` landing) live
  at **app level** in `app.mjs`.
- Growth is pure JS-module-resolution: a single `domains/doc.mjs` splits to
  `domains/doc/{index.mjs, routes/handlers.mjs, routes/shares.mjs}`; the
  framework treats both identically.

---

## Why B's `entity()` was rejected (subtract before add)
A second entry function forks the type system ("same type as `module()`" — so
why two?), forks the docs, and creates a migration cliff ("when you outgrow
entity, drop to module"). A and C both prove the floor is reachable on the
*single* constructor via omit-gets-defaults. The smooth path and the powerful
path must be the **same object growing**, not two APIs with a seam between them.

---

## Deliverable files
- `hello.mjs` — the 5-line floor.
- `app.mjs` — thin entry: `/` + `.mount(Session).mount(Doc).listen()`.
- `domains/doc/index.mjs` — full power-user Doc (auth bodies byte-for-byte from baseline).
- `domains/doc/routes/handlers.mjs` — `/feed`, `/home`, updatedAt bump.
- `domains/doc/routes/shares.mjs` — `/:docId/shares` sub-resource.
- `domains/session/index.mjs` — routes-only domain, `require: null`.
- `domains/session/handlers.mjs` — `userList`, `userPage`.

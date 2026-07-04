# Seam Review — Developer Experience, 0→1, and the Plugin Boundary

**Date**: 2026-07-04
**Scope**: the seams (construction, config, db, auth, client, blob, jobs), with a
first-principles focus on the 0→1 path for the stress-test apps (WhatsApp clone,
sync-movie-watching, Google Photos clone, …) and on structuring core parts so
they can be swapped by plugins via configuration.
**Method**: direct reads of `src/app.mjs`, `serve.mjs`, `kernel.mjs`, `db.mjs`,
`config.mjs`, `session.mjs`, `auth-entities.mjs`, `blob-store.mjs`,
`registry.mjs`, samples in `projects/`; plus two delegated exhaustive
inventories (DeepSeek V4 Pro): SQLite coupling across all of `src/`, and a
per-sample boilerplate/friction catalog. This complements FABLE-5-REVIEW.md
(architecture/auth) — findings there are not repeated here.

---

## 0. The thesis

The kernel seams are genuinely good. `principalOf` injection, the shared
`clock`, the `writeQueue` mutex, the post-commit consumer list in
`kernel.mjs:128-133`, the one-auth-story gate/grant split, and the
`app.use(prefix, fn)` prefix-intercept are clean, single-purpose seams — the
hard architecture is right.

What's wrong is the **rim**: the first hour of a developer's life. The framework
sells "declare entities, get a persisted realtime app," but **no sample wires a
database the supported way, no sample sets the session cookie its own principal
source reads, and no sample loads the client SDK**. The 30–80-line collaborative
page the Scope evidence promises is real *after* setup — but setup today is
undocumented, duplicated, or broken. Every finding below is either "the default
should do this" or "this seam should be a config-injected interface."

---

## 1. 0→1 findings (ranked)

### 1.1 The floor sample doesn't persist — and the only db-wired sample does it wrong

`todo.mjs:125`, `note.mjs`, `gdoc.mjs:114` all call `workbench()` with **no
db**: every entity route 500s at dispatch (fail-closed, by design — but a
server that fails every request is not a sample). The one sample that does wire
a db, `todo-app.mjs:18-51`, hand-writes:

- `new DatabaseSync('todo.db')` + `PRAGMA journal_mode=WAL` — which
  `workbench({db})` already applies (`app.mjs:355-362`);
- `CREATE TABLE User/Session` DDL — which `executeFrameworkDDL` already owns
  (`app.mjs:411`), **with a schema that has drifted from `auth-entities.mjs`**
  (the hand-written Session table carries a `userId` column the framework
  entity doesn't declare);
- a `generateDDL(entity)` loop — which `app.prepareSchema()` already runs for
  every mounted entity (`app.mjs:406-431`).

So the canonical newcomer path teaches three layers of boilerplate the
framework explicitly exists to own, and the auto-DDL feature — a real selling
point — is demonstrated nowhere.

**First-principles question**: who is the no-db app *for*? The tagline is
"collaborative, **persisted**, realtime data." A default that constructs a
server which cannot serve its own entities is not fail-closed, it's
dead-on-arrival. Persistence should be the default, not an option.

**Fix (also the first plugin seam — see §2):**

```js
workbench()                          // default: sqlite file at .data/app.db
workbench({ db: 'todo.db' })         // string → built-in sqlite driver
workbench({ db: ':memory:' })        // tests
workbench({ db: myDriverInstance })  // plugin: anything honoring the driver contract
```

The framework constructs `DatabaseSync` internally for the string forms —
`import { DatabaseSync } from 'node:sqlite'` disappears from every app. Samples
then shrink to the honest floor: entities + mounts + `listen`. Delete the DDL
and PRAGMA blocks from `todo-app.mjs`; they contradict the framework.

### 1.2 Auth 0→1 is broken end-to-end

The pieces all exist and don't connect:

- `sessionPrincipalOf` reads the `sid` **cookie** only (`src/session.mjs:64-96`).
- The exemplar login (`projects/session.mjs:18-28`) returns the token **in the
  JSON body and never sets the cookie**. A client following the sample is
  anonymous on every subsequent request.
- `sessionCookie()` — the helper that builds the correct fail-closed
  `Set-Cookie` — is exported only from `workbench/internal` (`internal.mjs:29`).
- The client SDK has no login/auth surface at all (`workbench-client.mjs`).
- `projects/app.mjs` (the "real" gdocs wiring) passes neither db nor
  `principalOf`, so it runs fully anonymous; `todo-app.mjs` hardcodes
  `principalOf: () => demoUser`.

No runnable path exists from "user types a password" to "req.principal is that
user." For every target app (WhatsApp, movie-sync, photos) this is step one.

**Fix — ship the battery, keep the seam.** Auth is already "the framework's
concern, not the app's" (`auth-entities.mjs:5-7`) — follow that argument to its
conclusion: the framework provides the *routes*, not just the entities.

```js
workbench({ db: 'chat.db' })
  .auth()                 // mounts /auth: signup, login, logout, link redemption
                          // — sets/clears the sid cookie itself
```

`.auth()` is sugar over exactly what `projects/session.mjs` hand-rolls (plus the
missing `Set-Cookie`), built on public primitives so an app can still write its
own. Promote `sessionCookie` to the main export either way. Client side:
`client.login(username, password)` / `client.logout()` on the SDK (a `fetch`
with `credentials: 'include'` — trivial, but its absence is why no sample
works).

### 1.3 The entity→browser path is broken

- **No sample imports the client library**; only tests do.
- `public/files.html:19` references `/files.mjs`, **which doesn't exist**.
- `doc.mjs:232-234` renders `files.html` from the wrong directory (it lives in
  `public/`, the renderer defaults to `views/` per `config.mjs:20`).
- `app.static()` exists (`app.mjs:444`) and is called by no sample.
- There is no route that serves `workbench-client.mjs` to a browser — a browser
  cannot `import 'workbench/client'`.

For "realtime collaborative apps," the browser is half the product. The 0→1
demo that matters is: open two tabs, edit in one, watch the other move.

**Fix**: the app serves its own client SDK by default (e.g. `GET
/workbench.mjs` → `public/workbench-client.mjs`, exactly like the `/events`
WebSocket is baked in — same argument: the framework owns both ends of its own
protocol). Then make ONE full-stack runnable sample (todo or chat) with an
`index.html` that imports it, and fix or delete `files.html`.

### 1.4 `config` is a frozen module-level singleton in the wrong package

`config.mjs` reads `process.env` at import time, freezes, and hard-codes
`sessionDurationMs`. Consequences: two apps in one process can't differ; tests
can't override without env mutation before first import; samples must import
from `workbench/internal` to get the port — so half the samples hardcode `3000`
instead (`note.mjs:28`, `gdoc.mjs:114`, `todo.mjs:129`), teaching the wrong
pattern.

**Fix**: fold config into the `workbench(options)` seam — per-app options with
env-var fallbacks (`port: options.port ?? env.PORT ?? 3000`,
`session: { durationMs }`). `listen()` with no port uses `app.config.port`.
Keep a read-only `config` export for the env-sourced defaults if desired, but
apps should never need `workbench/internal` for it.

### 1.5 Grant boilerplate (confirmed at scale)

The owner-only `scope(({is}) => is.owner()).can(...)` block appears
character-for-character in 5+ samples, and `VIEWER/EDITOR/OWNER` capability
arrays in 7 (see the DX inventory; `projects/todo/PAIN-POINTS.md` SHARP EDGE #1
already names this). FABLE-5-REVIEW D4 settled `owner()`/`owner.only()` as a
transparent expansion — this review just adds urgency: it is the single most
repeated code across every sample, i.e. the top of the 0→1 funnel.

### 1.6 Sample/doc rot undermines "exemplars are the source of truth"

- `README.md:20-28` points at root-level `doc.mjs`/`todo.mjs` and `node
  doc.mjs` — the files moved to `projects/` (this branch), and `node
  projects/doc.mjs` isn't runnable anyway (declares entities, no db).
- `google-photos/album.mjs:127` uses `Inbox` without importing it;
  `space-invaders/match.mjs` uses `everyone()`/`now`/`self` without importing
  them — both throw at load.
- The PAIN-POINTS docs still list `blob` and jobs as missing; both have since
  shipped. A reader can't tell which pain points are settled.

If exemplars are binding, they must run. Cheap fix: a smoke test that imports
every `projects/**/*.mjs` (load-time errors are exactly what the framework
prides itself on catching).

### 1.7 Smaller frictions worth recording

- **Magic conventions with no home in docs**: `role:'owner'` auto-deriving
  `checks.owner` *and* erroring if you redeclare it (the natural newcomer move);
  `req.doc` auto-loading from a `:docId` param; the lazy `await import()` dance
  for parent/child grant cycles (`doc.mjs:12-16`). All defensible designs — all
  discoverable only by reading inline comments in samples.
- **`workbench` vs `workbench/internal` boundary is illegible**: samples reach
  into internal for `config`, `generateDDL`, and field types (`blob`,
  `projected`, `json`, `list` — `google-photos/photo.mjs:9-14`) that ARE in the
  main export (`index.mjs:1`). The photo sample predates the export; nobody
  went back. Decide the rule (suggest: everything an *app* may need is in
  `workbench`; `internal` is for the framework's own tests/tooling) and sweep.

### 1.8 The target: what 0→1 should look like

WhatsApp-clone floor after §1.1–§1.3 land — every line is domain, zero lines
are plumbing:

```js
import workbench, { entity, text, date, ref, map, grant, read, write,
  subscribe, deny, scope, anyOf, inherit } from 'workbench';

const Chat = entity('Chat', {
  title:   text(),
  owner:   ref('User', { role: 'owner', readonly: true }),
  members: map(ref('User'), { default: {} }),
  checks:  { member: ({ Chat, principal }) => Chat.members.has(principal.id) },
  grant: () => [scope(({ is }) => anyOf(is.owner(), is.member()))
    .can(() => grant(read, write, subscribe))],
});

const Message = entity('Message', {
  chat:   ref('Chat', { required: true }),
  author: ref('User', { role: 'author', readonly: true }),
  body:   text({ validate: (v) => v?.length > 0 || 'empty message' }),
  sentAt: date({ default: () => new Date() }),
  grant:  inherit(Chat, { via: 'chat' }),
});

workbench({ db: 'chat.db' })   // string → built-in sqlite; auto-DDL; WAL
  .auth()                      // /auth signup+login+logout, sets sid cookie
  .mount('/chats', Chat)
  .mount('/chats/:chatId/messages', Message)
  .static('/', 'public')       // index.html; /workbench.mjs served by default
  .listen();                   // port from config/env
```

~30 lines of entities + 6 of wiring, and both tabs sync. That is the demo that
sells the framework, and every piece except `.auth()`, `db:'string'`, and
serving the client already exists.

---

## 2. The plugin boundary — what should swap, and how

Design stance (matching the stated intent): **instance-level injection via
configuration** — you construct the app and hand it an implementation; no
global plugin registry, no import-time side effects. The framework ships
default implementations; future first-party plugins are just other values for
the same config keys.

```js
workbench({
  db:    sqlite('app.db'),          // default; string sugar for exactly this
  blobs: s3({ bucket, prefix }),    // default: fsBlobs({ root: '.blobs' })
  log:   { level, channels },       // already injected this way — the model to copy
})
```

`principalOf`, `log`, `jobs`, and the post-commit consumer list already follow
this pattern. The work is promoting two more seams to it: the db and the blob
store.

### 2.1 The db driver seam — findings from the full coupling inventory

An exhaustive sweep of `src/` (28 files touch SQL or the handle) found the
*method* surface is already tiny:

| Driver method | Contract |
|---|---|
| `prepare(sql)` → `{run, get, all}` | ~95% of all access; `run` must return `{changes}` (job-queue and blob-store branch on it); `get` returns `undefined` for no row |
| `exec(sql)` | DDL, PRAGMA, transaction control |
| both `:name` and `?` params | both styles are used today |

But four **behavioral** couplings matter more than the methods:

1. **Synchrony.** Every call site is synchronous; the pipeline brackets
   `BEGIN IMMEDIATE`…`COMMIT` around awaits, relying on the single-writer
   `writeQueue` + sync statements. An async driver breaks the kernel, not just
   the call sites.
2. **Transaction control as raw literals** — `pipeline.mjs` and
   `migrations.mjs` issue `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` via `exec`.
3. **Two upsert idioms** — `ON CONFLICT … DO UPDATE SET x = excluded.x`
   (`_Cursor`, `_ConsumerCursor`) and `INSERT OR REPLACE` (`_ProjectedCursor`,
   ephemeral side-tables).
4. **Dialect generators** — `scope-sql.mjs` (portable today), `ddl.mjs` (type
   mapping, `PRAGMA table_info`), `side-table-strategy.mjs` (`ORDER BY rowid`),
   and `job-queue.mjs`'s claim (`UPDATE … RETURNING *` with a sub-select — the
   single most dialect-specific statement in the codebase).

**First-principles recommendation: define the driver contract as synchronous
and embedded, and say so out loud.** The honest v1 plugin story is "swap the
SQLite *implementation*" — file/memory/libSQL-embedded/encrypted — not "swap to
Postgres." A network database would invalidate the synchronous single-writer
kernel that the whole design (writeQueue, in-txn admission, 30–60Hz fanout)
leans on; abstracting toward it now would cost the simplicity that is the
product. Cross-dialect portability becomes tractable later *only* through the
generator modules, and those are already centralized — that's the insurance,
and it's already bought.

**Concrete steps (cheap now, prerequisite for any driver later):**

1. **Name the contract.** A `driver` is `{ prepare, exec }` + the behavioral
   contract above, documented in one place. `workbench({ db })` accepts a
   string (constructs the default driver) or any conforming object. The PRAGMA
   block moves into the default sqlite driver's constructor (a libSQL driver
   has its own bootstrap).
2. **Give transactions and upsert a home.** `driver.txn(fn)` (or
   `begin/commit/rollback` methods) replaces raw `exec('BEGIN IMMEDIATE')` in
   `pipeline.mjs` + `migrations.mjs`; one upsert helper replaces the two idioms
   in `consumer-cursor.mjs`/`projected-async.mjs`/`side-table-strategy.mjs`.
   After this, *everything outside the four generator modules is
   driver-portable by construction.*
3. **Contain the ambient.** `setActiveDb` is a module-level global
   (`db.mjs:13`): one db per process, colliding with multi-app tests and any
   future two-tenant use. Keep the ambient as the *default* binding (the
   declare-entities-without-an-app ergonomics are worth it) but route it
   through the app: entity query handles resolve `app → active` rather than a
   bare global, and constructing a second app with a different db either works
   or throws loudly. (The ambient entity registry in `db.mjs:36` has the same
   shape; same treatment.)

### 2.2 The blob store — the best first *shipped* plugin

`blob-store.mjs` fuses three concerns: byte storage (`node:fs`), metadata rows
(`BlobStore` table), and lifecycle (pending→adopt→finalize, reap). The
google-photos stress test says byte storage is the primitive of a photo app,
and S3-compatible storage is the obvious deployment reality. The lifecycle and
metadata are the framework's invariant; only the *byte* half should swap:

```
BlobBytes: put(id, bytes) / finalize(id) / read(id) → stream / unlink(id) / exists(id)
```

`workbench({ blobs: { root } })` today becomes `blobs: fsBlobs({ root })` by
default with `s3Blobs({...})` as the first first-party plugin. This is a
narrower, lower-risk seam than the db and proves the plugin pattern end-to-end
(config-injected interface + framework-owned lifecycle around it).

### 2.3 Field types — the third seam, later

Samples already want field types that arrived late (`blob`, `projected`,
`list`). `field-strategy.mjs`/`side-table-strategy.mjs` are internally
strategy-shaped already; a public `registerFieldType` (or a `fields:` config
key) is the natural extension point for domain plugins (geo, full-text,
CRDT toolkits — the deferred `raster`/`polyline` work would itself ship as
one). Not urgent; note it so the strategy seam isn't accidentally sealed.

### 2.4 What should NOT be pluggable

Fail-closed authorization, the event log format, the dispatch pipeline, and the
live protocol are the *identity* of the framework — the singular-system rule.
Making them swappable would reintroduce the second paths the whole design
exists to abolish. The plugin boundary is infrastructure (where bytes/rows
live, how identity arrives, where jobs run), never semantics.

---

## 3. Priority order

| # | Work | Why first |
|---|---|---|
| 1 | `db:` accepts string/default; PRAGMAs move into default driver; delete DDL+PRAGMA boilerplate from `todo-app.mjs` | Unblocks every sample; is the plugin seam's front door |
| 2 | Auth battery: `.auth()` routes + `Set-Cookie` on login + `sessionCookie` in main export + `client.login()` | No target app works without it; pieces all exist |
| 3 | Serve client SDK by default + one full-stack two-tab sample; fix/delete `files.html`; README paths | The demo that sells the framework |
| 4 | Load-smoke-test all `projects/**/*.mjs`; fix broken imports; mark stale PAIN-POINTS as settled | Restores "exemplars are binding" |
| 5 | `owner.only()` grant sugar (settled as D4) | Top repeated boilerplate |
| 6 | Per-app config; `listen()` portless; retire `workbench/internal` for app needs | Kills the internal-import habit |
| 7 | Driver contract doc + `driver.txn`/upsert homes + contained ambient | Cheap now, expensive later; enables db plugins |
| 8 | Blob byte-store interface, `fsBlobs` default | First shipped plugin, proves the pattern |

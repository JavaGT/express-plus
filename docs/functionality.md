# Functionality reference (public app API)

This document describes **shipped, public** library functionality: what you import
from `workbench` and `workbench/client`, and the major optional seams apps engage
when constructing the app (`workbench({ … })`, `.auth()`, jobs, blobs).

- Domain nouns: **[CONTEXT.md](../CONTEXT.md)**  
- Design rules: **[AGENTS.md](../AGENTS.md)**  
- Module map: **[architecture-map.md](architecture-map.md)**  
- Server-only helpers: `import … from 'workbench/server'`

Status: **implemented** (green `node --test` suite). Prefer this guide and running
samples over historical roadmap wording in older SPEC sections.

---

## 1. App assembly

### `workbench(options)` (default export)

Creates a chainable app.

```js
import workbench from 'workbench';

const app = workbench({
  db: 'app.db',              // string path, ':memory:', or DatabaseSync
  // jobs: { sharedSecret: '…' },
  // blobs: { root: '.blobs' },
  // migrations: […],
  // requireEnv: ['MY_KEY'],
});

app.mount('/notes', Note)
  .auth()                    // optional: /auth/* login surface
  .listen(3000);             // or .listen() → config.port (default 3000)

await app.ready;             // schema + kernel ready
```

| Option | Purpose |
| --- | --- |
| `db` | Engage SQLite persistence; framework runs entity + framework DDL |
| `jobs` | Engage job-queue substrate (`sharedSecret` required) |
| `blobs` | Blob store root for binary fields / `POST /blobs` |
| `migrations` | Versioned schema migrations at startup |
| `requireEnv` | Fail closed at construction if env vars missing |

### Chain methods (common)

| Method | Purpose |
| --- | --- |
| `.mount(path, Entity)` | Mount entity CRUD (+ entity `routes`) |
| `.auth(opts?)` | Mount framework `/auth` routes (login, logout, passkey/TOTP when used) |
| `.static(urlPath, dir)` | Serve static files |
| `.use(prefix, handler)` | Imperative middleware/handler mount |
| `.listen(port?, opts?)` | Open HTTP + live `/events`; opts include `principalOf`, rate limits, CORS |
| `.ready` | Promise: routes resolved, schema prepared, kernel started |

### `router()`

Imperative router for hand-written routes (auth boundaries, custom verbs):

```js
import { router, allowAnonymous } from 'workbench';
const r = router();
r.post('/login', allowAnonymous(), async (req, res) => { /* … */ });
```

### `matchRoute`, `serveStatic`

HTTP utilities for custom servers or static directories (also used by the framework).

---

## 2. Declaring data — `entity` and fields

### `entity(name, declaration)`

Compiles a persisted record type: fields, grant, optional routes, effects,
schedules, membership sugar, create policy.

```js
import { entity, text, boolean, owner, scope, grant, read, write, subscribe } from 'workbench';

const Note = entity('Note', {
  title: text({ required: true }),
  done: boolean({ default: false }),
  owner: owner(),
  grant: () => [
    scope(({ is }) => is.owner()).can(() => grant(read, write, subscribe)),
  ],
});
```

An entity **without a grant is a load-time error** (fail closed).

### Field constructors (`workbench` exports)

| Constructor | Kind / role |
| --- | --- |
| `text`, `boolean`, `date`, `number`, `json` | Scalar value fields |
| `ref(Target, opts)` | Typed foreign key (`role` for owner-style checks) |
| `hash()` | One-way password digest + `row.password.verify()` |
| `blob()` | Blob id field (upload via `POST /blobs`, adopt on write) |
| `link` | Share-link style principal field |
| `map`, `list`, `log` | Side-table / collection shapes |
| `ephemeral` | Non-durable live field (e.g. presence strokes) |
| `state` | Finite state with transition effects |
| `computed` / `computed.stored` | Derived values (read-time or stored) |
| `projected` / `projected.async` | Projection / async recompute fields |
| `raster`, `polyline` | Geometry-ish CRDT **replace stubs** (last-write-wins; not text-merge) |
| `vector(dim)` | Embedding vectors + nearest queries |
| `owner()` / `owner.only` | Owner ref sugar / owner-only grant sugar |
| `now` | Deferred “commit-time now” token for schedules/handlers |

Options commonly include `required`, `default`, `readonly`, `validate`, `indexed: 'fts'`.

### Side-table mutation

Map/ordered/log fields mutate via **row handles** on the loaded entity (HTTP
imperative routes or field sub-routes), not as opaque blobs in every PATCH body.

---

## 3. Authorization

### Capabilities — `grant`, `deny`, `read`, `write`, `subscribe`, `admin`

```js
import { grant, deny, read, write, subscribe, admin } from 'workbench';

.can(async ({ is }) => {
  if (await is.owner()) return grant(read, write, subscribe, admin);
  return deny('not authorized');
});
```

### Row scope — `scope`, `everyone`, `never`, `anyOf`, `inherit`

| API | Purpose |
| --- | --- |
| `scope(predicate).can(fn)` | SQL-compilable visibility + runtime capabilities |
| `everyone()`, `never()` | Open / closed row filters |
| `anyOf(…checks)` | OR composition of checks |
| `inherit(Parent, { via })` | Child grant follows parent row (typed FK) |

Two default-on layers on every entity request:

1. **Route gate** — auth required unless `allowAnonymous()` / entity `gate`  
2. **Row grant** — SQL scope + `.can` (same engine for REST and live)

### Route gates

| API | Purpose |
| --- | --- |
| `requireUser` | Default gate: authenticated user |
| `allowAnonymous` | Opt out for login/public routes |

### Principals

| API | Purpose |
| --- | --- |
| `principal({ type, id, attributes? })` | Build a principal |
| `anonymous` | Unauthenticated principal |

Closed kinds include `user`, `anonymous`, `system`, `link`, `apiKey` (and effect-
tagged system principals for in-txn effects).

### Membership sugar

```js
import { membership } from 'workbench';
// inside entity declaration:
// membership: { member: { can: [read, subscribe] } }
// or membership(Entity, { … }) after compile
```

### Session helpers (public)

| API | Purpose |
| --- | --- |
| `sessionCookie(token, opts)` | Fail-closed `Set-Cookie` (`sid`) |
| `sessionPrincipalOf(db)` | Cookie → principal (default when `db` engaged) |
| `sessionTokenOf(req)` | Read token from request |
| `apiKeyPrincipalOf(db)` | Bearer API key → principal |
| `parseCookies`, `SESSION_COOKIE` | Cookie parse helpers |

### Framework entities

Shipped from `workbench` (not redeclared by apps):

`User`, `Session`, `Inbox`, `Credential`, `Invitation`, `ApiKey`, `TwoFactor`

### Invitation helpers

`createInvitation`, `acceptInvitation`, `rejectInvitation`, `listInvitationsForUser`

### Auth product routes

`.auth()` mounts login/logout and related routes (passkeys, TOTP, API keys as
implemented). See `projects/chat` and auth tests for shapes.

---

## 4. Effects, schedule, tick

### In-transaction effects

```js
import { effect, inc, dec, self, many } from 'workbench';

// On entity:
// effects: (Self) => [
//   [Self.created, { mutate: Inbox, with: ({ delta, origin }) => ({ … }) }],
// ]
```

| API | Purpose |
| --- | --- |
| `effect` / pairs on entity | Trigger → mutate target in the **same** txn |
| `inc`, `dec` | RMW operators in `with` templates |
| `self`, `many` | Target origin row or FK collection fan-out |

Effects re-enter the durable pipeline under a bounded **effect principal**.
Target must admit effects. Out-of-band work (email/webhook) is **not** an
in-txn effect — use post-commit seams.

### Time sources

| API | Purpose |
| --- | --- |
| `schedule.at` / `schedule.after` | One-shot deadlines from a date/number field |
| `tick.hz` / `tick.every` | Recurring row-set scans → dispatch |
| `simulate` | Test helper for time-driven paths |

Clock dispatch is unified (`startClockTriggers` internally). Jobs’ lease reaper
is separate (`jobs` option).

---

## 5. Optional server seams

### Email (post-commit)

```js
import { emailSeam, noopTransport } from 'workbench';

const mail = emailSeam({ transport: async ({ to, subject, body }) => { /* SMTP */ } });
// mail.install(app) before listen — wires app._emailConsumer
// mail.send(app, { to, subject, body }) when jobs engaged
```

Default `noopTransport` logs only. Transport failures never roll back the origin.

### Jobs

```js
const app = workbench({
  db: 'app.db',
  jobs: { sharedSecret: process.env.JOB_SECRET },
});
// Framework intercepts worker HTTP: register / claim / heartbeat / result
// app.jobs.enqueue({ kind, payload })
```

### Blobs

```js
const app = workbench({ db: 'app.db', blobs: { root: '.blobs' } });
// POST /blobs (authenticated) → pending id; entity blob fields adopt on write
```

### Email / durable effects / projected.async

Declared on entities or installed as post-commit consumers; they run **after**
commit and must not invent a second write path into entity rows outside the
kernel.

---

## 6. HTTP surface the framework owns

When you `listen`, the framework serves (among other things):

| Path | Purpose |
| --- | --- |
| Entity mounts | CRUD for each `.mount` |
| `GET /health` (+ stats) | Liveness |
| `GET /snapshot/...`, `GET /events-since/...` | Bootstrap / resync |
| `WS /events` | Live subscriptions |
| `POST /blobs` | Blob upload (if blobs engaged) |
| Job worker routes | If jobs engaged |
| `/auth/*` | If `.auth()` |
| `/workbench.mjs` | Browser client SDK |

CSRF: foreign Origin/Referer rejected on mutations; same-origin / non-browser
(no Origin) allowed.

---

## 7. Browser client — `workbench/client`

```js
import {
  LiveChannel,
  LiveList,
  createLiveStore,
  createAuthClient,
  decodeResult,
} from 'workbench/client';
// or script src="/workbench.mjs" from a listening server
```

| Export | Purpose |
| --- | --- |
| `LiveChannel` | One WebSocket to `/events`; subscribe/unsubscribe; reconnect |
| `LiveList` | One document: snapshot bootstrap → stream; span-aware cursor |
| `createLiveStore` | Factory: CRUD dispatch + optimistic overlay + live lists |
| `createAuthClient` | Login/logout helpers against `/auth` |
| `decodeResult` | Shared HTTP result decode |

**One reconciliation path:** live envelopes and resync rows fold through the same
ingest decision (duplicate / next / gap). Optimistic UI is a placeholder until
the committed event folds.

Related: `public/workbench-ui*.mjs` + Svelte primitives (UI kit) bind to the
store; props catalogue is out of scope here — see components under `public/`.

---

## 8. What is *not* public app API

| Surface | Status |
| --- | --- |
| Unexported `src/*` modules | Framework implementation details |
| `src/kernel.mjs`, `pipeline.mjs`, raw DDL helpers | Framework assembly |
| PLANS / DECISIONLOG history | Execution history, not API |
| Sample apps under `projects/*` | Examples, not package exports |

If an app needs an implementation detail, first promote a deliberately supported
export through `workbench` or `workbench/server`.

---

## 9. Minimal end-to-end shape

```js
import workbench, {
  entity, text, owner,
  grant, read, write, subscribe, scope,
} from 'workbench';

const Note = entity('Note', {
  title: text({ required: true }),
  owner: owner(),
  grant: () => [
    scope(({ is }) => is.owner()).can(() => grant(read, write, subscribe)),
  ],
});

workbench({ db: ':memory:' })
  .mount('/notes', Note)
  .listen(0); // tests often use port 0
```

Runnable files:

- **[examples/minimal-note.mjs](../examples/minimal-note.mjs)** — curl CRUD  
- **[projects/chat/server.mjs](../projects/chat/server.mjs)** — auth + live UI  
- **[docs/quickstart.md](quickstart.md)** — step-by-step  

---

## 10. Mental model (three loops)

1. **Compile** — declaration → handlers, DDL, grants  
2. **Commit** — action → sequenced log event → projected row  
3. **Deliver** — post-commit → re-auth → WebSocket / HTTP snapshot → client fold  

Optional features (auth product, jobs, blobs, email) are a **coat** on that
machine — they must not invent a second write or auth path.

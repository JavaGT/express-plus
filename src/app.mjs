// The app assembly layer — Todo C (SPEC §3, §4, §6.2; ADR #20).
//
// `workbench()` is the default export: a chainable app. Assembly is TWO-PHASE.
// `app.mount(path, Entity)` RECORDS an ordered mount declaration and returns the
// app synchronously, so the fluent `app.mount(...).mount(...).listen()` chain is
// preserved. The concrete routing table is RESOLVED later by `resolveRoutes()`:
// it invokes each entity's `routes:(r, Entity)=>...` thunk with a route builder
// `r`, whose `r.resource()` declares the five CRUD verbs. The per-verb route
// gate is owned by the entity declaration (`gate: { list: allowAnonymous() }`)
// and resolved once at compile time through resolveRouteGate; `r.resource()`
// takes no gate arg — there is no per-mount override (AGENTS: one authorization
// story, not two places). Resolution is ASYNC — an
// entity's `routes` thunk may be `async` and dynamic-import a child module at
// wiring time (the parent/child lazy mount that breaks an import cycle without a
// second route-building path). The result is an INSPECTABLE routing table: a list
// of { method, path, verb, entity, gate } (CRUD) and { method, path, gate,
// handlers } (imperative) entries.
//
// This is the WIRING that connects a declared entity to its mounted routes with the
// two default-on auth layers intact — the route gate here, the row grant (the SQL
// scope + .can) still running on every verb downstream. There is no second auth
// path: this layer decides route admission, never row visibility.
//
// `.listen(port)` finalizes (resolveRoutes) and then opens the real node:http
// socket; it returns the app synchronously (chainable) and exposes the boot as
// `app.ready`. The server never serves a partial table — resolution completes
// before the request handler is created.

import { requireUser, isGate } from './route-gate.mjs';
import { listen as serveListen } from './serve.mjs';
import { setActiveDb } from './db.mjs';
import { wrapDriver } from './driver.mjs';
import { executeDDL, executeFrameworkDDL } from './ddl.mjs';
import { runMigrations } from './migrations.mjs';
import { createBlobStore } from './blob-store.mjs';
import { createJobQueue } from './job-queue.mjs';
import { createClock } from './clock.mjs';
import { createLog, setAmbientLog, getLog } from './log.mjs';
import { serveStatic } from './views.mjs';
import { authRoutes } from './auth/routes.mjs';
import { User, Session, Credential, Invitation, ApiKey, TwoFactor } from './auth/entities.mjs';
import { config, resolveConfig } from './config.mjs';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// The HTTP methods an imperative router verb maps to. `r.get/post/patch/delete`
// build a hand-written route (a handler chain) rather than entity CRUD.
const IMPERATIVE_VERBS = Object.freeze({
  get: 'GET',
  post: 'POST',
  patch: 'PATCH',
  delete: 'DELETE',
});

// The five CRUD verbs a resource exposes, each mapped to its Express-style HTTP
// method and path suffix (relative to the resource's base path). `:id` is the
// per-row path parameter the dispatcher binds to load a single row.
const RESOURCE_VERBS = Object.freeze([
  { verb: 'list', method: 'GET', suffix: '' },
  { verb: 'create', method: 'POST', suffix: '' },
  { verb: 'read', method: 'GET', suffix: '/:id' },
  { verb: 'update', method: 'PATCH', suffix: '/:id' },
  { verb: 'remove', method: 'DELETE', suffix: '/:id' },
]);

// Join a base path and a suffix into a single clean path. The base may be '/'
// (a router mounted bare) or '/notes'; the suffix is '' or '/:id'. Collapses any
// doubled slash so `'/' + '/:id'` does not become '//:id'.
function joinPath(base, suffix) {
  const joined = `${base}${suffix}`;
  return joined.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1');
}

// Build one imperative route record from a verb method call `r.get(path, ...rest)`.
// `rest` is the varargs chain: zero or more LEADING branded gates, then optional
// middleware, then exactly one final handler. Leading branded gates peel off the
// front into a single `gate` (the LAST leading gate wins if several are stacked —
// but normally exactly one). A plain (unbranded) function never peels — it is a
// handler/middleware and stays in the chain. With no leading gate the route
// defaults to requireUser() (fail closed: an undeclared-gate route admits no
// anonymous principal). The remaining chain must contain at least one handler.
//
// The record shares the route spine { method, path, gate } with entity CRUD
// routes but carries an imperative tail { handlers } instead of { entity, verb };
// the dispatcher discriminates structurally on the presence of `handlers`.
function buildImperativeRoute(method, path, rest) {
  let i = 0;
  let gate = requireUser();
  let gateDeclared = false;
  while (i < rest.length && isGate(rest[i])) {
    gate = rest[i];
    gateDeclared = true;
    i += 1;
  }

  const handlers = rest.slice(i);
  if (handlers.length === 0) {
    const detail = gateDeclared
      ? 'a gate alone is not a route'
      : 'a route must declare at least one handler';
    throw new Error(
      `imperative route ${method} ${path} has no handler — ${detail}. ` +
        `Pass (path, ...gates, handler).`,
    );
  }
  // A handler must be a function; a stray non-function in the chain is a typo.
  for (const handler of handlers) {
    if (typeof handler !== 'function') {
      throw new Error(
        `imperative route ${method} ${path} has a non-function handler. ` +
          `The chain is (...middleware, handler), each a function.`,
      );
    }
  }

  return Object.freeze({ method, path, gate, handlers: Object.freeze(handlers) });
}

// Re-base an already-resolved route under a parent mount path (used when a router
// mini-app is mounted into a parent app). The route's path was resolved relative
// to the router's own base; mounting re-roots it under `parentBase`.
function rebaseRoute(route, parentBase) {
  return Object.freeze({
    ...route,
    path: joinPath(parentBase, route.path),
  });
}

// A mountable surface — the shared core of the top-level app, a router mini-app,
// and the `r` handed to an entity's `routes:(r, Entity)=>...` thunk. Two-phase
// assembly: every `mount`/`use`/verb call RECORDS an ordered declaration; the
// concrete `routes` table is RESOLVED later by `resolveRoutes()`. Recording is
// synchronous (so the fluent `app.mount(...).mount(...).listen()` chain is
// preserved), but resolution may be async — an entity's `routes` thunk can be
// `async` and dynamic-import a child module at wiring time (the parent/child
// lazy-mount that breaks an import cycle). `mergeParams` is carried so a child
// router mounted under a parametric parent path (`/:docId/notes`) can read the
// parent's path param. `resource` is present only on the per-entity builder
// (bound to its entity + base); a bare router/app has no resource of its own.
function makeMountable({ mergeParams = false, entity = null, base = '/' } = {}) {
  const declarations = [];
  const routes = [];
  let resolution = null; // the in-flight/resolved finalization promise (idempotent)

  // When an ENTITY-bound builder mounts a child under a `:<entityName>Id` path
  // segment (doc.mjs: `r.mount('/:docId/shares', ...)` on Doc's builder), the
  // framework auto-loads that entity row by the path param and attaches it to
  // `req.<entityName>` for every descendant route — so a share handler reads
  // `req.doc` with no hand-written load boilerplate. The convention is scoped to
  // an entity's own route subtree (a generic router mounting `:userId` does NOT
  // auto-load), and the param name carries the link (no magic string — the
  // entity name is the link, named in the path).
  function makeAutoLoad(path) {
    if (!entity || typeof entity.name !== 'string') return null;
    const key = entity.name.toLowerCase();
    const param = `${key}Id`;
    return path.includes(`:${param}`) ? { param, entity, key } : null;
  }

  function recordMount(path, target) {
    if (resolution) {
      throw new Error('cannot mount after routes are resolved — assemble the app before listen()');
    }
    // `app.use(prefix, fn)` — a FUNCTION target is a catch-all request handler
    // under the prefix (the Express idiom for mounting a raw router/handler). It
    // is a distinct declaration kind: it does not contribute routes to the
    // matchRoute table (the matcher needs exact segment count and has no
    // wildcard), it intercepts by URL prefix BEFORE matchRoute. This is the
    // permanent home for third-party routers that own their own dynamic
    // sub-paths (e.g. better-auth's `/api/auth/[...all]`) and generalizes the
    // former `app.static` special-case — one prefix-intercept mechanism,
    // declared by apps, not baked into serve.mjs.
    if (typeof target === 'function') {
      declarations.push({ kind: 'handler', prefix: normalizePrefix(path), fn: target });
      return surface;
    }
    declarations.push({ kind: 'mount', path, target, autoLoad: makeAutoLoad(path) });
    return surface;
  }

  // Trim trailing slashes so the prefix-intercept matches with startsWith: the
  // bare prefix ('/api/auth') and any path under it. The bare root '/' collapses
  // to '/' so it matches everything, and `pathname.slice('/'.length)` still
  // yields the tail.
  function normalizePrefix(prefix) {
    return prefix.replace(/\/+$/, '') || '/';
  }

  const surface = {
    mergeParams,
    routes,
    declarations,
    mount: recordMount,
    use: recordMount,
  };

  // The per-entity builder also exposes `r.resource()`: expand the five CRUD
  // verbs for THIS entity at THIS base. The per-verb route gate comes from the
  // entity's compiled `gate` (declared next to `grant`); there is no gate arg.
  if (entity) {
    surface.resource = () => {
      if (resolution) {
        throw new Error('cannot declare routes after resolution');
      }
      declarations.push({ kind: 'resource' });
      return surface;
    };
  }

  // Imperative verb methods: `r.get/post/patch/delete(path, ...gates, handler)`.
  // Each records an imperative declaration; at resolution it becomes a route in
  // the SAME table the entity CRUD routes live in — one routing table,
  // discriminated by tail shape.
  for (const [verb, method] of Object.entries(IMPERATIVE_VERBS)) {
    surface[verb] = (path, ...rest) => {
      if (resolution) {
        throw new Error('cannot declare routes after resolution');
      }
      // buildImperativeRoute validates synchronously (a route with no handler is
      // a declaration error and must throw at authoring time, not at resolution).
      declarations.push({ kind: 'imperative', route: buildImperativeRoute(method, path, rest) });
      return surface;
    };
  }

  // Drain the ordered declarations into `routes`. Idempotent: the first call
  // performs (and caches) resolution; later calls return the same promise. An
  // entity's `routes` thunk may be async, so resolution is async throughout —
  // the synchronous recording above is what keeps the public chain sync.
  surface.resolveRoutes = () => {
    if (resolution) return resolution;
    resolution = (async () => {
      for (const decl of declarations) {
        if (decl.kind === 'imperative') {
          routes.push(rebaseRoute(decl.route, base));
        } else if (decl.kind === 'resource') {
          for (const route of resolveResource(entity, joinPath(base, ''))) {
            routes.push(route);
          }
        } else if (decl.kind === 'handler') {
          // A function-target `use` does not add to the matchRoute table — it
          // intercepts by prefix before the table is consulted. Collected in
          // declaration order so the first matching prefix wins.
          (surface._handlers ??= []).push({ prefix: decl.prefix, fn: decl.fn });
        } else if (decl.kind === 'mount') {
          for (const route of await resolveMount(decl.path, decl.target)) {
            const rebased = rebaseRoute(route, base);
            // Stamp the entity auto-load onto every descendant route so a
            // handler under `/:docId/shares` finds req.doc regardless of how
            // deeply the child router nests.
            routes.push(decl.autoLoad ? Object.freeze({ ...rebased, autoLoad: decl.autoLoad }) : rebased);
          }
        }
      }
      return routes;
    })();
    return resolution;
  };

  return surface;
}

// Resolve one `mount(path, target)` declaration into a flat list of route records
// based under `path`. A router/entity-builder target (anything with its own
// declarations + resolveRoutes) is finalized recursively and its routes re-based;
// a compiled entity target is wired through a fresh per-entity builder so its
// `routes:(r, Entity)=>...` thunk runs (awaited — it may be async).
async function resolveMount(path, target) {
  if (target && typeof target.resolveRoutes === 'function' && Array.isArray(target.declarations)) {
    await target.resolveRoutes();
    return target.routes.map((route) => rebaseRoute(route, path));
  }
  return buildEntityRoutes(target, path);
}

// Expand the five CRUD verbs for `entity` at `base`. The per-verb route gate is
// owned by the entity declaration (resolved once at compile time through
// resolveRouteGate, unlisted verbs default to requireUser()). There is no
// per-mount gate override — the route gate and the row grant are one
// authorization story on the entity, not two places (AGENTS: prefer a singular
// system). A path needing bespoke admission is a bespoke imperative route.
function resolveResource(entity, base) {
  const resolvedGate = entity.gate;
  return RESOURCE_VERBS.map(({ verb, method, suffix }) =>
    Object.freeze({
      method,
      path: joinPath(base, suffix),
      verb,
      entity,
      gate: resolvedGate[verb],
    }),
  );
}

// Wire one compiled entity at `base` into its route records. The entity's
// `routes:(r, Entity)=>...` thunk receives a per-entity builder (a mountable
// surface that also carries `.resource()` bound to this entity+base). The thunk
// may be async (it can dynamic-import a child module at wiring time); we await it.
// An entity that omits `routes` is auto-CRUD'd via a default `r.resource()`.
async function buildEntityRoutes(entity, base) {
  const r = makeMountable({ entity, base });
  if (typeof entity.routes === 'function') {
    await entity.routes(r, entity);
  } else {
    r.resource();
  }
  await r.resolveRoutes();
  return r.routes;
}

// router(opts) — a mini-app mounted bare into a parent app with
// `app.mount(path, router)`. `{ mergeParams: true }` lets a child read a parent
// path param. A router resolves its routes relative to its own base ('/') and is
// re-based when mounted.
export function router(options = {}) {
  return makeMountable({ mergeParams: options.mergeParams === true });
}

// workbench() — the default export. A chainable app. `.mount(path, Entity)`
// resolves and accumulates routes; `.listen(port, options)` opens a real
// node:http server serving the resolved routing table and returns the app
// (chainable). The server is exposed on `app.httpServer`. `options.principalOf`
// overrides the request→principal source (default: anonymous, fail-closed). Both
// chain.
export default function workbench({ db, blobs: blobOpts, requireEnv = [], migrations = [], jobs: jobOpts, log: logOpts, port, env, session, viewsDir } = {}) {
  // envGate (cso #15): fail-closed at app construction — required env vars must be set.
  for (const v of requireEnv) {
    const val = process.env[v];
    if (!val) {
      throw new Error(`missing required env: ${v}`);
    }
  }
  // A `db` string is a path (or ':memory:') the framework opens itself, so an app
  // never imports DatabaseSync just to hand the framework an instance it could
  // have opened from the same string. One construction path: the PRAGMA bootstrap
  // and `app.prepareSchema()` below own the driver — an app passing a bare string
  // gets the same schema/PRAGMA treatment as one passing a pre-built handle.
  if (typeof db === 'string') {
    const dir = path.dirname(db);
    if (dir && dir !== '.' && db !== ':memory:') {
      mkdirSync(dir, { recursive: true });
    }
    db = new DatabaseSync(db);
  }
  // Wrap the raw handle with the driver contract helpers (txn/begin/commit/
  // rollback/upsert) and run the PRAGMA bootstrap. A conforming custom driver
  // (already providing txn+upsert) is passed through untouched — it owns its
  // own bootstrap. The driver IS the raw handle with helpers attached, so
  // `app.db.prepare` keeps working — entity code and tests reach it everywhere.
  // One construction path: a bare-string app gets the same treatment as a
  // pre-built handle. (seam-review §2.1, priority #7.)
  if (db) db = wrapDriver(db);
  const app = makeMountable();
  // Per-app config — options override env fallbacks (SPEC §3). `app.config` is
  // the one place a mounted route / transport reads this app's port, env,
  // viewsDir, and session duration instead of the process-wide singleton. An
  // option left absent behaves exactly like the singleton (env-sourced
  // defaults), so an app that sets nothing still runs.
  app.config = resolveConfig({ port, env, session, viewsDir });
  // Set up the framework-wide structured logger BEFORE any module imports log.
  // The ambient logger is used by every layer — auth, dispatch, HTTP, live.
  // Callers pass `workbench({ log: { level: 'debug', channels: {...} } })`.
  const log = createLog(logOpts);
  setAmbientLog(log);
  log.info('system', 'workbench() constructed', { db: !!db, jobs: !!jobOpts, migrations: migrations.length });
  // The DB handle is an app-level resource, supplied once at construction and
  // read by every transport (HTTP now, WS /events later) — not a per-transport
  // listen option (DECISIONLOG: the SQLite handle lives on the app because
  // persistence is shared infrastructure; durability still follows the engaged
  // dispatch seam, not this field). An app with no db simply cannot serve
  // DB-backed entity CRUD — fail closed at dispatch.
  app.db = db;
  // Bind the ambient active database so an entity's query API (declared
  // independently of any app) reaches this same handle with no db argument.
  // One shared db — the singular-system rule — not a second persistence path.
  if (db) setActiveDb(db);
  // The blob store is an app-level resource, constructed when a db is engaged
  // (blobs are adopted by dispatch commits — no db, no durable kernel, no
  // blobs). The root defaults to a `.blobs` dir under cwd, durable across
  // restarts (an adopted blob's final file must survive a reboot); `blobs:
  // { root }` overrides. One store, reached by the /blobs upload route AND the
  // kernel's blob adopter — not a second persistence path.
  //
  // SEAM (seam-review §2.2): `blobs` may be either an options bag (`{ root }`,
  // back-compat — the framework builds fsBlobs({root}) internally) OR a
  // conforming byte-store object (e.g. `fsBlobs({root})` or a future
  // `s3Blobs({...})`). Detection is by SHAPE, not type: a byte store exposes
  // `writePending` (the signature method of the byte-store interface); an
  // options bag does not. The framework OWNS metadata + lifecycle; only the
  // byte half swaps.
  if (db) {
    if (blobOpts && typeof blobOpts.writePending === 'function') {
      app.blobs = createBlobStore({ db, bytes: blobOpts });
    } else {
      const root = blobOpts?.root ?? path.join(process.cwd(), '.blobs');
      mkdirSync(root, { recursive: true });
      app.blobs = createBlobStore({ root, db });
    }
  }
  // The job-queue substrate (spec #5) — a separate seam, opt-in. Built at
  // construction when a db + `jobs` config are engaged (the shared secret is
  // required: createJobQueue throws if absent — fail-closed at construction, like
  // envGate). Reached by the framework-owned /workers + /jobs HTTP routes AND by
  // post-commit consumers that call `app.jobs.enqueue(...)`. No `jobs` config →
  // no queue, no routes, no reaper (zero blast radius).
  // The shared clock is the single timer for all framework reapers (schedule,
  // tick, job-queue lease, blob, log-retention, job-worker polls). Created once
  // at app construction so the job queue and later serve.mjs share it.
  const clock = createClock();
  app.clock = clock;
  if (db && jobOpts) {
    app.jobs = createJobQueue({ db, clock, ...jobOpts });
  }
  app.port = undefined;
  app.httpServer = undefined;

  // Versioned schema migrations (eng-review spec #9, #17). Declared at
  // construction; run at startup pre-traffic during schema preparation AFTER the
  // entity tables exist, so each `up` may ALTER/backfill them. One migration txn
  // = (DDL + meta-version bump) atomic; see src/migrations.mjs.
  app.migrations = migrations;

  // Static accessor for the router constructor, so exemplars may write
  // `workbench.router({ mergeParams: true })` alongside the named import.
  // One constructor, two access paths — singular system.
  workbench.router = router;

  // Auto-create tables for mounted entities. Runs during `app.ready` before
  // traffic, after routes resolve and before the kernel starts. The method stays
  // callable for server-only/tests that prepare schema without listening, but it
  // is the same cached path `app.ready` uses — not a second DDL algorithm.
  app.prepareSchema = async () => {
    if (!app.schemaReady) {
      app.schemaReady = (async () => {
        if (!app.db) throw new Error('cannot generate DDL — no db configured on the app');
        // Framework tables come first — Log and Cursor are the durable event substrate.
        executeFrameworkDDL(app.db);
        await app.resolveRoutes();
        const seen = new Set();
        for (const decl of app.declarations) {
          if (decl.kind === 'mount') {
            const entity = decl.target;
            if (entity && typeof entity.name === 'string' && !seen.has(entity.name)) {
              seen.add(entity.name);
              executeDDL(entity, app.db);
            }
          }
        }
        // When `.auth()` is engaged, the framework auth entities (User, Session)
        // back the /auth routes' login/logout but are NOT mounted as entity
        // routes — `app.auth()` mounts an imperative router, not the entities.
        // Their tables would therefore never be created by the mount loop above,
        // yet login writes a User row and mints a Session. Create them here so the
        // battery works out of the box — fail-closed loud otherwise (a missing
        // table would surface as a 500 mid-login). buildKernel already registers
        // these in app.entities for the live/reaper seams; this is the DDL half.
        if (app._authEngaged) {
          for (const fe of [User, Session, Credential, Invitation, ApiKey, TwoFactor]) {
            if (!seen.has(fe.name)) {
              seen.add(fe.name);
              executeDDL(fe, app.db);
            }
          }
        }
        // Migrations run last, pre-traffic, after every entity table exists. Each
        // is its own transaction (DDL + meta-version bump atomic). Runs only when
        // declared — an app with no migrations is untouched (no _Migration table).
        if (app.migrations?.length) runMigrations(app.db, app.migrations);
        return app;
      })();
    }
    return app.schemaReady;
  };
  app.ddl = () => app.prepareSchema();

  app.listen = (port, optionsOrCallback) => {
    // Portless `app.listen()` binds `app.config.port` — the env-or-option value
    // resolved at construction — so an exemplar writes `workbench({ port:
    // 3000 }).listen()` with no redundant argument. An explicit port still wins
    // (the legacy `listen(3000, ...)` shape), preserving one listen path.
    const p = port ?? app.config.port;
    app.port = p;
    return serveListen(app, p, optionsOrCallback);
  };
  // Static file serving — a thin alias over the general `app.use` prefix-intercept
  // seam: `app.static('/public', dir)` is exactly
  // `app.use('/public', serveStatic(dir))`. Retained as a readability convenience
  // (the file-serve factory lives in views.mjs); the framework has ONE interceptor
  // mechanism, not two. A missing file falls through to the next declared
  // handler (e.g. a SPA fallback) rather than short-circuiting the request.
  app.static = (prefix, dir) => app.use(prefix, serveStatic(dir, { prefix: prefix.replace(/\/+$/, '') }));
  // `.auth()` mounts the framework-owned auth battery at `/auth` — login +
  // logout routes that set/clear the fail-closed `sid` cookie (the Set-Cookie
  // the exemplar omits, which is the whole 0→1 auth bug). Built from the SAME
  // public primitives an app would use to hand-roll its own boundary; an app
  // needing bespoke login mounts its own router instead. Returns the app
  // (chainable). Fail closed: an app with no db cannot serve auth — the routes
  // write User rows and mint Sessions, and sessionPrincipalOf has nothing to
  // look a token up in. Throw at construction (loud), not mid-login (a 500).
  app.auth = function auth(options = {}) {
    if (!app.db) {
      throw new Error('app.auth() requires a db — login writes a User row and mints a Session, and the session principal source has nothing to look a token up in without one (fail closed).');
    }
    app._authEngaged = true;
    // `secure` follows THIS app's env, not the process-wide singleton — an app
    // that opts into production cookie behavior does so through `workbench({
    // env: 'production' })`, the one config surface.
    //
    // `identifyBy` declares which User field(s) a login credential matches
    // (in order). Defaults to `['username']`. Pass `['email', 'username']` for
    // email-based login. See `authRoutes` for the full contract.
    app.mount('/auth', authRoutes({ secure: app.config.env === 'production', identifyBy: options.identifyBy }));
    // Per-app session duration: when the app's duration differs from the
    // singleton default, install a shallow copy of Session whose schedule.remove
    // trigger carries the app's delay. The compiled trigger (compile.mjs) is a
    // frozen object stamped with fieldName/whileSql/whileParams/whileAst/
    // sourceName/matches/delay — spreading it and overriding `delay` preserves
    // every stamped prop, so no re-compile is needed. buildKernel prefers this
    // copy over the framework Session, and the reaper / admitSystemMutation read
    // the delay off the entity in `app.entities` at runtime. Shallow spread is
    // safe: Session is a frozen Proxy whose field-handle/lifecycle-handle
    // resolution was used at declaration time, not runtime; the record's own
    // props (crudHandlers/projection/hydrate/findById/grant/registry/schedule)
    // are what downstream seams read.
    if (app.config.sessionDurationMs !== config.sessionDurationMs) {
      app._sessionEntity = {
        ...Session,
        schedule: Object.freeze({
          ...Session.schedule,
          remove: Object.freeze({ ...Session.schedule.remove, delay: app.config.sessionDurationMs }),
        }),
      };
    }
    return app;
  };
  return app;
}

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

import { listen as serveListen } from './serve.mjs';
import {
  maintenanceDefaults,
  startApplication,
  validateMaintenanceOptions,
} from './application-runtime.mjs';
import { wrapDriver } from './driver.mjs';
import { executeDDL, executeFrameworkDDL } from './ddl.mjs';
import { runMigrations } from './migrations.mjs';
import { createBlobStore } from './blob-store.mjs';
import { createJobQueue } from './job-queue.mjs';
import { createClock } from './clock.mjs';
import { createWriteQueue } from './write-queue.mjs';
import { prepareGracefulShutdown } from './lifecycle.mjs';
import { createLog, withLog } from './log.mjs';
import { serveStatic } from './views.mjs';
import { authRoutes } from './auth/routes.mjs';
import { User, Session, Inbox, Credential, Invitation, ApiKey, TwoFactor } from './auth/entities.mjs';
import { config, resolveConfig } from './config.mjs';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { joinPath, buildImperativeRoute, makeMountable, resolveMount, resolveResource, buildEntityRoutes, RESOURCE_VERBS, IMPERATIVE_VERBS } from './router.mjs';

// router(opts) — a mini-app mounted bare into a parent app with
// `app.mount(path, router)`. `{ mergeParams: true }` lets a child read a parent
// path param. A router resolves its routes relative to its own base ('/') and is
// re-based when mounted.
export function router(options = {}) {
  const mergeParams = options.mergeParams === true;
  const surface = makeMountable({ mergeParams });
  // A router is a reusable declaration blueprint. Each parent application
  // resolves a private instance with that application's entity registry, so a
  // cached route can never retain another application's database-bound facade.
  surface.resolveFor = async (entityOf) => {
    const instance = makeMountable({ mergeParams, entityOf });
    instance.declarations.push(...surface.declarations);
    await instance.resolveRoutes();
    return instance.routes;
  };
  return surface;
}

// workbench() — the default export. A chainable app. `.mount(path, Entity)`
// resolves and accumulates routes; `.listen(port, options)` opens a real
// node:http server serving the resolved routing table and returns the app
// (chainable). The server is exposed on `app.httpServer`. `options.principalOf`
// overrides the request→principal source (default: anonymous, fail-closed). Both
// chain.
export default function workbench({
  db,
  entities = [],
  blobs: blobOpts,
  requireEnv = [],
  migrations = [],
  jobs: jobOpts,
  log: logOpts,
  port,
  env,
  session,
  viewsDir,
  resolveScope,
  scopeSnapshot,
  history,
  blobReapIntervalMs = maintenanceDefaults.blobReapIntervalMs,
  blobReapTtlMs = maintenanceDefaults.blobReapTtlMs,
  logRetentionDays = maintenanceDefaults.logRetentionDays,
  logRetentionIntervalMs = maintenanceDefaults.logRetentionIntervalMs,
} = {}) {
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

  const declarationsByName = new Map();
  const bindingsByDeclaration = new Map();
  const bindingsByName = new Map();
  const ownedBindings = new WeakSet();
  let registryLocked = false;
  const runtime = {
    db,
    batch(...args) {
      return app.batch(...args);
    },
    entityOf(value) {
      if (ownedBindings.has(value)) return value;
      if (value?.runtime) {
        throw new Error(`entity '${value.name ?? 'unknown'}' belongs to a different application`);
      }
      const declaration = typeof value === 'string' ? declarationsByName.get(value) : value;
      if (!declaration || typeof declaration.bind !== 'function') {
        const label = typeof value === 'string' ? `'${value}'` : String(value);
        throw new Error(`entity ${label} is not registered with this application`);
      }
      const existing = declarationsByName.get(declaration.name);
      if (existing && existing !== declaration) {
        throw new Error(`entity name '${declaration.name}' is already registered with a different declaration`);
      }
      if (!existing && registryLocked) {
        throw new Error(`cannot register entity '${declaration.name}' after the application schema is prepared`);
      }
      declarationsByName.set(declaration.name, declaration);
      if (!bindingsByDeclaration.has(declaration)) {
        const bound = declaration.bind(runtime);
        bindingsByDeclaration.set(declaration, bound);
        bindingsByName.set(declaration.name, bound);
        ownedBindings.add(bound);
      }
      return bindingsByDeclaration.get(declaration);
    },
  };
  const app = makeMountable({ entityOf: runtime.entityOf });
  app.dispatch = async () => {
    throw new Error('application is not started; call start() before dispatching');
  };
  app.batch = async () => {
    throw new Error('application is not started; call start() before batching');
  };
  app.entity = runtime.entityOf;
  app.register = (...declared) => {
    for (const declaration of declared.flat()) runtime.entityOf(declaration);
    return app;
  };
  app.register(entities);
  for (const frameworkEntity of [User, Session, Inbox, Credential, Invitation, ApiKey, TwoFactor]) {
    if (!declarationsByName.has(frameworkEntity.name)) runtime.entityOf(frameworkEntity);
  }
  app.entities = bindingsByName;
  // Coarse recovery scopes (for example `project:p1`) must resolve to a normal
  // entity row. Snapshot, replay, and later live admission can then share the
  // existing row-scope + grant engine instead of trusting transport callbacks.
  app.resolveScope = resolveScope;
  app.scopeSnapshot = scopeSnapshot;
  app._history = history;
  // Per-app config — options override env fallbacks (SPEC §3). `app.config` is
  // the one place a mounted route / transport reads this app's port, env,
  // viewsDir, and session duration instead of the process-wide singleton. An
  // option left absent behaves exactly like the singleton (env-sourced
  // defaults), so an app that sets nothing still runs.
  app.config = resolveConfig({ port, env, session, viewsDir });
  // Logging is an application-owned runtime resource. Constructing another
  // application must not replace the logger used by this one.
  // Callers pass `workbench({ log: { level: 'debug', channels: {...} } })`.
  app.log = createLog(logOpts);
  app.log.info('system', 'workbench() constructed', { db: !!db, jobs: !!jobOpts, migrations: migrations.length });
  // The DB handle is an app-level resource, supplied once at construction and
  // read by every transport (HTTP now, WS /events later) — not a per-transport
  // listen option (DECISIONLOG: the SQLite handle lives on the app because
  // persistence is shared infrastructure; durability still follows the engaged
  // dispatch seam, not this field). An app with no db simply cannot serve
  // DB-backed entity CRUD — fail closed at dispatch.
  app.db = db;
  app._maintenance = validateMaintenanceOptions({
    blobReapIntervalMs,
    blobReapTtlMs,
    logRetentionDays,
    logRetentionIntervalMs,
  });
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
  app.writeQueue = createWriteQueue();
  prepareGracefulShutdown(app);
  if (db && jobOpts) {
    app.jobs = createJobQueue({ db, clock, ...jobOpts });
  }
  app.port = undefined;
  app.httpServer = undefined;
  app._transportReady = Promise.resolve();

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
  app.prepareSchema = async () => withLog(app.log, async () => {
    if (!app.schemaReady) {
      app.schemaReady = (async () => {
        if (!app.db) throw new Error('cannot generate DDL — no db configured on the app');
        // Framework tables come first — Log and Cursor are the durable event substrate.
        executeFrameworkDDL(app.db);
        await app.resolveRoutes();
        registryLocked = true;
        const seen = new Set();
        for (const entity of app.entities.values()) {
          if (!seen.has(entity.name)) {
            seen.add(entity.name);
            executeDDL(entity, app.db);
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
  });
  app.ddl = () => app.prepareSchema();

  app.start = () => startApplication(app);

  app.listen = (portOrOptionsOrCallback, optionsOrCallback) => {
    // One listen path, Express-compatible overload:
    //   listen()                         → config.port
    //   listen(3000) / listen(3000, cb)  → explicit port
    //   listen(3000, { principalOf })    → port + options
    //   listen(callback)                 → config.port + onListening (NOT port=function)
    //   listen({ principalOf, onListening }) → config.port + options object
    // An explicit port still wins over config/env. PORT env is applied at
    // construction via resolveConfig → app.config.port.
    let port;
    let options = optionsOrCallback ?? {};
    if (typeof portOrOptionsOrCallback === 'function') {
      port = app.config.port;
      options = portOrOptionsOrCallback;
    } else if (
      portOrOptionsOrCallback != null
      && typeof portOrOptionsOrCallback === 'object'
      && !Array.isArray(portOrOptionsOrCallback)
    ) {
      port = app.config.port;
      options = portOrOptionsOrCallback;
    } else {
      port = portOrOptionsOrCallback ?? app.config.port;
    }
    if (app.httpServer) {
      throw new Error('application is already listening');
    }
    if (app._startupMode === 'headless' || (app._startPromise && !app._transportAttached)) {
      throw new Error('application already started without HTTP; create a new app and call listen() before start()');
    }
    app.port = port;
    return withLog(app.log, () => serveListen(app, port, options));
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
    const authEntities = Object.fromEntries(
      [User, Session, Credential, Invitation, ApiKey, TwoFactor]
        .map((declaration) => [declaration.name, app.entity(declaration)]),
    );
    app.mount('/auth', authRoutes({
      secure: app.config.env === 'production',
      identifyBy: options.identifyBy,
      entities: authEntities,
      db: app.db,
    }));
    // Per-app session duration changes only the schedule metadata. The kernel
    // applies it to the app-bound Session facade, preserving its database-bound
    // query and mutation closures.
    if (app.config.sessionDurationMs !== config.sessionDurationMs) {
      app._sessionSchedule = Object.freeze({
        ...Session.schedule,
        remove: Object.freeze({ ...Session.schedule.remove, delay: app.config.sessionDurationMs }),
      });
    }
    return app;
  };
  return app;
}

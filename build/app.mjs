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
import { buildReadMirrorDescription, wrapDriver } from './driver.mjs';
import {
  openMemoryAdapter,
  openSqliteAdapter,
  SQLITE_DATA_FILENAME,
                            
} from './sqlite-adapter.mjs';
                                                                                              
import { executeDDL, executeFrameworkDDL, generateSideTableDDL, generatedIndexNames } from './ddl.mjs';
import { runMigrations } from './migrations.mjs';
import { runWorkbenchMigrations } from './workbench-migrations.mjs';
import { validateSchemaOwnedEntityTable } from './schema-entity-validation.mjs';
import { frameworkTableNames, declaredTableNames } from './schema-table-census.mjs';
import { createBlobStore } from './blob-store.mjs';
import { createJobQueue } from './job-queue.mjs';
import { createPostCommitEffectRunner } from './post-commit-effects.mjs';
import { createClock } from './clock.mjs';
import { createWriteQueue } from './write-queue.mjs';
import { createMaintenanceSeam } from './maintenance.mjs';
import { createPrincipalSnapshotTransaction } from './principal-snapshot-transaction.mjs';
import { prepareGracefulShutdown } from './lifecycle.mjs';
import { createLog, withLog } from './log.mjs';
import { serveStatic } from './views.mjs';
import { authRoutes } from './auth/routes.mjs';
import { attachApplicationLiveDelivery } from './application-live-delivery.mjs';
import { User, Session, Inbox, Credential, Invitation, ApiKey, TwoFactor } from './auth/entities.mjs';
import { config, resolveConfig } from './config.mjs';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { makeMountable } from './router.mjs';

// router(opts) — a mini-app mounted bare into a parent app with
// `app.mount(path, router)`. `{ mergeParams: true }` lets a child read a parent
// path param. A router resolves its routes relative to its own base ('/') and is
// re-based when mounted.
export function router(options      = {}) {
  const mergeParams = options.mergeParams === true;
  const surface = makeMountable({ mergeParams });
  // A router is a reusable declaration blueprint. Each parent application
  // resolves a private instance with that application's entity registry, so a
  // cached route can never retain another application's database-bound facade.
  surface.resolveFor = async (entityOf     ) => {
    const instance = makeMountable({ mergeParams, entityOf });
    instance.declarations.push(...surface.declarations);
    await instance.resolveRoutes();
    return instance.routes;
  };
  return surface;
}

// The `db` option may be a DbAdapterConfig (the app opens it via the sqlite
// adapter), a conforming DbAdapter (A1 contract: the app calls its async
// open() at the first boot boundary), a pre-opened adapter result
// (OpenedDatabase-shaped), a raw DatabaseSync/DbHandle, or a string ('<file>' /
// ':memory:'). Raw handles stay the wrapDriver path so ~29 test files passing
// DatabaseSync directly work unchanged; configs and strings route through the
// adapter, which owns the directory, locks it, and centralizes the PRAGMA layer.
function isDbAdapterConfig(value         )                           {
  if (value == null || typeof value !== 'object') return false;
  const candidate = value                           ;
  if (typeof candidate.prepare === 'function' || typeof candidate.open === 'function') {
    return false;
  }
  return candidate.mode !== undefined || candidate.directory !== undefined || candidate.name !== undefined;
}

// A conforming, BOUND adapter (src/db-adapter.ts A1 contract): async open() +
// readMirror(). `createSqliteAdapter(config)` returns exactly this shape — the
// config was captured at creation, so open() takes no argument (a zero-arg
// implementation satisfies the DbAdapter interface's `open(config)`). It is NOT
// a handle and must never reach wrapDriver. Detection is by SHAPE (not a
// registry), so a future non-SQLite backend is expressible without framework
// changes. It cannot be opened synchronously, so workbench defers the open to
// the first boot boundary (see installPendingDb below).
                          
                                  
                                      
                                     
 

function isDbAdapter(value         )                          {
  if (value == null || typeof value !== 'object') return false;
  const candidate = value                           ;
  return typeof candidate.open === 'function' && typeof candidate.readMirror === 'function';
}

function isOpenedAdapter(value         )                                {
  if (value == null || typeof value !== 'object') return false;
  const candidate = value                           ;
  return (
    candidate.handle !== undefined
    && typeof candidate.close === 'function'
    && candidate.capabilities != null
    && typeof candidate.capabilities === 'object'
  );
}

// Mutual overlap: `a` and `b` overlap when either contains the other. Used to
// refuse a blob root that sits inside the database-owned directory or vice
// versa (S1/A2 managed-path guard).
function pathsOverlap(a        , b        )          {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  return ra === rb || ra.startsWith(rb + path.sep) || rb.startsWith(ra + path.sep);
}

// Refuse a blob root overlapping the adapter-owned directory, in either
// direction. Called BEFORE the adapter opens so a refused configuration never
// leaks the OS-backed ownership lock.
function refuseBlobOverlap(ownedDirectory        , blobRoot               )       {
  if (blobRoot && pathsOverlap(blobRoot, ownedDirectory)) {
    throw new Error(
      `blobs.root '${blobRoot}' overlaps the database-owned directory '${ownedDirectory}'`,
    );
  }
}

// Resolve the blob root against an owned directory (S1/A2 managed-path guard).
// An EXPLICIT `blobs.root` that overlaps the owned directory is refused — the
// app opted into the guard and gets a loud construction error. The framework
// DEFAULT (cwd/.blobs) instead AUTO-PLACES into the owned directory's managed
// `blobs/` subdirectory when the owned directory overlaps it (e.g. a cwd-owned
// database, where cwd/.blobs would sit inside managed storage). Refuse-vs-place
// was chosen in review of #81: replacement keeps default-config examples working
// while refusing stays the explicit-root behavior. Called before the adapter
// opens so a refusal never leaks the OS-backed ownership lock.
function resolveBlobRoot(ownedDirectory        , current        , explicitRoot               )         {
  if (explicitRoot) {
    refuseBlobOverlap(ownedDirectory, explicitRoot);
    return current;
  }
  return pathsOverlap(current, ownedDirectory) ? path.join(ownedDirectory, 'blobs') : current;
}

// workbench() — the default export. A chainable app. `.mount(path, Entity)`
// resolves and accumulates routes; `.listen(port, options)` opens a real
// node:http server serving the resolved routing table and returns the app
// (chainable). The server is exposed on `app.httpServer`. `options.principalOf`
// overrides the request→principal source (default: anonymous, fail-closed). Both
// chain.
export default function workbench({
  db,
  schema,
  entities = [],
  actions = [],
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
  operationalConsumers = [],
  blobLifecycle,
}      = {}) {
  // envGate (cso #15): fail-closed at app construction — required env vars must be set.
  for (const v of requireEnv) {
    const val = process.env[v];
    if (!val) {
      throw new Error(`missing required env: ${v}`);
    }
  }
  // The blob root the app will use (a conforming byte store has no root we can
  // see). Computed once up front so the managed-path guard can refuse an
  // EXPLICIT blobs.root overlap BEFORE the adapter opens — an overlap thrown
  // after opening would leak the OS-backed ownership lock (S1/A2). The
  // framework default (cwd/.blobs) is historical and unguarded at this point: a
  // db option that owns an overlapping directory re-places it (resolveBlobRoot
  // below) before the adapter opens.
  const explicitBlobRoot = blobOpts
    && typeof blobOpts.writePending !== 'function'
    && blobOpts?.root
    ? blobOpts.root          
    : null;
  let blobRoot = explicitBlobRoot ?? path.join(process.cwd(), '.blobs');
  // `db` is opened through the sqlite adapter unless a raw DatabaseSync/DbHandle
  // was supplied (or a conforming DbAdapter — A1 contract — whose async open is
  // deferred to the first boot boundary). A string is a path (or ':memory:') the
  // framework opens itself, so an app never imports DatabaseSync just to hand
  // the framework an instance it could have opened from the same string. The
  // adapter owns the directory, holds the OS-backed ownership lock, runs the
  // centralized PRAGMA layer, and checkpoints on close (S1/A2).
  //
  // The whole construction is guarded: if any later step (schema validation,
  // migration checks, entity binding, blob store, job queue) throws, an adapter
  // opened HERE is closed again so the refused app cannot strand its ownership
  // lock / database handle (review #81).
  let openedDb                              = null;
  let openedHere = false;
  let pendingDbAdapter                        = null;
  let installPendingDb                                  = null;
  try {
    if (typeof db === 'string') {
      if (db !== ':memory:') blobRoot = resolveBlobRoot(path.dirname(db), blobRoot, explicitBlobRoot);
      openedDb = db === ':memory:'
        ? openMemoryAdapter()
        : openSqliteAdapter({ directory: path.dirname(db), name: path.basename(db), mode: 'file' });
      openedHere = true;
      db = openedDb.handle;
    } else if (isDbAdapterConfig(db)) {
      if (db.mode !== 'memory' && db.directory) blobRoot = resolveBlobRoot(db.directory, blobRoot, explicitBlobRoot);
      openedDb = db.mode === 'memory'
        ? openMemoryAdapter()
        : openSqliteAdapter({ ...db, mode: db.mode ?? 'file' });
      openedHere = true;
      db = openedDb.handle;
    } else if (isDbAdapter(db)) {
      // A conforming DbAdapter opens asynchronously (open() →
      // Promise<OpenedDatabase>), so construction cannot yield the handle
      // synchronously. The adapter is kept as the app's lifecycle owner and the
      // open is deferred: installPendingDb (below) runs it at the first async
      // boundary (prepareSchema / app.ready / route boot) and installs the
      // handle plus the handle-bound resources. Adapter-backed apps should
      // await `app.ready` (or call start()/prepareSchema()) before listen() so
      // the transport captures a real db handle.
      pendingDbAdapter = db;
      db = null;
    } else if (isOpenedAdapter(db)) {
      openedDb = db;
      db = db.handle;
    }
    // Wrap the raw handle with the driver contract helpers (txn/begin/commit/
    // rollback/upsert) and run the thin PRAGMA bootstrap. A conforming custom
    // driver (already providing txn+upsert) is passed through untouched — it owns
    // its own bootstrap. The driver IS the raw handle with helpers attached, so
    // `app.db.prepare` keeps working — entity code and tests reach it everywhere.
    // One construction path: a bare-string app gets the same treatment as a
    // pre-built handle. (seam-review §2.1, priority #7.)
    if (db) db = wrapDriver(db);

    if (schema !== undefined && (!schema || typeof schema.prepare !== 'function' || !Array.isArray(schema.tables))) {
      throw new TypeError('schema must be a SqliteSchemaResult');
    }
    const allMigrations = [...(schema?.migrations ?? []), ...migrations].sort((a, b) => a.version - b.version);
    for (let index = 1; index < allMigrations.length; index += 1) {
      if (allMigrations[index - 1].version === allMigrations[index].version) {
        throw new Error(`duplicate migration version ${allMigrations[index].version} across schema and application migrations`);
      }
    }

    const declarationsByName = new Map();
    const bindingsByDeclaration = new Map();
    const bindingsByName = new Map();
    const ownedBindings = new WeakSet();
    let registryLocked = false;
    const runtime = {
      db,
      batch(...args       ) {
        return app.batch(...args);
      },
      entityOf(value     ) {
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
    const app      = makeMountable({ entityOf: runtime.entityOf });
    app.actions = Object.freeze([...actions]);
    app.operationalConsumers = Object.freeze([...operationalConsumers]);
    app.dispatch = async () => {
      throw new Error('application is not started; call start() before dispatching');
    };
    app.batch = async () => {
      throw new Error('application is not started; call start() before batching');
    };
    app.entity = runtime.entityOf;
    app.register = (...declared       ) => {
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
    // DB-backed entity CRUD — fail closed at dispatch. For an adapter-backed app
    // the handle is null until the deferred open installs it (A1 contract).
    app.db = db;
    // When the app opened the database through the adapter, the adapter is the
    // app's lifecycle owner (shutdown checkpoints + closes it) and its managed-
    // path predicate guards static serving below. A conforming DbAdapter (A1
    // contract) fills the same role before its deferred open completes; the
    // opened database replaces it once installed.
    app._dbAdapter = pendingDbAdapter ?? openedDb;
    app._isManagedPath = pendingDbAdapter
      ? pendingDbAdapter.isManagedPath
      : openedDb ? openedDb.isManagedPath : undefined;
    // The controlled read-mirror description (S1/A5). External readers open it
    // with openReadMirror (read-mirror.ts), which enforces mode=ro at the
    // engine AND via a query-class rejector. The description never carries a
    // write path. A conforming adapter's own readMirror() wins; the default
    // sqlite adapter's opened database is described from its owned directory +
    // the fixed data filename (the physical path is never handed to the app
    // directly). A raw handle has no controlled description — fail closed.
    app.readMirror = () => {
      const adapter = app._dbAdapter;
      if (adapter && typeof adapter.readMirror === 'function') {
        return adapter.readMirror();
      }
      if (openedDb?.mode === 'file' && openedDb.root) {
        return buildReadMirrorDescription(path.join(openedDb.root, SQLITE_DATA_FILENAME));
      }
      if (openedDb?.mode === 'memory') {
        return buildReadMirrorDescription(':memory:');
      }
      throw new Error(
        'readMirror() requires an adapter-backed database — a raw handle has no controlled read-mirror description',
      );
    };
    app.schema = schema;
    app._maintenance = validateMaintenanceOptions({
      blobReapIntervalMs,
      blobReapTtlMs,
      logRetentionDays,
      logRetentionIntervalMs,
    });
    // The shared clock is the single timer for all framework reapers (schedule,
    // tick, job-queue lease, blob, log-retention, job-worker polls). Created once
    // at app construction so the job queue and later serve.mjs share it. The
    // write queue and principal-snapshot transaction are created here too — the
    // handle-bound resources below need the clock (job queue), and shutdown
    // reads the write queue.
    const clock = createClock();
    app.clock = clock;
    // The one platform write coordinator (S1/A5): every write category enters
    // through `run`. `app.writeCoordinator` is the formal name; `app.writeQueue`
    // is the same object (kept for the transport/kernel seams that already
    // reference it) — one mutex, never a second one.
    app.writeQueue = createWriteQueue();
    app.writeCoordinator = app.writeQueue;
    // OWNERSHIP BINDING (S1/A3 backup, review #82 finding 2): the adapter-opened
    // source declares the SAME coordinator as the app — so a backup manager
    // built over `app.writeCoordinator` + the app's opened source
    // (`createBackupManager({ source: app._dbAdapter, writeCoordinator:
    // app.writeCoordinator })`) works without manual mutation, while a
    // coordinator bound to any DIFFERENT source still refuses at construction.
    // The app opened the db BEFORE this coordinator existed, so the binding
    // fills it in now that the coordinator is real.
    if (openedDb) openedDb.writeCoordinator = app.writeCoordinator;
    // The shared-state PRAGMA maintenance seam (S1/A5): withForeignKeysDisabled
    // runs inside a coordinated write turn and restores foreign_keys = ON even
    // on throw. The app db may arrive later (deferred adapter open), so the
    // seam resolves the handle at call time and fails closed without one.
    app.withForeignKeysDisabled = createMaintenanceSeam(
      () => app.db ?? null,
      app.writeCoordinator,
    ).withForeignKeysDisabled;
    const principalSnapshotRuntime = createPrincipalSnapshotTransaction(app);
    app.principalSnapshots = { transaction: principalSnapshotRuntime.transaction };
    app._principalSnapshotRuntime = principalSnapshotRuntime;
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
    //
    // attachHandleResources builds the handle-bound resources (blob store,
    // post-commit effects, job queue). It runs at construction for a
    // synchronously-opened db and is DEFERRED to the open for an adapter-backed
    // app (installPendingDb below).
    const attachHandleResources = (handle     )       => {
      if (blobOpts && typeof blobOpts.writePending === 'function') {
        app.blobs = createBlobStore({ db: handle, bytes: blobOpts });
      } else {
        // `blobRoot` was already refused (explicit) or re-placed (default)
        // against the owned directory before the adapter opened (managed-path
        // guard, S1/A2). A re-placed default (ownedDir/blobs) already exists.
        mkdirSync(blobRoot, { recursive: true });
        app.blobs = createBlobStore({ root: blobRoot, db: handle });
      }
      app.postCommitEffects = createPostCommitEffectRunner({ db: handle });
      // The queue routes its multi-statement mutations through the ONE write
      // coordinator (job-queue.ts's writeQueue option); a post-commit consumer
      // calling enqueue from inside a dispatch turn joins that turn.
      if (jobOpts) app.jobs = createJobQueue({ db: handle, clock, ...jobOpts, writeQueue: app.writeCoordinator });
    };
    if (db) attachHandleResources(db);
    if (pendingDbAdapter) {
      const adapter = pendingDbAdapter;
      installPendingDb = (() => {
        let opening                          = null;
        return () => {
          if (!opening) {
            // A1 contract: the adapter's open() is awaited (never wrapDriver'd).
            opening = Promise.resolve()
              .then(() => adapter.open())
              .then((opened) => {
                // OWNERSHIP BINDING (S1/A3 backup): the deferred adapter open
                // lands AFTER the write coordinator exists — bind the app's
                // coordinator onto the opened source so an adapter-backed
                // backup manager constructs without manual mutation.
                (opened                        ).writeCoordinator = app.writeCoordinator;
                const handle = wrapDriver(opened.handle);
                runtime.db = handle;
                app.db = handle;
                app._dbAdapter = opened;
                app._isManagedPath = (opened                        ).isManagedPath;
                attachHandleResources(handle);
                return opened;
              });
            // The open's rejection is surfaced through app.ready /
            // prepareSchema / the boot promise, not as an unhandled rejection.
            opening.catch(() => {});
          }
          return opening;
        };
      })();
      // The boot path (bootApplication) awaits resolveRoutes before deciding
      // whether a db exists; installing the opened handle first makes the boot
      // gate and prepareSchema see a real db handle.
      const originalResolveRoutes = app.resolveRoutes;
      app.resolveRoutes = (...args           ) => installPendingDb ().then(() => originalResolveRoutes(...args));
      app._dbOpen = installPendingDb;
    }
    if (blobLifecycle) {
      if (!db && !pendingDbAdapter) throw new Error('blobLifecycle requires a database');
      app._blobLifecycleOptions = blobLifecycle;
    }
    // The job-queue substrate (spec #5) — a separate seam, opt-in. Built at
    // construction when a db + `jobs` config are engaged (the shared secret is
    // required: createJobQueue throws if absent — fail-closed at construction, like
    // envGate). Reached by the framework-owned /workers + /jobs HTTP routes AND by
    // post-commit consumers that call `app.jobs.enqueue(...)`. No `jobs` config →
    // no queue, no routes, no reaper (zero blast radius).
    prepareGracefulShutdown(app);
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
    (workbench       ).router = router;

    // Auto-create tables for mounted entities. Runs during `app.ready` before
    // traffic, after routes resolve and before the kernel starts. The method stays
    // callable for server-only/tests that prepare schema without listening, but it
    // is the same cached path `app.ready` uses — not a second DDL algorithm. An
    // adapter-backed app resolves its deferred open here first (A1 contract).
    app.prepareSchema = async () => withLog(app.log, async () => {
      if (installPendingDb) await installPendingDb();
      if (!app.schemaReady) {
        app.schemaReady = (async () => {
          if (!app.db) throw new Error('cannot generate DDL — no db configured on the app');
          // Framework tables come first — Log and Cursor are the durable event substrate.
          executeFrameworkDDL(app.db);
          await app.resolveRoutes();
          registryLocked = true;
          const schemaTables = new Map             ((schema?.tables ?? []).map((table     ) => [table.name.toLowerCase(), table]));
          const entityMainTables = new Set([...app.entities.values()].map((entity) => entity.name.toLowerCase()));
          const generatedTables = new Set(declaredTableNames([...app.entities.values()]).map((name) => name.toLowerCase()));
          const registeredEntities = new Map([...app.entities.values()].map((entity) => [entity.name.toLowerCase(), entity]));
          const generatedIndexes = new Map();
          for (const entity of app.entities.values()) {
            for (const [fieldName, field] of Object.entries(entity.fields ?? {})                        ) {
              if (field?.physical !== true || field?.kind !== 'value' || field.type !== 'ref') continue;
              // String refs remain logical for compatibility with declarations whose
              // target is supplied outside this app. A string self ref is closed.
              const targetName = field.target?.name ?? (field.target === entity.name ? entity.name : null);
              if (!targetName) continue;
              const target = registeredEntities.get(String(targetName).toLowerCase());
              if (!target) {
                throw new Error(`entity '${entity.name}' field '${fieldName}' references unregistered Workbench entity '${String(targetName)}'`);
              }
              const targetSchema = schemaTables.get(target.name.toLowerCase());
              if (targetSchema) {
                const id = targetSchema.columns.find((column     ) => column.name.toLowerCase() === 'id');
                if (!id || String(id.type).toLowerCase() !== 'text' || id.primaryKey !== true) {
                  throw new Error(`entity '${entity.name}' field '${fieldName}' ref target '${target.name}' must have a TEXT id primary key`);
                }
              }
            }
            for (const indexName of generatedIndexNames(entity)) {
              const key = indexName.toLowerCase();
              const prior = generatedIndexes.get(key);
              if (prior) throw new Error(`duplicate generated index '${indexName}' from ${entity.name} and ${prior}`);
              generatedIndexes.set(key, entity.name);
            }
          }
          for (const table of schema?.tables ?? []) {
            const name = table.name.toLowerCase();
            if (frameworkTableNames.some((frameworkName) => frameworkName.toLowerCase() === name)) {
              throw new Error(`schema table "${table.name}" conflicts with a framework table`);
            }
            if (generatedTables.has(name) && !entityMainTables.has(name)) {
              throw new Error(`schema table "${table.name}" conflicts with a generated entity side table`);
            }
          }
          // A declared migration may bring an existing table up to the declared
          // shape, so defer schema indexes and the exact physical check until it
          // has run. Tables must exist before generated supporting tables.
          if (schema) schema.prepare(app.db, { skipMigrations: true, skipIndexes: true });
          const seen = new Set();
          for (const entity of app.entities.values()) {
            if (!seen.has(entity.name)) {
              seen.add(entity.name);
              const declaration = schemaTables.get(entity.name.toLowerCase());
              if (declaration) {
                for (const sql of generateSideTableDDL(entity)) app.db.exec(sql);
              } else {
                executeDDL(entity, app.db);
              }
            }
          }
          // Migrations run last, pre-traffic, after every entity table exists. Each
          // is its own transaction (DDL + meta-version bump atomic). Runs only when
          // declared — an app with no migrations is untouched (no _Migration table).
          await runWorkbenchMigrations(app.db);
          if (allMigrations.length) runMigrations(app.db, allMigrations);
          if (schema) schema.prepare(app.db, { skipMigrations: true });
          for (const entity of app.entities.values()) {
            const declaration = schemaTables.get(entity.name.toLowerCase());
            if (declaration) validateSchemaOwnedEntityTable(app.db, entity, declaration);
          }
          return app;
        })();
      }
      return app.schemaReady;
    });
    app.ddl = () => app.prepareSchema();

    app.start = () => startApplication(app);
    // Live delivery attaches before startup, when the kernel has not yet captured
    // its post-commit consumers. The app owns registry and authorization wiring;
    // callers provide only transport policy and declared aggregate snapshots.
    app.attachLiveDelivery = (options     ) => attachApplicationLiveDelivery(app, options);

    app.listen = (portOrOptionsOrCallback     , optionsOrCallback     ) => {
      // One listen path, Express-compatible overload:
      //   listen()                         → config.port
      //   listen(3000) / listen(3000, cb)  → explicit port
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
    app.static = (prefix     , dir     ) => app.use(prefix, serveStatic(dir, {
      prefix: prefix.replace(/\/+$/, ''),
      // Refuse to serve anything under the adapter-owned directory (S1/A2).
      isManagedPath: app._isManagedPath,
    }));
    // `.auth()` mounts the framework-owned auth battery at `/auth` — login +
    // logout routes that set/clear the fail-closed `sid` cookie (the Set-Cookie
    // the exemplar omits, which is the whole 0→1 auth bug). Built from the SAME
    // public primitives an app would use to hand-roll its own boundary; an app
    // needing bespoke login mounts its own router instead. Returns the app
    // (chainable). Fail closed: an app with no db cannot serve auth — the routes
    // write User rows and mint Sessions, and sessionPrincipalOf has nothing to
    // look a token up in. Throw at construction (loud), not mid-login (a 500).
    app.auth = function auth(options      = {}) {
      if (!app.db) {
        throw new Error('app.auth() requires a db — registration writes a User row, authentication mints a Session, and the session principal source has nothing to look a token up in without one (fail closed).');
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
      }       ));
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
    if (installPendingDb) {
      // Adapter-backed apps (A1 contract): awaiting `app.ready` installs the
      // deferred open before listen(), so the transport captures a real db
      // handle. startApplication replaces this promise with the full boot when
      // the app starts.
      app.ready = installPendingDb();
    }
    return app;
  } catch (err) {
    // Construction failed after an adapter was opened but before the app (and
    // its shutdown owner) was handed out. Release the OS-backed ownership lock
    // and close the handle so a refused configuration cannot strand its
    // directory (S1/A2). A DEFERRED adapter never opened, so nothing to release.
    if (openedHere && openedDb) {
      try {
        openedDb.close();
      } catch {
        /* best-effort close on the construction-failure path */
      }
    }
    throw err;
  }
}

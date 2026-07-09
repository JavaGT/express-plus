// The HTTP transport — Phase 2, slice 1 (SPEC §3, §4).
//
// Phase 1 resolved a declared app into an inspectable routing table (a list of
// { method, path, verb, entity, gate }). This module turns that table into a
// running node:http server. It is a DISTINCT seam from the resolution layer
// (app.mjs): the table is built at mount time and is the single source of routes;
// this module only serves it. There is no second routing path.
//
// The request flow, fail-closed at each step:
//   1. derive the principal (default: anonymous, until session hydration lands)
//   2. match { method, url } to a route in the table — no match → 404
//   3. run the route's gate(principal) — the first default-on auth layer — and
//      deny with 401 when it returns false
//   4. dispatch the admitted request (slice 1: a stub echoing the matched verb;
//      DB-backed CRUD is the next slice)
//
// The row grant (the SQL scope + .can) still runs downstream in dispatch on every
// admitted verb — this layer decides route admission, never row visibility. No
// second auth path.

import { createServer as createHttpServer } from 'node:http';

import { anonymous } from './principal.mjs';
import { mayVerb, mayRow } from './row-grant.mjs';
import { config } from './config.mjs';
import { applySecurityHeaders, renderError, isSameOriginRequest } from './middleware.mjs';
import { sessionPrincipalOf, sessionTokenOf, apiKeyPrincipalOf } from './auth/session.mjs';
import { createLiveDelivery } from './live-delivery.mjs';
import { retentionPrune } from './committed-log.mjs';
import { getLog } from './log.mjs';
import { buildKernel, buildAndStart } from './kernel.mjs';
import { createRateLimiter } from './rate-limit.mjs';
import { BodyError, readRequestBody } from './http-body.mjs';
import { runChain } from './http-handler-chain.mjs';
import { matchRoute } from './http-route-match.mjs';
import { committedEventHeaders, responseHasStarted, warnLateResponse, sendJson } from './http-response.mjs';
import { createResponseFacade } from './http-response-factory.mjs';
import { dispatchCrud } from './http-crud-dispatch.mjs';
import { handleResyncRoute, handleBlobUploadRoute, handleJobRoute, handleClientSdkRoute } from './http-framework-routes.mjs';
import { installGracefulShutdown } from './lifecycle.mjs';

// Framework-owned snapshot + resync endpoints (spec #1, D6/D7). NOT mounted
// `makeHandlerRes(nodeRes, onEnd)` wraps a node response in the Express-style
// facade the `app.use(prefix, fn)` intercept hands to a mounted handler (shared
// methods from http-response-factory.mjs + a serve-specific `.stream()`).
// `onEnd` flips the intercept's handled flag so a handler that ended the
// response short-circuits the dispatch and one that did not write falls through
// to the next handler.
function makeHandlerRes(nodeRes, onEnd) {
  const res = createResponseFacade(nodeRes, { onEnd });

  // serve-specific: stream pipes a Web Response (or a bare ReadableStream) to
  // the Node response and calls onEnd() so the intercept short-circuits.
  res.stream = async function (webResponse, options = {}) {
    const source = webResponse instanceof ReadableStream
      ? new Response(webResponse)
      : webResponse;
    nodeRes.writeHead(source.status, Object.fromEntries(source.headers));
    if (options.buffering === false) {
      nodeRes.setHeader('X-Accel-Buffering', 'no');
    }
    if (source.body) {
      const reader = source.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        nodeRes.write(value);
      }
    }
    nodeRes.end();
    onEnd();
    return this;
  };

  return res;
}

// Framework-owned routes — handleResyncRoute, handleBlobUploadRoute, handleJobRoute
// — live in http-framework-routes.mjs and are imported above.
// Blob reaper cadence + stale threshold (eng-review spec #10, consult #17). A
// pending upload whose adopt dispatch never came (client crash / abandonment) is
// orphaned; once it is older than the TTL the reaper sweeps the .pending file +
// row. Defaults baked into the framework — no app config (AGENTS.md: sensible
// defaults are framework-owned). Interval chosen so a sweep lands well inside the
// TTL window (6×/hour) so orphans don't linger far past the threshold.
const BLOB_REAP_INTERVAL_MS = 10 * 60_000; // sweep every 10 minutes.
const BLOB_REAP_TTL_MS = 60 * 60_000;       // a pending blob is stale after 1 hour.

// The standard stateless CSRF guard (eng-review §8 Tier-2 ops bundle, #13). A
// state-MUTATING request (anything but a safe method) carrying a FOREIGN Origin
// or Referer is rejected; the browser always sends a foreign Origin on a
// cross-site POST (the real forgery vector). A mutation with NO Origin/Referer
// is allowed — Node fetch and curl omit these by default, so a fail-closed
// "missing → reject" would block every non-browser API client. Same-origin
// (the header's host:port equals the request Host) passes. This is a COMPUTED
// decision (AGENTS.md → Authorization: always functions), not a magic-word
// check; it runs before the route gate so a forged mutation never reaches it.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Returns true when the mutation is allowed, false when it is foreign (→ 403).
// Safe methods carry no state change; the same-origin verdict (shared with the
// WS upgrade handshake, middleware.mjs) gates every other method.
const csrfGuard = (req) => SAFE_METHODS.has(req.method) || isSameOriginRequest(req);

// Build the node:http request handler that serves a routing table. `principalOf`
// derives the request's principal; it defaults to a function returning anonymous
// so an unconfigured server is fail-closed (the default-on route gate denies
// every anonymous request). When an app has a db, `listen` supplies session
// hydration as the principal source (sessionPrincipalOf) — the SAME admission
// path, not a second one. `db` is the app-level node:sqlite handle the
// dispatcher runs against.
export function makeRequestHandler(source, { principalOf = () => anonymous, db, env = config.env, rateLimiter = null, csp, hsts, cors, requestLog = false } = {}) {
  // `source` is either a plain resolved routing table (an array) or an app whose
  // table resolves asynchronously (two-phase boot). When it is an app, every
  // request first awaits `app.ready` so the socket may accept connections before
  // resolution completes without ever dispatching against a partial table.
  const isApp = source && typeof source.resolveRoutes === 'function';
  // Request log (opt-in via `listen(port, {requestLog:true})`). The structured
  // logger also captures every request at info-level on the 'http' channel.
  const shouldLogRequest = requestLog;
  const log = getLog();
  const requestCount = { count: 0 };
  return async function handle(req, res) {
    const startTime = Date.now();
    if (isApp) requestCount.count += 1;
    if (shouldLogRequest) {
      let statusCode = 200;
      const origWriteHead = res.writeHead;
      res.writeHead = function patchedWriteHead(code, ...args) {
        statusCode = code;
        return origWriteHead.apply(this, [code, ...args]);
      };
      res.on('finish', () => {
        const path = new URL(req.url, 'http://localhost').pathname;
        const durationMs = Date.now() - startTime;
        if (shouldLogRequest) {
          process.stderr.write(`${req.method} ${path} ${statusCode} ${durationMs}ms\n`);
        }
        log.info('http', `${req.method} ${path} ${statusCode}`, { method: req.method, path, status: statusCode, durationMs });
      });
    }
    // Security headers are a baked-in default on EVERY response, set before any
    // exit path writes its head (SPEC §3). They are retained through writeHead.
    applySecurityHeaders(res);
    // CSP / HSTS / CORS policy headers (piece 4 — opt-in, default off)
    if (csp) res.setHeader('content-security-policy', csp);
    if (hsts) res.setHeader('strict-transport-security', 'max-age=31536000');
    // CORS: check Origin and set headers if configured (allowlist over denylist)
    const origin = req.headers.origin;
    if (cors && cors.origins && Array.isArray(cors.origins) && origin) {
      if (cors.origins.includes(origin)) {
        res.setHeader('access-control-allow-origin', origin);
        res.setHeader('access-control-expose-headers', 'x-workbench-seq, x-workbench-action-id');
        res.setHeader('vary', 'Origin');
      }
    }
    try {
      if (isApp) await source.ready;
      const routes = isApp ? source.routes : source;

      // Rate-limit (opt-in via `listen(port, {rateLimit:{...}})`) runs first in
      // the ops stack (eng-review line 213: rateLimit → csrfOrigin). A flood is
      // rejected cheaply here — before CSRF, the route gate, or any write lock —
      // so a denial-of-service attempt never reaches the kernel (the writeQueue
      // is never held by a request that will be refused). Per-IP fixed window; a
      // session window, when configured, additionally caps a logged-in browser
      // (stricter wins). The session key is the opaque `sid` cookie token — read
      // cheaply with no DB lookup, before principal hydration; the IP gate is the
      // non-spoofable base that holds when no cookie is present.
      if (rateLimiter) {
        const r = rateLimiter.check({ ip: req.socket?.remoteAddress, sessionId: sessionTokenOf(req) });
        if (!r.allowed) {
          res.setHeader('Retry-After', String(Math.ceil(r.retryAfterMs / 1000)));
          sendJson(res, 429, { error: 'rate limit exceeded', retryAfterMs: r.retryAfterMs });
          return;
        }
      }

      // CSRF origin guard (eng-review #13) — a foreign-origin mutation is
      // rejected before it reaches the route gate or any state change. Bare
      // non-browser requests (no Origin/Referer — Node fetch, curl) pass.
      if (isApp && !csrfGuard(req)) {
        sendJson(res, 403, { error: 'forbidden' });
        return;
      }

      const url = new URL(req.url, 'http://localhost');
      // Framework-owned /health endpoint (piece 1) — PUBLIC, anonymous, no auth.
      // Intercepts BEFORE matchRoute (like /snapshot, /blobs, /events).
      if (isApp && req.method === 'GET') {
        if (url.pathname === '/health') {
          sendJson(res, 200, { status: 'ok', env });
          return;
        }
        if (url.pathname === '/health/stats') {
          sendJson(res, 200, {
            status: 'ok',
            env,
            uptimeMs: Math.round(process.uptime() * 1000),
            rssBytes: process.memoryUsage().rss,
            requestCount: requestCount.count,
          });
          return;
        }
      }
      // CORS preflight (piece 4 — opt-in): OPTIONS with allowed origin/method → 204
      if (isApp && req.method === 'OPTIONS' && cors && cors.origins && Array.isArray(cors.origins)) {
        const origin = req.headers.origin;
        if (origin && cors.origins.includes(origin)) {
          res.setHeader('access-control-allow-origin', origin);
          res.setHeader('vary', 'Origin');
          res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
          res.setHeader('access-control-allow-headers', 'content-type');
          res.writeHead(204);
          res.end();
          return;
        }
      }

      // Static file serving — intercepts before route matching. The app declares
      // `app.static('/public', dir)`; every GET request under the prefix is served
      // from the filesystem with a content-type derived from the file extension.
      // Missing files → 404; path-traversal attempts → 404 (fail closed).
      // Framework-owned browser SDK: `GET /workbench.mjs` serves the client
      // side of the /events live protocol. Intercepts BEFORE matchRoute like
      // other framework defaults.
      if (isApp && req.method === 'GET') {
        const handled = await handleClientSdkRoute(source, req, res);
        if (handled || responseHasStarted(res)) return;
      }
      // Framework-owned default endpoints — snapshot + resync (spec #1, D6/D7).
      // Like the /events WS transport, these are framework defaults (not mounted
      // routes): `/snapshot/:entity/:id` and `/events-since/:entity/:id` resolve
      // the entity at request time from the path. Authorized through the SAME
      // mayVerb ('read') as REST `read` — one auth engine, no second path.
      if (isApp && req.method === 'GET') {
        const handled = await handleResyncRoute(source, req, res, principalOf(req));
        if (handled || responseHasStarted(res)) return;
      }
      // Framework-owned blob upload (spec #2): `POST /blobs` is a framework
      // default, not a mounted route — intercepted before route matching, like
      // the snapshot/resync endpoints and the /events WS transport.
      if (isApp && req.method === 'POST') {
        const handled = await handleBlobUploadRoute(source, req, res, principalOf(req));
        if (handled || responseHasStarted(res)) return;
      }
      // Framework-owned job-queue endpoints (spec #5): /workers/register,
      // /jobs/claim, /jobs/:id/heartbeat, /jobs/:id/result. Bearer-auth'd (not
      // route-gate auth) — intercepted before matchRoute, like /blobs.
      if (isApp && req.method === 'POST' && source.jobs) {
        const handled = await handleJobRoute(source, req, res);
        if (handled || responseHasStarted(res)) return;
      }
      // App-declared prefix-intercept handlers — `app.use(prefix, fn)` (and its
      // `app.static` sugar). Each fn is a catch-all under its prefix; the first
      // matching prefix wins, in declaration order. The fn receives an
      // Express-style { req, res } with `req.params.path` holding the prefix
      // tail (so a manual sub-router can split it). A fn that does NOT write
      // falls through to the next handler (and then to matchRoute); a fn that
      // throws is rendered as an error. Runs AFTER framework defaults (/blobs,
      // /jobs, /snapshot, /events-since) and BEFORE matchRoute — one interceptor
      // mechanism, no special-cases.
      if (isApp && source._handlers?.length) {
        for (const { prefix, fn } of source._handlers) {
          if (!url.pathname.startsWith(prefix)) continue;
          const rest = url.pathname.slice(prefix.length) || '/';
          const ctxReq = {
            body: undefined,
            params: { path: rest.replace(/^\//, '') },
            query: Object.fromEntries(url.searchParams),
            principal: principalOf(req),
            raw: req,
            headers: req.headers,
            method: req.method,
            url: req.url,
          };
          let handled = false;
          const ctxRes = makeHandlerRes(res, () => {
            handled = true;
          });
          try {
            await fn(ctxReq, ctxRes, () => {});
          } catch (err) {
            renderError(res, err, { env });
            return;
          }
          if (handled || responseHasStarted(res)) return;
        }
      }

      const { route, params, pathMatched } = matchRoute(routes, req.method, url.pathname);

      // no path match → 404; path matched but method did not → 405.
      if (!route) {
        if (pathMatched) {
          sendJson(res, 405, { error: 'method not allowed' });
        } else {
          sendJson(res, 404, { error: 'not found' });
        }
        return;
      }

      // the first default-on auth layer: the route gate decides admission.
      const principal = principalOf(req);
      if (!route.gate(principal)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }

      // read a body for mutating entity verbs and every imperative route. Entity
      // CRUD stays JSON-only; handlers may accept browser form posts.
      let body = {};
      if (route.handlers || route.verb === 'create' || route.verb === 'update') {
        try {
          body = await readRequestBody(req, { jsonOnly: !route.handlers });
        } catch (err) {
          // a refused body carries its own status (413 oversized, 400 malformed).
          if (err instanceof BodyError) return void sendJson(res, err.status, { error: err.message });
          throw err;
        }
      }

      // admitted. One spine, one legitimate fork at the tail: a route carrying a
      // handler chain runs the chain; an entity route runs DB-backed CRUD (where
      // the second default-on auth layer, the row grant, applies). This is NOT a
      // second auth path — the chain inherits the already-admitted principal and
      // never re-gates.
      if (route.handlers) {
        await runChain(route.handlers, req, res, { principal, params, body, query: url.searchParams, autoLoad: route.autoLoad, app: source }, { env });
      } else {
        await dispatchCrud({ entity: route.entity, verb: route.verb, db, principal, params, body, app: isApp ? source : null, res, sendJson, committedEventHeaders, mayRow });
      }
    } catch (err) {
      if (responseHasStarted(res)) {
        warnLateResponse(res, 'makeRequestHandler.catch', err);
        if (!res.writableEnded && !res.destroyed) {
          try { res.end(); } catch { /* stream already gone */ }
        }
        return;
      }
      renderError(res, err, { env });
    }
  };
}

// Open a real node:http server for a resolved app and start listening. The
// server is stored on `app.httpServer` and the app is returned (chainable). The
// app's db handle is passed to the dispatcher (read here, owned by the app). The
// routing table was built at mount time; this only serves it.
//
// The second argument is overloaded the Express way: a FUNCTION is a listening
// callback (`app.listen(port, () => ...)`, the exemplar shape); an OBJECT is
// server-owned listen options (`principalOf`, `env`). Both are server-owned —
// neither is client-controlled.
//
// Graceful shutdown (SPEC §3) is framework-owned: SIGTERM/SIGINT close the live
// server, and an unhandledRejection/uncaughtException is trapped. The app mounts
// none of this — `app.shutdown()` is the close the traps call (and tests use).
export function listen(app, port, optionsOrCallback = {}) {
  // Portless `app.listen()` — `port` was already optional to `app.listen`, but
  // here it is the value actually bound. An absent port falls back to
  // `app.config.port` (the env-or-option value resolved at construction) and
  // finally the process-wide singleton. One listen path, three sources, most-
  // specific-wins.
  port = port ?? app.config?.port ?? config.port;
  const isCallback = typeof optionsOrCallback === 'function';
  const options = isCallback ? {} : optionsOrCallback;
  const onListening = isCallback ? optionsOrCallback : options.onListening;
  const log = getLog();

  // The default principal source is session hydration when the app has a db: the
  // principal is built server-side from the request's session cookie (SPEC §572).
  // An explicit `principalOf` option overrides (tests inject a fixed principal).
  // With no db there is nothing to look a session up in, so the source stays the
  // fail-closed `() => anonymous` default in makeRequestHandler.
  //
  // When the session resolver returns anonymous (no cookie / invalid session),
  // the API key resolver is tried next: it reads `Authorization: Bearer <token>`,
  // hashes the token, looks up the ApiKey row, and returns an apiKey principal.
  // This is the SAME authorization engine as session principals — no second auth
  // path. The session takes priority: a request with BOTH a valid cookie and a
  // Bearer header resolves to the user principal.
  const sessionResolver = app.db ? sessionPrincipalOf(app.db) : null;
  const apiKeyResolver = app.db ? apiKeyPrincipalOf(app.db) : null;
  const defaultPrincipalOf = sessionResolver
    ? (req) => {
        const p = sessionResolver(req);
        if (p.type !== 'anonymous') return p;
        return apiKeyResolver ? apiKeyResolver(req) : p;
      }
    : undefined;
  const principalOf = options.principalOf ?? defaultPrincipalOf;

  // Two-phase boot. The routing table resolves asynchronously (an entity's
  // `routes` thunk may be async — e.g. a parent lazily dynamic-imports a child at
  // wiring time), but the SOCKET opens synchronously so `app.httpServer` is
  // available the instant `listen` returns (the chainable, fluent contract). The
  // handler bridges the two: every request first awaits `app.ready`, so no
  // request is ever served against a partial table even though the socket is
  // already accepting connections. A resolution failure rejects `app.ready`; the
  // handler surfaces it as a 500 and the request is never dispatched — fail closed.
  // CSP / HSTS / CORS / requestLog are opt-in policy headers (piece 4, 5).
  // `env` follows the app's config when set (per-app env), else the explicit
  // option, else the singleton default inside makeRequestHandler.
  const resolved = makeRequestHandler(
    // Read the table through a thunk: it is empty until resolution completes, and
    // the handler below gates every request on `app.ready` before reading it.
    app,
    { ...options, principalOf, db: app.db, env: options.env ?? app.config?.env ?? config.env,
      rateLimiter: options.rateLimit ? createRateLimiter(options.rateLimit) : null,
      csp: options.csp, hsts: options.hsts, cors: options.cors, requestLog: options.requestLog },
  );

  const httpServer = createHttpServer(resolved);
  app.httpServer = httpServer;
  installGracefulShutdown(app);
  // Register the shared clock shutdown handler once (one timer, not five).
  // All framework reapers (schedule, tick, job-queue lease, blob, log-retention,
  // job-worker polls) register as watchers on `app.clock`. The clock is stopped
  // once on graceful exit.
  app.onShutdown('clock', () => app.clock?.stop(), { timeoutMs: 1000 });
  // The job-queue reaper — re-assigns lease-expired jobs + revokes stale-
  // heartbeat workers. Scheduled on the shared clock. Only when the app engaged
  // the job-queue substrate.
  if (app.jobs) {
    app.jobs.startReaper();
  }
  // The blob reaper (eng-review spec #10, consult #17). `app.blobs` is built
  // whenever a db is engaged (not opt-in), and POST /blobs is always live, so an
  // abandoned upload leaks a .pending file + row forever with no operator lever
  // — a fail-open default the framework must own (AGENTS.md: Defaults + Fail
  // closed). The sweep runs UNDER the writeQueue mutex: reap() deletes DB rows
  // AND unlinks files (a transaction does not serialize FS unlinks), and a
  // dispatch txn spans an await, so an unsync'd reaper could delete a blob a
  // concurrent dispatch just referenced / is mid-adopting. serialize it as one
  // critical section against dispatch via writeQueue.run. app.blobColumns is set
  // in buildKernel (app.ready); the sweep reads it lazily so it is always current
  // even for apps whose blob fields register after listen() (buildKernel runs in
  // app.ready, which tests await). Scheduled on the shared clock.
  const blobReapIntervalMs = options.blobReapIntervalMs ?? BLOB_REAP_INTERVAL_MS;
  const blobReapTtlMs = options.blobReapTtlMs ?? BLOB_REAP_TTL_MS;
  if (app.blobs) {
    app.sweepBlobs = () => app.writeQueue.run(() =>
      app.blobs.reap({ ttl: blobReapTtlMs, blobColumns: app.blobColumns ?? [] })
    );
    app.clock.add({ name: 'blob-reaper', intervalMs: blobReapIntervalMs,
      fn: () => { app.sweepBlobs().catch((err) => log.warn('system', 'blob reap failed', { err })); } });
  }
  // _Log retention reaper (eng-review #42). The event log grows forever; when a
  // logRetentionDays option is set, the reaper prunes entries older than the
  // configured horizon. Runs at the same cadence as the blob reaper by default,
  // under the writeQueue mutex so concurrent dispatches don't race. The log is
  // eviction-safe: events-since delivers a gap → recover bundle (SPEC §D6); a
  // pruned entry that arrived after the subscriber's cursor is a legitimate gap.
  // Scheduled on the shared clock.
  const logRetentionDays = options.logRetentionDays;
  if (logRetentionDays > 0) {
    app.sweepLog = () => app.writeQueue.run(() => {
      const cutoff = new Date(Date.now() - logRetentionDays * 86_400_000).toISOString();
      retentionPrune(app.db, cutoff);
      app.db.prepare('DELETE FROM _ProjectedCursor WHERE lastSeq = 0').run();
    });
    app.clock.add({ name: 'log-reaper', intervalMs: options.logRetentionIntervalMs ?? BLOB_REAP_INTERVAL_MS,
      fn: () => { app.sweepLog().catch((err) => log.warn('system', 'log retention sweep failed', { err })); } });
  }
  // Start the tick engine if any entity declares a tick trigger. DEFERRED into
  // `app.ready` below — `app.kernel` (and thus `dispatch`) is not built until
  // `buildKernel(app)` runs; starting earlier would hand the engine an undefined
  // dispatch handle. Scans entities for tick triggers (tick.hz / tick.every);
  // only starts if at least one exists (avoids a no-op timer). ONE reconciliation
  // path — the engine dispatches under a system principal through `kernel.dispatch`,
  // admitted in-txn by the durable variant's `admission.beforeProjection` seam.
  if (typeof onListening === 'function') httpServer.once('listening', onListening);
  httpServer.listen(port);

  // Live Delivery (singular Deliver-loop seam): WS upgrade + fan-out + consumer.
  // Same mayVerb / principalOf as HTTP — no second auth path. createConsumer is
  // registered by the Kernel when assembling engaged post-commit seams.
  app.live = createLiveDelivery(httpServer, {
    path: '/events',
    mayVerb: (entity, verb, row, principal) => mayVerb(entity, verb, row, principal),
    principalOf,
    db: app.db,
    resolveEntity: (name) => app.entities?.get(name),
  });

  // Resolution runs in the background; `app.ready` completes once routes,
  // schema, kernel, background consumers, and the socket are ready, so a caller
  // may await it before traffic or shutdown.
  app.ready = (async () => {
    await app.resolveRoutes();
    if (app.db && typeof app.db.exec === 'function') await app.prepareSchema();
    app.kernel = buildKernel(app);
    await buildAndStart(app);
    return app;
  })();

  return app;
}

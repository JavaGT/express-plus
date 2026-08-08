// @ts-nocheck
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

import { anonymous } from './principal.ts';
import { mayVerb, mayRow } from './row-grant.ts';
import { config } from './config.ts';
import { applySecurityHeaders, renderError, isSameOriginRequest } from './middleware.ts';
import { sessionPrincipalOf, sessionTokenOf, apiKeyPrincipalOf } from './auth/session.ts';
import { createLiveDelivery } from './live-delivery.ts';
import { getLog, withLog } from './log.ts';
import { createRateLimiter } from './rate-limit.ts';
import { BodyError, readRequestBody } from './http-body.ts';
import { runChain } from './http-handler-chain.ts';
import { matchRoute } from './http-route-match.ts';
import { committedEventHeaders, responseHasStarted, warnLateResponse, sendJson } from './http-response.ts';
import { createResponseFacade } from './http-response-factory.ts';
import { dispatchCrud } from './http-crud-dispatch.ts';
import { failure } from './outcome.ts';
import { sendFailure } from './http-failure.ts';
import { handleResyncRoute, handleBlobUploadRoute, handleJobRoute, handleClientSdkRoute } from './http-framework-routes.ts';
import { handleApplicationActionHttp } from './application-action-http.ts';

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
  const log = (isApp && source.log) ? source.log : getLog();
  const requestCount = { count: 0 };

  // Handles the default route matching + dispatch after the handler chain.
  async function handleRouteMatch(req, res, routes, url) {
    const { route, params, pathMatched } = matchRoute(routes, req.method, url.pathname);

    // no path match → 404; path matched but method did not → 405.
    if (!route) {
      if (pathMatched) {
        sendFailure(sendJson, res, failure('invalid-input', 'method not allowed'), { status: 405 });
      } else {
        sendFailure(sendJson, res, failure('not-found', 'not found'));
      }
      return;
    }

    // the first default-on auth layer: the route gate decides admission.
    const principal = principalOf(req);
    if (!route.gate(principal)) {
      sendFailure(sendJson, res, failure('denied', 'unauthorized'), { status: 401 });
      return;
    }

    // read a body for mutating entity verbs and every imperative route. Entity
    // CRUD stays JSON-only; handlers may accept browser form posts.
    let body = {};
    if (route.handlers || route.verb === 'create' || route.verb === 'update' || route.verb === 'fieldApply') {
      try {
        body = await readRequestBody(req, { jsonOnly: !route.handlers });
      } catch (err) {
        // a refused body carries its own status (413 oversized, 400 malformed).
        if (err instanceof BodyError) {
          return void sendFailure(
            sendJson,
            res,
            failure('invalid-input', err.message),
            { status: err.status },
          );
        }
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
      await dispatchCrud({ entity: route.entity, verb: route.verb, fieldName: route.fieldName, db, principal, params, body, actionId: req.headers['x-workbench-action-id'], app: isApp ? source : null, res, sendJson, committedEventHeaders, mayRow });
    }
  }

  async function handle(req, res) {
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
          sendFailure(
            sendJson,
            res,
            failure('conflict', 'rate limit exceeded', { retryAfterMs: r.retryAfterMs }),
            { status: 429 },
          );
          return;
        }
      }

      // CSRF origin guard (eng-review #13) — a foreign-origin mutation is
      // rejected before it reaches the route gate or any state change. Bare
      // non-browser requests (no Origin/Referer — Node fetch, curl) pass.
      if (isApp && !csrfGuard(req)) {
        sendFailure(sendJson, res, failure('denied', 'forbidden'));
        return;
      }

      const url = new URL(req.url, 'http://localhost');

      // Ordered request handler chain: the first entry whose match() returns
      // true gets to handle(). If handle() returns true (or the response has
      // started), processing stops. If handle() returns false, the next
      // matching entry is tried. At the end, the default route matching +
      // dispatch runs.
      const handlers = [
        // /health — PUBLIC, anonymous, no auth (piece 1)
        {
          match: () => isApp && req.method === 'GET' && url.pathname === '/health',
          handle: () => { sendJson(res, 200, { status: 'ok', env }); return true; },
        },
        // /health/stats — includes uptime, RSS, request count
        {
          match: () => isApp && req.method === 'GET' && url.pathname === '/health/stats',
          handle: () => {
            sendJson(res, 200, {
              status: 'ok',
              env,
              uptimeMs: Math.round(process.uptime() * 1000),
              rssBytes: process.memoryUsage().rss,
              requestCount: requestCount.count,
            });
            return true;
          },
        },
        // CORS preflight (piece 4 — opt-in): OPTIONS with allowed origin → 204
        {
          match: () => isApp && req.method === 'OPTIONS' && cors && cors.origins && Array.isArray(cors.origins),
          handle: () => {
            const origin = req.headers.origin;
            if (origin && cors.origins.includes(origin)) {
              res.setHeader('access-control-allow-origin', origin);
              res.setHeader('vary', 'Origin');
              res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
              res.setHeader('access-control-allow-headers', 'content-type');
              res.writeHead(204);
              res.end();
              return true;
            }
            return false;
          },
        },
        // Browser SDK: GET /workbench.mjs (intercepts before matchRoute)
        {
          match: () => isApp && req.method === 'GET',
          handle: async () => {
            const handled = await handleClientSdkRoute(source, req, res);
            return handled || responseHasStarted(res);
          },
        },
        // Snapshot + resync: /snapshot/:entity/:id, /events-since/:entity/:id (spec #1, D6/D7)
        {
          match: () => isApp && req.method === 'GET',
          handle: async () => {
            const handled = await handleResyncRoute(source, req, res, principalOf(req));
            return handled || responseHasStarted(res);
          },
        },
        // Blob upload: POST /blobs (spec #2)
        {
          match: () => isApp && req.method === 'POST',
          handle: async () => {
            const handled = await handleBlobUploadRoute(source, req, res, principalOf(req));
            return handled || responseHasStarted(res);
          },
        },
        // Job-queue endpoints: /workers/register, /jobs/* (spec #5)
        {
          match: () => isApp && req.method === 'POST' && source.jobs,
          handle: async () => {
            const handled = await handleJobRoute(source, req, res);
            return handled || responseHasStarted(res);
          },
        },
        // Generic registered-action transport. This is intentionally before
        // application handlers so entity mutation authority stays in the
        // package-owned registered-action kernel.
        {
          match: () => isApp,
          handle: async () => handleApplicationActionHttp(source, req, res, principalOf, sendJson),
        },
        // Application-integrated SSE delivery is package-owned: this mounted
        // handler has no access to raw log rows or action callbacks.
        {
          match: () => isApp && Boolean(source._applicationLiveDelivery),
          handle: async () => {
            const handled = await source._applicationLiveDelivery.handler(req, res);
            return handled || responseHasStarted(res);
          },
        },
        // App-declared prefix-intercept handlers — app.use(prefix, fn)
        {
          match: () => isApp && source._handlers?.length,
          handle: async () => {
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
              const ctxRes = makeHandlerRes(res, () => { handled = true; });
              try {
                await fn(ctxReq, ctxRes, () => {});
              } catch (err) {
                renderError(res, err, { env });
                return true;
              }
              if (handled || responseHasStarted(res)) return true;
            }
            return false;
          },
        },
      ];

      // Run the handler chain
      for (const h of handlers) {
        if (h.match()) {
          const handled = await h.handle();
          if (handled || responseHasStarted(res)) return;
        }
      }

      // Default: route matching + dispatch
      await handleRouteMatch(req, res, routes, url);
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
  }
  return (req, res) => withLog(log, () => handle(req, res));
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
  if (app.httpServer) {
    throw new Error('application is already listening');
  }
  // Portless `app.listen()` — `port` was already optional to `app.listen`, but
  // here it is the value actually bound. An absent port falls back to
  // `app.config.port` (the env-or-option value resolved at construction) and
  // finally the process-wide singleton. One listen path, three sources, most-
  // specific-wins.
  port = port ?? app.config?.port ?? config.port;
  const isCallback = typeof optionsOrCallback === 'function';
  const options = isCallback ? {} : optionsOrCallback;
  const onListening = isCallback ? optionsOrCallback : options.onListening;
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
  const sessionResolver = app.db
    ? sessionPrincipalOf(app.db, { durationMs: app.config.sessionDurationMs })
    : null;
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
  // Start the tick engine if any entity declares a tick trigger. DEFERRED into
  // `app.ready` below — `app.kernel` (and thus `dispatch`) is not built until
  // `buildKernel(app)` runs; starting earlier would hand the engine an undefined
  // dispatch handle. Scans entities for tick triggers (tick.hz / tick.every);
  // only starts if at least one exists (avoids a no-op timer). ONE reconciliation
  // path — the engine dispatches under a system principal through `kernel.dispatch`,
  // admitted in-txn by the durable variant's `admission.beforeProjection` seam.
  let failTransport;
  app._transportReady = new Promise((resolve, reject) => {
    const cleanup = () => {
      httpServer.off('listening', onReady);
      httpServer.off('error', onError);
      httpServer.off('close', onClose);
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    failTransport = onError;
    const onClose = () => {
      cleanup();
      if (app._shutdownStarted) {
        resolve();
      } else {
        // `httpServer.close()` is a long-standing public escape hatch used by
        // callers that only own the transport. If it wins the race with the
        // listening event, treat that as cancellation and release the rest of
        // the application rather than creating an unobserved rejected `ready`.
        app._shutdownFromStartFailure().then(resolve, reject);
      }
    };
    httpServer.once('listening', onReady);
    httpServer.once('error', onError);
    httpServer.once('close', onClose);
  });
  if (typeof onListening === 'function') httpServer.once('listening', onListening);

  // Live Delivery is a durable _Log consumer, so a headless HTTP application
  // has no delivery seam to attach. DB-backed apps retain the single seam.
  if (app.db && !app._applicationLiveDelivery) {
    app.live = createLiveDelivery(httpServer, {
      path: '/events',
      mayVerb: (entity, verb, row, principal) => mayVerb(entity, verb, row, principal),
      principalOf,
      db: app.db,
      resolveEntity: (name) => app.entities?.get(name),
      ready: () => app.ready,
      log: app.log,
    });
  }
  app._transportAttached = true;

  // Job lifecycle events (W3 slice 2): the queue appends its _Job.* events to
  // _Log itself, not through the durable pipeline, so the post-commit consumer
  // never sees them. Bridge the queue's listener hook into the committed-event
  // delivery core — the core re-reads the _Log, re-authorises, projects, and
  // delivers to WebSocket subscribers. The event stays durable in _Log for
  // cursor catch-up either way. The fan-out is only for non-_Log ephemerals.
  if (app.jobs) {
    app._detachJobLive = app.jobs.onEvent((ev) => {
      if (!ev.scope) return;
      if (app._applicationLiveDelivery) app._applicationLiveDelivery.wake(ev.scope);
      else app.live?.wake(ev.scope);
    });
  }

  // Live and every other transport-owned consumer are selected before Kernel
  // assembly. Establish readiness before asking Node to bind, so even a request
  // accepted at the first possible instant observes the boot barrier.
  app.start();
  try {
    httpServer.listen(port);
  } catch (err) {
    failTransport(err);
    // `listen()` retains Node's synchronous argument-error contract. Attach an
    // observer to the same rejected readiness promise so callers that catch the
    // synchronous error are not also handed an unhandled rejection.
    app.ready.catch(() => {});
    throw err;
  }

  return app;
}

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
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { anonymous } from './principal.mjs';
import { bindReadScope } from './scope-sql.mjs';
import { validateMutation, ValidationError, serializeField } from './field-strategy.mjs';
import { mayVerb } from './row-grant.mjs';
import { config } from './config.mjs';
import { applySecurityHeaders, renderError } from './middleware.mjs';
import { sessionPrincipalOf } from './session.mjs';
import { createLiveServer } from './live.mjs';
import { resolveTemplate } from './views.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { isSafePath, matchExtension } from './views.mjs';

// Match a concrete request path against a route's path template. Phase-1 routes
// carry literal segments and `:param` segments (e.g. `/notes/:id`). Returns the
// bound params on a match, or null on no match. A segment count mismatch is a
// non-match (a longer or shorter path is a different route).
function matchPath(template, actual) {
  const t = template.split('/').filter(Boolean);
  const a = actual.split('/').filter(Boolean);
  if (t.length !== a.length) return null;
  const params = {};
  for (let i = 0; i < t.length; i += 1) {
    if (t[i].startsWith(':')) {
      params[t[i].slice(1)] = decodeURIComponent(a[i]);
    } else if (t[i] !== a[i]) {
      return null;
    }
  }
  return params;
}

// Find the route whose method AND path template match the request. Path is
// matched first so a known path with the wrong method can be told apart (405)
// from an unknown path (404).
function matchRoute(routes, method, pathname) {
  let pathMatched = false;
  for (const route of routes) {
    const params = matchPath(route.path, pathname);
    if (params === null) continue;
    pathMatched = true;
    if (route.method === method) return { route, params };
  }
  return { route: null, params: null, pathMatched };
}

// Send a JSON response with a status code. One place owns the response shape so
// every exit (404, 401, 200) is consistent.
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

// Read and JSON-parse a request body (create/update payloads). Caps the body to
// guard against an unbounded upload (a baked-in default; the formal middleware
// stack in the next slice generalizes this). An empty body parses to {}.
const BODY_LIMIT = 1_000_000; // ~1mb, SPEC §3 body-parse cap.

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > BODY_LIMIT) {
        // Stop consuming and reject so the handler can write a 413. Do NOT
        // destroy the socket — an abrupt close would race the response and the
        // client would see a dropped connection instead of the 413. Pausing and
        // resuming (drain-to-end) lets the response flush cleanly.
        aborted = true;
        req.pause();
        reject(new BodyError('request body exceeds the 1mb limit', 413));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw === '') return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new BodyError('request body is not valid JSON', 400));
      }
    });
    req.on('error', reject);
  });
}

// A request body the framework refuses to parse — distinct from a
// ValidationError (a well-formed payload that fails a field rule). It carries the
// HTTP status the refusal maps to: an oversized body is 413 Payload Too Large, a
// malformed body is 400 Bad Request.
class BodyError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// The owner field a row carries server-side: a readonly `ref` with a `role`. Its
// value is assigned from the principal's id on create (the client may not set it
// — validateMutation already rejects a readonly key in the payload). SPEC §158's
// `from:'req.user.id'` is the explicit form; a readonly role-ref is the default.
function ownerFieldOf(entity) {
  for (const [name, descriptor] of Object.entries(entity.fields)) {
    if (descriptor.type === 'ref' && descriptor.role && descriptor.readonly) {
      return name;
    }
  }
  return null;
}

// Serialize a payload's declared fields to their stored representation (booleans
// to 1/0, Dates to epoch — node:sqlite refuses JS booleans). Only declared
// fields are serialized; validateMutation already rejected undeclared keys.
function serializeRow(entity, payload) {
  const row = {};
  const { fields } = entity;
  for (const [key, descriptor] of Object.entries(fields)) {
    // map / store / presence / state fields are NOT stored in the main table.
    if (descriptor.kind === 'store' || descriptor.kind === 'presence' || descriptor.kind === 'state') continue;
    if (Object.hasOwn(payload, key)) {
      row[key] = serializeField(descriptor, payload[key]);
    } else if (Object.hasOwn(descriptor, 'default')) {
      const def = typeof descriptor.default === 'function' ? descriptor.default() : descriptor.default;
      row[key] = serializeField(descriptor, def);
    }
    // No default and not in payload → omit (SQLite stores NULL, which is correct
    // for truly optional fields with no declared default).
  }
  return row;
}

// DB-backed dispatch for one admitted verb. The route gate already admitted the
// request; here the SECOND default-on auth layer runs: the row grant's SQL scope
// (which rows are visible) and its .can capability (what may be done). Both must
// pass. A missing db is fail-closed (500): an entity CRUD route cannot serve
// without persistence.
async function dispatch(req, res, route, principal, db, params, body, app = null) {
  if (!db) {
    sendJson(res, 500, { error: 'no database configured for entity dispatch' });
    return;
  }
  const live = app?.live;
  const actionId = randomUUID();
  const { entity, verb } = route;
  const table = entity.name;
  const bound = bindReadScope(entity.readScope, principal);
  const where = bound ? bound.sql : '1=1';
  const scopeParams = bound ? bound.params : {};

  if (verb === 'list') {
    const rows = db.prepare(`SELECT * FROM ${table} AS t0 WHERE ${where}`).all(scopeParams);
    sendJson(res, 200, rows);
    return;
  }

  if (verb === 'read') {
    const row = db
      .prepare(`SELECT * FROM ${table} AS t0 WHERE ${where} AND t0.id = :id`)
      .get({ ...scopeParams, id: params.id });
    // not visible under scope OR absent → 404 (do not distinguish, fail closed).
    if (!row) return void sendJson(res, 404, { error: 'not found' });
    if (!(await mayVerb(entity, 'read', row, principal))) {
      return void sendJson(res, 403, { error: 'forbidden' });
    }
    sendJson(res, 200, row);
    return;
  }

  if (verb === 'create') {
    let payload;
    try {
      payload = validateMutation(entity, body);
    } catch (err) {
      if (err instanceof ValidationError) return void sendJson(res, 400, { error: err.message });
      throw err;
    }
    const ownerField = ownerFieldOf(entity);
    const row = serializeRow(entity, payload);
    if (ownerField) row[ownerField] = principal.id;
    const cols = Object.keys(row);
    const placeholders = cols.map((c) => `:${c}`).join(', ');
    const info = db
      .prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`)
      .run(row);
    const created = db
      .prepare(`SELECT * FROM ${table} WHERE id = ?`)
      .get(info.lastInsertRowid);
    sendJson(res, 201, created);
    if (live) live.emit(entity.name, created.id, created, { verb: 'create', row: created }, actionId);
    return;
  }

  if (verb === 'update') {
    const row = db
      .prepare(`SELECT * FROM ${table} AS t0 WHERE ${where} AND t0.id = :id`)
      .get({ ...scopeParams, id: params.id });
    if (!row) return void sendJson(res, 404, { error: 'not found' });
    if (!(await mayVerb(entity, 'update', row, principal))) {
      return void sendJson(res, 403, { error: 'forbidden' });
    }
    let payload;
    try {
      payload = validateMutation(entity, body);
    } catch (err) {
      if (err instanceof ValidationError) return void sendJson(res, 400, { error: err.message });
      throw err;
    }
    const updates = serializeRow(entity, payload);
    const cols = Object.keys(updates);
    if (cols.length > 0) {
      const setClause = cols.map((c) => `${c} = :${c}`).join(', ');
      db.prepare(`UPDATE ${table} SET ${setClause} WHERE id = :id`).run({ ...updates, id: params.id });
    }
    const updated = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(params.id);
    sendJson(res, 200, updated);
    if (live) live.emit(entity.name, updated.id, updated, { verb: 'update', row: updated }, actionId);
    return;
  }

  if (verb === 'remove') {
    const row = db
      .prepare(`SELECT * FROM ${table} AS t0 WHERE ${where} AND t0.id = :id`)
      .get({ ...scopeParams, id: params.id });
    if (!row) return void sendJson(res, 404, { error: 'not found' });
    if (!(await mayVerb(entity, 'remove', row, principal))) {
      return void sendJson(res, 403, { error: 'forbidden' });
    }
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(params.id);
    res.writeHead(204);
    res.end();
    if (live) live.emit(entity.name, String(params.id), row, { verb: 'remove', id: params.id }, actionId);
    return;
  }

  // an unknown verb is fail-closed (the routing table only mints the five).
  sendJson(res, 500, { error: `unknown verb '${verb}'` });
}

// The imperative terminal: run a hand-written handler chain over an Express-like
// (req, res, next). This is the OTHER arm of the single dispatch fork — it never
// touches the db or the row grant (an imperative route has no entity), so the
// route gate is its only framework-applied auth, and the principal it sees was
// already admitted by that gate (no second auth path).
//
// The chain is `[...optional middleware, finalHandler]`. Each handler is awaited
// with (req, res, next). Calling next() with no argument advances to the next
// handler; calling next(err) — including the deliberate next({ status, message })
// shape — defers to the single error renderer and stops the chain. A handler that
// writes the response (res.json / res.sendStatus / res.send) and does not call
// next() ends the chain by completing the request.
async function runChain(handlers, nodeReq, nodeRes, { principal, params, body, query }, { env }) {
  // an Express-like request facade over the node request. The raw node request
  // remains reachable for handlers that need headers; the framework surfaces the
  // already-parsed body, the matched path params, the parsed query, and the
  // already-admitted principal.
  const req = {
    body,
    params,
    query: Object.fromEntries(query),
    principal,
    raw: nodeReq,
    headers: nodeReq.headers,
    method: nodeReq.method,
    url: nodeReq.url,
  };

  // an Express-like response facade over the node response. `status(n)` records a
  // pending code and chains; `json`/`send` flush with it (defaulting to 200);
  // `sendStatus(n)` ends with no body.
  let pendingStatus = 200;
  const res = {
    status(code) {
      pendingStatus = code;
      return res;
    },
    json(value) {
      sendJson(nodeRes, pendingStatus, value);
      return res;
    },
    send(value) {
      const payload = typeof value === 'string' ? value : String(value);
      if (!nodeRes.headersSent) {
        nodeRes.writeHead(pendingStatus, {
          'content-type': 'text/plain; charset=utf-8',
          'content-length': Buffer.byteLength(payload),
        });
      }
      nodeRes.end(payload);
      return res;
    },
    sendStatus(code) {
      nodeRes.writeHead(code);
      nodeRes.end();
      return res;
    },
    render(name, data = {}) {
      try {
        const html = resolveTemplate(config.viewsDir ?? resolve(process.cwd(), 'views'), name, data);
        if (!nodeRes.headersSent) {
          nodeRes.writeHead(pendingStatus, {
            'content-type': 'text/html; charset=utf-8',
            'content-length': Buffer.byteLength(html),
          });
        }
        nodeRes.end(html);
      } catch (err) {
        // Template read failure (e.g. file not found) → 500 or 404.
        const status = err.code === 'ENOENT' ? 404 : 500;
        renderError(nodeRes, { status, message: err.code === 'ENOENT' ? `template not found: ${name}` : err.message }, { env });
      }
      return res;
    },
    raw: nodeRes,
  };

  // walk the chain. `next` is single-shot per step: it either advances (no arg)
  // or renders an error and halts. A thrown error inside a handler propagates to
  // makeRequestHandler's catch, which runs the same renderer.
  for (const handler of handlers) {
    let advance = false;
    let errored = false;
    const next = (err) => {
      if (err) {
        errored = true;
        renderError(nodeRes, err, { env });
      } else {
        advance = true;
      }
    };
    await handler(req, res, next);
    if (errored) return;
    if (!advance) return; // the handler completed the response (no next() call)
  }
}

// Build the node:http request handler that serves a routing table. `principalOf`
// derives the request's principal; it defaults to a function returning anonymous
// so an unconfigured server is fail-closed (the default-on route gate denies
// every anonymous request). When an app has a db, `listen` supplies session
// hydration as the principal source (sessionPrincipalOf) — the SAME admission
// path, not a second one. `db` is the app-level node:sqlite handle the
// dispatcher runs against.
export function makeRequestHandler(source, { principalOf = () => anonymous, db, env = config.env } = {}) {
  // `source` is either a plain resolved routing table (an array) or an app whose
  // table resolves asynchronously (two-phase boot). When it is an app, every
  // request first awaits `app.ready` so the socket may accept connections before
  // resolution completes without ever dispatching against a partial table.
  const isApp = source && typeof source.resolveRoutes === 'function';
  return async function handle(req, res) {
    // Security headers are a baked-in default on EVERY response, set before any
    // exit path writes its head (SPEC §3). They are retained through writeHead.
    applySecurityHeaders(res);
    try {
      if (isApp) await source.ready;
      const routes = isApp ? source.routes : source;

      // Static file serving — intercepts before route matching. The app declares
      // `app.static('/public', dir)`; every GET request under the prefix is served
      // from the filesystem with a content-type derived from the file extension.
      // Missing files → 404; path-traversal attempts → 404 (fail closed).
      const url = new URL(req.url, 'http://localhost');
      if (isApp && source._static && req.method === 'GET') {
        const { prefix, dir } = source._static;
        if (url.pathname.startsWith(prefix)) {
          const filePath = url.pathname.slice(prefix.length) || '/index.html';
          if (!isSafePath(dir, filePath)) {
            sendJson(res, 404, { error: 'not found' });
            return;
          }
          const fullPath = resolve(dir, filePath);
          if (!existsSync(fullPath)) {
            sendJson(res, 404, { error: 'not found' });
            return;
          }
          try {
            const content = readFileSync(fullPath);
            const mime = matchExtension(filePath);
            res.writeHead(200, {
              'content-type': mime,
              'content-length': Buffer.byteLength(content),
            });
            res.end(content);
          } catch {
            sendJson(res, 500, { error: 'internal error' });
          }
          return;
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

      // read a JSON body for the mutating entity verbs and for every imperative
      // route (a hand-written handler expects req.body populated Express-style);
      // read-only entity verbs ignore it.
      let body = {};
      if (route.handlers || route.verb === 'create' || route.verb === 'update') {
        try {
          body = await readJsonBody(req);
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
        await runChain(route.handlers, req, res, { principal, params, body, query: url.searchParams }, { env });
      } else {
        await dispatch(req, res, route, principal, db, params, body, isApp ? source : null);
      }
    } catch (err) {
      // the single error renderer (SPEC §3): an unexpected exception becomes an
      // opaque prod-safe 500 (or a dev 500 with a stack). `env` is server-owned,
      // never client-controlled.
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
  const isCallback = typeof optionsOrCallback === 'function';
  const options = isCallback ? {} : optionsOrCallback;
  const onListening = isCallback ? optionsOrCallback : options.onListening;

  // The default principal source is session hydration when the app has a db: the
  // principal is built server-side from the request's session cookie (SPEC §572).
  // An explicit `principalOf` option overrides (tests inject a fixed principal).
  // With no db there is nothing to look a session up in, so the source stays the
  // fail-closed `() => anonymous` default in makeRequestHandler.
  const principalOf =
    options.principalOf ?? (app.db ? sessionPrincipalOf(app.db) : undefined);

  // Two-phase boot. The routing table resolves asynchronously (an entity's
  // `routes` thunk may be async — e.g. a parent lazily dynamic-imports a child at
  // wiring time), but the SOCKET opens synchronously so `app.httpServer` is
  // available the instant `listen` returns (the chainable, fluent contract). The
  // handler bridges the two: every request first awaits `app.ready`, so no
  // request is ever served against a partial table even though the socket is
  // already accepting connections. A resolution failure rejects `app.ready`; the
  // handler surfaces it as a 500 and the request is never dispatched — fail closed.
  const resolved = makeRequestHandler(
    // Read the table through a thunk: it is empty until resolution completes, and
    // the handler below gates every request on `app.ready` before reading it.
    app,
    { ...options, principalOf, db: app.db },
  );

  const httpServer = createHttpServer(resolved);
  app.httpServer = httpServer;
  installGracefulShutdown(app);
  if (typeof onListening === 'function') httpServer.once('listening', onListening);
  httpServer.listen(port);

  // The live WebSocket server for /events subscriptions. It fans out entity-row
  // change events to authorized subscribers using the SAME mayVerb the REST
  // dispatch uses (verb='subscribe') — no second auth path. Created after the
  // HTTP server so the upgrade handler binds to a real socket; stored on the app
  // so dispatch can reach it at request time.
  app.live = createLiveServer(httpServer, {
    path: '/events',
    mayVerb: (entity, verb, row, principal) => mayVerb(entity, verb, row, principal),
  });

  // Resolution runs in the background; `app.ready` completes once the table is
  // built AND the socket is listening, so a caller may await it before closing.
  app.ready = (async () => {
    await app.resolveRoutes();
    if (!httpServer.listening) {
      await new Promise((resolve) => httpServer.once('listening', resolve));
    }
    return app;
  })();

  return app;
}

// The set of live apps to close on a shutdown signal, and whether the
// process-level traps are installed. These traps belong to the PROCESS, not an
// app — installing them per app would accumulate listeners (a leak, and a
// MaxListeners warning). They are installed ONCE; the signal handler closes
// every registered app.
const liveApps = new Set();
let processTrapsInstalled = false;

function installProcessTraps() {
  if (processTrapsInstalled) return;
  processTrapsInstalled = true;

  const onSignal = () => {
    Promise.all([...liveApps].map((a) => a.shutdown())).then(() => process.exit(0));
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  process.on('unhandledRejection', (reason) => {
    // surface, do not crash silently; fail closed by logging to stderr.
    process.stderr.write(`unhandledRejection: ${reason}\n`);
  });
  process.on('uncaughtException', (err) => {
    process.stderr.write(`uncaughtException: ${err?.stack ?? err}\n`);
  });
}

// The graceful-shutdown seam. `app.shutdown()` closes the live server (resolving
// once it has stopped accepting connections) and unregisters the app. SIGTERM/
// SIGINT close every registered app; an unhandledRejection/uncaughtException is
// trapped so a stray rejection cannot crash the process silently. The framework
// owns these — an app that mounted its own would be a leak.
function installGracefulShutdown(app) {
  if (!app.shutdown) {
    app.shutdown = () =>
      new Promise((resolve) => {
        if (app.httpServer && app.httpServer.listening) {
          app.httpServer.close(() => {
            liveApps.delete(app);
            resolve();
          });
        } else {
          liveApps.delete(app);
          resolve();
        }
      });
  }
  liveApps.add(app);
  installProcessTraps();
}

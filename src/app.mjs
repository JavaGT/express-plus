// The app resolution layer — Todo C (SPEC §3, §4, §6.2; ADR #20).
//
// `expressPlus()` is the default export: a chainable app. `app.mount(path, Entity)`
// resolves a declared entity into routes by invoking its `routes:(r)=>...` thunk
// with a route builder `r`. The builder's `r.resource({gate})` declares the five
// CRUD verbs and runs the per-verb gate map through resolveRouteGate (Todo B), so
// every mounted route carries its resolved `(principal)=>boolean` gate. The result
// is an INSPECTABLE routing table: a list of { method, path, verb, entity, gate }.
//
// This is the WIRING that connects a declared entity to its mounted routes with the
// two default-on auth layers intact — the route gate here, the row grant (the SQL
// scope + .can) still running on every verb downstream. There is no second auth
// path: this layer decides route admission, never row visibility.
//
// Scope (DECISIONLOG): the RESOLUTION layer only. `.listen(port)` records the port
// and returns the app (chainable) so the exemplar call shape works; the live HTTP
// socket + req/res dispatch + the baked-in middleware stack land in Phase 2 when a
// real transport is needed. The architecturally interesting part — does the table
// resolve with the gates correctly wired — is fully proven here without a socket.

import { resolveRouteGate, requireUser, isGate } from './route-gate.mjs';
import { listen as serveListen } from './serve.mjs';
import { setActiveDb } from './db.mjs';

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

// The route builder `r` handed to an entity's `routes:(r)=>...` thunk. It collects
// resource declarations; each `r.resource({gate})` expands to the five CRUD verbs
// with the per-verb gate resolved (unlisted verbs default to requireUser()). An
// entity that omits `routes` is auto-CRUD'd via a default `r.resource()`.
function buildResourceRoutes(entity, base) {
  const collected = [];

  const r = {
    resource(options = {}) {
      const resolvedGate = resolveRouteGate(options.gate ?? {});
      for (const { verb, method, suffix } of RESOURCE_VERBS) {
        collected.push(
          Object.freeze({
            method,
            path: joinPath(base, suffix),
            verb,
            entity,
            gate: resolvedGate[verb],
          }),
        );
      }
      return r;
    },
  };

  if (typeof entity.routes === 'function') {
    entity.routes(r);
  } else {
    // No `routes` declared → the framework auto-CRUDs through the grant.
    r.resource();
  }

  return collected;
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

// A mountable surface — the shared core of both the top-level app and a router
// mini-app. `mount(path, target)` accepts either a compiled entity (resolve its
// resource routes under `path`) or another router (re-base its routes under
// `path`). The accumulated `routes` table is inspectable. `mergeParams` is carried
// so a child router mounted under a parametric parent path (`/:docId/notes`) can
// read the parent's path param.
function makeMountable({ mergeParams = false } = {}) {
  const routes = [];

  const surface = {
    mergeParams,
    routes,
    mount(path, target) {
      if (target && Array.isArray(target.routes) && typeof target.mount === 'function') {
        // target is a router mini-app: re-base its already-resolved routes. The
        // tail (entity/verb OR handlers) is carried through unchanged by rebase.
        for (const route of target.routes) {
          routes.push(rebaseRoute(route, path));
        }
      } else {
        // target is a compiled entity: resolve its resource routes under `path`.
        for (const route of buildResourceRoutes(target, path)) {
          routes.push(route);
        }
      }
      return surface;
    },
  };

  // `use` is a second NAME for `mount` — the readability convention the repo-root
  // exemplars adopt (`app.use('/sessions', router)` for routers,
  // `app.mount('/docs', Doc)` for entities). Both names call the one resolver;
  // there is a single mount operation, two words for it.
  surface.use = surface.mount;

  // Imperative verb methods: `r.get/post/patch/delete(path, ...gates, handler)`.
  // Each builds an imperative route record and pushes it into the SAME table the
  // entity CRUD routes live in — one routing table, discriminated by tail shape.
  for (const [verb, method] of Object.entries(IMPERATIVE_VERBS)) {
    surface[verb] = (path, ...rest) => {
      routes.push(buildImperativeRoute(method, path, rest));
      return surface;
    };
  }

  return surface;
}

// router(opts) — a mini-app mounted bare into a parent app with
// `app.mount(path, router)`. `{ mergeParams: true }` lets a child read a parent
// path param. A router resolves its routes relative to its own base ('/') and is
// re-based when mounted.
export function router(options = {}) {
  return makeMountable({ mergeParams: options.mergeParams === true });
}

// expressPlus() — the default export. A chainable app. `.mount(path, Entity)`
// resolves and accumulates routes; `.listen(port, options)` opens a real
// node:http server serving the resolved routing table and returns the app
// (chainable). The server is exposed on `app.httpServer`. `options.principalOf`
// overrides the request→principal source (default: anonymous, fail-closed). Both
// chain.
export default function expressPlus({ db } = {}) {
  const app = makeMountable();
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
  app.port = undefined;
  app.httpServer = undefined;
  app.listen = (port, optionsOrCallback) => {
    app.port = port;
    return serveListen(app, port, optionsOrCallback);
  };
  return app;
}

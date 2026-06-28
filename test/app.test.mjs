// Phase 1 — Todo C: the app resolution layer (SPEC §3, §4, §6.2).
//
// `expressPlus()` is the default export: a chainable app. `app.mount(path, Entity)`
// invokes the entity's `routes:(r)=>...` thunk with a route builder `r`, collects
// the CRUD routes `r.resource({gate})` declares, runs the per-verb gate map through
// resolveRouteGate (Todo B), and produces an INSPECTABLE routing table — a list of
// { method, path, verb, entity, gate } entries. This is the WIRING that connects a
// declared entity to its mounted routes with the two default-on auth layers intact.
//
// Scope (user decision, DECISIONLOG): the RESOLUTION layer only. We prove the table
// shape + gate wiring against principals; we do NOT stand up a real HTTP socket or
// dispatch real req/res here — that live transport lands in Phase 2. `.listen(port)`
// records the port and returns the app (chainable) so the exemplar call shape works.
//
// The five CRUD verbs map to method+path like Express resource routes:
//   list   GET    /base
//   create POST   /base
//   read   GET    /base/:id
//   update PATCH  /base/:id
//   remove DELETE /base/:id

import { test } from 'node:test';
import assert from 'node:assert/strict';

import expressPlus, {
  router,
  entity,
  text,
  ref,
  boolean,
  grant,
  read,
  write,
  subscribe,
  scope,
  allowAnonymous,
  requireUser,
  open,
} from '../src/index.mjs';
import { principal, anonymous } from '../src/principal.mjs';

const user = principal({ type: 'user', id: 'user-1' });

// A minimal owned entity (the note.mjs floor). `routes` omitted → auto-CRUD.
function makeNote() {
  return entity('Note', {
    fields: {
      body: text(),
      owner: ref('User', { role: 'owner', readonly: true }),
    },
    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read),
      ),
    ],
  });
}

// An entity that declares an explicit per-verb gate via r.resource({gate}).
function makePost() {
  return entity('Post', {
    fields: {
      title: text(),
      published: boolean({ default: false }),
      owner: ref('User', { role: 'owner', readonly: true }),
    },
    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read),
      ),
    ],
    // list is public (a published blog index); everything else is default-on.
    routes: (r) => r.resource({ gate: { list: allowAnonymous() } }),
  });
}

// --- the default export is a chainable app ---

test('expressPlus() returns a chainable app; mount and listen return the app', () => {
  const app = expressPlus();
  assert.equal(typeof app.mount, 'function');
  assert.equal(typeof app.listen, 'function');
  const Note = makeNote();
  assert.equal(app.mount('/notes', Note), app, 'mount is chainable');
  // listen opens a real socket (Phase 2); use an ephemeral port and close it.
  assert.equal(app.listen(0), app, 'listen is chainable');
  app.httpServer.close();
});

// --- mounting an entity with omitted routes auto-CRUDs all five verbs ---

test('mounting an entity with no `routes` auto-CRUDs all five verbs, each default-on', () => {
  const app = expressPlus().mount('/notes', makeNote());
  const verbs = app.routes.map((r) => r.verb).sort();
  assert.deepEqual(verbs, ['create', 'list', 'read', 'remove', 'update']);
  // every auto-CRUD route is default-on: anonymous denied, user admitted.
  for (const route of app.routes) {
    assert.equal(route.gate(anonymous), false, `${route.verb} default-on`);
    assert.equal(route.gate(user), true, `${route.verb} admits a user`);
  }
});

// --- the routing table maps each verb to the right method + path ---

test('the routing table maps the five verbs to Express resource method+path', () => {
  const app = expressPlus().mount('/notes', makeNote());
  const byVerb = Object.fromEntries(app.routes.map((r) => [r.verb, r]));
  assert.equal(byVerb.list.method, 'GET');
  assert.equal(byVerb.list.path, '/notes');
  assert.equal(byVerb.create.method, 'POST');
  assert.equal(byVerb.create.path, '/notes');
  assert.equal(byVerb.read.method, 'GET');
  assert.equal(byVerb.read.path, '/notes/:id');
  assert.equal(byVerb.update.method, 'PATCH');
  assert.equal(byVerb.update.path, '/notes/:id');
  assert.equal(byVerb.remove.method, 'DELETE');
  assert.equal(byVerb.remove.path, '/notes/:id');
});

// --- each route carries its entity, so the dispatcher can reach the grant ---

test('each route entry carries the entity it was mounted for', () => {
  const Note = makeNote();
  const app = expressPlus().mount('/notes', Note);
  for (const route of app.routes) {
    assert.equal(route.entity, Note);
  }
});

// --- r.resource({gate}) wires the per-verb gate into the table ---

test('r.resource({gate}) relaxes only the named verb; other verbs stay default-on', () => {
  const app = expressPlus().mount('/posts', makePost());
  const byVerb = Object.fromEntries(app.routes.map((r) => [r.verb, r]));
  // list is relaxed: anonymous admitted to the list ROUTE
  assert.equal(byVerb.list.gate(anonymous), true);
  // create/read/update/remove stay default-on
  assert.equal(byVerb.create.gate(anonymous), false);
  assert.equal(byVerb.create.gate(user), true);
  assert.equal(byVerb.read.gate(anonymous), false);
  assert.equal(byVerb.update.gate(anonymous), false);
  assert.equal(byVerb.remove.gate(anonymous), false);
});

// --- mounting multiple entities accumulates their routes under their base paths ---

test('mounting two entities accumulates both route sets under their base paths', () => {
  const app = expressPlus()
    .mount('/notes', makeNote())
    .mount('/posts', makePost());
  const notePaths = app.routes.filter((r) => r.entity.name === 'Note').map((r) => r.path);
  const postPaths = app.routes.filter((r) => r.entity.name === 'Post').map((r) => r.path);
  assert.ok(notePaths.every((p) => p.startsWith('/notes')));
  assert.ok(postPaths.every((p) => p.startsWith('/posts')));
  assert.equal(app.routes.length, 10, 'two resources × five verbs');
});

// --- router() builds a mini-app mounted bare into a parent app ---

test('router({mergeParams}) builds a mini-app; app.mount(path, router) merges its routes under the path', () => {
  const r = router({ mergeParams: true });
  r.mount('/', makeNote());
  // mini-app exposes its own (bare) routing table
  assert.equal(r.routes.length, 5);
  // mounting the router into a parent app re-bases every route under the mount path
  const app = expressPlus().mount('/docs/:docId/notes', r);
  assert.equal(app.routes.length, 5);
  for (const route of app.routes) {
    assert.ok(route.path.startsWith('/docs/:docId/notes'), `re-based: ${route.path}`);
  }
});

test('router records mergeParams so a child can read a parent path param', () => {
  const r = router({ mergeParams: true });
  assert.equal(r.mergeParams, true);
  const plain = router();
  assert.equal(plain.mergeParams, false);
});

// --- Slice A: imperative router verbs build a SECOND route kind ---------------
//
// `r.get/post/patch/delete(path, ...handlers)` builds an imperative route: a
// shared spine { method, path, gate } plus a discriminated tail { handlers }
// (vs the entity tail { entity, verb }). The discriminant is structural — a
// route with `handlers` is imperative, a route with `entity`/`verb` is an entity
// CRUD route. Leading BRANDED gates peel off the front into `gate`; the rest is
// the handler chain (optional middleware then exactly one final handler). A route
// with no leading gate defaults to requireUser() (fail closed).

test('router exposes the four imperative verb methods', () => {
  const r = router();
  for (const verb of ['get', 'post', 'patch', 'delete']) {
    assert.equal(typeof r[verb], 'function', `r.${verb} is a function`);
  }
});

test('r.get(path, handler) builds an imperative route with method, path, handlers and a default gate', () => {
  const handler = (req, res) => res.json({ ok: true });
  const r = router();
  assert.equal(r.get('/ping', handler), r, 'verb method is chainable');
  assert.equal(r.routes.length, 1);
  const [route] = r.routes;
  assert.equal(route.method, 'GET');
  assert.equal(route.path, '/ping');
  // imperative tail: a handler chain, NOT an entity/verb tail
  assert.deepEqual(route.handlers, [handler]);
  assert.equal(route.entity, undefined);
  assert.equal(route.verb, undefined);
  // no leading gate => default-on (requireUser): anonymous denied, user admitted
  assert.equal(route.gate(anonymous), false);
  assert.equal(route.gate(user), true);
});

test('a leading `open` gate peels off into route.gate, leaving only the handler chain', () => {
  const handler = (req, res) => res.json({});
  const r = router();
  r.post('/login', open(), handler);
  const [route] = r.routes;
  assert.equal(route.gate(anonymous), true, 'open admits anonymous');
  assert.deepEqual(route.handlers, [handler], 'gate is peeled, not left in the chain');
});

test('leading middleware before the final handler stays in the chain; only branded gates peel', () => {
  const mw = (req, res, next) => next();
  const handler = (req, res) => res.json({});
  const r = router();
  r.post('/x', open(), mw, handler);
  const [route] = r.routes;
  // open peels (branded); the plain middleware does NOT peel and stays in order
  assert.deepEqual(route.handlers, [mw, handler]);
  assert.equal(route.gate(anonymous), true);
});

test('an imperative route with no handlers is rejected (a route must do something)', () => {
  const r = router();
  assert.throws(() => r.get('/nothing'), /handler/i);
  assert.throws(() => r.get('/nothing', open()), /handler/i);
});

test('the four verbs map to their HTTP methods', () => {
  const h = (req, res) => res.json({});
  const r = router();
  r.get('/a', h);
  r.post('/b', h);
  r.patch('/c', h);
  r.delete('/d', h);
  const byPath = Object.fromEntries(r.routes.map((rt) => [rt.path, rt.method]));
  assert.deepEqual(byPath, { '/a': 'GET', '/b': 'POST', '/c': 'PATCH', '/d': 'DELETE' });
});

// --- Slice A: app.use(path, router) mounts an imperative router ----------------
//
// `use` is a second NAME for the same mount operation as `mount`; the repo-root
// exemplars deliberately read `app.use('/sessions', router)` for routers and
// `app.mount('/docs', Doc)` for entities. Both call one resolver. Re-basing must
// carry the imperative `handlers` tail through unchanged.

test('app.use is an alias for mount; both re-base a mounted router under the path', () => {
  const app = expressPlus();
  assert.equal(typeof app.use, 'function');
  const r = router();
  const handler = (req, res) => res.json({});
  r.post('/', open(), handler);
  app.use('/sessions', r);
  assert.equal(app.routes.length, 1);
  const [route] = app.routes;
  assert.equal(route.method, 'POST');
  assert.equal(route.path, '/sessions');
  // the imperative tail survives re-basing intact
  assert.deepEqual(route.handlers, [handler]);
  assert.equal(route.gate(anonymous), true);
});

test('app.use re-bases a multi-route imperative router and preserves each tail', () => {
  const app = expressPlus();
  const h = (req, res) => res.json({});
  const r = router();
  r.get('/', h);
  r.get('/:id', h);
  app.use('/users', r);
  const paths = app.routes.map((rt) => rt.path).sort();
  assert.deepEqual(paths, ['/users', '/users/:id']);
  for (const route of app.routes) {
    assert.deepEqual(route.handlers, [h]);
    // default gate carried through re-basing
    assert.equal(route.gate(anonymous), false);
  }
});

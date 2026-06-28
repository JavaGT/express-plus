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

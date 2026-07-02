// Phase 2 — slice 1: the real HTTP transport (SPEC §3, §4).
//
// Phase 1 resolved a declared app into an inspectable routing table. This slice
// makes `.listen(port)` open a real node:http server that serves that table:
// an incoming request is matched to a route, the route gate (the first default-on
// auth layer) runs against the request's principal, and admission decides the
// response — 401 when the gate denies, the dispatched result when it admits.
//
// Fail-closed default: a server with no configured principal source treats every
// request as `anonymous`. The route gate is default-on (requireUser), so an
// unconfigured server denies every request — the smoothest path is the safe path.
// Session → req.user → principal hydration is a later slice that REPLACES this
// principal source; it does not add a second auth path.
//
// This slice proves admission over a live socket. DB-backed CRUD dispatch (the
// list/read/create/update/remove bodies) is the next slice; here an admitted
// request reaches a stub that echoes its matched verb so we can assert the route
// resolved and the gate let it through.

import { text, ref, grant, read, write, subscribe, scope, allowAnonymous } from '../src/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import workbench, {
  entity } from '../src/internal.mjs';
import { principal, anonymous } from '../src/principal.mjs';

// An owned entity, routes omitted → auto-CRUD, every verb default-on.
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

// An entity whose list verb is public (route gate relaxed for `list` only).
function makePublicListNote() {
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
    routes: (r) => r.resource({ gate: { list: allowAnonymous() } }),
  });
}

// Start a server on an ephemeral port and return { origin, close }.
async function listen(app) {
  const server = app.listen(0);
  // .listen must expose the underlying node:http server (or a handle) so a test
  // can read the assigned port and close it. The bound port lives on .address().
  await new Promise((resolve) => {
    if (server.httpServer.listening) resolve();
    else server.httpServer.once('listening', resolve);
  });
  const { port } = server.httpServer.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.httpServer.close(r)),
  };
}

test('.listen(0) opens a real node:http server with the resolved routing table', async () => {
  const app = workbench().mount('/notes', makeNote());
  const { origin, close } = await listen(app);
  try {
    // a request to a declared route reaches the server (not a connection refusal)
    const res = await fetch(`${origin}/notes`);
    assert.ok(res.status > 0, 'the server answered');
  } finally {
    await close();
  }
});

test('the default-on route gate denies an anonymous request with 401', async () => {
  // No principal source configured → every request is anonymous → requireUser
  // denies the auto-CRUD list route.
  const app = workbench().mount('/notes', makeNote());
  const { origin, close } = await listen(app);
  try {
    const res = await fetch(`${origin}/notes`);
    assert.equal(res.status, 401, 'anonymous denied by the default-on gate');
  } finally {
    await close();
  }
});

test('a relaxed (allowAnonymous) verb admits an anonymous request', async () => {
  const app = workbench().mount('/notes', makePublicListNote());
  const { origin, close } = await listen(app);
  try {
    // list is public; GET /notes is admitted past the gate.
    const res = await fetch(`${origin}/notes`);
    assert.notEqual(res.status, 401, 'public list admits anonymous');
    // a default-on verb on the same resource still denies anonymous.
    const created = await fetch(`${origin}/notes`, { method: 'POST' });
    assert.equal(created.status, 401, 'create stays default-on');
  } finally {
    await close();
  }
});

test('an admitted request reaches dispatch (fail-closed without a db)', async () => {
  // With list public, an admitted GET passes the gate and REACHES dispatch. This
  // app was constructed without a db, so DB-backed dispatch is fail-closed at
  // 500 — which proves the request crossed the gate into dispatch (a denied
  // request would have stopped at 401, never reaching the db check). The full
  // DB-backed CRUD path is proven end to end in test/http-crud.test.mjs.
  const app = workbench().mount('/notes', makePublicListNote());
  const { origin, close } = await listen(app);
  try {
    const res = await fetch(`${origin}/notes`);
    assert.equal(res.status, 500, 'admitted, reached dispatch, no db → fail closed');
  } finally {
    await close();
  }
});

test('a request to an undeclared path returns 404', async () => {
  const app = workbench().mount('/notes', makePublicListNote());
  const { origin, close } = await listen(app);
  try {
    const res = await fetch(`${origin}/nonexistent`);
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

test('a request with an unsupported method on a known path returns 405', async () => {
  const app = workbench().mount('/notes', makePublicListNote());
  const { origin, close } = await listen(app);
  try {
    const res = await fetch(`${origin}/notes`, { method: 'PUT' });
    assert.equal(res.status, 405);
    const body = await res.json();
    assert.equal(body.error, 'method not allowed');
  } finally {
    await close();
  }
});

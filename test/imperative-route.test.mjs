// Phase 2 — slice A: the imperative router surface over the live HTTP transport
// (SPEC §3, §4).
//
// An imperative route is a hand-written handler chain: `r.post('/', open, fn)`.
// It shares the request spine with entity CRUD routes — one match, one principal,
// one route gate — and forks only at the tail: a route carrying `handlers` runs
// the chain; a route carrying `entity`/`verb` runs DB-backed CRUD. There is no
// second auth path: the chain receives the already-admitted principal and never
// re-gates.
//
// The handler sees an Express-like (req, res, next):
//   req.body / req.params / req.query
//   res.status(n).json(obj) / res.json(obj) / res.sendStatus(n) / res.send(s)
//   next(err)        — defers to the single error renderer
//   next({status, message}) — a DELIBERATE client error rendered with that status
//
// Fail-closed default: an imperative route with no leading gate inherits
// requireUser(), so anonymous is denied 401. `open` is the explicit opt-out.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import expressPlus, { router, open } from '../src/index.mjs';

// Start a server on an ephemeral port and return { origin, close }.
async function listen(app) {
  const server = app.listen(0);
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

test('an open imperative GET runs its handler and returns res.json', async () => {
  const r = router();
  r.get('/ping', open(), (req, res) => res.json({ pong: true }));
  const app = expressPlus().use('/api', r);
  const { origin, close } = await listen(app);
  try {
    const res = await fetch(`${origin}/api/ping`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { pong: true });
  } finally {
    await close();
  }
});

test('res.status(n).json(obj) sets the status code', async () => {
  const r = router();
  r.post('/things', open(), (req, res) => res.status(201).json({ created: true }));
  const app = expressPlus().use('/api', r);
  const { origin, close } = await listen(app);
  try {
    const res = await fetch(`${origin}/api/things`, { method: 'POST' });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { created: true });
  } finally {
    await close();
  }
});

test('res.sendStatus(204) ends with no body', async () => {
  const r = router();
  r.delete('/things/:id', open(), (req, res) => res.sendStatus(204));
  const app = expressPlus().use('/api', r);
  const { origin, close } = await listen(app);
  try {
    const res = await fetch(`${origin}/api/things/abc`, { method: 'DELETE' });
    assert.equal(res.status, 204);
    assert.equal(await res.text(), '');
  } finally {
    await close();
  }
});

test('req.params binds the path parameter; req.query the search string', async () => {
  const r = router();
  r.get('/things/:id', open(), (req, res) =>
    res.json({ id: req.params.id, q: req.query.q ?? null }),
  );
  const app = expressPlus().use('/api', r);
  const { origin, close } = await listen(app);
  try {
    const res = await fetch(`${origin}/api/things/xyz?q=hi`);
    assert.deepEqual(await res.json(), { id: 'xyz', q: 'hi' });
  } finally {
    await close();
  }
});

test('req.body is the parsed JSON payload for a POST', async () => {
  const r = router();
  r.post('/echo', open(), (req, res) => res.json({ echo: req.body }));
  const app = expressPlus().use('/api', r);
  const { origin, close } = await listen(app);
  try {
    const res = await fetch(`${origin}/api/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'ada' }),
    });
    assert.deepEqual(await res.json(), { echo: { name: 'ada' } });
  } finally {
    await close();
  }
});

// --- the route gate is the only auth layer for an imperative route -----------

test('an imperative route with no leading gate denies anonymous with 401 (fail closed)', async () => {
  const r = router();
  // no `open` → inherits requireUser(); no principal source → anonymous → 401
  r.get('/secret', (req, res) => res.json({ secret: true }));
  const app = expressPlus().use('/api', r);
  const { origin, close } = await listen(app);
  try {
    const res = await fetch(`${origin}/api/secret`);
    assert.equal(res.status, 401);
  } finally {
    await close();
  }
});

// --- next(err) and next({status, message}) reach the error renderer ----------

test('next({status, message}) renders a deliberate client error with that status', async () => {
  const r = router();
  r.post('/login', open(), (req, res, next) =>
    next({ status: 401, message: 'bad credentials' }),
  );
  const app = expressPlus().use('/api', r);
  const { origin, close } = await listen(app);
  try {
    const res = await fetch(`${origin}/api/login`, { method: 'POST' });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, 'bad credentials');
  } finally {
    await close();
  }
});

test('a thrown exception in a handler renders an opaque 500 (no leaked message in prod)', async () => {
  const r = router();
  r.get('/boom', open(), () => {
    throw new Error('secret internal detail');
  });
  // env defaults to config.env; force production semantics via a listen option.
  const app = expressPlus().use('/api', r);
  const { origin, close } = await (async () => {
    const server = app.listen(0, { env: 'production' });
    await new Promise((resolve) => {
      if (server.httpServer.listening) resolve();
      else server.httpServer.once('listening', resolve);
    });
    const { port } = server.httpServer.address();
    return {
      origin: `http://127.0.0.1:${port}`,
      close: () => new Promise((rr) => server.httpServer.close(rr)),
    };
  })();
  try {
    const res = await fetch(`${origin}/api/boom`);
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.error, 'internal error');
    assert.equal(body.message, undefined, 'no leaked internal message in prod');
  } finally {
    await close();
  }
});

// --- middleware in the chain runs before the final handler -------------------

test('chain middleware runs in order and can short-circuit via next(err)', async () => {
  const r = router();
  const reject = (req, res, next) => next({ status: 403, message: 'nope' });
  const never = (req, res) => res.json({ reached: true });
  r.get('/guarded', open(), reject, never);
  const app = expressPlus().use('/api', r);
  const { origin, close } = await listen(app);
  try {
    const res = await fetch(`${origin}/api/guarded`);
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'nope');
  } finally {
    await close();
  }
});

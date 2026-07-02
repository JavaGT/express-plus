// Phase 2 — slice A: the imperative router surface over the live HTTP transport
// (SPEC §3, §4).
//
// An imperative route is a hand-written handler chain: `r.post('/', allowAnonymous(), fn)`.
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
// requireUser(), so anonymous is denied 401. `allowAnonymous()` is the explicit opt-out.

import { allowAnonymous } from '../src/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import workbench, { router } from '../src/internal.mjs';

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

test('an anonymous imperative GET runs its handler and returns res.json', async () => {
  const r = router();
  r.get('/ping', allowAnonymous(), (req, res) => res.json({ pong: true }));
  const app = workbench().mount('/api', r);
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
  r.post('/things', allowAnonymous(), (req, res) => res.status(201).json({ created: true }));
  const app = workbench().mount('/api', r);
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
  r.delete('/things/:id', allowAnonymous(), (req, res) => res.sendStatus(204));
  const app = workbench().mount('/api', r);
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
  r.get('/things/:id', allowAnonymous(), (req, res) =>
    res.json({ id: req.params.id, q: req.query.q ?? null }),
  );
  const app = workbench().mount('/api', r);
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
  r.post('/echo', allowAnonymous(), (req, res) => res.json({ echo: req.body }));
  const app = workbench().mount('/api', r);
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

test('req.body parses urlencoded form fields for imperative POST', async () => {
  const r = router();
  r.post('/echo-form', allowAnonymous(), (req, res) => res.json({ echo: req.body }));
  const app = workbench().mount('/api', r);
  const { origin, close } = await listen(app);
  try {
    const res = await fetch(`${origin}/api/echo-form`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'title=Scope+notes&tag=one&tag=two&empty=',
    });
    assert.deepEqual(await res.json(), {
      echo: { title: 'Scope notes', tag: ['one', 'two'], empty: '' },
    });
  } finally {
    await close();
  }
});

test('form fields named __proto__ remain ordinary own fields', async () => {
  const r = router();
  r.post('/safe-form', allowAnonymous(), (req, res) =>
    res.json({
      own: Object.prototype.hasOwnProperty.call(req.body, '__proto__'),
      value: req.body.__proto__,
      polluted: {}.polluted ?? null,
    }),
  );
  const app = workbench().mount('/api', r);
  const { origin, close } = await listen(app);
  try {
    const res = await fetch(`${origin}/api/safe-form`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: '__proto__=plain&polluted=nope',
    });
    assert.deepEqual(await res.json(), {
      own: true,
      value: 'plain',
      polluted: null,
    });
    assert.equal({}.polluted, undefined);
  } finally {
    await close();
  }
});

test('req.body parses multipart text fields and file parts for imperative POST', async () => {
  const r = router();
  r.post('/upload', allowAnonymous(), (req, res) => {
    res.json({
      title: req.body.title,
      file: {
        name: req.body.photo.name,
        filename: req.body.photo.filename,
        type: req.body.photo.type,
        size: req.body.photo.size,
        text: req.body.photo.content.toString('utf8'),
      },
    });
  });
  const app = workbench().mount('/api', r);
  const { origin, close } = await listen(app);
  const boundary = 'workbench-test-boundary';
  const body = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="title"',
    '',
    'Summer photo',
    `--${boundary}`,
    'Content-Disposition: form-data; name="photo"; filename="hello.txt"',
    'Content-Type: text/plain',
    '',
    'hello upload',
    `--${boundary}--`,
    '',
  ].join('\r\n');

  try {
    const res = await fetch(`${origin}/api/upload`, {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      title: 'Summer photo',
      file: {
        name: 'photo',
        filename: 'hello.txt',
        type: 'text/plain',
        size: 12,
        text: 'hello upload',
      },
    });
  } finally {
    await close();
  }
});

test('imperative routes reject unsupported request body content types', async () => {
  const r = router();
  r.post('/echo-text', allowAnonymous(), (req, res) => res.json({ echo: req.body }));
  const app = workbench().mount('/api', r);
  const { origin, close } = await listen(app);
  try {
    const res = await fetch(`${origin}/api/echo-text`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'hello',
    });
    assert.equal(res.status, 415);
  } finally {
    await close();
  }
});

// --- the route gate is the only auth layer for an imperative route -----------

test('an imperative route with no leading gate denies anonymous with 401 (fail closed)', async () => {
  const r = router();
  // no `allowAnonymous()` → inherits requireUser(); no principal source → anonymous → 401
  r.get('/secret', (req, res) => res.json({ secret: true }));
  const app = workbench().mount('/api', r);
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
  r.post('/login', allowAnonymous(), (req, res, next) =>
    next({ status: 401, message: 'bad credentials' }),
  );
  const app = workbench().mount('/api', r);
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
  r.get('/boom', allowAnonymous(), () => {
    throw new Error('secret internal detail');
  });
  // env defaults to config.env; force production semantics via a listen option.
  const app = workbench().mount('/api', r);
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
  r.get('/guarded', allowAnonymous(), reject, never);
  const app = workbench().mount('/api', r);
  const { origin, close } = await listen(app);
  try {
    const res = await fetch(`${origin}/api/guarded`);
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'nope');
  } finally {
    await close();
  }
});

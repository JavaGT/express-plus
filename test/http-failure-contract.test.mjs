// Canonical HTTP failure contract: {ok:false, failure:{category,message,details?}}.

import { allowAnonymous, statusForFailure } from '../src/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import workbench, { entity, router } from '../src/internal.mjs';
import { failureForHttpError } from '../src/http-failure.mjs';

// --- helpers ----------------------------------------------------------------

test('HTTP errors map every supported status and preserve structured details', () => {
  const statuses = [400, 401, 403, 404, 405, 409, 413, 415, 429, 503];
  const categories = [
    'invalid-input', 'denied', 'denied', 'not-found', 'invalid-input',
    'conflict', 'invalid-input', 'invalid-input', 'conflict', 'conflict',
  ];

  assert.deepEqual(
    statuses.map((status) => failureForHttpError({
      status,
      message: `status ${status}`,
      details: { status },
    })),
    categories.map((category, index) => ({
      category,
      message: `status ${statuses[index]}`,
      details: { status: statuses[index] },
    })),
  );
});

function ownedNote() {
  return entity('Note', {
    body: 'a', owner: 'b',
    grant: () => [],
  });
}

function makePublicListNote() {
  return entity('Note', {
    body: 'a', owner: 'b',
    grant: () => [],
    gate: { list: allowAnonymous(), create: allowAnonymous() },
  });
}

function makePublicNote() {
  return entity('Note', {
    body: 'a', owner: 'b',
    grant: () => [],
    gate: { list: allowAnonymous(), create: allowAnonymous(), read: allowAnonymous() },
  });
}

async function serve(t, app, options = {}) {
  app.listen(0, options);
  await new Promise((resolve) => {
    if (app.httpServer.listening) resolve();
    else app.httpServer.once('listening', resolve);
  });
  t.after(() => app.shutdown());
  const { port } = app.httpServer.address();
  return { origin: `http://127.0.0.1:${port}` };
}

// --- 1. canonical failure body shape ----------------------------------------

test('a handler error renders as {ok:false, failure:{category,message}}', async (t) => {
  const r = router();
  r.get('/fail', allowAnonymous(), (req, res, next) =>
    next({ status: 403, message: 'not allowed' }),
  );
  const app = workbench().mount('/api', r);
  const { origin } = await serve(t, app);

  const res = await fetch(`${origin}/api/fail`);
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.ok(body.failure, 'response has failure object');
  assert.equal(body.failure.category, 'denied');
  assert.equal(body.failure.message, 'not allowed');
});

// --- 2. category-derived default HTTP statuses ------------------------------

test('each failure category maps to its canonical HTTP status', async (t) => {
  const r = router();

  const categories = [
    { status: 400, category: 'invalid-input', message: 'bad input' },
    { status: 403, category: 'denied', message: 'denied' },
    { status: 404, category: 'not-found', message: 'missing' },
    { status: 409, category: 'conflict', message: 'conflict' },
    { status: 500, category: 'internal', message: 'error', publicMessage: 'Internal error.' },
  ];

  for (const { status, category, message } of categories) {
    r.get(`/cat-${category}`, allowAnonymous(), (req, res, next) =>
      next({ status, message }),
    );
  }

  const app = workbench().mount('/api', r);
  const { origin } = await serve(t, app);

  for (const { status, category, message, publicMessage = message } of categories) {
    const res = await fetch(`${origin}/api/cat-${category}`);
    assert.equal(res.status, status, `status ${status} for category ${category}`);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.failure.category, category);
    // message is visible because this is a deliberate client error
    assert.equal(body.failure.message, publicMessage);
  }
});

// --- 3. route-gate 401 retains denied category ------------------------------

test('route-gate 401 response includes failure body with denied category', async (t) => {
  const app = workbench().mount('/notes', ownedNote());
  const { origin } = await serve(t, app);

  const res = await fetch(`${origin}/notes`);
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.failure.category, 'denied');
  assert.equal(body.failure.message, 'unauthorized');
});

// --- 4. oversized body 415 retains invalid-input category --------------------

test('oversized body 413 response includes failure body with invalid-input category', async (t) => {
  const app = workbench().mount('/notes', makePublicListNote());
  const { origin } = await serve(t, app);

  const huge = JSON.stringify({ body: 'x'.repeat(1_000_001) });
  const res = await fetch(`${origin}/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: huge,
  });
  assert.equal(res.status, 413);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.failure.category, 'invalid-input');
  assert.ok(body.failure.message.length > 0);
});

// --- 5. unsupported content-type 415 retains invalid-input category ----------

test('unsupported content-type 415 response includes failure body', async (t) => {
  const app = workbench().mount('/notes', makePublicNote());
  const { origin } = await serve(t, app);

  const res = await fetch(`${origin}/notes`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: 'hello',
  });
  assert.equal(res.status, 415);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.failure.category, 'invalid-input');
  assert.ok(body.failure.message.length > 0);
});

// --- 6. rate-limit 429 retains conflict category ----------------------------

test('rate-limit 429 response includes failure body with conflict category', async (t) => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db });
  app.mount('/notes', ownedNote());
  await app.ddl();
  app.listen(0, {
    principalOf: () => ({ id: 'u1' }),
    rateLimit: { ip: { windowMs: 60_000, max: 0 } },
  });
  await app.ready;
  t.after(() => { app.shutdown(); db.close(); });
  const port = app.httpServer.address().port;
  const base = `http://127.0.0.1:${port}`;

  const res = await fetch(`${base}/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'x' }),
  });
  assert.equal(res.status, 429);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.failure.category, 'conflict');
  assert.equal(body.failure.details.retryAfterMs > 0, true);
  assert.equal(body.failure.message, 'rate limit exceeded');
});

// --- 7. service-unavailable 503 retains conflict category -------------------

test('503 response includes failure body with conflict category', async (t) => {
  const r = router();
  r.get('/busy', allowAnonymous(), (req, res, next) =>
    next({ status: 503, message: 'service busy' }),
  );
  const app = workbench().mount('/api', r);
  const { origin } = await serve(t, app);

  const res = await fetch(`${origin}/api/busy`);
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.failure.category, 'conflict');
  assert.equal(body.failure.message, 'service busy');
});

// --- 8. unexpected errors sanitized even in development ---------------------

test('unexpected error renders sanitized {ok:false, failure} in development', async (t) => {
  const r = router();
  r.get('/crash', allowAnonymous(), () => {
    throw new Error('secret db password leaked');
  });
  const app = workbench().mount('/api', r);
  const { origin } = await serve(t, app, { env: 'development' });

  const res = await fetch(`${origin}/api/crash`);
  assert.equal(res.status, 500);
  const body = await res.json();
  // Must still be the canonical shape — no top-level message/stack even in dev
  assert.equal(body.ok, false);
  assert.equal(body.failure.category, 'internal');
  assert.equal(body.failure.message, 'Internal error.');
  // Sanitized: no leaked original message or stack in the public JSON
  assert.equal(body.message, undefined, 'no leaked message at top level in dev');
  assert.equal(body.stack, undefined, 'no leaked stack at top level in dev');
  // The internal message must not appear ANYWHERE in the JSON
  assert.ok(
    !JSON.stringify(body).includes('secret db password leaked'),
    'original error message not present in dev response',
  );
});

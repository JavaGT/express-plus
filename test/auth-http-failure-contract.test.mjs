import { test } from 'node:test';
import assert from 'node:assert/strict';

import { allowAnonymous, failure } from '../build/index.mjs';
import workbench, { router } from '../build/internal.mjs';

async function serve(t, app) {
  app.listen(0);
  await app.ready;
  t.after(() => app.shutdown());
  const { port } = app.httpServer.address();
  return `http://127.0.0.1:${port}`;
}

async function postLogin(origin, body) {
  const response = await fetch(`${origin}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('auth validation uses the canonical invalid-input failure', async (t) => {
  const origin = await serve(t, workbench({ db: ':memory:' }).auth());

  assert.deepEqual(await postLogin(origin, {}), {
    status: 400,
    body: {
      ok: false,
      failure: {
        category: 'invalid-input',
        message: 'username and password are required',
      },
    },
  });
});

test('bad credentials use the canonical denied failure', async (t) => {
  const origin = await serve(t, workbench({ db: ':memory:' }).auth());
  await postLogin(origin, { username: 'alice', password: 'right' });

  assert.deepEqual(await postLogin(origin, { username: 'alice', password: 'wrong' }), {
    status: 401,
    body: {
      ok: false,
      failure: { category: 'denied', message: 'bad credentials' },
    },
  });
});

test('a bare WorkbenchFailure is deliberate and is not logged as unexpected', async (t) => {
  const logMessages = [];
  const routes = router();
  routes.get('/deny', allowAnonymous(), (_req, _res, next) => {
    next(failure('denied', 'not allowed'));
  });
  const app = workbench({
    log: {
      level: 'error',
      output: (_level, channel, message) => logMessages.push({ channel, message }),
    },
  }).mount('/api', routes);
  const origin = await serve(t, app);
  const response = await fetch(`${origin}/api/deny`);

  assert.deepEqual({
    status: response.status,
    body: await response.json(),
    logMessages,
  }, {
    status: 403,
    body: {
      ok: false,
      failure: { category: 'denied', message: 'not allowed' },
    },
    logMessages: [],
  });
});

test('a numeric internal error is sanitized and logged as unexpected', async (t) => {
  const logMessages = [];
  const routes = router();
  routes.get('/explode', allowAnonymous(), (_req, _res, next) => {
    next({ status: 500, message: 'database password leaked' });
  });
  const app = workbench({
    log: {
      level: 'error',
      output: (_level, channel, message) => logMessages.push({ channel, message }),
    },
  }).mount('/api', routes);
  const origin = await serve(t, app);
  const response = await fetch(`${origin}/api/explode`);

  assert.deepEqual({
    status: response.status,
    body: await response.json(),
    logMessages,
  }, {
    status: 500,
    body: {
      ok: false,
      failure: { category: 'internal', message: 'Internal error.' },
    },
    logMessages: [{ channel: 'http', message: 'request failed' }],
  });
});

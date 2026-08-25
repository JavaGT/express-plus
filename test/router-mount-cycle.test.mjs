// Hardening: circular router mounts fail loudly at resolution (#164) instead of
// deadlocking listen() on a never-settling resolution promise.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeMountable } from '../build/router.mjs';

test('mutually mounted routers reject resolveRoutes with the mount chain', async () => {
  const a = makeMountable();
  const b = makeMountable();
  a.mount('/b', b);
  b.mount('/a', a);

  await assert.rejects(
    () => a.resolveRoutes(),
    (error) => {
      assert.match(error.message, /^circular mount detected:/);
      // The chain names all three hops: a → b → a.
      assert.match(error.message, /router:\d+ → router:\d+ → router:\d+/);
      assert.match(error.message, /at mount path '\/a'/);
      return true;
    },
  );
});

test('a router mounted into itself throws instead of hanging', async () => {
  const a = makeMountable();
  a.mount('/self', a);

  await assert.rejects(
    () => a.resolveRoutes(),
    /circular mount detected: (router:\d+) → \1/,
  );
});

test('resolution state is cleaned up after a failed resolution (retry still errors, no stale stack)', async () => {
  const a = makeMountable();
  const b = makeMountable();
  a.mount('/b', b);
  b.mount('/a', a);

  await assert.rejects(() => a.resolveRoutes(), /circular mount detected/);
  await assert.rejects(() => a.resolveRoutes(), /circular mount detected/);
});

test('non-cyclic diamonds still resolve (shared child mounted twice)', async () => {
  const app = makeMountable();
  const shared = makeMountable();
  shared.get('/ping', () => {});
  app.mount('/one', shared);
  app.mount('/two', shared);

  const routes = await app.resolveRoutes();
  assert.deepEqual(routes.map((route) => route.path).sort(), ['/one/ping', '/two/ping']);
});

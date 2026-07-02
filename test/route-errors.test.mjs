// Hardening: route error edges — mount-after-resolve, broken thunk, idempotent.
import { text, grant, read } from '../src/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import workbench, { entity } from '../src/internal.mjs';

test('mount after resolveRoutes throws', async () => {
  const E = entity('E', { fields: { x: text() }, grant: () => grant(read) });
  const app = workbench().mount('/e', E);
  await app.resolveRoutes();
  assert.throws(
    () => app.mount('/f', E),
    /cannot mount after routes are resolved/,
  );
});

test('mount after listen throws', async () => {
  const E = entity('E', { fields: { x: text() }, grant: () => grant(read) });
  const app = workbench().mount('/e', E);
  app.listen(0);
  await app.ready;
  assert.throws(
    () => app.mount('/f', E),
    /cannot mount after routes are resolved/,
  );
  app.httpServer.close();
});

test('broken routes thunk throws at resolveRoutes', async () => {
  const E = entity('E', {
    fields: { x: text() },
    grant: () => grant(read),
    routes: () => { throw new Error('broken'); },
  });
  const app = workbench().mount('/e', E);
  await assert.rejects(
    () => app.resolveRoutes(),
    /broken/,
  );
});

test('double resolveRoutes is idempotent', async () => {
  const E = entity('E', { fields: { x: text() }, grant: () => grant(read) });
  const app = workbench().mount('/e', E);
  const r1 = await app.resolveRoutes();
  const r2 = await app.resolveRoutes();
  assert.equal(r1, r2, 'second resolve returns the same routes');
  assert.equal(r1.length, 5);
});

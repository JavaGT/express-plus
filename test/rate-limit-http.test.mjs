// Priority 4 — rate-limiting wired into the request stack (opt-in). An app that
// declares `listen(port, {rateLimit:{ip:{windowMs,max}}})` gets a per-IP fixed
// window before the route gate; the Nth+1 request within the window is 429 with
// a Retry-After. Off by default (limits are app-specific; a forbidden request
// already returns before the kernel so it never held the write lock). The bare
// module is covered by test/rate-limit.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import expressPlus, {
  entity, text, ref, scope, grant, read, write, subscribe,
} from '../src/index.mjs';

function ownedNote() {
  return entity('Note', {
    fields: { body: text(), owner: ref('User', { role: 'owner', readonly: true }) },
    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read)),
    ],
  });
}

test('rate-limit (opt-in): the Nth+1 request in the window is 429 with Retry-After', async (t) => {
  const db = new DatabaseSync(':memory:');
  const app = expressPlus({ db });
  app.mount('/notes', ownedNote());
  await app.ddl();
  app.listen(0, {
    principalOf: () => ({ id: 'u1' }),
    rateLimit: { ip: { windowMs: 60_000, max: 3 } },
  });
  await app.ready;
  const port = app.httpServer.address().port;
  const base = `http://127.0.0.1:${port}`;
  t.after(() => { app.httpServer.close(); db.close(); });

  async function post() {
    return fetch(`${base}/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'x' }),
    });
  }

  const within = await Promise.all([post(), post(), post()]);
  assert.deepEqual(within.map((r) => r.status), [201, 201, 201], 'first 3 allowed');

  const over = await post();
  assert.equal(over.status, 429);
  assert.ok(over.headers.get('retry-after'), 'Retry-After header set');
  const body = await over.json();
  assert.equal(body.error, 'rate limit exceeded');
});

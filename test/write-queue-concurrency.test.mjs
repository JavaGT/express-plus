// Priority 4 — the writeQueue serializes concurrent in-flight mutations (D9,
// eng-review spec #6). A durable dispatch holds BEGIN→…→COMMIT open across an
// async afterProjection admission step (the in-txn create row-grant); without a
// single-writer mutex, a second concurrent mutation would BEGIN on the open
// connection → "cannot start a transaction within a transaction" → 500. With the
// writeQueue, the second waits for the first to COMMIT, then proceeds. This is
// the integration guard over the already-unit-tested write-queue module.

import { text, ref, scope, grant, read, write, subscribe } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  entity } from '../build/internal.mjs';

function ownedNote() {
  return entity('Note', {
        body: text(),
    owner: ref('User', { role: 'owner', readonly: true }),

    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read)),
    ],
  });
}

test('writeQueue: concurrent in-flight creates all commit (no BEGIN-on-open-txn 500)', async (t) => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db });
  app.mount('/notes', ownedNote());
  await app.ddl();
  app.listen(0, { principalOf: () => ({ id: 'u1' }) });
  await app.ready;
  const port = app.httpServer.address().port;
  const base = `http://127.0.0.1:${port}`;
  t.after(() => { app.httpServer.close(); db.close(); });

  const N = 8;
  const responses = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      fetch(`${base}/notes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: `concurrent-${i}` }),
      }),
    ),
  );
  const statuses = responses.map((r) => r.status);
  assert.deepEqual(statuses, Array(N).fill(201), `all ${N} concurrent creates commit; got ${JSON.stringify(statuses)}`);

  const ids = await Promise.all(responses.map((r) => r.json().then((b) => b.id)));
  assert.equal(new Set(ids).size, N, 'each create minted a distinct id');

  const rows = db.prepare("SELECT * FROM _Log WHERE eventType = 'Note.created'").all();
  assert.equal(rows.length, N, 'every concurrent create appended a committed event');
});

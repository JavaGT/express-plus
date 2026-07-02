// Dispatch re-entry via hydrated handle .set() does not deadlock.
// A custom route handler under /:docId/... calling req.doc.collaborators.set(...)
// re-enters writeQueue.run through the dispatchRef. The re-entry hits the
// fast-path (running=false, waiters=0) and completes without deadlock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import workbench, { entity, text, ref, map, grant, read, write, scope, generateDDL } from '../src/index.mjs';

function makeDoc() {
  return entity('Doc', {
    fields: {
      title: text(),
      owner: ref('User', { role: 'owner', readonly: true }),
      collaborators: map(ref('User'), { role: ['viewer', 'editor'] }),
    },
    grant: () => [
      scope(({ is }) => is.owner()).can(() => grant(read, write)),
    ],
    routes: (r) => {
      r.resource();
      // Custom handler under /:docId/collab — req.doc is auto-loaded.
      const collab = workbench.router();
      collab.post('/add-viewer', async (req, res) => {
        // This .set re-enters dispatch via dispatchRef, wrapped in writeQueue.run.
        // Since custom handlers run OUTSIDE writeQueue.run (src/serve.mjs:900),
        // this is a fresh re-entry hitting the fast-path.
        await req.doc.collaborators.set('u2', { role: 'viewer' });
        res.json({ added: 'u2' });
      });
      r.use('/:docId/collab', collab);
    },
  });
}

test('custom handler .set() re-entry completes without deadlock', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS User (id TEXT PRIMARY KEY, username TEXT, password TEXT)');
  const Doc = makeDoc();
  for (const sql of generateDDL(Doc)) db.exec(sql);
  // Seed a doc owned by u1
  db.prepare("INSERT INTO Doc (id, title, owner) VALUES ('d1', 'Test Doc', 'u1')").run();

  const app = workbench({ db }).mount('/docs', Doc);
  app.listen(0, { principalOf: () => ({ id: 'u1' }) });
  await app.ready;
  const port = app.httpServer.address().port;
  const base = `http://127.0.0.1:${port}`;
  t.after(() => { app.httpServer.close(); db.close(); });

  // Timeout wrapper: if the handler deadlocks, this fails the test.
  const timeoutMs = 2000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${base}/docs/d1/collab/add-viewer`, {
      method: 'POST',
      signal: controller.signal,
    });

    clearTimeout(timeout);
    assert.equal(response.status, 200, 'handler should complete without deadlock');

    const body = await response.json();
    assert.equal(body.added, 'u2');

    // Verify the side-table row exists (the mutation landed).
    const row = db.prepare(
      `SELECT * FROM Doc_collaborators WHERE Doc_id = :docId AND member_id = :member`,
    ).get({ docId: 'd1', member: 'u2' });

    assert.ok(row, 'side-table should have the inserted row');
    assert.equal(row.role, 'viewer');
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      assert.fail(`handler did not complete within ${timeoutMs}ms — possible deadlock`);
    }
    throw err;
  }
});

test('custom handler .set() re-entry with held writeQueue lock completes after release', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS User (id TEXT PRIMARY KEY, username TEXT, password TEXT)');
  const Doc = makeDoc();
  for (const sql of generateDDL(Doc)) db.exec(sql);
  db.prepare("INSERT INTO Doc (id, title, owner) VALUES ('d2', 'Test Doc 2', 'u1')").run();

  const app = workbench({ db }).mount('/docs', Doc);
  app.listen(0, { principalOf: () => ({ id: 'u1' }) });
  await app.ready;
  const port = app.httpServer.address().port;
  const base = `http://127.0.0.1:${port}`;
  t.after(() => { app.httpServer.close(); db.close(); });

  // Hold the writeQueue lock with a long-running task.
  let releaseHold;
  const holdPromise = app.writeQueue.run(() => new Promise((resolve) => {
    releaseHold = resolve;
  }));

  // Timeout guard: a real regression (re-entry waiting on a lock it already holds)
  // would hang the suite — this turns a hang into a test failure.
  const timeoutMs = 2000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  // Fire the custom handler request while the lock is held.
  // It should wait, not deadlock, and complete after we release.
  const requestPromise = fetch(`${base}/docs/d2/collab/add-viewer`, {
    method: 'POST',
    signal: controller.signal,
  }).then(async (r) => {
    assert.equal(r.status, 200, 'handler should complete after lock release');
    return r.json();
  });

  // Give the request a moment to queue up, then release the hold.
  await new Promise((r) => setTimeout(r, 50));
  releaseHold();
  await holdPromise;

  // Now the request should complete.
  let body;
  try {
    body = await requestPromise;
    clearTimeout(timeout);
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      assert.fail(`handler did not complete within ${timeoutMs}ms — possible deadlock under contention`);
    }
    throw err;
  }
  assert.equal(body.added, 'u2');

  // Verify the side-table row exists.
  const row = db.prepare(
    `SELECT * FROM Doc_collaborators WHERE Doc_id = :docId AND member_id = :member`,
  ).get({ docId: 'd2', member: 'u2' });

  assert.ok(row, 'side-table should have the inserted row');
  assert.equal(row.role, 'viewer');
});

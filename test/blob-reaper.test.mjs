// Priority 2 reaper (finding #3, eng-review spec #10, consult #17). The blob
// store's `reap()` is a WRITER: it DELETEs BlobStore rows and unlinks files. A
// dispatch's transaction spans an `await` (the async `mayVerb`), so a sync reaper
// firing during that yield would race the adopt/finalize in flight — deleting a
// row the dispatch just adopted, or unlinking a file mid-finalize. The reaper must
// therefore run under the writeQueue mutex (the same single-writer lock dispatch
// uses), so a sweep and a mutation can NEVER interleave. The framework owns this
// (app.blobs is auto-built on db-engaged and POST /blobs is always live, so an
// abandoned upload leaks .pending forever with no operator lever — fail-closed
// default baked into the framework, not an app responsibility).

import { text, ref, blob, scope, grant, read, write, subscribe } from '../src/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import workbench, {
  entity } from '../src/internal.mjs';

function photoNote() {
  return entity('Note', {
        body: text(),
    photo: blob(),
    owner: ref('User', { role: 'owner', readonly: true }),

    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read)),
    ],
  });
}

async function harness(t, options = {}, beforeStart = () => {}) {
  const db = new DatabaseSync(':memory:');
  const root = mkdtempSync(path.join(tmpdir(), 'express-blobreap-'));
  const app = workbench({ db, blobs: { root }, ...options });
  app.mount('/notes', photoNote());
  await app.ddl();
  beforeStart(app);
  app.listen(0, { principalOf: () => ({ id: 'u1' }) });
  await app.ready;
  t.after(async () => {
    await app.shutdown();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { app, db, root };
}

// Backdate a pending blob's createdAt so the orphan sweep treats it as abandoned.
function backdate(db, id, agoMs) {
  db.prepare('UPDATE BlobStore SET createdAt = ? WHERE id = ?').run(
    new Date(Date.now() - agoMs).toISOString(),
    id,
  );
}

test('blob reaper sweeps stale orphan .pending blobs', async (t) => {
  const { app, db, root } = await harness(t);
  const up = app.blobs.upload({ bytes: Buffer.from('orphaned upload'), id: 'orph1' });
  assert.ok(existsSync(path.join(root, 'orph1.pending')), 'the .pending file landed');
  backdate(db, 'orph1', 2 * 3600_000); // older than the default 1h TTL

  await app.sweepBlobs();

  assert.ok(!existsSync(path.join(root, 'orph1.pending')), 'the .pending file was reaped');
  assert.ok(!app.blobs.stat('orph1'), 'the BlobStore row was reaped');
});

test('blob reaper TTL is configured when the application is constructed', async (t) => {
  const { app, db, root } = await harness(t, { blobReapTtlMs: 10 });
  app.blobs.upload({ bytes: Buffer.from('short-lived orphan'), id: 'orph-override' });
  backdate(db, 'orph-override', 20);

  await app.sweepBlobs();

  assert.ok(!existsSync(path.join(root, 'orph-override.pending')));
  assert.ok(!app.blobs.stat('orph-override'));
});

test('application runtime registers the construction-level blob reaper interval', async (t) => {
  const registrations = [];
  const { app } = await harness(
    t,
    { blobReapIntervalMs: 1234 },
    (runtime) => {
      const add = runtime.clock.add;
      runtime.clock.add = (watcher) => {
        registrations.push(watcher);
        return add(watcher);
      };
    },
  );

  assert.equal(registrations.find((watcher) => watcher.name === 'blob-reaper')?.intervalMs, 1234);
  assert.equal(app.ready, app.start());
});

test('blob reaper runs under the writeQueue mutex — waits for an in-flight dispatch', async (t) => {
  const { app, db, root } = await harness(t);
  const up = app.blobs.upload({ bytes: Buffer.from('orphaned upload'), id: 'orph2' });
  backdate(db, 'orph2', 2 * 3600_000);

  // Hold the writeQueue — a stand-in for an in-flight dispatch whose txn spans an
  // await. The reaper must WAIT; a sync reap firing mid-txn would race the
  // adopt/finalize in flight (eng-review spec #10 — the reaper acquires the mutex).
  let releaseDispatch;
  const held = app.writeQueue.run(() => new Promise((r) => { releaseDispatch = r; }));
  for (let i = 0; i < 1000 && !releaseDispatch; i++) {
    await new Promise((r) => setImmediate(r));
  }
  assert.ok(releaseDispatch, 'the writeQueue lock is held by the in-flight dispatch');

  let swept = false;
  const sweepP = app.sweepBlobs().then(() => { swept = true; });
  for (let i = 0; i < 100 && !swept; i++) {
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(swept, false, 'the reaper waits for the writeQueue mutex');
  assert.ok(existsSync(path.join(root, 'orph2.pending')), 'the orphan is NOT reaped while the lock is held');

  releaseDispatch();
  await held;
  await sweepP;
  assert.equal(swept, true, 'the reaper ran once the writeQueue released');
  assert.ok(!existsSync(path.join(root, 'orph2.pending')), 'the orphan was reaped after release');
});

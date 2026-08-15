// blob-low-disk.test.mjs — S6/A5 low-disk guard (workbench#94 #27): new
// uploads are refused before free-disk headroom can compromise database
// durability. The threshold is configurable and the guard FAILS CLOSED when a
// durable byte store cannot declare free space.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { generateFrameworkDDL } from '../build/ddl.mjs';
import { memoryBlobs } from '../build/memory-blobs.mjs';
import { BLOB_STORAGE_UNDER_DISK_LIMIT } from '../build/blob-store.mjs';
import workbench from '../build/index.mjs';

// A fake DURABLE byte store with a controllable free-space probe (the memory
// backend is ephemeral, so the guard would otherwise skip it). This is what an
// S3-compatible backend would look like: durable bytes + a freeBytes() probe.
function durableStoreWithFree(free, { hasFreeBytes = true, durability = 'durable' } = {}) {
  const memory = memoryBlobs();
  const store = { ...memory };
  store.capabilities = { ...memory.capabilities, durability };
  if (hasFreeBytes) store.freeBytes = () => free;
  return store;
}

function openDb() {
  const db = new DatabaseSync(':memory:');
  for (const sql of generateFrameworkDDL()) db.exec(sql);
  return db;
}

async function makeStore(db, bytes, lowDiskHeadroomBytes) {
  const { createBlobStore } = await import('../build/blob-store.mjs');
  return createBlobStore({ db, bytes, lowDiskHeadroomBytes });
}

test('an upload is refused below the configured free-disk headroom', async () => {
  const db = openDb();
  const store = await makeStore(db, durableStoreWithFree(500), 1_000);

  assert.throws(() => store.upload({ bytes: 'too-risky' }), /BLOB_STORAGE_UNDER_DISK_LIMIT/, 'refused before the write');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM BlobStore').get().count, 0, 'no metadata row was written');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM BlobStore').get().count, 0);

  // Back above the threshold → accepted.
  const ok = durableStoreWithFree(2_000);
  const store2 = await makeStore(openDb(), ok, 1_000);
  const uploaded = store2.upload({ bytes: 'safe' });
  assert.ok(uploaded.id);
});

test('the threshold is inclusive — free space at the headroom accepts the upload', async () => {
  const store = await makeStore(openDb(), durableStoreWithFree(1_000), 1_000);
  const uploaded = store.upload({ bytes: 'exactly-at-headroom' });
  assert.ok(uploaded.id);
});

test('the guard is disabled when the headroom is zero', async () => {
  const store = await makeStore(openDb(), durableStoreWithFree(1), 0);
  const uploaded = store.upload({ bytes: 'unguarded' });
  assert.ok(uploaded.id);
});

test('a durable store that cannot declare free space fails closed (refuses uploads)', async () => {
  const store = await makeStore(openDb(), durableStoreWithFree(0, { hasFreeBytes: false }), 1_000);
  assert.throws(() => store.upload({ bytes: 'no-probe' }), /BLOB_STORAGE_UNDER_DISK_LIMIT/, 'never guesses when free space is unknowable');
});

test('an ephemeral store (memory) has no disk to guard — uploads are not refused', async () => {
  const store = await makeStore(openDb(), durableStoreWithFree(1, { durability: 'ephemeral' }), 1_000);
  const uploaded = store.upload({ bytes: 'ephemeral-bytes' });
  assert.ok(uploaded.id);
});

test('the application wires the configured threshold into the blob store', async (t) => {
  const app = workbench({
    db: ':memory:',
    blobs: durableStoreWithFree(10),
    blobLowDiskHeadroomBytes: 10_000,
  });
  await app.start();
  t.after(async () => { await app.shutdown(); });

  assert.throws(() => app.blobs.upload({ bytes: 'refused-by-app-policy' }), (err) =>
    err?.code === BLOB_STORAGE_UNDER_DISK_LIMIT, 'the app-level headroom reaches the store');
});

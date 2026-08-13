import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

import { createServer, durableMutationVariant } from '../build/pipeline.mjs';
import { createBlobStore } from '../build/blob-store.mjs';
import { executeFrameworkDDL } from '../build/ddl.mjs';

// A blobAdopter wired to an event's `photo` field — the kernel stays free of
// field knowledge; the app's wiring (here: a fixture) resolves which blob ids an
// event references.
function blobAdopterFor(store, field) {
  return {
    resolve: (ev) => ev.data && ev.data[field] ? [ev.data[field]] : [],
    adopt: (txnDb, ids) => { for (const id of ids) store.adopt(txnDb, id); },
    finalize: (id) => store.finalize(id),
  };
}

// The post-commit blob-finalize consumer — mirrors what buildKernel registers for
// a real app. finalize is a post-commit consumer now (the inline kernel call was
// retired by the fan-out registry), so a fixture test must register it.
function blobAdapterFor(adopter) {
  return {
    async adoptInTxn(txnDb, events) {
      const ids = new Set();
      for (const ev of events) for (const id of adopter.resolve(ev)) ids.add(id);
      adopter.adopt(txnDb, [...ids]);
    },
  };
}

function blobFinalizeFor(adopter) {
  return async (events) => {
    const ids = new Set();
    for (const ev of events) for (const id of adopter.resolve(ev)) ids.add(id);
    for (const id of ids) { try { adopter.finalize(id); } catch { /* reaper reconciles */ } }
  };
}

function setup(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  executeFrameworkDDL(db);
  const root = path.join(os.tmpdir(), 'express-blob-atom-' + randomUUID());
  fs.mkdirSync(root, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createBlobStore({ root, db });
  return { db, store };
}

const handlers = {
  'Note.create': ({ payload }) => [{
    type: 'Note.created',
    scope: `Note:${payload.id}`,
    data: { id: payload.id, photo: payload.photo },
  }],
};

test('a denied dispatch rolls its blob adopt back — the blob stays pending', async (t) => {
  const { db, store } = setup(t);
  const { id: blobId } = store.upload({ bytes: Buffer.from('photo-bytes'), mime: 'image/png' });
  assert.equal(store.stat(blobId).status, 'pending');

  const adopter = blobAdopterFor(store, 'photo');
  const kernel = createServer({
    handlers,
    authorize: () => true,
    db,
    pipeline: durableMutationVariant({
      blobAdapter: blobAdapterFor(adopter),
      postCommitConsumers: [blobFinalizeFor(adopter)],
      // The row-grant admission DENIES — the whole txn, including the blob adopt, rolls back.
      admission: { beforeProjection: () => true, afterProjection: () => false },
    }),
  });

  const res = await kernel.dispatch({
    actionId: randomUUID(),
    type: 'Note.create',
    payload: { id: 'n1', photo: blobId },
  });

  assert.equal(res.ok, false);
  // Atomicity boundary: the in-txn adopt was rolled back with the denial.
  assert.equal(store.stat(blobId).status, 'pending');
  assert.ok(fs.existsSync(store.pathFor(blobId, { pending: true })), '.pending file still present');
  assert.ok(!fs.existsSync(store.pathFor(blobId)), 'no final file — finalize skipped on rollback');
});

test('a successful dispatch adopts + finalizes the blob in the same commit', async (t) => {
  const { db, store } = setup(t);
  const { id: blobId } = store.upload({ bytes: Buffer.from('photo-bytes'), mime: 'image/png' });
  assert.equal(store.stat(blobId).status, 'pending');

  const adopter = blobAdopterFor(store, 'photo');
  const kernel = createServer({
    handlers,
    authorize: () => true,
    db,
    pipeline: durableMutationVariant({
      blobAdapter: blobAdapterFor(adopter),
      postCommitConsumers: [blobFinalizeFor(adopter)],
      admission: { beforeProjection: () => true, afterProjection: () => true },
    }),
  });

  const res = await kernel.dispatch({
    actionId: randomUUID(),
    type: 'Note.create',
    payload: { id: 'n2', photo: blobId },
  });

  assert.equal(res.ok, true);
  assert.equal(store.stat(blobId).status, 'adopted');
  assert.ok(!fs.existsSync(store.pathFor(blobId, { pending: true })), '.pending renamed away post-commit');
  assert.ok(fs.existsSync(store.pathFor(blobId)), 'final file exists post-commit');
});

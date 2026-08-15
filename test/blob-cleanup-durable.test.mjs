// blob-cleanup-durable.test.mjs — S6/A5 durable cleanup state (workbench#94):
// a failed byte deletion is recorded durably on the row, retried by the next
// sweep, and NEVER reported complete until the pending slot, final slot, and
// metadata row are verified gone. A failed recycle-bin routing keeps the
// generation durable for retry. Byte-store deletion and finalization stay
// idempotent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { generateFrameworkDDL } from '../build/ddl.mjs';
import { compileBlobCensus } from '../build/blob-census.mjs';

const photoCensus = compileBlobCensus({
  entities: new Map(),
  declaredBlobFields: [
    { actionName: 'Photo.upload', field: 'data', resourceField: 'id', owningResource: 'Photo', erasureCategory: 'deletable' },
  ],
});

async function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'workbench-blob-cleanup-'));
  const db = new DatabaseSync(':memory:');
  for (const sql of generateFrameworkDDL()) db.exec(sql);
  db.exec('CREATE TABLE Photo (id TEXT PRIMARY KEY, data TEXT)');
  const { createBlobStore } = await import('../build/blob-store.mjs');
  const store = createBlobStore({ root, db });
  return { root, db, store };
}

function adoptAndFinalize(db, store, id) {
  db.exec('BEGIN IMMEDIATE');
  store.adopt(db, id);
  db.exec('COMMIT');
  store.finalize(id);
}

function referencePhoto(db, photoId, generationId) {
  db.prepare('INSERT INTO Photo (id, data) VALUES (?, ?)').run(photoId, generationId);
}

// Make the final slot undeletable (a directory cannot be unlinked) so a
// verified byte removal throws — the durable-cleanup failure injection.
function makeFinalSlotUndeletable(store, id) {
  const finalPath = store._pathFor(id);
  rmSync(finalPath, { force: true });
  mkdirSync(finalPath);
}

test('a failed byte deletion records durable cleanup state and is never reported complete', async () => {
  const { root, db, store } = await setup();
  const { id } = store.upload({ bytes: 'unremovable-bytes' });
  adoptAndFinalize(db, store, id);
  makeFinalSlotUndeletable(store, id);

  const result = await store.reap({ ttl: 0, census: photoCensus });
  assert.deepStrictEqual(result, { orphans: 0, danglers: 0 }, 'a failed deletion is NOT counted as reaped (never reported complete)');

  const state = store.cleanupState(id);
  assert.ok(state, 'the row survives with durable cleanup state');
  assert.equal(state.status, 'adopted');
  assert.ok(state.cleanupError, 'the failure reason is recorded');
  assert.equal(state.cleanupAttempts, 1, 'one failed attempt is recorded');
  assert.deepStrictEqual(store.pendingCleanups(), [id], 'the id is listed as pending cleanup');
  assert.ok(store.stat(id), 'the metadata row still exists');
  rmSync(root, { recursive: true, force: true });
});

test('the next sweep retries the failed deletion and completes it once verified', async () => {
  const { root, db, store } = await setup();
  const { id } = store.upload({ bytes: 'recoverable-bytes' });
  adoptAndFinalize(db, store, id);
  makeFinalSlotUndeletable(store, id);

  await store.reap({ ttl: 0, census: photoCensus });
  assert.ok(store.stat(id), 'first attempt fails and is retained');

  // The operator clears the blocker; the durable-cleanup retry sweep finishes.
  rmSync(store._pathFor(id), { recursive: true, force: true });
  await store.reap({ ttl: 0, census: photoCensus });

  assert.equal(store.stat(id), undefined, 'the retried deletion completed');
  assert.deepStrictEqual(store.pendingCleanups(), [], 'no cleanup state remains');
  assert.ok(!existsSync(store._pathFor(id)), 'the final slot is verified gone');
  rmSync(root, { recursive: true, force: true });
});

test('a failed recycle-bin routing keeps the generation durable for the next sweep', async () => {
  const { root, db, store } = await setup();
  const { id } = store.upload({ bytes: 'bin-once' });
  adoptAndFinalize(db, store, id);

  const attempts = [];
  const flakyRecycle = {
    bin: async (deletion) => {
      attempts.push(...deletion.generations);
      if (attempts.length === 1) throw new Error('bin storage unavailable');
      return { ok: true };
    },
  };

  await store.reap({ ttl: 0, census: photoCensus, recycle: flakyRecycle });
  assert.deepStrictEqual(attempts, [id], 'the generation was routed to the bin');
  assert.ok(store.stat(id), 'a bin failure keeps the generation durable');
  assert.ok(store.cleanupState(id).cleanupError, 'the bin failure is recorded durably');
  assert.equal(store.cleanupState(id).cleanupAttempts, 1);

  await store.reap({ ttl: 0, census: photoCensus, recycle: flakyRecycle });
  assert.equal(attempts.length, 2, 'the next sweep retries the bin + deletion');
  assert.equal(store.stat(id), undefined, 'the generation was reaped once the bin succeeded');
  assert.deepStrictEqual(store.pendingCleanups(), []);
  rmSync(root, { recursive: true, force: true });
});

test('a replaced generation with a failed byte removal keeps durable cleanup state until verified', async () => {
  const { root, db, store } = await setup();
  const v1 = store.upload({ bytes: 'old-bytes', id: 'gen-old' });
  adoptAndFinalize(db, store, v1.id);
  const staged = store.replace(v1.id, { bytes: 'new-bytes' });

  db.exec('BEGIN IMMEDIATE');
  store.switchReplacement(db, v1.id, staged.id);
  db.exec('COMMIT');
  store.finalize(staged.id);
  referencePhoto(db, 'p1', staged.id); // the owning reference now points at the new generation
  db.prepare('UPDATE BlobStore SET replacedAt = ? WHERE id = ?').run(
    new Date(Date.now() - 120_000).toISOString(), v1.id,
  );
  makeFinalSlotUndeletable(store, v1.id);

  const result = await store.reap({ ttl: 0, census: photoCensus, replacedRetentionMs: 60_000 });
  assert.equal(result.danglers, 0, 'the failed removal is never reported complete');
  const state = store.cleanupState(v1.id);
  assert.equal(state.status, 'replaced', 'the replaced row survives with cleanup state');
  assert.ok(state.cleanupError);

  rmSync(store._pathFor(v1.id), { recursive: true, force: true });
  await store.reap({ ttl: 0, census: photoCensus, replacedRetentionMs: 60_000 });
  assert.equal(store.stat(v1.id), undefined, 'verified cleanup completes on the retry');
  assert.deepStrictEqual(store.pendingCleanups(), []);
  rmSync(root, { recursive: true, force: true });
});

test('byte-store deletion and finalization remain idempotent (S6/A5 #6)', async () => {
  const { root, db, store } = await setup();
  const { id } = store.upload({ bytes: 'twice-removed' });
  adoptAndFinalize(db, store, id);

  store.discard(id);
  assert.doesNotThrow(() => store.discard(id), 'a second discard is a no-op');
  assert.equal(store.stat(id), undefined);

  assert.doesNotThrow(() => store.finalize(id), 'finalize of a never-uploaded id is a no-op');
  assert.doesNotThrow(() => store.discardPending('never-staged-id'), 'discardPending of a missing row is a no-op');
  rmSync(root, { recursive: true, force: true });
});

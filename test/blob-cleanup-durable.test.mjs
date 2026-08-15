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

test('a durable-cleanup retry never deletes a generation re-referenced after the failed reap (S6/A5)', async () => {
  const { root, db, store } = await setup();
  const { id } = store.upload({ bytes: 're-referenced-bytes' });
  adoptAndFinalize(db, store, id);
  makeFinalSlotUndeletable(store, id);

  await store.reap({ ttl: 0, census: photoCensus });
  assert.ok(store.stat(id), 'the first reap failed and retained the row');
  assert.equal(store.cleanupState(id).cleanupAttempts, 1, 'the first removal attempt failed');

  // The generation is referenced again BEFORE the retry sweep runs, and the
  // operator clears the byte blocker. The retry must REVALIDATE (the census
  // reference is a column source) and skip the row — never delete a newly
  // referenced generation out from under its owner.
  referencePhoto(db, 'p1', id);
  rmSync(store._pathFor(id), { recursive: true, force: true });

  await store.reap({ ttl: 0, census: photoCensus });
  assert.ok(store.stat(id), 'a re-referenced generation is NOT deleted by the retry sweep');
  assert.equal(store.cleanupState(id).cleanupAttempts, 1, 'no removal attempt ran for the re-referenced row — it was revalidated, not blindly retried');
  assert.equal(db.prepare('SELECT data FROM Photo WHERE id = ?').get('p1').data, id, 'the re-reference is intact');
  rmSync(root, { recursive: true, force: true });
});

test('a reap never reports complete against a metadata row that is still present (S6/A5 #3)', async () => {
  const { root, db, store } = await setup();
  const { id } = store.upload({ bytes: 'verified-removal' });
  adoptAndFinalize(db, store, id);

  // A re-inserting trigger forces the DELETE to leave the row behind: removal
  // must VERIFY the metadata is gone (affected rows + a follow-up existence
  // check) and record a durable failure instead of reporting a complete reap.
  db.exec(`CREATE TRIGGER reinsert_blob AFTER DELETE ON BlobStore BEGIN
    INSERT INTO BlobStore (id, status, md5, sha256, size, mime, createdAt)
    VALUES (OLD.id, OLD.status, OLD.md5, OLD.sha256, OLD.size, OLD.mime, OLD.createdAt);
  END`);

  const result = await store.reap({ ttl: 0, census: photoCensus });
  assert.deepStrictEqual(result, { orphans: 0, danglers: 0 }, 'a removal that cannot delete the metadata row is never reported complete');
  const state = store.cleanupState(id);
  assert.ok(state, 'the row survives with durable cleanup state');
  assert.match(state.cleanupError, /metadata row/, 'the verification failure is recorded');
  assert.equal(state.cleanupAttempts, 1, 'the failed verified removal is counted');
  assert.ok(store.stat(id), 'the metadata row is still present');

  db.exec('DROP TRIGGER reinsert_blob');
  await store.reap({ ttl: 0, census: photoCensus });
  assert.equal(store.stat(id), undefined, 'the verified removal completes once the blocker is gone');
  assert.deepStrictEqual(store.pendingCleanups(), []);
  rmSync(root, { recursive: true, force: true });
});

test('stat() surfaces replacement + durable cleanup state (S6/A5)', async () => {
  const { root, db, store } = await setup();
  const v1 = store.upload({ bytes: 'old-bytes', id: 'gen-stat' });
  adoptAndFinalize(db, store, v1.id);
  const staged = store.replace(v1.id, { bytes: 'new-bytes' });
  db.exec('BEGIN IMMEDIATE');
  store.switchReplacement(db, v1.id, staged.id);
  db.exec('COMMIT');
  store.finalize(staged.id);

  const oldStat = store.stat(v1.id);
  assert.equal(oldStat.status, 'replaced');
  assert.equal(oldStat.replacedBy, staged.id, 'stat() reports the replacement generation');
  assert.ok(oldStat.replacedAt, 'stat() reports the switch instant');

  // A failed byte removal records cleanup state visible through stat() too.
  const { id } = store.upload({ bytes: 'stat-cleanup' });
  adoptAndFinalize(db, store, id);
  makeFinalSlotUndeletable(store, id);
  await store.reap({ ttl: 0, census: photoCensus });
  const cleanupStat = store.stat(id);
  assert.ok(cleanupStat.cleanupError, 'stat() reports the cleanup failure');
  assert.equal(cleanupStat.cleanupAttempts, 1, 'stat() reports the attempt count');
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

// blob-replacement.test.mjs — S6/A5 generation replacement (workbench#94):
// stage/adopt/switch/finalize/reap exercised at every failure point. A failed
// replacement (validation, adopt, or switch) leaves the old generation readable
// and authoritative; a replaced generation is reclaimed only when unreferenced
// AND the named 'replaced-generation' retention has elapsed; replaced
// generations route through the S1/A6 recycle seam before live bytes are
// removed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { generateFrameworkDDL } from '../build/ddl.mjs';
import { compileBlobCensus } from '../build/blob-census.mjs';
import workbench, { entity, blob } from '../build/internal.mjs';

const photoCensus = compileBlobCensus({
  entities: new Map(),
  declaredBlobFields: [
    { actionName: 'Photo.upload', field: 'data', resourceField: 'id', owningResource: 'Photo', erasureCategory: 'deletable' },
  ],
});

async function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'workbench-blob-replace-'));
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

// The owning reference currently points at the new generation (a real
// replacement: Photo.data switched from oldId to newId).
function referencePhoto(db, photoId, generationId) {
  db.prepare('INSERT INTO Photo (id, data) VALUES (?, ?)').run(photoId, generationId);
}

async function backdateReplacedAt(db, id, agoMs) {
  db.prepare('UPDATE BlobStore SET replacedAt = ? WHERE id = ?').run(
    new Date(Date.now() - agoMs).toISOString(), id,
  );
}

test('stage validation: a missing, pending, or unreadable generation is refused and nothing is staged', async () => {
  const { root, db, store } = await setup();
  const before = db.prepare('SELECT COUNT(*) AS count FROM BlobStore').get().count;

  assert.throws(() => store.replace('no-such-generation', { bytes: 'x' }), /does not exist/);

  const pending = store.upload({ bytes: 'never-adopted' });
  assert.throws(() => store.replace(pending.id, { bytes: 'y' }), /not adopted/);

  const adopted = store.upload({ bytes: 'v1-bytes' });
  adoptAndFinalize(db, store, adopted.id);
  rmSync(store._pathFor(adopted.id), { force: true }); // corrupt: bytes gone
  assert.throws(() => store.replace(adopted.id, { bytes: 'z' }), /unreadable/);

  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM BlobStore').get().count, before + 2, 'no replacement staged after a failed validation');
  rmSync(root, { recursive: true, force: true });
});

test('replace stages new bytes as a pending generation and leaves the old generation readable', async () => {
  const { root, db, store } = await setup();
  const v1 = store.upload({ bytes: 'generation-one', mime: 'text/plain', id: 'gen-v1' });
  adoptAndFinalize(db, store, v1.id);

  const staged = store.replace(v1.id, { bytes: 'generation-two', mime: 'image/png' });
  assert.notEqual(staged.id, v1.id, 'a replacement is a NEW generation id');
  assert.equal(staged.previousId, v1.id);
  assert.equal(staged.size, 'generation-two'.length);
  assert.equal(staged.mime, 'image/png');

  const stagedRow = store.stat(staged.id);
  assert.equal(stagedRow.status, 'pending', 'the staged replacement awaits the switch');
  assert.equal(store.stat(v1.id).status, 'adopted', 'the old generation is untouched by staging');
  assert.deepStrictEqual(store.readRange(v1.id), Buffer.from('generation-one'), 'the old generation stays readable');
  rmSync(root, { recursive: true, force: true });
});

test('switchReplacement atomically commits: new adopted, old marked replaced, old readable until retention', async () => {
  const { root, db, store } = await setup();
  const v1 = store.upload({ bytes: 'old-bytes', id: 'gen-old' });
  adoptAndFinalize(db, store, v1.id);
  const staged = store.replace(v1.id, { bytes: 'new-bytes' });

  db.exec('BEGIN IMMEDIATE');
  const switched = store.switchReplacement(db, v1.id, staged.id);
  db.exec('COMMIT');

  assert.deepStrictEqual(switched, { adopted: 1, replaced: 1 });
  assert.equal(store.stat(staged.id).status, 'adopted', 'the replacement generation was adopted');
  const oldState = store.cleanupState(v1.id);
  assert.equal(oldState.status, 'replaced');
  assert.equal(oldState.replacedBy, staged.id, 'the replacement generation is recorded');
  assert.ok(oldState.replacedAt, 'the switch instant is recorded');
  assert.deepStrictEqual(store.readRange(v1.id), Buffer.from('old-bytes'), 'the old generation remains readable');

  store.finalize(staged.id); // post-commit finalize consumer

  // Retention window: elapsed only via backdating → still not reaped yet.
  await store.reap({ ttl: 0, census: photoCensus, replacedRetentionMs: 60_000 });
  assert.ok(store.stat(v1.id), 'the replaced generation is kept inside the retention window');

  await backdateReplacedAt(db, v1.id, 120_000);
  await store.reap({ ttl: 0, census: photoCensus, replacedRetentionMs: 60_000 });
  assert.equal(store.stat(v1.id), undefined, 'the replaced generation is reaped once unreferenced AND retention elapsed');
  assert.ok(!existsSync(store._pathFor(v1.id)), 'the old bytes were removed');
  rmSync(root, { recursive: true, force: true });
});

test('a failed switch rolls back and leaves the old generation authoritative', async () => {
  const { root, db, store } = await setup();
  const v1 = store.upload({ bytes: 'old-bytes', id: 'gen-old' });
  adoptAndFinalize(db, store, v1.id);
  const unrelated = store.upload({ bytes: 'adopted-not-pending', id: 'gen-other' });
  adoptAndFinalize(db, store, unrelated.id);
  const staged = store.replace(v1.id, { bytes: 'new-bytes' });

  db.exec('BEGIN IMMEDIATE');
  assert.throws(() => store.switchReplacement(db, v1.id, unrelated.id), /not staged as pending/);
  db.exec('ROLLBACK');

  assert.equal(store.stat(v1.id).status, 'adopted', 'the old generation stays adopted after the failed switch');
  assert.equal(store.stat(unrelated.id).status, 'adopted', 'the unrelated generation is untouched');
  assert.equal(store.stat(staged.id).status, 'pending', 'the staged replacement stays pending after the failed switch');
  assert.deepStrictEqual(store.readRange(v1.id), Buffer.from('old-bytes'), 'the old generation remains authoritative');
  rmSync(root, { recursive: true, force: true });
});

test('a failed switch on the previous side (not adopted) throws and rolls back', async () => {
  const { root, db, store } = await setup();
  const v1 = store.upload({ bytes: 'old', id: 'gen-v1' });
  adoptAndFinalize(db, store, v1.id);
  const staged = store.replace(v1.id, { bytes: 'new' });
  const neverAdopted = store.upload({ bytes: 'orphan', id: 'gen-orphan' });

  db.exec('BEGIN IMMEDIATE');
  assert.throws(() => store.switchReplacement(db, neverAdopted.id, staged.id), /not an adopted generation/);
  db.exec('ROLLBACK');

  assert.equal(store.stat(v1.id).status, 'adopted', 'the real generation is untouched');
  assert.equal(store.stat(staged.id).status, 'pending', 'the staged replacement was rolled back');
  assert.equal(store.stat(neverAdopted.id).status, 'pending', 'the never-adopted previous is untouched');
  rmSync(root, { recursive: true, force: true });
});

test('switchReplacement is exactly-once — re-running after the switch committed throws', async () => {
  const { root, db, store } = await setup();
  const v1 = store.upload({ bytes: 'old', id: 'gen-v1' });
  adoptAndFinalize(db, store, v1.id);
  const staged = store.replace(v1.id, { bytes: 'new' });

  db.exec('BEGIN IMMEDIATE');
  store.switchReplacement(db, v1.id, staged.id);
  db.exec('COMMIT');

  db.exec('BEGIN IMMEDIATE');
  assert.throws(() => store.switchReplacement(db, v1.id, staged.id), /not staged as pending/);
  db.exec('ROLLBACK');
  rmSync(root, { recursive: true, force: true });
});

test('a replacement that never finalizes leaves the old generation readable; the recovery finalize promotes it', async () => {
  const { root, db, store } = await setup();
  const v1 = store.upload({ bytes: 'old-bytes', id: 'gen-old' });
  adoptAndFinalize(db, store, v1.id);
  const staged = store.replace(v1.id, { bytes: 'new-bytes' });

  db.exec('BEGIN IMMEDIATE');
  store.switchReplacement(db, v1.id, staged.id);
  db.exec('COMMIT');
  // The post-commit finalize consumer FAILED/never ran — the replacement's
  // bytes stay pending, but the old generation is still readable.
  assert.deepStrictEqual(store.readRange(v1.id), Buffer.from('old-bytes'));
  assert.ok(existsSync(store._pathFor(staged.id, { pending: true })), 'the replacement bytes remain in the pending slot');

  // The blob-lifecycle replacement finalize pass promotes it idempotently.
  store.finalize(staged.id);
  assert.deepStrictEqual(store.readRange(staged.id), Buffer.from('new-bytes'), 'the replacement is finalized and readable');
  rmSync(root, { recursive: true, force: true });
});

test('a replaced generation that is STILL referenced is not reclaimed even after retention', async () => {
  const { root, db, store } = await setup();
  const v1 = store.upload({ bytes: 'old-bytes', id: 'gen-old' });
  adoptAndFinalize(db, store, v1.id);
  const staged = store.replace(v1.id, { bytes: 'new-bytes' });

  // BUGGED replacement: the owning reference never switched (still v1).
  referencePhoto(db, 'p1', v1.id);

  db.exec('BEGIN IMMEDIATE');
  store.switchReplacement(db, v1.id, staged.id);
  db.exec('COMMIT');

  await backdateReplacedAt(db, v1.id, 86_400_000 * 30);
  await store.reap({ ttl: 0, census: photoCensus, replacedRetentionMs: 60_000 });
  assert.ok(store.stat(v1.id), 'a still-referenced replaced generation is never reclaimed');
  assert.deepStrictEqual(store.readRange(v1.id), Buffer.from('old-bytes'), 'its bytes stay readable');
  rmSync(root, { recursive: true, force: true });
});

test('replaced generations route through the recycle seam before live bytes are removed', async () => {
  const { root, db, store } = await setup();
  const v1 = store.upload({ bytes: 'old-bytes', id: 'gen-old' });
  adoptAndFinalize(db, store, v1.id);
  const staged = store.replace(v1.id, { bytes: 'new-bytes' });
  referencePhoto(db, 'p1', staged.id);

  db.exec('BEGIN IMMEDIATE');
  store.switchReplacement(db, v1.id, staged.id);
  db.exec('COMMIT');

  const binned = [];
  const recycle = { bin: async (deletion) => { binned.push(...deletion.generations); return { ok: true }; } };

  await backdateReplacedAt(db, v1.id, 120_000);
  const result = await store.reap({ ttl: 0, census: photoCensus, replacedRetentionMs: 60_000, recycle });
  assert.deepStrictEqual(binned, [v1.id], 'the replaced generation was routed to the recycle bin');
  assert.equal(result.danglers, 1, 'the replaced generation was reaped');
  assert.equal(store.stat(v1.id), undefined);
  rmSync(root, { recursive: true, force: true });
});

test('app-level: the blob-lifecycle replacement finalize pass promotes a switched-in replacement', async (t) => {
  const db = new DatabaseSync(':memory:');
  const root = mkdtempSync(path.join(tmpdir(), 'workbench-blob-replace-app-'));
  const app = workbench({ db, blobs: { root } });
  app.mount('/notes', entity('Note', { photo: blob() }));
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });

  const v1 = app.blobs.upload({ bytes: 'old-bytes', id: 'gen-v1' });
  app.db.exec('BEGIN IMMEDIATE');
  app.blobs.adopt(app.db, v1.id);
  app.db.exec('COMMIT');
  app.blobs.finalize(v1.id);

  const staged = app.blobs.replace(v1.id, { bytes: 'new-bytes' });
  app.db.exec('BEGIN IMMEDIATE');
  app.blobs.switchReplacement(app.db, v1.id, staged.id);
  app.db.exec('COMMIT');
  // The replacement is adopted but its bytes are still pending.
  assert.throws(() => app.blobs.readRange(staged.id), /blob not found/);

  const { finalized } = await app.reconcileBlobFinalize(app.db);
  assert.ok(finalized >= 1, 'the replacement finalize pass promoted the switched-in generation');
  assert.deepStrictEqual(app.blobs.readRange(staged.id), Buffer.from('new-bytes'), 'the replacement bytes are finalized');
  rmSync(root, { recursive: true, force: true });
});

// Guard against the no-op lifecycle regression: with no engaged entity blob
// fields the lifecycle returns a no-op, so the replacement finalize pass must
// never be invoked on a null blob pipeline.
test('replacement ids are bounded identifiers like every other blob id', async () => {
  const { root, db, store } = await setup();
  assert.throws(() => store.replace('../evil', { bytes: 'x' }), /invalid blob id/);
  assert.throws(() => store.switchReplacement(db, '../evil', randomUUID()), /invalid blob id/);
  rmSync(root, { recursive: true, force: true });
});

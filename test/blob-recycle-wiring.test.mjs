// blob-recycle-wiring.test.mjs — S6/A5 #4 app assembly (workbench#94): the
// `blobRecycle` option wires the app-owned S1/A6 recycle manager into
// app.blobRecycleSeam at boot, and that seam routes a DELETED generation
// through the real recycling bin BEFORE live bytes are removed — verified
// against a real backup holding the generation. The named 'backup-retention'
// policy (S6/A5 #21) drives the bin's recoverable window.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import workbench, { principal } from '../build/index.mjs';
import { pendingBlobStager, declaredBlobField } from '../build/server.mjs';
import { createBackupManager } from '../build/backup.mjs';

async function harness(t, retention = {}) {
  const owned = mkdtempSync(join(tmpdir(), 'wb-recycle-wiring-'));
  const app = workbench({
    db: { directory: owned, name: 'app' },
    blobRecycle: { root: owned },
    blobRetention: retention,
    actions: [
      { type: 'File.upload', authorize: () => true, projections: [{ eventTypes: ['File.created'], apply: () => {} }], handler: ({ payload, scope }) => [{ type: 'File.created', scope, data: { data: payload.data } }] },
      { type: 'File.purge', authorize: () => true, projections: [{ eventTypes: ['File.deleted'], apply: () => {} }], handler: ({ scope }) => [{ type: 'File.deleted', scope, data: {} }] },
    ],
    blobLifecycle: {
      fields: [declaredBlobField({ actionName: 'File.upload', field: 'data', resourceField: 'id', owningResource: 'Photo', erasureCategory: 'deletable', purgeActionName: 'File.purge' })],
      pendingTtlMs: 60_000,
      adoptedRecoveryTtlMs: 60_000,
    },
  });
  await app.start();
  t.after(async () => {
    await app.shutdown();
    rmSync(owned, { recursive: true, force: true });
  });
  app.db.exec('CREATE TABLE Photo (id TEXT PRIMARY KEY, data TEXT)');
  return { app, owned };
}

test('an assembled app wires the recycle seam and routes a deleted generation through the real bin (S6/A5)', async (t) => {
  const { app, owned } = await harness(t);

  assert.ok(app.blobRecycleSeam, 'the app assembled app.blobRecycleSeam at boot');

  const actor = principal({ type: 'user', id: 'u1' });
  const staged = await pendingBlobStager(app, actor).stage({ scopeId: 'project:p1', resourceId: 'f1', bytes: new Uint8Array([1, 2, 3]) });
  assert.equal((await app.dispatch({ actionId: 'upload', type: 'File.upload', scope: 'project:p1', payload: { id: 'f1', data: staged.claim }, principal: actor })).ok, true);
  const blobId = app.db.prepare('SELECT blobId FROM _PendingBlob WHERE pendingKey = ?').get(staged.pendingKey).blobId;
  await app.pendingBlobLifecycle.reconcile();
  app.db.prepare('INSERT INTO Photo (id, data) VALUES (?, ?)').run('p1', blobId);

  // A real backup that holds the generation (the census enumerates Photo.data).
  const backup = createBackupManager({
    source: app._dbAdapter,
    writeCoordinator: app.writeCoordinator,
    blobs: app.createBlobSeams(),
  });
  const made = await backup.backup();
  assert.equal(made.ok, true, JSON.stringify(made));
  const backupDir = made.directory;
  const backupId = backupDir.split(/[\\/]/).pop();
  assert.equal(existsSync(join(backupDir, 'blobs', blobId)), true, 'the backup holds the generation');

  // Delete the generation through the assembled seam: bin BEFORE live-byte
  // removal, so the backup copy moves into the recoverable bin and the live
  // bytes + rows are removed only after the bin succeeded.
  assert.equal((await app.dispatch({ actionId: 'delete', type: 'File.purge', scope: 'project:p1', payload: { id: 'f1', data: { blobId } }, principal: actor })).ok, true);
  await app.pendingBlobLifecycle.reconcile();

  assert.equal(app.db.prepare('SELECT * FROM _PendingBlob WHERE blobId = ?').get(blobId), undefined, 'the deletion completed');
  assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM BlobStore WHERE id = ?').get(blobId).count, 0, 'the live BlobStore row is gone');
  assert.equal(existsSync(join(backupDir, 'blobs', blobId)), false, 'the byte file moved OUT of the retained backup');
  assert.equal(existsSync(join(owned, 'recycle', backupId, blobId, blobId)), true, 'the deleted generation landed in the recoverable bin');
});

test('the backup-retention policy drives the recycle bin recoverable window (S6/A5 #21)', async (t) => {
  const { app } = await harness(t, { backupRetentionMs: 12 * 86_400_000 });

  assert.ok(app.blobRecycleSeam, 'the app assembled the recycle seam');
  const manager = app.createRecycleManager();
  assert.equal(manager.retentionDays, 12, 'the named backup-retention policy is the bin window source (12 days)');
});

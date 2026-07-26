import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import workbench, { principal } from '../src/index.mjs';
import { pendingBlobStager, declaredBlobField } from '../src/server.mjs';

test('pending blob staging retains Scope canonical key and immutable digest identity', async (t) => {
  const db = new DatabaseSync(':memory:');
  const root = mkdtempSync(path.join(tmpdir(), 'workbench-pending-'));
  const app = workbench({
    db,
    blobs: { root },
    blobLifecycle: { fields: [declaredBlobField({ actionName: 'File.upload', field: 'blob', validator: async () => ({ allow: true }) })], pendingTtlMs: 1, adoptedRecoveryTtlMs: 1 },
  });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const stager = pendingBlobStager(app, principal({ type: 'user', id: 'u1' }));
  const staged = await stager.stage({ projectId: 'p1', fileId: 'f1', bytes: new Uint8Array([1, 2, 3]), mediaType: 'application/octet-stream' });
  assert.equal(staged.pendingKey, 'p1/f1.pending');
  assert.equal(staged.byteLength, 3);
  assert.match(staged.contentDigest, /^[a-f0-9]{64}$/);
  await assert.rejects(stager.stage({ projectId: 'p1', fileId: 'f1', bytes: new Uint8Array([4]) }), /PENDING_KEY_EXISTS/);
});

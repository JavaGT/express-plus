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

test('declared blob claims are validated and adopted atomically with the registered action', async (t) => {
  const db = new DatabaseSync(':memory:');
  const root = mkdtempSync(path.join(tmpdir(), 'workbench-pending-'));
  const seen = [];
  const app = workbench({
    db,
    blobs: { root },
    actions: [{
      type: 'File.upload',
      authorize: () => true,
      projections: [{ eventTypes: ['File.created'], apply: () => {} }],
      handler: ({ payload, scope }) => [{ type: 'File.created', scope, data: { id: 'f1', blob: payload.blob } }],
    }],
    blobLifecycle: {
      fields: [declaredBlobField({
        actionName: 'File.upload', field: 'blob',
        validator: async (context) => { seen.push(context); return { allow: context.authenticatedPrincipalId === 'u1' }; },
      })],
      pendingTtlMs: 1,
      adoptedRecoveryTtlMs: 1,
    },
  });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const stager = pendingBlobStager(app, principal({ type: 'user', id: 'u1' }));
  const staged = await stager.stage({ projectId: 'p1', fileId: 'f1', bytes: new Uint8Array([7, 8]) });
  const outcome = await app.dispatch({ actionId: 'upload-1', type: 'File.upload', scope: 'project:p1', payload: { blob: staged.claim }, principal: principal({ type: 'user', id: 'u1' }) });
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(seen.length, 1);
  assert.deepEqual(Object.keys(seen[0]).sort(), ['actionId', 'actionName', 'authenticatedPrincipalId', 'byteLength', 'committedEventId', 'contentDigest', 'pendingKey', 'scopeId']);
  assert.equal(seen[0].pendingKey, 'p1/f1.pending');
  assert.equal(app.db.prepare('SELECT status FROM _PendingBlob WHERE pendingKey = ?').get(staged.pendingKey).status, 'finalized');
  const duplicate = await app.dispatch({ actionId: 'upload-2', type: 'File.upload', scope: 'project:p1', payload: { blob: staged.claim }, principal: principal({ type: 'user', id: 'u1' }) });
  assert.equal(duplicate.ok, false);
});

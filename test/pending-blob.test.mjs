import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import workbench, { principal } from '../src/index.mjs';
import { pendingBlobStager, declaredBlobField, readClaimedBlob } from '../src/server.mjs';

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
  const handled = [];
  const projected = [];
  const app = workbench({
    db,
    blobs: { root },
    actions: [{
      type: 'File.upload',
      authorize: () => true,
      projections: [{ eventTypes: ['File.created'], apply: (event) => projected.push(event) }],
      handler: ({ actionId, payload, scope }) => {
        handled.push({ actionId, blob: payload.blob });
        return [{ type: 'File.created', scope, data: { id: 'f1', blob: payload.blob } }];
      },
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
  assert.deepEqual(handled, [{ actionId: 'upload-1', blob: staged.claim }]);
  assert.equal(seen.length, 1);
  assert.deepEqual(Object.keys(seen[0]).sort(), ['actionId', 'actionName', 'authenticatedPrincipalId', 'byteLength', 'committedEventId', 'contentDigest', 'pendingKey', 'scopeId']);
  assert.equal(seen[0].pendingKey, 'p1/f1.pending');
  const blobId = app.db.prepare('SELECT blobId FROM _PendingBlob WHERE pendingKey = ?').get(staged.pendingKey).blobId;
  assert.equal(projected[0].data.blob, blobId, 'projections receive the canonical blob id, not a pending claim');
  const persisted = app.db.prepare('SELECT eventData FROM _Log WHERE actionId = ?').get('upload-1').eventData;
  assert.equal(JSON.parse(persisted).blob, blobId, 'the committed event never retains a pending claim token');
  assert.equal(persisted.includes(staged.claim.claimToken), false);
  assert.equal(app.db.prepare('SELECT status FROM _PendingBlob WHERE pendingKey = ?').get(staged.pendingKey).status, 'finalized');
  const duplicate = await app.dispatch({ actionId: 'upload-2', type: 'File.upload', scope: 'project:p1', payload: { blob: staged.claim }, principal: principal({ type: 'user', id: 'u1' }) });
  assert.equal(duplicate.ok, false);
});

test('a failed duplicate staging request leaves an unrelated pending blob intact', async (t) => {
  const db = new DatabaseSync(':memory:');
  const root = mkdtempSync(path.join(tmpdir(), 'workbench-pending-'));
  const app = workbench({
    db,
    blobs: { root },
    blobLifecycle: { fields: [declaredBlobField({ actionName: 'File.upload', field: 'blob', validator: async () => ({ allow: true }) })], pendingTtlMs: 60_000, adoptedRecoveryTtlMs: 60_000 },
  });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const stager = pendingBlobStager(app, principal({ type: 'user', id: 'u1' }));
  const first = await stager.stage({ projectId: 'p1', fileId: 'first', bytes: new Uint8Array([1]) });
  await stager.stage({ projectId: 'p1', fileId: 'second', bytes: new Uint8Array([2]) });
  await assert.rejects(stager.stage({ projectId: 'p1', fileId: 'second', bytes: new Uint8Array([3]) }), /PENDING_KEY_EXISTS/);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM _PendingBlob WHERE pendingKey IN (?, ?)').get(first.pendingKey, 'p1/second.pending').count, 2);
  assert.deepEqual(app.blobs.readRange(app.db.prepare('SELECT blobId FROM _PendingBlob WHERE pendingKey = ?').get(first.pendingKey).blobId), Buffer.from([1]));
});

test('declared deletion is authorized, idempotent, and makes claimed bytes unavailable', async (t) => {
  const db = new DatabaseSync(':memory:');
  const root = mkdtempSync(path.join(tmpdir(), 'workbench-pending-'));
  const app = workbench({
    db,
    blobs: { root },
    actions: [
      { type: 'File.upload', authorize: () => true, projections: [{ eventTypes: ['File.created'], apply: () => {} }], handler: ({ payload, scope }) => [{ type: 'File.created', scope, data: { blob: payload.blob } }] },
      { type: 'File.delete', authorize: () => true, projections: [{ eventTypes: ['File.deleted'], apply: () => {} }], handler: ({ scope }) => [{ type: 'File.deleted', scope, data: {} }] },
    ],
    blobLifecycle: {
      fields: [declaredBlobField({ actionName: 'File.upload', field: 'blob', deletionActionName: 'File.delete', validator: async ({ authenticatedPrincipalId }) => ({ allow: authenticatedPrincipalId === 'u1', code: 'DENIED' }) })],
      pendingTtlMs: 1, adoptedRecoveryTtlMs: 1,
    },
  });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const stager = pendingBlobStager(app, principal({ type: 'user', id: 'u1' }));
  const staged = await stager.stage({ projectId: 'p1', fileId: 'f1', bytes: new Uint8Array([7, 8]) });
  assert.equal((await app.dispatch({ actionId: 'upload', type: 'File.upload', scope: 'project:p1', payload: { blob: staged.claim }, principal: principal({ type: 'user', id: 'u1' }) })).ok, true);
  const blobId = app.db.prepare('SELECT blobId FROM _PendingBlob WHERE pendingKey = ?').get(staged.pendingKey).blobId;
  assert.deepEqual(readClaimedBlob(app, blobId), Buffer.from([7, 8]));
  assert.equal((await app.dispatch({ actionId: 'denied', type: 'File.delete', scope: 'project:p1', payload: { blob: { blobId } }, principal: principal({ type: 'user', id: 'u2' }) })).ok, false);
  assert.equal((await app.dispatch({ actionId: 'delete', type: 'File.delete', scope: 'project:p1', payload: { blob: { blobId } }, principal: principal({ type: 'user', id: 'u1' }) })).ok, true);
  await app.pendingBlobLifecycle.reconcile();
  assert.equal(app.db.prepare('SELECT status FROM _PendingBlob WHERE blobId = ?').get(blobId).status, 'deleted');
  assert.throws(() => readClaimedBlob(app, blobId), /BLOB_UNAVAILABLE/);
});

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
    blobLifecycle: { fields: [declaredBlobField({ actionName: 'File.upload', field: 'blob' })], pendingTtlMs: 60_000, adoptedRecoveryTtlMs: 1 },
  });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const stager = pendingBlobStager(app, principal({ type: 'user', id: 'u1' }));
  const staged = await stager.stage({ scopeId: 'project:p1', resourceId: 'f1', bytes: new Uint8Array([1, 2, 3]), mediaType: 'application/octet-stream' });
  assert.equal(staged.pendingKey, 'project:p1/f1.pending');
  assert.equal(staged.byteLength, 3);
  assert.match(staged.contentDigest, /^[a-f0-9]{64}$/);
  await assert.rejects(stager.stage({ scopeId: 'project:p1', resourceId: 'f1', bytes: new Uint8Array([4]) }), /PENDING_KEY_EXISTS/);
});

test('declared blob claims are validated and adopted atomically with the registered action', async (t) => {
  const db = new DatabaseSync(':memory:');
  const root = mkdtempSync(path.join(tmpdir(), 'workbench-pending-'));
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
      fields: [declaredBlobField({ actionName: 'File.upload', field: 'blob' })],
      pendingTtlMs: 60_000,
      adoptedRecoveryTtlMs: 1,
    },
  });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const stager = pendingBlobStager(app, principal({ type: 'user', id: 'u1' }));
  const staged = await stager.stage({ scopeId: 'project:p1', resourceId: 'f1', bytes: new Uint8Array([7, 8]) });
  const outcome = await app.dispatch({ actionId: 'upload-1', type: 'File.upload', scope: 'project:p1', payload: { blob: staged.claim }, principal: principal({ type: 'user', id: 'u1' }) });
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  const blobId = app.db.prepare('SELECT blobId FROM _PendingBlob WHERE pendingKey = ?').get(staged.pendingKey).blobId;
  assert.deepEqual(handled, [{ actionId: 'upload-1', blob: blobId }]);
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
    blobLifecycle: { fields: [declaredBlobField({ actionName: 'File.upload', field: 'blob' })], pendingTtlMs: 60_000, adoptedRecoveryTtlMs: 60_000 },
  });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const stager = pendingBlobStager(app, principal({ type: 'user', id: 'u1' }));
  const first = await stager.stage({ scopeId: 'project:p1', resourceId: 'first', bytes: new Uint8Array([1]) });
  await stager.stage({ scopeId: 'project:p1', resourceId: 'second', bytes: new Uint8Array([2]) });
  await assert.rejects(stager.stage({ scopeId: 'project:p1', resourceId: 'second', bytes: new Uint8Array([3]) }), /PENDING_KEY_EXISTS/);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM _PendingBlob WHERE pendingKey IN (?, ?)').get(first.pendingKey, 'project:p1/second.pending').count, 2);
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
      { type: 'File.delete', authorize: ({ principal }) => principal?.id === 'u1', projections: [{ eventTypes: ['File.deleted'], apply: () => {} }], handler: ({ scope }) => [{ type: 'File.deleted', scope, data: {} }] },
    ],
    blobLifecycle: {
      fields: [declaredBlobField({ actionName: 'File.upload', field: 'blob', deletionActionName: 'File.delete',  })],
      pendingTtlMs: 60_000, adoptedRecoveryTtlMs: 1,
    },
  });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const stager = pendingBlobStager(app, principal({ type: 'user', id: 'u1' }));
  const staged = await stager.stage({ scopeId: 'project:p1', resourceId: 'f1', bytes: new Uint8Array([7, 8]) });
  const committed = await app.dispatch({ actionId: 'upload', type: 'File.upload', scope: 'project:p1', payload: { blob: staged.claim }, principal: principal({ type: 'user', id: 'u1' }) });
  assert.equal(committed.ok, true, JSON.stringify(committed));
  const blobId = app.db.prepare('SELECT blobId FROM _PendingBlob WHERE pendingKey = ?').get(staged.pendingKey).blobId;
  assert.deepEqual(readClaimedBlob(app, blobId), Buffer.from([7, 8]));
  assert.equal((await app.dispatch({ actionId: 'denied', type: 'File.delete', scope: 'project:p1', payload: { blob: { blobId } }, principal: principal({ type: 'user', id: 'u2' }) })).ok, false);
  assert.equal((await app.dispatch({ actionId: 'delete', type: 'File.delete', scope: 'project:p1', payload: { blob: { blobId } }, principal: principal({ type: 'user', id: 'u1' }) })).ok, true);
  await app.pendingBlobLifecycle.reconcile();
  assert.equal(app.db.prepare('SELECT * FROM _PendingBlob WHERE blobId = ?').get(blobId), undefined);
  assert.throws(() => readClaimedBlob(app, blobId), /BLOB_UNAVAILABLE/);
  assert.ok((await stager.stage({ scopeId: 'project:p1', resourceId: 'f1', bytes: new Uint8Array([9]) })).claim, 'deletion releases the deterministic identity for replacement');
});

test('the ordinary blob reaper retains a finalized pending-blob generation', async (t) => {
  const db = new DatabaseSync(':memory:');
  const root = mkdtempSync(path.join(tmpdir(), 'workbench-pending-'));
  const app = workbench({
    db, blobs: { root },
    actions: [{ type: 'File.upload', authorize: () => true, projections: [{ eventTypes: ['File.created'], apply: () => {} }], handler: ({ payload, scope }) => [{ type: 'File.created', scope, data: { blob: payload.blob } }] }],
    blobLifecycle: { fields: [declaredBlobField({ actionName: 'File.upload', field: 'blob' })], pendingTtlMs: 60_000, adoptedRecoveryTtlMs: 60_000 },
  });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const actor = principal({ type: 'user', id: 'u1' });
  const staged = await pendingBlobStager(app, actor).stage({ scopeId: 'project:p1', resourceId: 'f1', bytes: new Uint8Array([1]) });
  assert.equal((await app.dispatch({ actionId: 'upload', type: 'File.upload', scope: 'project:p1', payload: { blob: staged.claim }, principal: actor })).ok, true);
  const blobId = db.prepare('SELECT blobId FROM _PendingBlob WHERE pendingKey = ?').get(staged.pendingKey).blobId;
  assert.deepEqual(app.blobs.reap({ ttl: 0, blobColumns: [] }), { orphans: 0, danglers: 0 });
  assert.deepEqual(readClaimedBlob(app, blobId), Buffer.from([1]));
});

test('claims are scope-bound and action authorization runs before claiming', async (t) => {
  const db = new DatabaseSync(':memory:');
  const root = mkdtempSync(path.join(tmpdir(), 'workbench-pending-'));
  let handled = 0;
  const app = workbench({
    db, blobs: { root },
    actions: [{ type: 'File.upload', authorize: ({ principal }) => principal.id === 'u1', handler: ({ payload, scope }) => { handled++; return [{ type: 'File.created', scope, data: { blob: payload.blob } }]; } }],
    blobLifecycle: { fields: [declaredBlobField({ actionName: 'File.upload', field: 'blob' })], pendingTtlMs: 60_000, adoptedRecoveryTtlMs: 60_000 },
  });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const staged = await pendingBlobStager(app, principal({ type: 'user', id: 'u1' })).stage({ scopeId: 'project:p1', resourceId: 'f1', bytes: new Uint8Array([1]) });
  assert.equal((await app.dispatch({ actionId: 'foreign', type: 'File.upload', scope: 'project:p2', payload: { blob: staged.claim }, principal: principal({ type: 'user', id: 'u1' }) })).ok, false);
  assert.equal((await app.dispatch({ actionId: 'denied', type: 'File.upload', scope: 'project:p1', payload: { blob: staged.claim }, principal: principal({ type: 'user', id: 'u2' }) })).ok, false);
  assert.equal(handled, 0);
  assert.equal(db.prepare('SELECT status FROM _PendingBlob WHERE pendingKey = ?').get(staged.pendingKey).status, 'pending');
});

test('a foreign principal with a valid token cannot claim a staged blob', async (t) => {
  const db = new DatabaseSync(':memory:');
  const root = mkdtempSync(path.join(tmpdir(), 'workbench-pending-'));
  const app = workbench({ db, blobs: { root }, actions: [{ type: 'File.upload', authorize: () => true, handler: () => [] }], blobLifecycle: { fields: [declaredBlobField({ actionName: 'File.upload', field: 'blob' })], pendingTtlMs: 60_000, adoptedRecoveryTtlMs: 60_000 } });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const staged = await pendingBlobStager(app, principal({ type: 'user', id: 'u1' })).stage({ scopeId: 'project:p1', resourceId: 'f1', bytes: new Uint8Array([1]) });
  assert.equal((await app.dispatch({ actionId: 'stolen', type: 'File.upload', scope: 'project:p1', payload: { blob: staged.claim }, principal: principal({ type: 'user', id: 'u2' }) })).ok, false);
  assert.equal(db.prepare('SELECT status FROM _PendingBlob WHERE pendingKey = ?').get(staged.pendingKey).status, 'pending');
});

test('a claimed blob cannot be replayed under its action id in a foreign scope', async (t) => {
  const db = new DatabaseSync(':memory:');
  const root = mkdtempSync(path.join(tmpdir(), 'workbench-pending-'));
  const app = workbench({
    db, blobs: { root },
    actions: [{ type: 'File.upload', authorize: () => true, projections: [{ eventTypes: ['File.created'], apply: () => {} }], handler: ({ payload, scope }) => [{ type: 'File.created', scope, data: { blob: payload.blob } }] }],
    blobLifecycle: { fields: [declaredBlobField({ actionName: 'File.upload', field: 'blob' })], pendingTtlMs: 60_000, adoptedRecoveryTtlMs: 60_000 },
  });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const staged = await pendingBlobStager(app, principal({ type: 'user', id: 'u1' })).stage({ scopeId: 'project:p1', resourceId: 'f1', bytes: new Uint8Array([1]) });
  assert.equal((await app.dispatch({ actionId: 'upload', type: 'File.upload', scope: 'project:p1', payload: { blob: staged.claim }, principal: principal({ type: 'user', id: 'u1' }) })).ok, true);
  assert.equal((await app.dispatch({ actionId: 'upload', type: 'File.upload', scope: 'project:p2', payload: { blob: staged.claim }, principal: principal({ type: 'user', id: 'u1' }) })).ok, false);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM _ActionReceipt WHERE scope = 'project:p2'").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM _Log WHERE scope = 'project:p2'").get().count, 0);
});

test('concurrent action ids can claim a staged generation exactly once', async (t) => {
  const db = new DatabaseSync(':memory:');
  const root = mkdtempSync(path.join(tmpdir(), 'workbench-pending-'));
  let handled = 0;
  const app = workbench({
    db, blobs: { root },
    actions: [{ type: 'File.upload', authorize: () => true, projections: [{ eventTypes: ['File.created'], apply: () => {} }], handler: ({ payload, scope }) => { handled++; return [{ type: 'File.created', scope, data: { blob: payload.blob } }]; } }],
    blobLifecycle: { fields: [declaredBlobField({ actionName: 'File.upload', field: 'blob' })], pendingTtlMs: 60_000, adoptedRecoveryTtlMs: 60_000 },
  });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const actor = principal({ type: 'user', id: 'u1' });
  const staged = await pendingBlobStager(app, actor).stage({ scopeId: 'project:p1', resourceId: 'f1', bytes: new Uint8Array([1]) });
  const outcomes = await Promise.all(['first', 'second'].map((actionId) => app.dispatch({ actionId, type: 'File.upload', scope: 'project:p1', payload: { blob: staged.claim }, principal: actor })));
  assert.equal(outcomes.filter((outcome) => outcome.ok).length, 1);
  assert.equal(handled, 1);
});

test('permanent erasure does not implicitly remove declared blob bytes', async (t) => {
  const db = new DatabaseSync(':memory:');
  const root = mkdtempSync(path.join(tmpdir(), 'workbench-pending-'));
  const app = workbench({
    db, blobs: { root },
    actions: [{ type: 'File.upload', authorize: () => true, projections: [{ eventTypes: ['File.created'], apply: () => {} }], handler: ({ payload, scope }) => [{ type: 'File.created', scope, data: { blob: payload.blob } }] }],
    blobLifecycle: { fields: [declaredBlobField({ actionName: 'File.upload', field: 'blob' })], pendingTtlMs: 60_000, adoptedRecoveryTtlMs: 60_000 },
  });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const actor = principal({ type: 'user', id: 'u1' });
  const staged = await pendingBlobStager(app, actor).stage({ scopeId: 'project:p1', resourceId: 'f1', bytes: new Uint8Array([1]) });
  assert.equal((await app.dispatch({ actionId: 'upload', type: 'File.upload', scope: 'project:p1', payload: { blob: staged.claim }, principal: actor })).ok, true);
  const blobId = db.prepare('SELECT blobId FROM _PendingBlob WHERE pendingKey = ?').get(staged.pendingKey).blobId;
  db.prepare("UPDATE _Log SET eventType = '$workbench.erased', eventData = '{\"version\":1}', actionId = '$workbench.erased' WHERE scope = ? AND actionId = ?").run('project:p1', 'upload');
  db.prepare('DELETE FROM _ActionReceipt WHERE scope = ? AND actionId = ?').run('project:p1', 'upload');
  assert.deepEqual(readClaimedBlob(app, blobId), Buffer.from([1]));
  assert.notEqual(db.prepare('SELECT status FROM _PendingBlob WHERE blobId = ?').get(blobId).status, 'deleted');
});

test('projection failure rolls claim back and a retry can commit it once', async (t) => {
  const db = new DatabaseSync(':memory:');
  const root = mkdtempSync(path.join(tmpdir(), 'workbench-pending-'));
  let fail = true;
  let handled = 0;
  const app = workbench({
    db, blobs: { root },
    actions: [{ type: 'File.upload', authorize: () => true, handler: ({ payload, scope }) => { handled++; return [{ type: 'File.created', scope, data: { blob: payload.blob } }]; }, projections: [{ eventTypes: ['File.created'], apply: () => { if (fail) throw new Error('projection failed'); } }] }],
    blobLifecycle: { fields: [declaredBlobField({ actionName: 'File.upload', field: 'blob' })], pendingTtlMs: 60_000, adoptedRecoveryTtlMs: 60_000 },
  });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const staged = await pendingBlobStager(app, principal({ type: 'user', id: 'u1' })).stage({ scopeId: 'project:p1', resourceId: 'f1', bytes: new Uint8Array([1]) });
  assert.equal((await app.dispatch({ actionId: 'upload', type: 'File.upload', scope: 'project:p1', payload: { blob: staged.claim }, principal: principal({ type: 'user', id: 'u1' }) })).ok, false);
  assert.equal(db.prepare('SELECT status FROM _PendingBlob WHERE pendingKey = ?').get(staged.pendingKey).status, 'pending');
  fail = false;
  assert.equal((await app.dispatch({ actionId: 'upload', type: 'File.upload', scope: 'project:p1', payload: { blob: staged.claim }, principal: principal({ type: 'user', id: 'u1' }) })).ok, true);
  assert.equal((await app.dispatch({ actionId: 'upload', type: 'File.upload', scope: 'project:p1', payload: { blob: staged.claim }, principal: principal({ type: 'user', id: 'u1' }) })).deduped, true);
  assert.equal(handled, 2);
});

test('missing and expired claims fail before the handler', async (t) => {
  const db = new DatabaseSync(':memory:');
  const root = mkdtempSync(path.join(tmpdir(), 'workbench-pending-'));
  let handled = 0;
  const app = workbench({
    db, blobs: { root },
    actions: [{ type: 'File.upload', authorize: () => true, handler: () => { handled++; return []; } }],
    blobLifecycle: { fields: [declaredBlobField({ actionName: 'File.upload', field: 'blob' })], pendingTtlMs: 0, adoptedRecoveryTtlMs: 60_000 },
  });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const actor = principal({ type: 'user', id: 'u1' });
  assert.equal((await app.dispatch({ actionId: 'missing', type: 'File.upload', scope: 'project:p1', payload: {}, principal: actor })).ok, false);
  const staged = await pendingBlobStager(app, actor).stage({ scopeId: 'project:p1', resourceId: 'f1', bytes: new Uint8Array([1]) });
  assert.equal((await app.dispatch({ actionId: 'expired', type: 'File.upload', scope: 'project:p1', payload: { blob: staged.claim }, principal: actor })).ok, false);
  assert.equal(handled, 0);
});

test('the receipt stores only the canonical blob id', async (t) => {
  const db = new DatabaseSync(':memory:');
  const root = mkdtempSync(path.join(tmpdir(), 'workbench-pending-'));
  const app = workbench({
    db, blobs: { root },
    actions: [{ type: 'File.upload', authorize: () => true, projections: [{ eventTypes: ['File.created'], apply: () => {} }], handler: ({ payload, scope }) => [{ type: 'File.created', scope, data: { blob: payload.blob } }] }],
    blobLifecycle: { fields: [declaredBlobField({ actionName: 'File.upload', field: 'blob' })], pendingTtlMs: 60_000, adoptedRecoveryTtlMs: 60_000 },
  });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const actor = principal({ type: 'user', id: 'u1' });
  const staged = await pendingBlobStager(app, actor).stage({ scopeId: 'project:p1', resourceId: 'f1', bytes: new Uint8Array([1]) });
  const committed = await app.dispatch({ actionId: 'upload', type: 'File.upload', scope: 'project:p1', payload: { blob: staged.claim }, principal: actor });
  assert.equal(committed.ok, true, JSON.stringify(committed));
  const receipt = db.prepare("SELECT actionData FROM _ActionReceipt WHERE actionId = 'upload'").get();
  const blobId = db.prepare('SELECT blobId FROM _PendingBlob WHERE pendingKey = ?').get(staged.pendingKey).blobId;
  assert.deepEqual(JSON.parse(receipt.actionData), { blob: blobId });
  assert.equal(receipt.actionData.includes(staged.claim.claimToken), false);
  assert.equal(receipt.actionData.includes(staged.pendingKey), false);
});

test('blob declarations reject policy callbacks and other unknown keys', () => {
  assert.throws(() => declaredBlobField({ actionName: 'File.upload', field: 'blob', validator: () => true }), /requires actionName and field/);
});

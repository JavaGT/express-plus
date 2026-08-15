import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import workbench, { principal } from '../build/index.mjs';
import { pendingBlobStager, declaredBlobField, readClaimedBlob, claimedBlobLifecycle } from '../build/server.mjs';
import { BlobSlotNotFoundError } from '../build/fs-blobs.mjs';
import { memoryBlobs } from '../build/memory-blobs.mjs';

test('pending blob staging retains Scope canonical key and immutable digest identity', async (t) => {
  const db = new DatabaseSync(':memory:');
  const root = mkdtempSync(path.join(tmpdir(), 'workbench-pending-'));
  const app = workbench({
    db,
    blobs: { root },
    blobLifecycle: { fields: [declaredBlobField({ actionName: 'File.upload', field: 'blob', resourceField: 'id', owningResource: 'File', erasureCategory: 'deletable' })], pendingTtlMs: 60_000, adoptedRecoveryTtlMs: 1 },
  });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const stager = pendingBlobStager(app, principal({ type: 'user', id: 'u1' }));
  const staged = await stager.stage({ scopeId: 'project:p1', resourceId: 'f1', bytes: new Uint8Array([1, 2, 3]), mediaType: 'application/octet-stream' });
  assert.match(staged.pendingKey, /^project:p1\/f1\.[a-f0-9]{64}\.pending$/);
  assert.equal(staged.byteLength, 3);
  assert.match(staged.contentDigest, /^[a-f0-9]{64}$/);
  await assert.rejects(stager.stage({ scopeId: 'project:p1', resourceId: 'f1', bytes: new Uint8Array([4]) }), /PENDING_KEY_EXISTS/);
});

test('claimed blob lifecycle exposes pending, available, failed, and missing states', async (t) => {
  const db = new DatabaseSync(':memory:');
  const root = mkdtempSync(path.join(tmpdir(), 'workbench-pending-'));
  const app = workbench({
    db,
    blobs: { root },
    blobLifecycle: { fields: [declaredBlobField({ actionName: 'File.upload', field: 'blob', resourceField: 'id', owningResource: 'File', erasureCategory: 'deletable' })], pendingTtlMs: 60_000, adoptedRecoveryTtlMs: 0 },
  });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const facade = claimedBlobLifecycle(app);
  const actor = principal({ type: 'user', id: 'u1' });
  const staged = await pendingBlobStager(app, actor).stage({ scopeId: 'project:p1', resourceId: 'f1', bytes: new Uint8Array([1, 2, 3]) });
  const claimed = await app.pendingBlobLifecycle.validateClaim({
    claim: staged.claim,
    field: 'blob',
    resourceId: 'f1',
    actionName: 'File.upload',
    actionId: 'upload-1',
    authenticatedPrincipal: actor,
    scopeId: 'project:p1',
    committedEventId: 'event-1',
  });
  const blobId = claimed.blobId;
  assert.deepEqual(facade.inspect(blobId), { kind: 'pending' });
  await Promise.all([facade.reconcile(), facade.reconcile()]);
  const available = facade.inspect(blobId);
  assert.equal(available.kind, 'available');
  assert.deepEqual(available.readRange(), Buffer.from([1, 2, 3]));
  assert.deepEqual(available.readRange([1, 3]), Buffer.from([2, 3]));

  writeFileSync(app.blobs._pathFor(blobId), Buffer.from([9]));
  assert.deepEqual(facade.inspect(blobId), { kind: 'failed' });
  db.prepare('DELETE FROM _PendingBlob WHERE blobId = ?').run(blobId);
  assert.deepEqual(facade.inspect(blobId), { kind: 'missing' });
});

test('declared blob claims are validated and adopted atomically with the registered action', async (t) => {
  const db = new DatabaseSync(':memory:');
  const root = mkdtempSync(path.join(tmpdir(), 'workbench-pending-'));
  const handled = [];
  const projected = [];
  const claimed = [];
  const app = workbench({
    db,
    blobs: { root },
    actions: [{
      type: 'File.upload',
      authorize: () => true,
      projections: [{ eventTypes: ['File.created'], apply: (event, _db, context) => projected.push({ event, context }) }],
      handler: ({ actionId, payload, scope, claimedBlobs }) => {
        handled.push({ actionId, blob: payload.blob });
        claimed.push(claimedBlobs.blob);
        return [{ type: 'File.created', scope, data: { id: 'f1', blob: payload.blob, file: { id: 'f1' } } }];
      },
    }],
    blobLifecycle: {
      fields: [declaredBlobField({
        actionName: 'File.upload', field: 'blob', resourceField: 'id',
        owningResource: 'File', erasureCategory: 'deletable',
        canonicalEventMetadata: { byteLength: ['file', 'size'], mediaType: ['file', 'mime'] },
      })],
      pendingTtlMs: 60_000,
      adoptedRecoveryTtlMs: 1,
    },
  });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const stager = pendingBlobStager(app, principal({ type: 'user', id: 'u1' }));
  const staged = await stager.stage({ scopeId: 'project:p1', resourceId: 'f1', bytes: new Uint8Array([7, 8]), mediaType: 'application/octet-stream' });
  const outcome = await app.dispatch({ actionId: 'upload-1', type: 'File.upload', scope: 'project:p1', payload: { id: 'f1', blob: staged.claim }, principal: principal({ type: 'user', id: 'u1' }) });
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  const blobId = app.db.prepare('SELECT blobId FROM _PendingBlob WHERE pendingKey = ?').get(staged.pendingKey).blobId;
  assert.deepEqual(handled, [{ actionId: 'upload-1', blob: blobId }]);
  assert.equal(projected[0].event.data.blob, blobId, 'projections receive the canonical blob id, not a pending claim');
  assert.deepEqual(claimed, [{ blobId, resourceId: 'f1', sha256: staged.contentDigest, md5: '31540cf0b21cd8513d3dbc7192d8cad1', byteLength: 2, mediaType: 'application/octet-stream' }]);
  assert.deepEqual(projected[0].context.claimedBlobs.blob, claimed[0], 'projection receives the same transaction-bound package attestation');
  assert.deepEqual(projected[0].event.data.file, { id: 'f1', size: 2, mime: 'application/octet-stream' }, 'projection receives replay-required package-written domain metadata');
  const persisted = app.db.prepare('SELECT eventData FROM _Log WHERE actionId = ?').get('upload-1').eventData;
  assert.deepEqual(JSON.parse(persisted), { id: 'f1', blob: blobId, file: { id: 'f1', size: 2, mime: 'application/octet-stream' } }, 'the replay fact contains only declared canonical metadata');
  assert.equal(persisted.includes(staged.claim.claimToken), false);
  assert.equal(persisted.includes(staged.pendingKey), false);
  assert.equal(persisted.includes(staged.contentDigest), false);
  assert.equal(JSON.stringify(outcome).includes(staged.contentDigest), false, 'delivery-shaped dispatch output excludes private digests');
  const receipt = app.db.prepare('SELECT actionData FROM _ActionReceipt WHERE actionId = ?').get('upload-1').actionData;
  assert.deepEqual(JSON.parse(receipt), { id: 'f1', blob: blobId });
  assert.equal(receipt.includes(staged.contentDigest), false);
  assert.equal(app.db.prepare('SELECT status FROM _PendingBlob WHERE pendingKey = ?').get(staged.pendingKey).status, 'finalized');
  const duplicate = await app.dispatch({ actionId: 'upload-2', type: 'File.upload', scope: 'project:p1', payload: { id: 'f1', blob: staged.claim }, principal: principal({ type: 'user', id: 'u1' }) });
  assert.equal(duplicate.ok, false);
});

test('a failed duplicate staging request leaves an unrelated pending blob intact', async (t) => {
  const db = new DatabaseSync(':memory:');
  const root = mkdtempSync(path.join(tmpdir(), 'workbench-pending-'));
  const app = workbench({
    db,
    blobs: { root },
    blobLifecycle: { fields: [declaredBlobField({ actionName: 'File.upload', field: 'blob', resourceField: 'id', owningResource: 'File', erasureCategory: 'deletable' })], pendingTtlMs: 60_000, adoptedRecoveryTtlMs: 60_000 },
  });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const stager = pendingBlobStager(app, principal({ type: 'user', id: 'u1' }));
  const first = await stager.stage({ scopeId: 'project:p1', resourceId: 'first', bytes: new Uint8Array([1]) });
  await stager.stage({ scopeId: 'project:p1', resourceId: 'second', bytes: new Uint8Array([2]) });
  await assert.rejects(stager.stage({ scopeId: 'project:p1', resourceId: 'second', bytes: new Uint8Array([3]) }), /PENDING_KEY_EXISTS/);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM _PendingBlob').get().count, 2);
  assert.deepEqual(app.blobs.readPending(app.db.prepare('SELECT blobId FROM _PendingBlob WHERE pendingKey = ?').get(first.pendingKey).blobId), Buffer.from([1]));
});

test('declared deletion is authorized, idempotent, and makes claimed bytes unavailable', async (t) => {
  const db = new DatabaseSync(':memory:');
  const root = mkdtempSync(path.join(tmpdir(), 'workbench-pending-'));
  const app = workbench({
    db,
    blobs: { root },
    actions: [
      { type: 'File.upload', authorize: () => true, projections: [{ eventTypes: ['File.created'], apply: () => {} }], handler: ({ payload, scope }) => [{ type: 'File.created', scope, data: { blob: payload.blob } }] },
      { type: 'File.purge', authorize: ({ principal }) => principal?.id === 'u1', projections: [{ eventTypes: ['File.deleted'], apply: () => {} }], handler: ({ scope }) => [{ type: 'File.deleted', scope, data: {} }] },
    ],
    blobLifecycle: {
      fields: [declaredBlobField({ actionName: 'File.upload', field: 'blob', resourceField: 'id', owningResource: 'File', erasureCategory: 'deletable', purgeActionName: 'File.purge' })],
      pendingTtlMs: 60_000, adoptedRecoveryTtlMs: 1,
    },
  });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const stager = pendingBlobStager(app, principal({ type: 'user', id: 'u1' }));
  const staged = await stager.stage({ scopeId: 'project:p1', resourceId: 'f1', bytes: new Uint8Array([7, 8]) });
  const committed = await app.dispatch({ actionId: 'upload', type: 'File.upload', scope: 'project:p1', payload: { id: 'f1', blob: staged.claim }, principal: principal({ type: 'user', id: 'u1' }) });
  assert.equal(committed.ok, true, JSON.stringify(committed));
  const blobId = app.db.prepare('SELECT blobId FROM _PendingBlob WHERE pendingKey = ?').get(staged.pendingKey).blobId;
  assert.deepEqual(readClaimedBlob(app, blobId), Buffer.from([7, 8]));
  assert.equal((await app.dispatch({ actionId: 'denied', type: 'File.purge', scope: 'project:p1', payload: { id: 'f1', blob: { blobId } }, principal: principal({ type: 'user', id: 'u2' }) })).ok, false);
  assert.equal((await app.dispatch({ actionId: 'delete', type: 'File.purge', scope: 'project:p1', payload: { id: 'f1', blob: { blobId } }, principal: principal({ type: 'user', id: 'u1' }) })).ok, true);
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
    blobLifecycle: { fields: [declaredBlobField({ actionName: 'File.upload', field: 'blob', resourceField: 'id', owningResource: 'File', erasureCategory: 'deletable' })], pendingTtlMs: 60_000, adoptedRecoveryTtlMs: 60_000 },
  });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const actor = principal({ type: 'user', id: 'u1' });
  const staged = await pendingBlobStager(app, actor).stage({ scopeId: 'project:p1', resourceId: 'f1', bytes: new Uint8Array([1]) });
  assert.equal((await app.dispatch({ actionId: 'upload', type: 'File.upload', scope: 'project:p1', payload: { id: 'f1', blob: staged.claim }, principal: actor })).ok, true);
  const blobId = db.prepare('SELECT blobId FROM _PendingBlob WHERE pendingKey = ?').get(staged.pendingKey).blobId;
  assert.deepEqual(await app.blobs.reap({ ttl: 0, census: app.blobCensus }), { orphans: 0, danglers: 0 });
  assert.deepEqual(readClaimedBlob(app, blobId), Buffer.from([1]));
});

test('the ordinary blob reaper retains a staged generation until its claim expires', async (t) => {
  const db = new DatabaseSync(':memory:');
  const root = mkdtempSync(path.join(tmpdir(), 'workbench-pending-'));
  const app = workbench({ db, blobs: { root }, blobLifecycle: { fields: [declaredBlobField({ actionName: 'File.upload', field: 'blob', resourceField: 'id', owningResource: 'File', erasureCategory: 'deletable' })], pendingTtlMs: 60_000, adoptedRecoveryTtlMs: 60_000 } });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const staged = await pendingBlobStager(app, principal({ type: 'user', id: 'u1' })).stage({ scopeId: 'project:p1', resourceId: 'f1', bytes: new Uint8Array([1]) });
  assert.deepEqual(await app.blobs.reap({ ttl: -1, census: app.blobCensus }), { orphans: 0, danglers: 0 });
  assert.ok(db.prepare('SELECT 1 FROM _PendingBlob WHERE pendingKey = ?').get(staged.pendingKey));
});

test('principals receive independent staging slots for the same scope and resource', async (t) => {
  const db = new DatabaseSync(':memory:');
  const root = mkdtempSync(path.join(tmpdir(), 'workbench-pending-'));
  const app = workbench({ db, blobs: { root }, blobLifecycle: { fields: [declaredBlobField({ actionName: 'File.upload', field: 'blob', resourceField: 'id', owningResource: 'File', erasureCategory: 'deletable' })], pendingTtlMs: 60_000, adoptedRecoveryTtlMs: 60_000 } });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const first = await pendingBlobStager(app, principal({ type: 'user', id: 'u1' })).stage({ scopeId: 'project:p1', resourceId: 'f1', bytes: new Uint8Array([1]) });
  const second = await pendingBlobStager(app, principal({ type: 'user', id: 'u2' })).stage({ scopeId: 'project:p1', resourceId: 'f1', bytes: new Uint8Array([2]) });
  assert.notEqual(first.pendingKey, second.pendingKey);
});

test('claims are scope-bound and action authorization runs before claiming', async (t) => {
  const db = new DatabaseSync(':memory:');
  const root = mkdtempSync(path.join(tmpdir(), 'workbench-pending-'));
  let handled = 0;
  const app = workbench({
    db, blobs: { root },
    actions: [{ type: 'File.upload', authorize: ({ principal }) => principal.id === 'u1', handler: ({ payload, scope }) => { handled++; return [{ type: 'File.created', scope, data: { blob: payload.blob } }]; } }],
    blobLifecycle: { fields: [declaredBlobField({ actionName: 'File.upload', field: 'blob', resourceField: 'id', owningResource: 'File', erasureCategory: 'deletable' })], pendingTtlMs: 60_000, adoptedRecoveryTtlMs: 60_000 },
  });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const staged = await pendingBlobStager(app, principal({ type: 'user', id: 'u1' })).stage({ scopeId: 'project:p1', resourceId: 'f1', bytes: new Uint8Array([1]) });
  assert.equal((await app.dispatch({ actionId: 'foreign', type: 'File.upload', scope: 'project:p2', payload: { id: 'f1', blob: staged.claim }, principal: principal({ type: 'user', id: 'u1' }) })).ok, false);
  assert.equal((await app.dispatch({ actionId: 'denied', type: 'File.upload', scope: 'project:p1', payload: { id: 'f1', blob: staged.claim }, principal: principal({ type: 'user', id: 'u2' }) })).ok, false);
  assert.equal(handled, 0);
  assert.equal(db.prepare('SELECT status FROM _PendingBlob WHERE pendingKey = ?').get(staged.pendingKey).status, 'pending');
});

test('a foreign principal with a valid token cannot claim a staged blob', async (t) => {
  const db = new DatabaseSync(':memory:');
  const root = mkdtempSync(path.join(tmpdir(), 'workbench-pending-'));
  const app = workbench({ db, blobs: { root }, actions: [{ type: 'File.upload', authorize: () => true, handler: () => [] }], blobLifecycle: { fields: [declaredBlobField({ actionName: 'File.upload', field: 'blob', resourceField: 'id', owningResource: 'File', erasureCategory: 'deletable' })], pendingTtlMs: 60_000, adoptedRecoveryTtlMs: 60_000 } });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const staged = await pendingBlobStager(app, principal({ type: 'user', id: 'u1' })).stage({ scopeId: 'project:p1', resourceId: 'f1', bytes: new Uint8Array([1]) });
  assert.equal((await app.dispatch({ actionId: 'stolen', type: 'File.upload', scope: 'project:p1', payload: { id: 'f1', blob: staged.claim }, principal: principal({ type: 'user', id: 'u2' }) })).ok, false);
  assert.equal(db.prepare('SELECT status FROM _PendingBlob WHERE pendingKey = ?').get(staged.pendingKey).status, 'pending');
});

test('a claimed blob cannot be replayed under its action id in a foreign scope', async (t) => {
  const db = new DatabaseSync(':memory:');
  const root = mkdtempSync(path.join(tmpdir(), 'workbench-pending-'));
  const app = workbench({
    db, blobs: { root },
    actions: [{ type: 'File.upload', authorize: () => true, projections: [{ eventTypes: ['File.created'], apply: () => {} }], handler: ({ payload, scope }) => [{ type: 'File.created', scope, data: { blob: payload.blob } }] }],
    blobLifecycle: { fields: [declaredBlobField({ actionName: 'File.upload', field: 'blob', resourceField: 'id', owningResource: 'File', erasureCategory: 'deletable' })], pendingTtlMs: 60_000, adoptedRecoveryTtlMs: 60_000 },
  });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const staged = await pendingBlobStager(app, principal({ type: 'user', id: 'u1' })).stage({ scopeId: 'project:p1', resourceId: 'f1', bytes: new Uint8Array([1]) });
  assert.equal((await app.dispatch({ actionId: 'upload', type: 'File.upload', scope: 'project:p1', payload: { id: 'f1', blob: staged.claim }, principal: principal({ type: 'user', id: 'u1' }) })).ok, true);
  assert.equal((await app.dispatch({ actionId: 'upload', type: 'File.upload', scope: 'project:p2', payload: { id: 'f1', blob: staged.claim }, principal: principal({ type: 'user', id: 'u1' }) })).ok, false);
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
    blobLifecycle: { fields: [declaredBlobField({ actionName: 'File.upload', field: 'blob', resourceField: 'id', owningResource: 'File', erasureCategory: 'deletable' })], pendingTtlMs: 60_000, adoptedRecoveryTtlMs: 60_000 },
  });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const actor = principal({ type: 'user', id: 'u1' });
  const staged = await pendingBlobStager(app, actor).stage({ scopeId: 'project:p1', resourceId: 'f1', bytes: new Uint8Array([1]) });
  const outcomes = await Promise.all(['first', 'second'].map((actionId) => app.dispatch({ actionId, type: 'File.upload', scope: 'project:p1', payload: { id: 'f1', blob: staged.claim }, principal: actor })));
  assert.equal(outcomes.filter((outcome) => outcome.ok).length, 1);
  assert.equal(handled, 1);
});

test('permanent erasure does not implicitly remove declared blob bytes', async (t) => {
  const db = new DatabaseSync(':memory:');
  const root = mkdtempSync(path.join(tmpdir(), 'workbench-pending-'));
  const app = workbench({
    db, blobs: { root },
    actions: [{ type: 'File.upload', authorize: () => true, projections: [{ eventTypes: ['File.created'], apply: () => {} }], handler: ({ payload, scope }) => [{ type: 'File.created', scope, data: { blob: payload.blob } }] }],
    blobLifecycle: { fields: [declaredBlobField({ actionName: 'File.upload', field: 'blob', resourceField: 'id', owningResource: 'File', erasureCategory: 'deletable' })], pendingTtlMs: 60_000, adoptedRecoveryTtlMs: 60_000 },
  });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const actor = principal({ type: 'user', id: 'u1' });
  const staged = await pendingBlobStager(app, actor).stage({ scopeId: 'project:p1', resourceId: 'f1', bytes: new Uint8Array([1]) });
  assert.equal((await app.dispatch({ actionId: 'upload', type: 'File.upload', scope: 'project:p1', payload: { id: 'f1', blob: staged.claim }, principal: actor })).ok, true);
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
    blobLifecycle: { fields: [declaredBlobField({ actionName: 'File.upload', field: 'blob', resourceField: 'id', owningResource: 'File', erasureCategory: 'deletable' })], pendingTtlMs: 60_000, adoptedRecoveryTtlMs: 60_000 },
  });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const staged = await pendingBlobStager(app, principal({ type: 'user', id: 'u1' })).stage({ scopeId: 'project:p1', resourceId: 'f1', bytes: new Uint8Array([1]) });
  assert.equal((await app.dispatch({ actionId: 'upload', type: 'File.upload', scope: 'project:p1', payload: { id: 'f1', blob: staged.claim }, principal: principal({ type: 'user', id: 'u1' }) })).ok, false);
  assert.equal(db.prepare('SELECT status FROM _PendingBlob WHERE pendingKey = ?').get(staged.pendingKey).status, 'pending');
  fail = false;
  assert.equal((await app.dispatch({ actionId: 'upload', type: 'File.upload', scope: 'project:p1', payload: { id: 'f1', blob: staged.claim }, principal: principal({ type: 'user', id: 'u1' }) })).ok, true);
  assert.equal((await app.dispatch({ actionId: 'upload', type: 'File.upload', scope: 'project:p1', payload: { id: 'f1', blob: staged.claim }, principal: principal({ type: 'user', id: 'u1' }) })).deduped, true);
  assert.equal(handled, 2);
});

test('missing and expired claims fail before the handler', async (t) => {
  const db = new DatabaseSync(':memory:');
  const root = mkdtempSync(path.join(tmpdir(), 'workbench-pending-'));
  let handled = 0;
  const app = workbench({
    db, blobs: { root },
    actions: [{ type: 'File.upload', authorize: () => true, handler: () => { handled++; return []; } }],
    blobLifecycle: { fields: [declaredBlobField({ actionName: 'File.upload', field: 'blob', resourceField: 'id', owningResource: 'File', erasureCategory: 'deletable' })], pendingTtlMs: 0, adoptedRecoveryTtlMs: 60_000 },
  });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const actor = principal({ type: 'user', id: 'u1' });
  assert.equal((await app.dispatch({ actionId: 'missing', type: 'File.upload', scope: 'project:p1', payload: { id: 'f1' }, principal: actor })).ok, false);
  const staged = await pendingBlobStager(app, actor).stage({ scopeId: 'project:p1', resourceId: 'f1', bytes: new Uint8Array([1]) });
  assert.equal((await app.dispatch({ actionId: 'expired', type: 'File.upload', scope: 'project:p1', payload: { id: 'f1', blob: staged.claim }, principal: actor })).ok, false);
  assert.equal(handled, 0);
});

test('the receipt stores only the canonical blob id', async (t) => {
  const db = new DatabaseSync(':memory:');
  const root = mkdtempSync(path.join(tmpdir(), 'workbench-pending-'));
  const app = workbench({
    db, blobs: { root },
    actions: [{ type: 'File.upload', authorize: () => true, projections: [{ eventTypes: ['File.created'], apply: () => {} }], handler: ({ payload, scope }) => [{ type: 'File.created', scope, data: { blob: payload.blob } }] }],
    blobLifecycle: { fields: [declaredBlobField({ actionName: 'File.upload', field: 'blob', resourceField: 'id', owningResource: 'File', erasureCategory: 'deletable' })], pendingTtlMs: 60_000, adoptedRecoveryTtlMs: 60_000 },
  });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const actor = principal({ type: 'user', id: 'u1' });
  const staged = await pendingBlobStager(app, actor).stage({ scopeId: 'project:p1', resourceId: 'f1', bytes: new Uint8Array([1]) });
  const committed = await app.dispatch({ actionId: 'upload', type: 'File.upload', scope: 'project:p1', payload: { id: 'f1', blob: staged.claim }, principal: actor });
  assert.equal(committed.ok, true, JSON.stringify(committed));
  const receipt = db.prepare("SELECT actionData FROM _ActionReceipt WHERE actionId = 'upload'").get();
  const blobId = db.prepare('SELECT blobId FROM _PendingBlob WHERE pendingKey = ?').get(staged.pendingKey).blobId;
  assert.deepEqual(JSON.parse(receipt.actionData), { id: 'f1', blob: blobId });
  assert.equal(receipt.actionData.includes(staged.claim.claimToken), false);
  assert.equal(receipt.actionData.includes(staged.pendingKey), false);
});

test('a staged claim cannot be attached to a different resource identity', async (t) => {
  const db = new DatabaseSync(':memory:');
  const root = mkdtempSync(path.join(tmpdir(), 'workbench-pending-'));
  let handled = 0;
  const app = workbench({
    db, blobs: { root },
    actions: [{ type: 'File.upload', authorize: () => true, handler: () => { handled++; return []; } }],
    blobLifecycle: { fields: [declaredBlobField({ actionName: 'File.upload', field: 'blob', resourceField: 'id', owningResource: 'File', erasureCategory: 'deletable' })], pendingTtlMs: 60_000, adoptedRecoveryTtlMs: 60_000 },
  });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const actor = principal({ type: 'user', id: 'u1' });
  const staged = await pendingBlobStager(app, actor).stage({ scopeId: 'project:p1', resourceId: 'f1', bytes: new Uint8Array([1]) });
  const outcome = await app.dispatch({ actionId: 'forged-resource', type: 'File.upload', scope: 'project:p1', payload: { id: 'f2', blob: staged.claim }, principal: actor });
  assert.equal(outcome.ok, false);
  assert.equal(handled, 0);
  assert.equal(db.prepare('SELECT status FROM _PendingBlob WHERE pendingKey = ?').get(staged.pendingKey).status, 'pending');
});

test('claimed blob metadata cannot be serialized through a post-commit effect', async (t) => {
  const db = new DatabaseSync(':memory:');
  const root = mkdtempSync(path.join(tmpdir(), 'workbench-pending-'));
  const app = workbench({
    db, blobs: { root },
    actions: [{
      type: 'File.upload', authorize: () => true,
      handler: ({ claimedBlobs }) => ({
        events: [{ type: 'File.created', scope: 'project:p1', data: { blob: claimedBlobs.blob.blobId } }],
        privateFact: { before: {}, after: {} },
        effects: [{ file: 'scope', operation: 'index', verification: 'v1', payload: {
          resourceId: claimedBlobs.blob.resourceId,
          sha256: claimedBlobs.blob.sha256,
          md5: claimedBlobs.blob.md5,
          byteLength: claimedBlobs.blob.byteLength,
          mediaType: claimedBlobs.blob.mediaType,
        } }],
      }),
    }],
    blobLifecycle: { fields: [declaredBlobField({ actionName: 'File.upload', field: 'blob', resourceField: 'id', owningResource: 'File', erasureCategory: 'deletable' })], pendingTtlMs: 60_000, adoptedRecoveryTtlMs: 60_000 },
  });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const actor = principal({ type: 'user', id: 'u1' });
  const staged = await pendingBlobStager(app, actor).stage({ scopeId: 'project:p1', resourceId: 'f1', bytes: new Uint8Array([1]) });
  const outcome = await app.dispatch({ actionId: 'leak', type: 'File.upload', scope: 'project:p1', payload: { id: 'f1', blob: staged.claim }, principal: actor });
  assert.equal(outcome.ok, false);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM _PostCommitEffect WHERE actionId = 'leak'").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM _Log WHERE actionId = 'leak'").get().count, 0);
  assert.equal(db.prepare('SELECT status FROM _PendingBlob WHERE pendingKey = ?').get(staged.pendingKey).status, 'pending');
});

test('renaming a copied claimed digest in an event does not bypass attestation non-leakage', async (t) => {
  const db = new DatabaseSync(':memory:');
  const root = mkdtempSync(path.join(tmpdir(), 'workbench-pending-'));
  const app = workbench({
    db, blobs: { root },
    actions: [{
      type: 'File.upload', authorize: () => true,
      handler: ({ payload, scope, claimedBlobs }) => [{ type: 'File.created', scope, data: {
        blob: payload.blob, file: { digest: claimedBlobs.blob.sha256 },
      } }],
    }],
    blobLifecycle: { fields: [declaredBlobField({ actionName: 'File.upload', field: 'blob', resourceField: 'id', owningResource: 'File', erasureCategory: 'deletable' })], pendingTtlMs: 60_000, adoptedRecoveryTtlMs: 60_000 },
  });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const actor = principal({ type: 'user', id: 'u1' });
  const staged = await pendingBlobStager(app, actor).stage({ scopeId: 'project:p1', resourceId: 'f1', bytes: new Uint8Array([1]) });
  const outcome = await app.dispatch({ actionId: 'renamed-leak', type: 'File.upload', scope: 'project:p1', payload: { id: 'f1', blob: staged.claim }, principal: actor });
  assert.equal(outcome.ok, false);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM _Log WHERE actionId = 'renamed-leak'").get().count, 0);
});

test('blob declarations reject policy callbacks and other unknown keys', () => {
  assert.throws(() => declaredBlobField({ actionName: 'File.upload', field: 'blob', resourceField: 'id', owningResource: 'File', erasureCategory: 'deletable', validator: () => true }), /requires actionName, field, resourceField, owningResource, and erasureCategory/);
  assert.throws(() => declaredBlobField({ actionName: 'File.upload', field: 'blob', resourceField: 'id', owningResource: 'File', erasureCategory: 'deletable', canonicalEventMetadata: { sha256: ['file', 'sha256'] } }), /requires actionName, field, resourceField, owningResource, and erasureCategory/);
  assert.throws(() => declaredBlobField({ actionName: 'File.upload', field: 'blob', resourceField: 'id', owningResource: 'File', erasureCategory: 'deletable', canonicalEventMetadata: { byteLength: ['file', '__proto__'] } }), /requires actionName, field, resourceField, owningResource, and erasureCategory/);
  // S6 #4: a declared blob field without an owning resource or erasure category fails validation.
  assert.throws(() => declaredBlobField({ actionName: 'File.upload', field: 'blob', resourceField: 'id' }), /requires actionName, field, resourceField, owningResource, and erasureCategory/);
});

test('pending bytes are served only through the uploader claim — no generic fallback (S6/A4)', async (t) => {
  const db = new DatabaseSync(':memory:');
  const root = mkdtempSync(path.join(tmpdir(), 'workbench-pending-'));
  const app = workbench({
    db, blobs: { root },
    actions: [{ type: 'File.upload', authorize: () => true, projections: [{ eventTypes: ['File.created'], apply: () => {} }], handler: ({ payload, scope }) => [{ type: 'File.created', scope, data: { blob: payload.blob } }] }],
    blobLifecycle: { fields: [declaredBlobField({ actionName: 'File.upload', field: 'blob', resourceField: 'id', owningResource: 'File', erasureCategory: 'deletable' })], pendingTtlMs: 60_000, adoptedRecoveryTtlMs: 60_000 },
  });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const actor = principal({ type: 'user', id: 'u1' });
  const staged = await pendingBlobStager(app, actor).stage({ scopeId: 'project:p1', resourceId: 'f1', bytes: new Uint8Array([7, 8]), mediaType: 'application/octet-stream' });
  const blobId = db.prepare('SELECT blobId FROM _PendingBlob WHERE pendingKey = ?').get(staged.pendingKey).blobId;

  // Unclaimed: the blob id alone never serves bytes at the framework seam — the
  // generic read must not fall back to pending, and the claim reader refuses
  // a generation the claim was never admitted for.
  assert.throws(() => app.blobs.readRange(blobId), /blob not found/, 'no generic final-slot read of pending bytes');
  assert.throws(() => readClaimedBlob(app, blobId), /BLOB_UNAVAILABLE/, 'the claim reader refuses an unclaimed generation');

  // The claim IS the admission: after validateClaim the uploader previews the
  // still-pending bytes through the claim-gated reader.
  const claimed = await app.pendingBlobLifecycle.validateClaim({
    claim: staged.claim, field: 'blob', resourceId: 'f1', actionName: 'File.upload',
    actionId: 'upload-1', authenticatedPrincipal: actor, scopeId: 'project:p1', committedEventId: 'event-1',
  });
  assert.equal(claimed.blobId, blobId);
  assert.deepEqual(readClaimedBlob(app, blobId), Buffer.from([7, 8]), 'the uploader previews pending bytes through the claim');
  assert.deepEqual(app.pendingBlobLifecycle.readClaimed(blobId, [1, 2]), Buffer.from([8]), 'ranged claim reads work pre-finalize');

  // Finalized: the claim-gated reader serves the promoted final bytes.
  await app.pendingBlobLifecycle.reconcile();
  assert.deepEqual(readClaimedBlob(app, blobId), Buffer.from([7, 8]), 'finalized bytes still serve through the claim reader');
});

test('crash-window recovery falls back to the final slot even when the backend phrases its missing-slot error differently', async (t) => {
  const db = new DatabaseSync(':memory:');
  const root = mkdtempSync(path.join(tmpdir(), 'workbench-pending-'));
  // A conforming backend whose missing-slot signal uses an ENOENT-style
  // message instead of the default 'blob not found' text. The claim machinery
  // must branch on the TYPED signal (BlobSlotNotFoundError), never a message
  // string — a conforming backend phrases the message however it likes.
  const backing = memoryBlobs();
  const enoentStore = {
    ...backing,
    readPending(id, range) {
      if (!backing.exists(id, { pending: true })) throw new BlobSlotNotFoundError(`ENOENT: no such file or directory, blob '${id}'`);
      return backing.readPending(id, range);
    },
    readRange(id, range) {
      if (!backing.exists(id, { pending: false })) throw new BlobSlotNotFoundError(`ENOENT: no such file or directory, blob '${id}'`);
      return backing.readRange(id, range);
    },
  };
  const app = workbench({
    db,
    blobs: enoentStore,
    blobLifecycle: { fields: [declaredBlobField({ actionName: 'File.upload', field: 'blob', resourceField: 'id', owningResource: 'File', erasureCategory: 'deletable' })], pendingTtlMs: 60_000, adoptedRecoveryTtlMs: 1 },
  });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const actor = principal({ type: 'user', id: 'u1' });
  const staged = await pendingBlobStager(app, actor).stage({ scopeId: 'project:p1', resourceId: 'f1', bytes: new Uint8Array([7, 8]) });
  const blobId = db.prepare('SELECT blobId FROM _PendingBlob WHERE pendingKey = ?').get(staged.pendingKey).blobId;
  const claimed = await app.pendingBlobLifecycle.validateClaim({
    claim: staged.claim, field: 'blob', resourceId: 'f1', actionName: 'File.upload',
    actionId: 'upload-1', authenticatedPrincipal: actor, scopeId: 'project:p1', committedEventId: 'event-1',
  });
  assert.equal(claimed.blobId, blobId);
  assert.deepEqual(readClaimedBlob(app, blobId), Buffer.from([7, 8]), 'pending bytes serve through the claim');

  // Crash window: the bytes were finalized (pending slot gone, final slot
  // holds them) but the durable status UPDATE was lost. reconcile must still
  // serve the bytes by falling back to the final slot — even though this
  // backend reports the missing pending slot with an ENOENT-style message.
  app.blobs.finalize(blobId);
  await app.pendingBlobLifecycle.reconcile();
  assert.equal(db.prepare('SELECT status FROM _PendingBlob WHERE blobId = ?').get(blobId).status, 'finalized', 'the claimed generation is finalized after the fallback');
  assert.deepEqual(readClaimedBlob(app, blobId), Buffer.from([7, 8]), 'finalized bytes still serve through the claim reader');
});

test('a content hash is never an access token (S6/A4 #4)', async (t) => {
  const db = new DatabaseSync(':memory:');
  const root = mkdtempSync(path.join(tmpdir(), 'workbench-pending-'));
  const app = workbench({
    db, blobs: { root },
    actions: [{ type: 'File.upload', authorize: () => true, projections: [{ eventTypes: ['File.created'], apply: () => {} }], handler: ({ payload, scope }) => [{ type: 'File.created', scope, data: { blob: payload.blob } }] }],
    blobLifecycle: { fields: [declaredBlobField({ actionName: 'File.upload', field: 'blob', resourceField: 'id', owningResource: 'File', erasureCategory: 'deletable' })], pendingTtlMs: 60_000, adoptedRecoveryTtlMs: 60_000 },
  });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const actor = principal({ type: 'user', id: 'u1' });
  const staged = await pendingBlobStager(app, actor).stage({ scopeId: 'project:p1', resourceId: 'f1', bytes: new Uint8Array([7, 8]) });

  // The sha256 digest (and the pending key) are integrity/locator metadata, not
  // credentials: submitting a digest where the claim token belongs fails
  // admission exactly like any forged claim.
  const digestAsToken = await app.dispatch({
    actionId: 'digest-as-token', type: 'File.upload', scope: 'project:p1',
    payload: { id: 'f1', blob: { pendingKey: staged.pendingKey, claimToken: staged.contentDigest } }, principal: actor,
  });
  assert.equal(digestAsToken.ok, false, 'the content digest never acts as a claim token');
  const pendingKeyAsToken = await app.dispatch({
    actionId: 'pendingkey-as-token', type: 'File.upload', scope: 'project:p1',
    payload: { id: 'f1', blob: { pendingKey: staged.claimToken, claimToken: staged.claimToken } }, principal: actor,
  });
  assert.equal(pendingKeyAsToken.ok, false, 'a hash/locator never admits a claim on its own');
  assert.equal(db.prepare('SELECT status FROM _PendingBlob WHERE pendingKey = ?').get(staged.pendingKey).status, 'pending', 'nothing was claimed with a forged credential');

  // The genuine claim still works — the digest did not corrupt or expose the row.
  const genuine = await app.dispatch({
    actionId: 'genuine', type: 'File.upload', scope: 'project:p1',
    payload: { id: 'f1', blob: staged.claim }, principal: actor,
  });
  assert.equal(genuine.ok, true, JSON.stringify(genuine));
});

test('the delete path routes a deleted generation through the S1/A6 recycle seam (S6/A5)', async (t) => {
  const db = new DatabaseSync(':memory:');
  const root = mkdtempSync(path.join(tmpdir(), 'workbench-pending-'));
  const binned = [];
  const app = workbench({
    db, blobs: { root },
    actions: [
      { type: 'File.upload', authorize: () => true, projections: [{ eventTypes: ['File.created'], apply: () => {} }], handler: ({ payload, scope }) => [{ type: 'File.created', scope, data: { blob: payload.blob } }] },
      { type: 'File.purge', authorize: () => true, projections: [{ eventTypes: ['File.deleted'], apply: () => {} }], handler: ({ scope }) => [{ type: 'File.deleted', scope, data: {} }] },
    ],
    blobLifecycle: {
      fields: [declaredBlobField({ actionName: 'File.upload', field: 'blob', resourceField: 'id', owningResource: 'File', erasureCategory: 'deletable', purgeActionName: 'File.purge' })],
      pendingTtlMs: 60_000, adoptedRecoveryTtlMs: 60_000,
    },
  });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });
  app.blobRecycleSeam = { bin: async (deletion) => { binned.push(...deletion.generations); return { ok: true }; } };

  const actor = principal({ type: 'user', id: 'u1' });
  const staged = await pendingBlobStager(app, actor).stage({ scopeId: 'project:p1', resourceId: 'f1', bytes: new Uint8Array([7, 8]) });
  assert.equal((await app.dispatch({ actionId: 'upload', type: 'File.upload', scope: 'project:p1', payload: { id: 'f1', blob: staged.claim }, principal: actor })).ok, true);
  const blobId = db.prepare('SELECT blobId FROM _PendingBlob WHERE pendingKey = ?').get(staged.pendingKey).blobId;
  assert.equal((await app.dispatch({ actionId: 'delete', type: 'File.purge', scope: 'project:p1', payload: { id: 'f1', blob: { blobId } }, principal: actor })).ok, true);

  await app.pendingBlobLifecycle.reconcile();
  assert.deepStrictEqual(binned, [blobId], 'the deleted generation was routed to the recycling bin');
  assert.equal(db.prepare('SELECT * FROM _PendingBlob WHERE blobId = ?').get(blobId), undefined, 'the deletion completed');
});

test('a failed recycle-bin route keeps the delete durable and the next sweep retries it', async (t) => {
  const db = new DatabaseSync(':memory:');
  const root = mkdtempSync(path.join(tmpdir(), 'workbench-pending-'));
  let binAttempts = 0;
  const app = workbench({
    db, blobs: { root },
    actions: [
      { type: 'File.upload', authorize: () => true, projections: [{ eventTypes: ['File.created'], apply: () => {} }], handler: ({ payload, scope }) => [{ type: 'File.created', scope, data: { blob: payload.blob } }] },
      { type: 'File.purge', authorize: () => true, projections: [{ eventTypes: ['File.deleted'], apply: () => {} }], handler: ({ scope }) => [{ type: 'File.deleted', scope, data: {} }] },
    ],
    blobLifecycle: {
      fields: [declaredBlobField({ actionName: 'File.upload', field: 'blob', resourceField: 'id', owningResource: 'File', erasureCategory: 'deletable', purgeActionName: 'File.purge' })],
      pendingTtlMs: 60_000, adoptedRecoveryTtlMs: 60_000,
    },
  });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });
  app.blobRecycleSeam = {
    bin: async (deletion) => {
      binAttempts++;
      if (binAttempts === 1) throw new Error('bin storage unavailable');
      return { ok: true };
    },
  };

  const actor = principal({ type: 'user', id: 'u1' });
  const staged = await pendingBlobStager(app, actor).stage({ scopeId: 'project:p1', resourceId: 'f1', bytes: new Uint8Array([1, 2]) });
  assert.equal((await app.dispatch({ actionId: 'upload', type: 'File.upload', scope: 'project:p1', payload: { id: 'f1', blob: staged.claim }, principal: actor })).ok, true);
  const blobId = db.prepare('SELECT blobId FROM _PendingBlob WHERE pendingKey = ?').get(staged.pendingKey).blobId;
  assert.equal((await app.dispatch({ actionId: 'delete', type: 'File.purge', scope: 'project:p1', payload: { id: 'f1', blob: { blobId } }, principal: actor })).ok, true);

  // The pending-blob consumer runs reconcile() post-commit inside the delete
  // dispatch, so the FIRST bin attempt happens there — it failed, so the
  // deletion stays durably requested for a later sweep to retry.
  const row = db.prepare('SELECT status, recoveryFailure FROM _PendingBlob WHERE blobId = ?').get(blobId);
  assert.equal(binAttempts, 1, 'the first bin attempt ran in the dispatch post-commit consumer');
  assert.equal(row.status, 'delete-requested', 'a failed bin keeps the delete durably requested');
  assert.ok(row.recoveryFailure, 'the bin failure is recorded for retry');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM BlobStore WHERE id = ?').get(blobId).count, 0, 'the live bytes were still removed (idempotent discard)');

  await app.pendingBlobLifecycle.reconcile();
  assert.equal(binAttempts, 2, 'the next sweep retries the bin');
  assert.equal(db.prepare('SELECT * FROM _PendingBlob WHERE blobId = ?').get(blobId), undefined, 'the deletion completed after the retry');
});

test('a deleted generation emits the derived-store deletion signal through the staleness contract (S6/A5)', async (t) => {
  const db = new DatabaseSync(':memory:');
  const root = mkdtempSync(path.join(tmpdir(), 'workbench-pending-'));
  const signals = [];
  const app = workbench({
    db, blobs: { root },
    actions: [
      { type: 'File.upload', authorize: () => true, projections: [{ eventTypes: ['File.created'], apply: () => {} }], handler: ({ payload, scope }) => [{ type: 'File.created', scope, data: { blob: payload.blob } }] },
      { type: 'File.purge', authorize: () => true, projections: [{ eventTypes: ['File.deleted'], apply: () => {} }], handler: ({ scope }) => [{ type: 'File.deleted', scope, data: {} }] },
    ],
    blobLifecycle: {
      fields: [declaredBlobField({ actionName: 'File.upload', field: 'blob', resourceField: 'id', owningResource: 'File', erasureCategory: 'deletable', purgeActionName: 'File.purge' })],
      pendingTtlMs: 60_000, adoptedRecoveryTtlMs: 60_000,
    },
  });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });
  app.searchStaleness = { notifySourceChange: (input) => { signals.push(input); return { recorded: true, priority: 'high', affected: 1 }; } };

  const actor = principal({ type: 'user', id: 'u1' });
  const staged = await pendingBlobStager(app, actor).stage({ scopeId: 'project:p1', resourceId: 'f1', bytes: new Uint8Array([9]) });
  assert.equal((await app.dispatch({ actionId: 'upload', type: 'File.upload', scope: 'project:p1', payload: { id: 'f1', blob: staged.claim }, principal: actor })).ok, true);
  const blobId = db.prepare('SELECT blobId FROM _PendingBlob WHERE pendingKey = ?').get(staged.pendingKey).blobId;
  assert.equal((await app.dispatch({ actionId: 'delete', type: 'File.purge', scope: 'project:p1', payload: { id: 'f1', blob: { blobId } }, principal: actor })).ok, true);

  await app.pendingBlobLifecycle.reconcile();
  const signal = signals.find((s) => s.entity === 'BlobStore' && s.rowId === blobId);
  assert.ok(signal, 'the generation-level deletion signal was emitted');
  assert.equal(signal.kind, 'removed');
  assert.equal(signal.erasure, true);
  assert.equal(signal.priority, 'high');
  assert.ok(typeof signal.committedAt === 'string' && signal.committedAt.length > 0, 'the signal carries post-commit proof');
  assert.equal(db.prepare('SELECT * FROM _PendingBlob WHERE blobId = ?').get(blobId), undefined, 'the deletion completed only after the signal');
});

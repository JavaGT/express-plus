// pending-blob-stream.mjs — the streaming pending-slot reads (#738 W1).
//
// Two layers of proof, mirroring the buffered tests (blob-contract.test.mjs /
// fs-blobs.test.mjs for the byte store, pending-blob.test.mjs for the claim
// lifecycle):
// 1. ByteStore.readPendingStream against BOTH conforming backends — the
//    claimed-window download path streams PENDING-slot bytes with the same
//    range semantics as readRangeStream, throws the TYPED missing-slot error
//    synchronously (before any stream exists), validates bounds identically,
//    and cancels on an AbortSignal.
// 2. PendingBlobLifecycle.readClaimedStream — the same claim admission as
//    readClaimed ('claimed'/'finalized' rows only), the same pending→final
//    slot fallback keyed on the typed signal, and the same BLOB_UNAVAILABLE
//    collapse when a claimed generation's bytes are gone from BOTH slots.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import workbench, { principal } from '../build/index.mjs';
import { pendingBlobStager, declaredBlobField } from '../build/server.mjs';
import { fsBlobs, BlobSlotNotFoundError } from '../build/fs-blobs.mjs';
import { memoryBlobs } from '../build/memory-blobs.mjs';

const BYTES = Buffer.from('pending-stream-bytes');
const collect = async (stream) => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); };
const settle = (stream) => new Promise((resolve) => {
  let ended = false;
  stream.on('data', () => {});
  stream.on('end', () => { ended = true; resolve({ kind: 'end' }); });
  stream.on('error', (error) => { if (!ended) resolve({ kind: 'error', error }); });
});

// ─── 1. ByteStore.readPendingStream across both backends ────────────────────

function backendSessions() {
  return [
    {
      label: 'fsBlobs',
      make() {
        const root = mkdtempSync(path.join(tmpdir(), 'wb-pending-stream-fs-'));
        return { store: fsBlobs({ root }), dispose: () => rmSync(root, { recursive: true, force: true }) };
      },
    },
    {
      label: 'memoryBlobs',
      make() {
        return { store: memoryBlobs(), dispose: () => {} };
      },
    },
  ];
}

for (const { label, make } of backendSessions()) {
  test(`${label}: readPendingStream serves claimed-window bytes with the shared range semantics`, async () => {
    const { store, dispose } = make();
    try {
      store.writePending('g', BYTES);
      assert.deepEqual(await collect(store.readPendingStream('g')), BYTES, 'open-ended stream reads the whole pending slot');
      assert.deepEqual(await collect(store.readPendingStream('g', [8, 14])), Buffer.from('stream'), 'range [8,14) slices correctly');
      assert.deepEqual(await collect(store.readPendingStream('g', [0, Infinity])), BYTES, 'Infinity end streams to EOF');
      assert.deepEqual(await collect(store.readPendingStream('g', [5, 5])), Buffer.alloc(0), 'empty range is a valid empty stream');

      // The final slot stays untouched by a pending-slot stream — and an id in
      // the final slot only does NOT satisfy a pending read (S6/A4 parity).
      store.finalizePending('g');
      assert.deepEqual(await collect(store.readRangeStream('g')), BYTES, 'sanity: final stream exists post-promotion');
      assert.throws(() => store.readPendingStream('g'), BlobSlotNotFoundError, 'after promotion the pending slot is gone — typed signal');
    } finally {
      dispose();
    }
  });

  test(`${label}: readPendingStream throws the typed missing-slot error synchronously, BEFORE any stream exists`, () => {
    const { store, dispose } = make();
    try {
      let threw;
      try {
        store.readPendingStream('never-uploaded');
        threw = false;
      } catch (error) {
        threw = error instanceof BlobSlotNotFoundError; // typed, never message-string
      }
      assert.ok(threw, 'a missing pending slot throws BlobSlotNotFoundError synchronously');
    } finally {
      dispose();
    }
  });

  test(`${label}: readPendingStream validates bounds identically to the buffered reads`, async () => {
    const { store, dispose } = make();
    try {
      store.writePending('rng', BYTES);
      for (const range of [[-1, 5], [5, 2], [0, -5], [NaN, 5], [Infinity, Infinity]]) {
        assert.throws(() => store.readPendingStream('rng', range), /invalid blob range/, `bounds ${JSON.stringify(range)} rejected`);
      }
    } finally {
      dispose();
    }
  });

  test(`${label}: readPendingStream cancels on abort — pre-aborted signals error instead of delivering`, async () => {
    const { store, dispose } = make();
    try {
      store.writePending('cancel', Buffer.alloc(200_000, 7));
      const controller = new AbortController();
      controller.abort(); // pre-aborted: deterministic error path on both backends
      const result = await settle(store.readPendingStream('cancel', undefined, { signal: controller.signal }));
      assert.equal(result.kind, 'error', 'an aborted stream errors instead of ending');
      assert.match(result.error.message, /abort/i, 'the error is the AbortError shape');
    } finally {
      dispose();
    }
  });
}

// ─── 2. PendingBlobLifecycle.readClaimedStream ──────────────────────────────

function lifecycleApp(t) {
  const db = new DatabaseSync(':memory:');
  const root = mkdtempSync(path.join(tmpdir(), 'workbench-pending-stream-'));
  const app = workbench({
    db,
    blobs: { root },
    blobLifecycle: { fields: [declaredBlobField({ actionName: 'File.upload', field: 'blob', resourceField: 'id', owningResource: 'File', erasureCategory: 'deletable' })], pendingTtlMs: 60_000, adoptedRecoveryTtlMs: 0 },
  });
  return app.start().then(() => {
    t.after(async () => { await app.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });
    return app;
  });
}

async function stageAndClaim(app, actor = principal({ type: 'user', id: 'u1' })) {
  const staged = await pendingBlobStager(app, actor).stage({ scopeId: 'project:p1', resourceId: 'f1', bytes: BYTES });
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
  return { blobId: claimed.blobId, actor };
}

test('readClaimedStream serves the CLAIMED generation from its pending slot (claimed window)', async (t) => {
  const app = await lifecycleApp(t);
  const { blobId } = await stageAndClaim(app);

  // The row is 'claimed' and finalize has not run: the bytes still live in the
  // pending slot — exactly the window workers download in.
  assert.equal(app.pendingBlobLifecycle.status(blobId), 'claimed');
  const pendingPath = app.blobs._pathFor(blobId, { pending: true });
  assert.ok(statSync(pendingPath), 'pending slot present');
  assert.deepEqual(await collect(app.pendingBlobLifecycle.readClaimedStream(blobId)), BYTES);
  assert.deepEqual(await collect(app.pendingBlobLifecycle.readClaimedStream(blobId, [8, 14])), Buffer.from('stream'));
});

test('readClaimedStream falls back to the FINAL slot once the pending slot is gone', async (t) => {
  const app = await lifecycleApp(t);
  const { blobId } = await stageAndClaim(app);

  // Reconcile promotes pending → final (twice, like the buffered lifecycle
  // test): the pending slot is gone, but a claimed/finalized row must still be
  // downloadable through the SAME seam.
  const facade = { reconcile: () => app.writeQueue.run(() => app.pendingBlobLifecycle.reconcile()) };
  await Promise.all([facade.reconcile(), facade.reconcile()]);
  assert.equal(statSync(app.blobs._pathFor(blobId, { pending: true }), { throwIfNoEntry: false }), undefined, 'pending slot gone after finalize');
  assert.deepEqual(await collect(app.pendingBlobLifecycle.readClaimedStream(blobId)), BYTES, 'final-slot fallback serves identical bytes');
});

test('readClaimedStream enforces the claim admission and collapses byte failures like readClaimed', async (t) => {
  const app = await lifecycleApp(t);

  // A staged-but-unclaimed generation (row 'pending') is dark to the stream,
  // exactly like readClaimed. The staged result carries only the claim
  // capability, not the id — read the row's blobId directly (as the buffered
  // lifecycle tests do).
  const unclaimed = await pendingBlobStager(app, principal({ type: 'user', id: 'u1' })).stage({ scopeId: 'project:p1', resourceId: 'staged', bytes: BYTES });
  const unclaimedId = app.db.prepare('SELECT blobId FROM _PendingBlob WHERE pendingKey = ?').get(unclaimed.pendingKey).blobId;
  await assert.rejects(
    Promise.resolve().then(() => app.pendingBlobLifecycle.readClaimedStream(unclaimedId)),
    /BLOB_UNAVAILABLE/,
    'an unclaimed blob id never serves bytes',
  );

  // An unknown id is equally dark.
  await assert.rejects(Promise.resolve().then(() => app.pendingBlobLifecycle.readClaimedStream('no-such-blob')), /BLOB_UNAVAILABLE/);

  // A CLAIMED row whose bytes vanished from BOTH slots fails with the same
  // generic BLOB_UNAVAILABLE collapse as the buffered readClaimed (recovery
  // failure recorded, no distinguishable existence/byte signal beyond it).
  const { blobId } = await stageAndClaim(app);
  rmSync(app.blobs._pathFor(blobId, { pending: true }));
  await assert.rejects(
    Promise.resolve().then(() => app.pendingBlobLifecycle.readClaimedStream(blobId)),
    /BLOB_UNAVAILABLE/,
    'both slots gone collapses into the generic failure',
  );
});

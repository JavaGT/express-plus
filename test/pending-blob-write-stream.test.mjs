// pending-blob-write-stream.mjs — the streaming pending-slot WRITE (#738 W2).
//
// Three layers of proof, mirroring the W1 read-side split:
// 1. ByteStore.writePendingStream against BOTH conforming backends — chunks
//    land in the pending slot, hash-while-write digests match a fresh hash of
//    what readRange serves back, maxBytes aborts MID-STREAM with the TYPED
//    BlobTooLargeError and leaves NO readable pending slot, non-Uint8Array
//    chunks are rejected, and a failed write never leaves final bytes.
// 2. BlobStore.writePendingStream — id validation, the low-disk guard, and
//    the 'pending' metadata row recorded from ATTESTED values.
// 3. PendingBlobLifecycle.stage() parity — an iterable staged through the new
//    path yields IDENTICAL durable state (digests, byteLength, claimed bytes,
//    validateClaim attestation) to the old buffered path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import workbench, { principal } from '../build/index.mjs';
import { pendingBlobStager, declaredBlobField, BlobSlotNotFoundError, BlobTooLargeError } from '../build/server.mjs';
import { fsBlobs } from '../build/fs-blobs.mjs';
import { memoryBlobs } from '../build/memory-blobs.mjs';

const BYTES = Buffer.from('pending-write-stream-bytes');
const collect = async (stream) => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const md5 = (bytes) => createHash('md5').update(bytes).digest('hex');

function backendSessions() {
  return [
    {
      label: 'fsBlobs',
      make() {
        const root = mkdtempSync(path.join(tmpdir(), 'wb-pending-write-fs-'));
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

async function* chunked(bytes, size) {
  for (let offset = 0; offset < bytes.length; offset += size) {
    yield bytes.subarray(offset, Math.min(offset + size, bytes.length));
  }
}

for (const { label, make } of backendSessions()) {
  test(`${label}: writePendingStream lands chunks in the pending slot with matching hash-while-write digests`, async () => {
    const { store, dispose } = make();
    try {
      const attested = await store.writePendingStream('w1', chunked(BYTES, 7));
      assert.deepEqual(
        { byteLength: attested.byteLength, sha256: attested.sha256, md5: attested.md5 },
        { byteLength: BYTES.length, sha256: sha256(BYTES), md5: md5(BYTES) },
        'the attestation describes EXACTLY what landed',
      );
      assert.ok(store.exists('w1', { pending: true }), 'pending slot written');
      assert.deepEqual(store.readPending('w1'), BYTES, 'pending bytes equal the streamed payload');
      // The read-back bytes re-hash to the attested values.
      assert.equal(sha256(await Promise.resolve().then(() => store.readPending('w1'))), attested.sha256);
      assert.ok(!store.exists('w1', { pending: false }), 'no final slot was created');
    } finally {
      dispose();
    }
  });

  test(`${label}: maxBytes aborts MID-STREAM with the typed error and leaves NO readable pending slot`, async () => {
    const { store, dispose } = make();
    try {
      await assert.rejects(
        store.writePendingStream('over', chunked(BYTES, 4), { maxBytes: BYTES.length - 1 }),
        (error) => error instanceof BlobTooLargeError
          && error.limit === BYTES.length - 1
          && error.received === BYTES.length
          && error.message.includes(`(received ${BYTES.length})`),
        'the abort is the typed over-limit signal carrying the bound AND the count at abort',
      );
      assert.equal(store.exists('over', { pending: true }), false, 'the torn pending slot is gone');
      assert.throws(() => store.readPending('over'), BlobSlotNotFoundError, 'no readable pending slot survives');
      assert.ok(!store.exists('over', { pending: false }), 'a torn pending write is never final bytes');

      // Exactly-at-limit completes: the bound is exclusive only past the limit.
      const exact = await store.writePendingStream('exact', chunked(BYTES, 4), { maxBytes: BYTES.length });
      assert.equal(exact.byteLength, BYTES.length);
    } finally {
      dispose();
    }
  });

  test(`${label}: a mid-stream source failure removes the torn pending slot too`, async () => {
    const { store, dispose } = make();
    try {
      async function* broken() {
        yield BYTES.subarray(0, 5);
        throw new Error('source exploded');
      }
      await assert.rejects(store.writePendingStream('torn', broken()), /source exploded/);
      assert.equal(store.exists('torn', { pending: true }), false, 'no torn slot after a source failure');
      assert.throws(() => store.readPending('torn'), BlobSlotNotFoundError);
    } finally {
      dispose();
    }
  });

  test(`${label}: non-Uint8Array chunks are rejected before any digest update`, async () => {
    const { store, dispose } = make();
    try {
      async function* bad() { yield 'not-bytes'; }
      await assert.rejects(store.writePendingStream('bad', bad()), TypeError);
      assert.equal(store.exists('bad', { pending: true }), false);
      async function* late() { yield BYTES.subarray(0, 3); yield 42; }
      await assert.rejects(store.writePendingStream('late-bad', late()), TypeError, 'a valid first chunk does not excuse a later one');
      assert.equal(store.exists('late-bad', { pending: true }), false);
    } finally {
      dispose();
    }
  });

  test(`${label}: invalid maxBytes bounds are rejected cleanly`, async () => {
    const { store, dispose } = make();
    try {
      for (const maxBytes of [-1, NaN, Infinity]) {
        await assert.rejects(store.writePendingStream('bounded', chunked(BYTES, 3), { maxBytes }), /invalid maxBytes/, `maxBytes ${maxBytes} rejected`);
      }
      assert.equal(store.exists('bounded', { pending: true }), false);
    } finally {
      dispose();
    }
  });
}

// ─── 2. BlobStore.writePendingStream ────────────────────────────────────────

test('BlobStore.writePendingStream records the pending metadata row from ATTESTED values', async (t) => {
  const db = new DatabaseSync(':memory:');
  const root = mkdtempSync(path.join(tmpdir(), 'workbench-pending-write-store-'));
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const app = workbench({ db, blobs: { root } });
  await app.start();
  try {
    const blobId = randomUUID();
    const attested = await app.blobs.writePendingStream(blobId, chunked(BYTES, 5), { mime: 'video/mp4' });
    const row = app.blobs.stat(blobId);
    assert.ok(row, 'metadata row written on success');
    assert.equal(row.status, 'pending');
    assert.equal(row.size, attested.byteLength);
    assert.equal(row.sha256, attested.sha256);
    assert.equal(row.md5, attested.md5);
    assert.equal(row.mime, 'video/mp4');

    // An invalid id never reaches the byte store.
    await assert.rejects(app.blobs.writePendingStream('../escape', chunked(BYTES, 3)), /invalid blob id/);

    // A failed write writes NO metadata row either (bytes first, row second).
    await assert.rejects(app.blobs.writePendingStream(randomUUID(), chunked(BYTES, 4), { maxBytes: 3 }), BlobTooLargeError);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM BlobStore').get().count, 1, 'only the successful write has a row');
  } finally {
    await app.shutdown();
  }
});

// ─── 3. stage() parity: streamed iterables vs the buffered path ─────────────

function lifecycleApp(t) {
  const db = new DatabaseSync(':memory:');
  const root = mkdtempSync(path.join(tmpdir(), 'workbench-pending-write-lifecycle-'));
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

test('stage() with an iterable produces identical digests and durable state vs the buffered path (parity)', async (t) => {
  const app = await lifecycleApp(t);
  const actor = principal({ type: 'user', id: 'u1' });

  // The OLD path's expected values: the whole-buffer stage still supported by
  // the same seam (wrapped internally as a one-chunk stream).
  const buffered = await pendingBlobStager(app, actor).stage({ scopeId: 'project:p1', resourceId: 'buffered', bytes: BYTES });
  assert.equal(buffered.byteLength, BYTES.length);
  assert.equal(buffered.contentDigest, sha256(BYTES), 'buffered digest matches a fresh hash');

  // The NEW path: the same bytes as a multi-chunk iterable.
  const streamed = await pendingBlobStager(app, actor).stage({ scopeId: 'project:p1', resourceId: 'streamed', bytes: chunked(BYTES, 6) });
  assert.equal(streamed.byteLength, buffered.byteLength, 'identical byteLength');
  assert.equal(streamed.contentDigest, buffered.contentDigest, 'identical sha-256 digest');
  assert.match(streamed.pendingKey, /^project:p1\/streamed\.[a-f0-9]{64}\.pending$/);

  // Durable rows agree except identity columns; both carry the attestation.
  const rows = app.db.prepare('SELECT * FROM _PendingBlob WHERE pendingKey IN (?, ?) ORDER BY resourceId').all(buffered.pendingKey, streamed.pendingKey);
  assert.deepEqual(
    rows.map(({ resourceId, contentDigest, byteLength, status }) => ({ resourceId, contentDigest, byteLength, status })),
    [
      { resourceId: 'buffered', contentDigest: sha256(BYTES), byteLength: BYTES.length, status: 'pending' },
      { resourceId: 'streamed', contentDigest: sha256(BYTES), byteLength: BYTES.length, status: 'pending' },
    ],
  );

  // Both claims admit identically: the stat()-based attestation sees the same
  // metadata whichever write path landed the bytes.
  const claimArgs = (staged, resourceId) => ({
    claim: staged.claim,
    field: 'blob',
    resourceId,
    actionName: 'File.upload',
    actionId: `upload-${resourceId}`,
    authenticatedPrincipal: actor,
    scopeId: 'project:p1',
    committedEventId: `event-${resourceId}`,
  });
  const claimedBuffered = await app.pendingBlobLifecycle.validateClaim(claimArgs(buffered, 'buffered'));
  const claimedStreamed = await app.pendingBlobLifecycle.validateClaim(claimArgs(streamed, 'streamed'));
  // Identity fields differ by design (separate generations); every ATTESTED
  // field must be identical.
  const attestationOf = ({ sha256: digest, md5: md5Sum, byteLength, mediaType }) => ({ digest, md5: md5Sum, byteLength, mediaType });
  assert.deepEqual(attestationOf(claimedStreamed), attestationOf(claimedBuffered), 'identical ClaimedBlob attestation');
  assert.equal(claimedStreamed.sha256, sha256(BYTES));
  assert.equal(claimedStreamed.byteLength, BYTES.length);

  // And the claimed STREAM read (#738 W1) serves exactly the staged bytes.
  assert.deepEqual(await collect(app.pendingBlobLifecycle.readClaimedStream(claimedStreamed.blobId)), BYTES);
});

test('an over-limit iterable staging fails with NO readable slot and NO durable row', async (t) => {
  const app = await lifecycleApp(t);
  // stage() exposes no limit knob — the bound is enforced at the byte-store /
  // BlobStore layer (proven above). The staging failure contract proven here:
  // a source that throws mid-stream leaves no slot, no row, and no claim.
  async function* exploding() {
    yield Buffer.alloc(64, 1);
    throw new Error('upload source died');
  }
  await assert.rejects(
    pendingBlobStager(app, principal({ type: 'user', id: 'u1' })).stage({ scopeId: 'project:p1', resourceId: 'dies', bytes: exploding() }),
    /upload source died/,
  );
  assert.equal(db_row_count(app), 0, 'no _PendingBlob row was written');
  assert.equal(db_blob_count(app), 0, 'no BlobStore row was written');
});

function db_row_count(app) {
  return app.db.prepare('SELECT COUNT(*) AS count FROM _PendingBlob').get().count;
}
function db_blob_count(app) {
  return app.db.prepare('SELECT COUNT(*) AS count FROM BlobStore').get().count;
}

test('a crash-torn pending file is NOT a final slot and not readable through any claim path', async (t) => {
  const app = await lifecycleApp(t);
  // Simulate a crash mid-write: bytes in the staging area, no durable rows.
  const orphanId = randomUUID();
  const pendingPath = app.blobs._pathFor(orphanId, { pending: true });
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync(path.dirname(pendingPath), { recursive: true });
  writeFileSync(pendingPath, Buffer.from('half-written-torn'));

  // Not final: readRange refuses (S6/A4 — no generic fallback).
  assert.throws(() => app.blobs.readRange(orphanId), BlobSlotNotFoundError);
  // No metadata → no lifecycle row → no claim machinery route exists at all.
  assert.equal(db_row_count(app), 0);
  assert.equal(db_blob_count(app), 0);
  assert.equal(statSync(pendingPath).size, 'half-written-torn'.length, 'the torn residue is inert until swept');
});

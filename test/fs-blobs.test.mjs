// fs-blobs.mjs — the byte-store plugin seam (seam-review §2.2).
//
// Three layers of proof:
// 1. The fsBlobs byte-store INTERFACE CONTRACT against a temp root —
//    writePending→exists→readRange roundtrip, finalize durability, remove
//    idempotence, bogus-range rejection. These are the guarantees the lifecycle
//    in blob-store.mjs leans on.
// 2. Capability honesty: fsBlobs declares durable + atomic + range + verified,
//    `createBlobStore` surfaces it, and delete verification holds — `remove`
//    throws on a real failure and never reports an erasure that did not happen.
// 3. An end-to-end proof that `workbench({ blobs: { root } })` still constructs
//    fsBlobs internally (the back-compat path). The in-memory backend's plug-in
//    proof lives in memory-blobs.test.mjs; the shared contract suite that runs
//    against BOTH backends lives in blob-contract.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { fsBlobs } from '../build/fs-blobs.mjs';
import { generateFrameworkDDL } from '../build/ddl.mjs';
import { createBlobStore } from '../build/blob-store.mjs';
import { text, ref, blob, scope, grant, read, write, subscribe } from '../build/index.mjs';
import workbench, { entity } from '../build/internal.mjs';

// ─── 1. fsBlobs interface contract ──────────────────────────────────────────

function freshRoot() {
  return mkdtempSync(path.join(tmpdir(), 'express-fsblobs-'));
}

test('writePending → exists → readPending roundtrip', () => {
  const root = freshRoot();
  const store = fsBlobs({ root });
  const bytes = Buffer.from('hello bytes');

  store.writePending('b1', bytes);

  assert.ok(store.exists('b1', { pending: true }), 'pending slot written');
  assert.ok(!store.exists('b1', { pending: false }), 'no final slot yet');

  // Pending bytes are reachable ONLY through the explicit pending read — the
  // generic final-slot read never falls back (S6/A4).
  assert.throws(() => store.readRange('b1'), /blob not found/, 'no generic final-slot read of pending bytes');
  const full = store.readPending('b1');
  assert.deepStrictEqual(full, bytes, 'open-ended pending read returns all bytes');

  const slice = store.readPending('b1', [2, 7]);
  assert.deepStrictEqual(slice, Buffer.from('llo b'), 'range [2,7) slices correctly');

  rmSync(root, { recursive: true, force: true });
});

test('finalizePending promotes pending → final and is durable (survives a fresh store on the same root)', () => {
  const root = freshRoot();
  const store = fsBlobs({ root });
  store.writePending('b2', Buffer.from('durable'));

  const finalPath = store.finalizePending('b2');

  assert.ok(!store.exists('b2', { pending: true }), 'pending slot gone after finalize');
  assert.ok(store.exists('b2', { pending: false }), 'final slot present');
  assert.deepStrictEqual(store.readRange('b2'), Buffer.from('durable'), 'final bytes readable');

  // Durability: a NEW byte store bound to the same root sees the finalized bytes
  // — the bytes survived the process boundary (an adopted blob's final file must
  // survive a reboot; this is the finalize contract).
  const reopened = fsBlobs({ root });
  assert.deepStrictEqual(reopened.readRange('b2'), Buffer.from('durable'), 'bytes survive across store instances');
  assert.equal(finalPath, path.join(root, 'b2'), 'pathFor points at the final slot');

  rmSync(root, { recursive: true, force: true });
});

test('finalizePending is idempotent — a missing pending slot is a no-op', () => {
  const root = freshRoot();
  const store = fsBlobs({ root });

  // No pending slot was ever written — finalize must not throw.
  assert.doesNotThrow(() => store.finalizePending('never-uploaded'));
  assert.ok(!store.exists('never-uploaded', { pending: false }), 'no final slot created from nothing');

  // Finalizing an already-finalized blob is also a no-op.
  store.writePending('once', Buffer.from('x'));
  store.finalizePending('once');
  assert.doesNotThrow(() => store.finalizePending('once'));
  assert.deepStrictEqual(store.readRange('once'), Buffer.from('x'), 'bytes intact after double finalize');

  rmSync(root, { recursive: true, force: true });
});

test('remove is idempotent — a missing slot is a no-op', () => {
  const root = freshRoot();
  const store = fsBlobs({ root });

  assert.doesNotThrow(() => store.remove('ghost', { pending: true }));
  assert.doesNotThrow(() => store.remove('ghost', { pending: false }));

  store.writePending('temp', Buffer.from('t'));
  store.remove('temp', { pending: true });
  assert.ok(!store.exists('temp', { pending: true }), 'pending removed');
  // removing again is a no-op, not an ENOENT.
  assert.doesNotThrow(() => store.remove('temp', { pending: true }));

  rmSync(root, { recursive: true, force: true });
});

test('readRange serves final bytes only — no pending fallback (S6/A4)', () => {
  const root = freshRoot();
  const store = fsBlobs({ root });
  store.writePending('pend', Buffer.from('still-pending'));
  // No finalize — the final-slot read must NOT serve pending bytes.
  assert.throws(() => store.readRange('pend'), /blob not found/, 'an unclaimed blob id never serves bytes');
  assert.deepStrictEqual(store.readPending('pend'), Buffer.from('still-pending'), 'the explicit pending read serves the claim-gated bytes');
  store.finalizePending('pend');
  assert.deepStrictEqual(store.readRange('pend'), Buffer.from('still-pending'), 'final bytes served after promotion');
  assert.throws(() => store.readPending('pend'), /blob not found/, 'the pending slot is gone after finalize');
  rmSync(root, { recursive: true, force: true });
});

test('readRangeStream streams final bytes with the same range semantics as readRange', async () => {
  const root = freshRoot();
  const store = fsBlobs({ root });
  const bytes = Buffer.from('0123456789');
  store.writePending('s', bytes);
  store.finalizePending('s');

  const collect = async (stream) => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); };
  assert.deepStrictEqual(await collect(store.readRangeStream('s')), bytes, 'open-ended stream reads to EOF');
  assert.deepStrictEqual(await collect(store.readRangeStream('s', [2, 7])), Buffer.from('23456'), 'range [2,7) streams');
  assert.deepStrictEqual(await collect(store.readRangeStream('s', [0, Infinity])), bytes, 'Infinity end streams to EOF');
  assert.deepStrictEqual(await collect(store.readRangeStream('s', [5, 5])), Buffer.alloc(0), 'empty range is a valid empty stream');

  // Streaming an unclaimed blob id fails the read, never falls back to pending.
  store.writePending('pend', Buffer.from('still-pending'));
  assert.throws(() => store.readRangeStream('pend'), /blob not found/, 'no generic pending fallback for streaming reads');

  rmSync(root, { recursive: true, force: true });
});

test('readRangeStream validates bounds identically to readRange', () => {
  const root = freshRoot();
  const store = fsBlobs({ root });
  store.writePending('rng', Buffer.from('0123456789'));
  store.finalizePending('rng');

  assert.throws(() => store.readRangeStream('rng', [-1, 5]), /invalid blob range/);
  assert.throws(() => store.readRangeStream('rng', [5, 2]), /invalid blob range/);
  assert.throws(() => store.readRangeStream('rng', [0, -5]), /invalid blob range/);
  assert.throws(() => store.readRangeStream('rng', [NaN, 5]), /invalid blob range/);
  assert.throws(() => store.readRangeStream('rng', [0, NaN]), /invalid blob range/);
  assert.throws(() => store.readRangeStream('rng', [Infinity, Infinity]), /invalid blob range/);

  rmSync(root, { recursive: true, force: true });
});

test('readRangeStream cancels on abort — a cancelled read stops delivering bytes', async () => {
  const root = freshRoot();
  const store = fsBlobs({ root });
  store.writePending('big', Buffer.alloc(5_000_000, 7));
  store.finalizePending('big');

  const settle = (stream) => new Promise((resolve) => {
    let ended = false;
    stream.on('data', () => {});
    stream.on('end', () => { ended = true; resolve({ kind: 'end' }); });
    stream.on('error', (error) => { if (!ended) resolve({ kind: 'error', error }); });
  });

  // Abort immediately after creation: the stream must error, never report clean
  // completion — cancellation stops the read mid-flight.
  const controller = new AbortController();
  const live = store.readRangeStream('big', [0, 5_000_000], { signal: controller.signal });
  controller.abort();
  const aborted = await settle(live);
  assert.equal(aborted.kind, 'error', 'an aborted stream errors instead of ending');
  assert.match(aborted.error.message, /abort/i, 'the error is the AbortError shape');

  // A pre-aborted signal errors the stream deterministically too.
  const pre = new AbortController();
  pre.abort();
  const doomed = store.readRangeStream('big', [0, 5_000_000], { signal: pre.signal });
  assert.equal((await settle(doomed)).kind, 'error', 'a pre-aborted signal errors the stream');

  rmSync(root, { recursive: true, force: true });
});

test('readRange rejects bogus ranges cleanly', () => {
  const root = freshRoot();
  const store = fsBlobs({ root });
  store.writePending('rng', Buffer.from('0123456789'));
  store.finalizePending('rng');

  assert.throws(() => store.readRange('rng', [-1, 5]), /invalid blob range/);
  assert.throws(() => store.readRange('rng', [5, 2]), /invalid blob range/);
  assert.throws(() => store.readRange('rng', [0, -5]), /invalid blob range/);
  assert.throws(() => store.readRange('rng', [NaN, 5]), /invalid blob range/);
  assert.throws(() => store.readRange('rng', [0, NaN]), /invalid blob range/);
  assert.deepStrictEqual(store.readRange('rng', [5, 5]), Buffer.alloc(0), 'empty range is valid');

  rmSync(root, { recursive: true, force: true });
});

test('safeId rejects path-traversal / bogus ids at the byte-store boundary', () => {
  const root = freshRoot();
  const store = fsBlobs({ root });
  for (const id of ['../evil', '/abs/path', 'a/b', 'a\x00b', '..', '', 'has space']) {
    assert.throws(() => store.writePending(id, Buffer.from('x')), /invalid blob id/);
  }
  store.writePending('valid_id-1', Buffer.from('ok'));
  assert.ok(store.exists('valid_id-1', { pending: true }));
  rmSync(root, { recursive: true, force: true });
});

// ─── 2. createBlobStore delegates bytes to an injected store ────────────────

test('createBlobStore delegates bytes to the injected byte store (metadata stays in SQL)', () => {
  const root = freshRoot();
  const db = new DatabaseSync(':memory:');
  for (const sql of generateFrameworkDDL()) db.exec(sql);

  const bytes = fsBlobs({ root });
  const store = createBlobStore({ db, bytes });

  const up = store.upload({ bytes: Buffer.from('via-seam'), mime: 'text/plain' });
  assert.ok(existsSync(path.join(root, `${up.id}.pending`)), 'bytes landed through the injected store');

  db.exec('BEGIN IMMEDIATE');
  store.adopt(db, up.id);
  db.exec('COMMIT');
  store.finalize(up.id);

  assert.equal(store.stat(up.id).status, 'adopted');
  assert.deepStrictEqual(store.readRange(up.id), Buffer.from('via-seam'), 'readRange routed through the byte store');

  db.close();
  rmSync(root, { recursive: true, force: true });
});

// ─── 2. capability honesty + delete verification ───────────────────────────

test('fsBlobs declares honest capabilities — durable, atomic, range-verified', () => {
  const root = freshRoot();
  const store = fsBlobs({ root });
  assert.deepEqual(store.capabilities, {
    durability: 'durable',
    atomicPromotion: true,
    rangeSupport: true,
    deleteVerification: true,
    consistency: 'single-node-strong',
  });
  rmSync(root, { recursive: true, force: true });
});

test('createBlobStore surfaces the byte store’s capabilities', () => {
  const root = freshRoot();
  const db = new DatabaseSync(':memory:');
  for (const sql of generateFrameworkDDL()) db.exec(sql);
  const store = createBlobStore({ db, bytes: fsBlobs({ root }) });
  assert.deepEqual(store.capabilities, {
    durability: 'durable',
    atomicPromotion: true,
    rangeSupport: true,
    deleteVerification: true,
    consistency: 'single-node-strong',
  });
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('deleteVerification: remove throws on a real failure — erasure is never silently reported complete', () => {
  const root = freshRoot();
  const store = fsBlobs({ root });
  assert.equal(store.capabilities.deleteVerification, true, 'fs declares delete verification');

  // A directory at the slot path is not a deletable file: unlink fails with a
  // real error (EISDIR), and a verification-capable backend MUST throw — a
  // deletion can never be reported complete while the bytes are still there.
  mkdirSync(path.join(root, 'occupied'));
  assert.throws(() => store.remove('occupied', { pending: false }), /EISDIR|EPERM/);
  assert.ok(existsSync(path.join(root, 'occupied')), 'failed erasure leaves the slot behind — never reported complete');

  // ENOENT stays the idempotent no-op: a missing slot is not a failure.
  assert.doesNotThrow(() => store.remove('ghost', { pending: false }));

  rmSync(root, { recursive: true, force: true });
});

// ─── 3. end-to-end: the back-compat `{ root }` options bag ──────────────────

function photoNote() {
  return entity('Note', {
    body: text(),
    photo: blob(),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read)),
    ],
  });
}

async function harness(t, blobs) {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, blobs });
  app.mount('/notes', photoNote());
  await app.ddl();
  app.listen(0, { principalOf: () => ({ id: 'u1' }) });
  await app.ready;
  const port = app.httpServer.address().port;
  t.after(() => { app.httpServer.close(); db.close(); });
  return { app, db, base: `http://127.0.0.1:${port}` };
}

const json = (r) => r.json();

test('back-compat: blobs: { root } still constructs fsBlobs internally (the default path)', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'express-blob-bc-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { app, base } = await harness(t, { root });

  const up = await json(await fetch(`${base}/blobs`, {
    method: 'POST', headers: { 'content-type': 'image/png' }, body: Buffer.from('on disk'),
  }));
  assert.ok(existsSync(path.join(root, `${up.id}.pending`)), 'the {root} options bag still lands bytes on fs');
  assert.equal(app.blobs.stat(up.id).status, 'pending');
});

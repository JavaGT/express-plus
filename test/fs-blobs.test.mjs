// fs-blobs.mjs — the byte-store plugin seam (seam-review §2.2).
//
// Two layers of proof:
// 1. The fsBlobs byte-store INTERFACE CONTRACT against a temp root —
//    writePending→exists→readRange roundtrip, finalize durability, remove
//    idempotence, bogus-range rejection. These are the guarantees the lifecycle
//    in blob-store.mjs leans on.
// 2. An end-to-end proof that a CUSTOM byte store (an in-memory Map-backed
//    implementation written here) plugs in via `workbench({ blobs: memStore })`
//    by SHAPE, and the existing blob upload/read HTTP flow runs against it —
//    no fs bytes land on disk, yet upload/adopt/finalize/stat all work. This is
//    the seam's reason for existing: a photo app deploys to S3, not node:fs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { fsBlobs } from '../src/fs-blobs.mjs';
import { generateFrameworkDDL } from '../src/ddl.mjs';
import { createBlobStore } from '../src/blob-store.mjs';
import { text, ref, blob, scope, grant, read, write, subscribe } from '../src/index.mjs';
import workbench, { entity } from '../src/internal.mjs';

// ─── 1. fsBlobs interface contract ──────────────────────────────────────────

function freshRoot() {
  return mkdtempSync(path.join(tmpdir(), 'express-fsblobs-'));
}

test('writePending → exists → readRange roundtrip', () => {
  const root = freshRoot();
  const store = fsBlobs({ root });
  const bytes = Buffer.from('hello bytes');

  store.writePending('b1', bytes);

  assert.ok(store.exists('b1', { pending: true }), 'pending slot written');
  assert.ok(!store.exists('b1', { pending: false }), 'no final slot yet');

  const full = store.readRange('b1');
  assert.deepStrictEqual(full, bytes, 'open-ended read returns all bytes');

  const slice = store.readRange('b1', [2, 7]);
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

test('readRange falls back to the pending slot when no final exists', () => {
  const root = freshRoot();
  const store = fsBlobs({ root });
  store.writePending('pend', Buffer.from('still-pending'));
  // No finalize — readRange must still serve the pending bytes.
  assert.deepStrictEqual(store.readRange('pend'), Buffer.from('still-pending'));
  rmSync(root, { recursive: true, force: true });
});

test('readRange rejects bogus ranges cleanly', () => {
  const root = freshRoot();
  const store = fsBlobs({ root });
  store.writePending('rng', Buffer.from('0123456789'));

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

// ─── 3. end-to-end: a CUSTOM in-memory byte store plugs into workbench ──────

// A Map-backed byte store conforming to the byte-store interface. Proves the
// seam accepts ANY conforming object by shape — no fs, no node:fs import in the
// "deployment". `pathFor` returns a synthetic key (an S3 driver would do the
// same — there is no filesystem path in object storage).
function memBlobs() {
  const pending = new Map();
  const final = new Map();
  return {
    writePending(id, buf) { pending.set(id, Buffer.from(buf)); },
    finalizePending(id) {
      const buf = pending.get(id);
      if (buf) { final.set(id, buf); pending.delete(id); }
      return `mem://blobs/${id}`;
    },
    readRange(id, [start, end] = []) {
      const buf = final.get(id) ?? pending.get(id);
      if (!buf) throw new Error('blob not found');
      start = start ?? 0;
      if (!Number.isFinite(start) || start < 0 || !Number.isInteger(start)) throw new Error('invalid blob range: start');
      end = end == null ? buf.length : Math.min(end, buf.length);
      if (!Number.isFinite(end) || end < 0 || !Number.isInteger(end)) throw new Error('invalid blob range: end');
      if (end < start) throw new Error('invalid blob range: end < start');
      return buf.subarray(start, end);
    },
    remove(id, { pending: p } = {}) {
      if (p) pending.delete(id); else final.delete(id);
    },
    exists(id, { pending: p } = {}) {
      return p ? pending.has(id) : final.has(id);
    },
    pathFor(id) { return `mem://blobs/${id}`; },
  };
}

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

test('a custom in-memory byte store plugs in via workbench({ blobs }) by shape — upload/read HTTP flow works with no fs', async (t) => {
  const mem = memBlobs();
  const { app, base } = await harness(t, mem);

  // The injected byte store is the one the framework uses — same object.
  assert.equal(app.blobs.pathFor('x'), 'mem://blobs/x', 'the custom byte store was accepted by shape');

  const bytes = Buffer.from('a photo in memory');
  const up = await json(await fetch(`${base}/blobs`, {
    method: 'POST',
    headers: { 'content-type': 'image/png' },
    body: bytes,
  }));
  assert.equal(up.size, bytes.length);
  assert.equal(up.md5, createHash('md5').update(bytes).digest('hex'));
  assert.equal(up.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.ok(mem.exists(up.id, { pending: true }), 'bytes are in the Map, NOT on disk');

  // A dispatch referencing the blob adopts it (in-txn metadata) and finalizes it
  // (post-commit byte promotion) — against the in-memory store.
  const created = await json(await fetch(`${base}/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'n', photo: up.id }),
  }));
  assert.equal(created.photo, up.id, 'the blob id is stored on the note');
  assert.equal(app.blobs.stat(up.id).status, 'adopted', 'metadata row adopted');
  assert.ok(mem.exists(up.id, { pending: false }), 'bytes promoted to the final Map slot');
  assert.ok(!mem.exists(up.id, { pending: true }), 'pending slot cleared');
  assert.deepStrictEqual(mem.readRange(up.id), bytes, 'final bytes served from the Map');
});

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

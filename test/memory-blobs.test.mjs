// memory-blobs.test.mjs — the in-memory fake byte-store backend: conformance
// beyond the shared contract suite (which also runs against this backend — see
// blob-contract.test.mjs). Proves the fake declares its capabilities HONESTLY
// (ephemeral = durable only within the process), never leaks bytes across a
// process boundary, returns read copies like fsBlobs, and plugs into
// `workbench({ blobs })` by shape so the whole upload/adopt/finalize flow runs
// with no filesystem.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { memoryBlobs } from '../build/memory-blobs.mjs';
import { createBlobStore } from '../build/blob-store.mjs';
import { generateFrameworkDDL } from '../build/ddl.mjs';
import { text, ref, blob, scope, grant, read, write, subscribe } from '../build/index.mjs';
import workbench, { entity } from '../build/internal.mjs';

// ─── 1. capability honesty ─────────────────────────────────────────────────

test('memoryBlobs declares honest capabilities — ephemeral durability, in-process only', () => {
  const store = memoryBlobs();
  assert.deepEqual(store.capabilities, {
    durability: 'ephemeral',
    atomicPromotion: true,
    rangeSupport: true,
    deleteVerification: true,
    consistency: 'single-node-strong',
  });
});

test('durability is in-process only — a fresh backing (a process boundary) sees nothing', () => {
  const first = memoryBlobs();
  first.writePending('x', Buffer.from('in-process'));
  first.finalizePending('x');
  assert.ok(first.exists('x', { pending: false }), 'final slot present in the owning process');

  const freshProcess = memoryBlobs(); // fresh backing = the process boundary
  assert.equal(freshProcess.exists('x', { pending: false }), false);
  assert.equal(freshProcess.exists('x', { pending: true }), false);
});

// ─── 2. byte semantics parity with fsBlobs ─────────────────────────────────

test('readRange returns a copy — mutating the result does not corrupt stored bytes', () => {
  const store = memoryBlobs();
  store.writePending('c', Buffer.from('precious'));
  store.finalizePending('c');

  const view = store.readRange('c');
  view.fill(0);
  assert.deepStrictEqual(store.readRange('c'), Buffer.from('precious'), 'stored bytes untouched by the returned buffer');
});

test('writePending copies its input — mutating the caller buffer does not corrupt the store', () => {
  const store = memoryBlobs();
  const input = Buffer.from('original');
  store.writePending('in', input);
  input.fill(0);
  assert.deepStrictEqual(store.readRange('in'), Buffer.from('original'), 'stored bytes untouched by the input buffer');
});

test('pathFor is synthetic and test/debug-only', () => {
  const store = memoryBlobs();
  assert.equal(store.pathFor('b', { pending: true }), 'mem://blobs/b.pending');
  assert.equal(store.pathFor('b'), 'mem://blobs/b');
  assert.equal(store.finalizePending('never-written'), 'mem://blobs/never-written');
});

test('memoryBlobs validates blob ids identically to fsBlobs', () => {
  const store = memoryBlobs();
  for (const id of ['../evil', '/abs/path', 'a/b', 'a\x00b', '..', '', 'has space']) {
    assert.throws(() => store.writePending(id, Buffer.from('x')), /invalid blob id/);
  }
});

test('createBlobStore surfaces the injected memory byte store’s capabilities', () => {
  const db = new DatabaseSync(':memory:');
  for (const sql of generateFrameworkDDL()) db.exec(sql);
  const store = createBlobStore({ db, bytes: memoryBlobs() });
  assert.equal(store.capabilities.durability, 'ephemeral');
  assert.equal(store.capabilities.atomicPromotion, true);
  assert.equal(store.capabilities.rangeSupport, true);
  assert.equal(store.capabilities.deleteVerification, true);
  assert.equal(store.capabilities.consistency, 'single-node-strong');
  db.close();
});

// ─── 3. end-to-end: memoryBlobs plugs into workbench by shape ───────────────

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
  return { app, base: `http://127.0.0.1:${port}` };
}

const json = (r) => r.json();

test('memoryBlobs plugs into workbench({ blobs }) by shape — upload/read HTTP flow works with no fs', async (t) => {
  const mem = memoryBlobs();
  const { app, base } = await harness(t, mem);

  assert.equal(app.blobs._pathFor('x'), 'mem://blobs/x', 'the memory byte store was accepted by shape');

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

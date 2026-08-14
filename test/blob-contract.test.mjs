// blob-contract.test.mjs — the SHARED byte-store contract suite, parameterized
// over both conforming backends (fsBlobs + memoryBlobs) so each is proven with
// IDENTICAL assertions for write / finalize / read / remove / exists /
// capabilities. These are the guarantees the lifecycle in blob-store.ts leans
// on; a backend that passes here satisfies the contract. Backend-specific
// proof — delete-verification failure injection for fs, process-boundary
// honesty for memory — lives in each backend's own test file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { fsBlobs } from '../build/fs-blobs.mjs';
import { memoryBlobs } from '../build/memory-blobs.mjs';

// session() → { store, reopen, dispose }: a fresh store plus reopen() which
// binds a NEW store to the SAME backing. That is what "durability" means within
// each backend's scope — fs survives a fresh store (and process) on the same
// root; memory survives a store recreation on the same in-process backing.
function fsSession() {
  const root = mkdtempSync(path.join(tmpdir(), 'workbench-blob-contract-'));
  return {
    store: fsBlobs({ root }),
    reopen: () => fsBlobs({ root }),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

function memSession() {
  const backing = { pending: new Map(), final: new Map() };
  return {
    store: memoryBlobs({ backing }),
    reopen: () => memoryBlobs({ backing }),
    dispose: () => {},
  };
}

const EXPECTED_CAPABILITIES = {
  fsBlobs: {
    durability: 'durable',
    atomicPromotion: true,
    rangeSupport: true,
    deleteVerification: true,
    consistency: 'single-node-strong',
  },
  memoryBlobs: {
    durability: 'ephemeral',
    atomicPromotion: true,
    rangeSupport: true,
    deleteVerification: true,
    consistency: 'single-node-strong',
  },
};

export function blobContractSuite(session, { label }) {
  const expectedCaps = EXPECTED_CAPABILITIES[label];
  const run = (name, fn) =>
    test(`${label}: ${name}`, () => {
      const s = session();
      try {
        fn(s.store, s);
      } finally {
        s.dispose();
      }
    });
  const runAsync = (name, fn) =>
    test(`${label}: ${name}`, async () => {
      const s = session();
      try {
        await fn(s.store, s);
      } finally {
        s.dispose();
      }
    });

  run('capabilities is queryable and honest', (store) => {
    assert.deepEqual(store.capabilities, expectedCaps);
  });

  run('writePending → exists → readPending roundtrip', (store) => {
    const bytes = Buffer.from('hello bytes');
    store.writePending('b1', bytes);

    assert.ok(store.exists('b1', { pending: true }), 'pending slot written');
    assert.ok(!store.exists('b1', { pending: false }), 'no final slot yet');

    // Pending bytes are reachable ONLY through the explicit pending read — the
    // generic final-slot read must never fall back (S6/A4).
    assert.throws(() => store.readRange('b1'), /blob not found/, 'no generic final-slot read of pending bytes');
    const full = store.readPending('b1');
    assert.deepStrictEqual(full, bytes, 'open-ended pending read returns all bytes');
    const slice = store.readPending('b1', [2, 7]);
    assert.deepStrictEqual(slice, Buffer.from('llo b'), 'range [2,7) slices correctly');
  });

  run('finalizePending promotes pending → final and survives a reopened store', (store, s) => {
    store.writePending('b2', Buffer.from('durable'));
    const finalKey = store.finalizePending('b2');

    assert.ok(!store.exists('b2', { pending: true }), 'pending slot gone after finalize');
    assert.ok(store.exists('b2', { pending: false }), 'final slot present');
    assert.deepStrictEqual(store.readRange('b2'), Buffer.from('durable'), 'final bytes readable');
    assert.equal(finalKey, store.pathFor('b2'), 'finalize returns the final slot key');

    // Durability within the backend's declared scope: a NEW store bound to the
    // same backing sees the finalized bytes (fs: same root / new instance, i.e.
    // a process restart; memory: same backing / new instance, i.e. an
    // in-process restart — ephemeral durability extends that far and no
    // further, see the boundary test below).
    const reopened = s.reopen();
    assert.deepStrictEqual(reopened.readRange('b2'), Buffer.from('durable'), 'bytes survive a reopened store');
  });

  run('finalize durability conforms to the declared durability — durable backends survive a process boundary on the same storage', (store, s) => {
    // memoryBlobs declares `ephemeral`: its loss across a FRESH backing (a
    // process boundary) is proven in memory-blobs.test.mjs — this shared
    // suite's reopen() only models an in-process restart, which ephemeral
    // durability does not claim to beat. Only the declared-durable backend is
    // held to the full restart MUST here.
    if (store.capabilities.durability !== 'durable') return;
    store.writePending('boundary', Buffer.from('across-restart'));
    store.finalizePending('boundary');
    const restarted = s.reopen();
    assert.deepStrictEqual(
      restarted.readRange('boundary'),
      Buffer.from('across-restart'),
      'a durable backend keeps finalized bytes across a store/process boundary on the same storage',
    );
  });

  run('finalizePending is idempotent — a missing pending slot is a no-op', (store) => {
    // No pending slot was ever written — finalize must not throw.
    assert.doesNotThrow(() => store.finalizePending('never-uploaded'));
    assert.ok(!store.exists('never-uploaded', { pending: false }), 'no final slot created from nothing');

    // Finalizing an already-finalized blob is also a no-op.
    store.writePending('once', Buffer.from('x'));
    store.finalizePending('once');
    assert.doesNotThrow(() => store.finalizePending('once'));
    assert.deepStrictEqual(store.readRange('once'), Buffer.from('x'), 'bytes intact after double finalize');
  });

  run('remove is idempotent — a missing slot is a no-op', (store) => {
    assert.doesNotThrow(() => store.remove('ghost', { pending: true }));
    assert.doesNotThrow(() => store.remove('ghost', { pending: false }));

    store.writePending('temp', Buffer.from('t'));
    store.remove('temp', { pending: true });
    assert.ok(!store.exists('temp', { pending: true }), 'pending removed');
    assert.doesNotThrow(() => store.remove('temp', { pending: true }), 'removing again is a no-op');
  });

  run('remove targets only the requested slot', (store) => {
    store.writePending('x', Buffer.from('bytes'));
    store.remove('x', { pending: false }); // no final slot — must not touch pending
    assert.ok(store.exists('x', { pending: true }), 'final-targeted remove leaves pending alone');
    store.remove('x', { pending: true });
    assert.ok(!store.exists('x', { pending: true }), 'pending-targeted remove clears it');
  });

  run('readRange serves final bytes only — no pending fallback (S6/A4)', (store) => {
    store.writePending('pend', Buffer.from('still-pending'));
    // No finalize — the final-slot read must NOT serve pending bytes: an
    // unclaimed blob id never serves bytes.
    assert.throws(() => store.readRange('pend'), /blob not found/, 'an unclaimed blob id never serves bytes');
    assert.deepStrictEqual(store.readPending('pend'), Buffer.from('still-pending'), 'the explicit pending read serves the claim-gated bytes');
    // After promotion, readRange serves the final bytes and readPending no longer does.
    store.finalizePending('pend');
    assert.deepStrictEqual(store.readRange('pend'), Buffer.from('still-pending'), 'final bytes served after promotion');
    assert.throws(() => store.readPending('pend'), /blob not found/, 'the pending slot is gone after finalize');
  });

  run('readPending validates bounds identically to readRange', (store) => {
    store.writePending('pendrng', Buffer.from('0123456789'));

    assert.throws(() => store.readPending('pendrng', [-1, 5]), /invalid blob range/);
    assert.throws(() => store.readPending('pendrng', [5, 2]), /invalid blob range/);
    assert.throws(() => store.readPending('pendrng', [0, NaN]), /invalid blob range/);
    assert.throws(() => store.readPending('pendrng', [0, 1.5]), /invalid blob range/);
    assert.deepStrictEqual(store.readPending('pendrng', [5, 5]), Buffer.alloc(0), 'empty range is valid');
  });

  runAsync('readRangeStream streams final bytes for full and ranged reads', async (store) => {
    store.writePending('stream', Buffer.from('0123456789'));
    store.finalizePending('stream');
    const full = await collect(store.readRangeStream('stream'));
    assert.deepStrictEqual(Buffer.concat(full), Buffer.from('0123456789'), 'full stream matches readRange');
    const slice = await collect(store.readRangeStream('stream', [2, 7]));
    assert.deepStrictEqual(Buffer.concat(slice), Buffer.from('23456'), 'range stream matches readRange');
    // A missing final slot fails the stream's start, never falls back to pending.
    store.writePending('stream-pending', Buffer.from('never final'));
    assert.throws(() => store.readRangeStream('stream-pending'), /blob not found/, 'streaming an unclaimed blob id throws');
  });

  runAsync('readRangeStream cancels on abort', async (store) => {
    store.writePending('cancel', Buffer.alloc(1_000_000, 7));
    store.finalizePending('cancel');
    const controller = new AbortController();
    const stream = store.readRangeStream('cancel', undefined, { signal: controller.signal });
    controller.abort();
    const outcome = await settled(stream);
    assert.equal(outcome.kind, 'error', 'the aborted stream errors instead of ending');
    assert.match(outcome.error.message, /abort/i, 'the error is the AbortError shape');
  });

  run('readRange rejects bogus ranges cleanly', (store) => {
    store.writePending('rng', Buffer.from('0123456789'));
    store.finalizePending('rng');

    assert.throws(() => store.readRange('rng', [-1, 5]), /invalid blob range/);
    assert.throws(() => store.readRange('rng', [5, 2]), /invalid blob range/);
    assert.throws(() => store.readRange('rng', [0, -5]), /invalid blob range/);
    assert.throws(() => store.readRange('rng', [NaN, 5]), /invalid blob range/);
    assert.throws(() => store.readRange('rng', [0, NaN]), /invalid blob range/);
    assert.throws(() => store.readRange('rng', [0, 1.5]), /invalid blob range/);
    assert.deepStrictEqual(store.readRange('rng', [5, 5]), Buffer.alloc(0), 'empty range is valid');
  });

  run('readRange treats Infinity end as the EOF sentinel (clamped to the byte length)', (store) => {
    store.writePending('eof', Buffer.from('0123456789'));
    store.finalizePending('eof');

    assert.deepStrictEqual(store.readRange('eof', [0, Infinity]), Buffer.from('0123456789'), 'Infinity end reads to EOF from 0');
    assert.deepStrictEqual(store.readRange('eof', [5, Infinity]), Buffer.from('56789'), 'Infinity end clamps to EOF from a mid offset');
    assert.deepStrictEqual(store.readRange('eof', [8, Number.MAX_SAFE_INTEGER]), Buffer.from('89'), 'a huge-but-finite end clamps to EOF');
    // Infinity remains an EOF sentinel ONLY for `end`: an Infinity `start` is
    // still rejected, because no finite blob has bytes starting at Infinity.
    assert.throws(() => store.readRange('eof', [Infinity, Infinity]), /invalid blob range/);
    assert.throws(() => store.readRange('eof', [Infinity, 5]), /invalid blob range/);
  });

  run('readRange on a missing blob throws blob not found', (store) => {
    assert.throws(() => store.readRange('missing'), /blob not found/);
  });

  run('exists is false for an unknown id in both slots', (store) => {
    assert.equal(store.exists('unknown', { pending: true }), false);
    assert.equal(store.exists('unknown', { pending: false }), false);
  });

  run('safeId rejects path-traversal / bogus ids at the byte-store boundary', (store) => {
    for (const id of ['../evil', '/abs/path', 'a/b', 'a\x00b', '..', '', 'has space']) {
      assert.throws(() => store.writePending(id, Buffer.from('x')), /invalid blob id/);
    }
    store.writePending('valid_id-1', Buffer.from('ok'));
    assert.ok(store.exists('valid_id-1', { pending: true }));
  });
}

blobContractSuite(fsSession, { label: 'fsBlobs' });
blobContractSuite(memSession, { label: 'memoryBlobs' });

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

// Resolve once a stream reaches a terminal state: 'end' (clean) or 'error'
// (the error object). 'close' always follows a terminal state and never wins.
function settled(stream) {
  return new Promise((resolve) => {
    let done = false;
    stream.on('data', () => {});
    stream.on('end', () => { done = true; resolve({ kind: 'end' }); });
    stream.on('error', (error) => { if (!done) resolve({ kind: 'error', error }); });
  });
}

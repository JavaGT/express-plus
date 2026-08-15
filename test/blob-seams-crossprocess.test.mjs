// blob-seams-crossprocess.test.mjs — S6/A6 (workbench#97) cross-process
// collision safety: materializers in SEPARATE contexts (distinct lock buffers,
// simulating separate processes that share NO lock state) to the same
// generation and destination directory. The only things keeping them
// collision-free are the seam's no-clobber final publish (link(2), never a
// replace-on-collision rename) and the ownership-verified rollback (a final is
// removed only while its device+inode still match what that invocation wrote).
// These tests pin the observable guarantees:
//  - a loser fails closed — it never overwrites a winner's final and never
//    deletes one, even when its own rollback runs after a failure;
//  - the winner's final survives byte-identical and is the SAME file (same
//    inode) before and after a loser's attempt;
//  - no temp files, no partial generations, no byte-without-sidecar, and no
//    sidecar-without-byte are ever left behind.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

import { generateFrameworkDDL } from '../build/ddl.mjs';
import { compileBlobCensus } from '../build/blob-census.mjs';
import { createBlobStore } from '../build/blob-store.mjs';
import {
  blobGenerationDigestFileName,
  blobMaterializeLockBuffer,
  createBlobSeams,
} from '../build/blob-seams.mjs';

const workerUrl = new URL('./blob-seams-concurrency.worker.mjs', import.meta.url);

// A worker runs one materializer with its OWN byte store and lock buffer (the
// workerData.lockBuffer) into the shared destination and reports
// { ok, error, report } — a genuine outcome, never a worker crash.
function runWorker(workerData) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, { workerData });
    worker.once('message', (message) => resolve(message));
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`cross-process worker exited with code ${code}`));
    });
  });
}

function sha256hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

// A complete, self-contained context: its own in-memory DB, its own byte store,
// and its own seam instance over a caller-supplied lock buffer — exactly what a
// separate process would hold. Store roots live under `root` so one rmSync
// cleans everything up.
function setupContext(root, label, lockBuffer) {
  const storeRoot = join(root, label);
  const db = new DatabaseSync(':memory:');
  for (const sql of generateFrameworkDDL()) db.exec(sql);
  db.exec('CREATE TABLE IF NOT EXISTS Photo (id TEXT PRIMARY KEY, data TEXT)');
  const store = createBlobStore({ root: join(storeRoot, 'blobs'), db });
  const seams = createBlobSeams({
    db,
    blobs: store,
    census: compileBlobCensus({ entities: new Map(), declaredBlobFields: [] }),
    lockBuffer,
  });
  const adopt = (bytes, id) => {
    const uploaded = store.upload({ bytes, id });
    db.exec('BEGIN IMMEDIATE');
    store.adopt(db, uploaded.id);
    db.exec('COMMIT');
    store.finalize(uploaded.id);
    return uploaded;
  };
  return { db, store, seams, adopt };
}

test('a later writer with a separate lock buffer fails closed and never removes the earlier winner’s final', () => {
  const root = mkdtempSync(join(tmpdir(), 'wb-seams-xproc-'));
  const blobsDir = join(root, 'blobs');
  const generation = 'gen-cross-proc';
  const bytes = Buffer.from('the earlier winner’s bytes');
  const contextA = setupContext(root, 'proc-a', blobMaterializeLockBuffer());
  const contextB = setupContext(root, 'proc-b', blobMaterializeLockBuffer());
  try {
    contextA.adopt(bytes, generation);
    contextB.adopt(bytes, generation);

    // Process A materializes first — the winner.
    contextA.seams.materialize(generation, blobsDir);
    const bytePath = join(blobsDir, generation);
    const sidecarPath = join(blobsDir, blobGenerationDigestFileName(generation));
    const winnerByte = readFileSync(bytePath);
    const winnerSidecar = readFileSync(sidecarPath, 'utf8');
    const winnerInode = statSync(bytePath).ino;
    const winnerDev = statSync(bytePath).dev;

    // Process B (its OWN lock buffer — shares no lock state with A) tries the
    // same generation into the same destination: it must fail closed, and its
    // rollback must leave the winner's final EXACTLY as it was — same bytes,
    // same file (device + inode), no temps, no partials.
    assert.throws(
      () => contextB.seams.materialize(generation, blobsDir),
      /already exists/,
      'the later writer fails closed instead of overwriting the winner',
    );

    assert.deepEqual(readFileSync(bytePath), winnerByte, 'the winner’s byte file is byte-identical');
    assert.equal(readFileSync(sidecarPath, 'utf8'), winnerSidecar, 'the winner’s digest sidecar is intact');
    const winnerAfter = statSync(bytePath);
    assert.equal(winnerAfter.ino, winnerInode, 'the winner’s final is the SAME file — never overwritten');
    assert.equal(winnerAfter.dev, winnerDev, 'the winner’s final is on the same device — never replaced');
    assert.deepEqual(
      readdirSync(blobsDir).sort(),
      [generation, blobGenerationDigestFileName(generation)].sort(),
      'no temp files and no partial generation appear after the loser’s attempt',
    );
  } finally {
    contextA.db.close();
    contextB.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('concurrent materializers in SEPARATE contexts (distinct lock buffers, simulating separate processes): one wins, losers fail closed, winner final intact, no corruption', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wb-seams-xproc-concurrent-'));
  const generation = 'gen-cross-concurrent';
  const bytes = Buffer.from('the cross-process content-addressed bytes');
  const rounds = 3;
  const workersPerRound = 8;
  try {
    for (let round = 0; round < rounds; round++) {
      // A fresh shared destination per round so every round is a full race
      // from an empty directory.
      const destBlobDir = join(root, `shared-${round}`, 'blobs');
      // Every worker gets its OWN lock buffer: separate processes share no
      // lock state, so only the no-clobber publish + ownership-verified
      // rollback keep them collision-free.
      const results = await Promise.all(
        Array.from({ length: workersPerRound }, (_, i) =>
          runWorker({
            storeRoot: join(root, `store-${round}-${i}`),
            destBlobDir,
            generation,
            bytes,
            lockBuffer: blobMaterializeLockBuffer(),
          }),
        ),
      );

      const winners = results.filter((r) => r.ok);
      const losers = results.filter((r) => !r.ok);
      assert.ok(winners.length >= 1, 'at least one materializer completes');
      for (const loser of losers) {
        assert.match(
          loser.error,
          /already exists|being materialized by another writer/,
          `a losing materializer fails closed (never a torn/partial error): ${loser.error}`,
        );
      }

      // The winning generation is complete and verified: byte file + sidecar,
      // nothing else — no temps, no partial byte-without-sidecar, nothing a
      // loser could have deleted.
      const entries = readdirSync(destBlobDir);
      assert.deepEqual(
        entries.sort(),
        [generation, blobGenerationDigestFileName(generation)].sort(),
        'only the complete generation is present after every round',
      );
      assert.equal(
        readFileSync(join(destBlobDir, generation)).toString('utf8'),
        bytes.toString('utf8'),
        'the byte file holds the generation bytes',
      );
      assert.equal(
        readFileSync(join(destBlobDir, blobGenerationDigestFileName(generation)), 'utf8').trim(),
        sha256hex(bytes),
        'the digest sidecar matches the bytes',
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

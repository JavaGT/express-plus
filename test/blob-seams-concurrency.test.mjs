// blob-seams-concurrency.test.mjs — S6/A6 (workbench#97) concurrent
// materializers to the same generation. The seam's materialize path is
// synchronous on one thread, so real concurrency is exercised with worker
// threads: several workers each run their own materializer over an isolated
// byte store into the SAME shared destination directory, sharing the
// per-destination lock buffer the seam uses (BlobSeamsOptions.lockBuffer).
// Every interleaving must be safe: each worker either materializes fully or
// loses cleanly (fail-closed on the destination lock or on an already
// materialized generation), the winning generation is complete and verified,
// and no temp files are left behind — a loser never deletes the winner's files.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

import { blobGenerationDigestFileName, blobMaterializeLockBuffer } from '../build/blob-seams.mjs';

const workerUrl = new URL('./blob-seams-concurrency.worker.mjs', import.meta.url);

// A worker runs one materializer into the shared destination and reports
// { ok, error, report } — a genuine outcome, never a worker crash.
function runWorker(workerData) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, { workerData });
    worker.once('message', (message) => resolve(message));
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`concurrency worker exited with code ${code}`));
    });
  });
}

function sha256hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('concurrent materializers to the same generation: one wins, losers fail closed, no torn output, no deleted winner files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wb-seams-concurrent-'));
  const destBlobDir = join(root, 'shared', 'blobs');
  const generation = 'gen-same';
  const bytes = Buffer.from('the same content-addressed bytes for every worker');
  // One lock buffer shared by every worker: the per-destination lock is
  // genuinely cross-thread, so only one materializer may write the shared
  // destination at a time.
  const lockBuffer = blobMaterializeLockBuffer();
  const workers = 6;
  try {
    const results = await Promise.all(
      Array.from({ length: workers }, (_, i) =>
        runWorker({
          storeRoot: join(root, `store-${i}`),
          destBlobDir,
          generation,
          bytes,
          lockBuffer,
        }),
      ),
    );

    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);
    assert.ok(winners.length >= 1, 'at least one materializer completes');
    for (const loser of losers) {
      assert.match(
        loser.error,
        /being materialized by another writer|already exists/,
        `a losing materializer fails closed, not with a torn/partial error: ${loser.error}`,
      );
    }

    // The winner's generation is complete and verified: byte file + sidecar,
    // nothing else (no temps, nothing a loser could have deleted).
    const entries = readdirSync(destBlobDir);
    assert.deepEqual(
      entries.sort(),
      [generation, blobGenerationDigestFileName(generation)].sort(),
      'only the complete generation is present',
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

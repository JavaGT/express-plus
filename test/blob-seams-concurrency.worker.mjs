// Concurrency worker for test/blob-seams-concurrency.test.mjs: runs one
// materializer in its own thread, sharing the per-destination lock buffer with
// the other workers so the seam's per-destination serialization is genuinely
// cross-thread. Each worker has its own isolated byte store but materializes
// the SAME generation (same content-addressed bytes) into the SAME shared
// destination directory, then reports its outcome to the parent.
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { generateFrameworkDDL } from '../build/ddl.mjs';
import { compileBlobCensus } from '../build/blob-census.mjs';
import { createBlobStore } from '../build/blob-store.mjs';
import { createBlobSeams } from '../build/blob-seams.mjs';

const { storeRoot, destBlobDir, generation, bytes, lockBuffer } = workerData;

let ok = false;
let error = null;
let report = null;
try {
  mkdirSync(join(storeRoot, 'blobs'), { recursive: true });
  const db = new DatabaseSync(':memory:');
  for (const sql of generateFrameworkDDL()) db.exec(sql);
  const store = createBlobStore({ root: join(storeRoot, 'blobs'), db });
  const seams = createBlobSeams({
    db,
    blobs: store,
    census: compileBlobCensus({ entities: new Map(), declaredBlobFields: [] }),
    lockBuffer,
  });
  const uploaded = store.upload({ bytes, id: generation });
  db.exec('BEGIN IMMEDIATE');
  store.adopt(db, uploaded.id);
  db.exec('COMMIT');
  store.finalize(uploaded.id);
  report = seams.materialize(generation, destBlobDir);
  ok = true;
} catch (err) {
  error = err instanceof Error ? err.message : String(err);
}
parentPort.postMessage({ ok, error, report });

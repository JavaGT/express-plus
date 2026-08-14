// blob-seams-recycle.test.mjs — S6/A6 (workbench#97) the recycle side of the
// real blob seams: resolveBackupBlobName resolves EXACTLY the file name
// materialize wrote (name-resolution parity) and fails closed on missing,
// unverifiable, or invalid generations — the recycle module never guesses at
// file names. Plus the real recycle-manager integration: bin() moves a
// generation's bytes out of a real backup and re-marks its manifest, and
// restore() moves them back, all through the same seam-resolved name.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateFrameworkDDL } from '../build/ddl.mjs';
import { compileBlobCensus } from '../build/blob-census.mjs';
import { createBlobStore } from '../build/blob-store.mjs';
import { createBlobSeams, blobGenerationDigestFileName } from '../build/blob-seams.mjs';
import { openSqliteAdapter } from '../build/sqlite-adapter.mjs';
import { createWriteQueue } from '../build/write-queue.mjs';
import { createBackupManager } from '../build/backup.mjs';
import { createRecycleManager } from '../build/backup/recycle.mjs';

function sha256hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function photoCensus() {
  return compileBlobCensus({
    entities: new Map(),
    declaredBlobFields: [
      { actionName: 'Photo.upload', field: 'data', resourceField: 'id', owningResource: 'Photo', erasureCategory: 'deletable' },
    ],
  });
}

async function setupSeams() {
  const root = mkdtempSync(join(tmpdir(), 'wb-seams-recycle-'));
  const db = new DatabaseSync(':memory:');
  for (const sql of generateFrameworkDDL()) db.exec(sql);
  db.exec('CREATE TABLE IF NOT EXISTS Photo (id TEXT PRIMARY KEY, data TEXT)');
  const blobs = createBlobStore({ root, db });
  const seams = createBlobSeams({ db, blobs, census: photoCensus() });
  const adopt = (bytes, id) => {
    const uploaded = blobs.upload({ bytes, id });
    db.exec('BEGIN IMMEDIATE');
    blobs.adopt(db, uploaded.id);
    db.exec('COMMIT');
    blobs.finalize(uploaded.id);
    return uploaded;
  };
  return { root, db, blobs, seams, adopt };
}

const BYTES = Buffer.from('recycle me');

test('resolveBackupBlobName resolves exactly the file name materialize wrote', async () => {
  const { root, seams, adopt } = await setupSeams();
  const blobsDir = mkdtempSync(join(tmpdir(), 'wb-recycle-'));
  try {
    const uploaded = adopt(BYTES, 'gen-cyc');
    const report = seams.materialize('gen-cyc', blobsDir);
    assert.deepEqual(report, [{ name: 'gen-cyc', size: BYTES.length }]);
    assert.equal(seams.resolveBackupBlobName('gen-cyc', blobsDir), report[0].name, 'recycle resolves the materialized name');
    assert.equal(seams.resolveBackupBlobName('gen-cyc', blobsDir), 'gen-cyc', 'the stable name is the generation id');
    assert.equal(uploaded.sha256, sha256hex(BYTES));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(blobsDir, { recursive: true, force: true });
  }
});

test('resolveBackupBlobName fails closed on missing, corrupt, and invalid generations', async () => {
  const { root, seams, adopt } = await setupSeams();
  const blobsDir = mkdtempSync(join(tmpdir(), 'wb-recycle-'));
  try {
    adopt(BYTES, 'gen-cyc');
    seams.materialize('gen-cyc', blobsDir);

    // Missing byte file → unresolvable.
    rmSync(join(blobsDir, 'gen-cyc'), { force: true });
    assert.throws(() => seams.resolveBackupBlobName('gen-cyc', blobsDir), /cannot be resolved/);

    // Corrupt bytes → unresolvable (never bin unverifiable bytes).
    writeFileSync(join(blobsDir, 'gen-cyc'), BYTES);
    writeFileSync(join(blobsDir, blobGenerationDigestFileName('gen-cyc')), `${'0'.repeat(64)}\n`);
    assert.throws(() => seams.resolveBackupBlobName('gen-cyc', blobsDir), /failed digest verification/);

    // A generation that was never written to this backup is not guessed at.
    assert.throws(() => seams.resolveBackupBlobName('gen-never', blobsDir), /cannot be resolved/);

    // An invalid generation id is refused outright.
    assert.throws(() => seams.resolveBackupBlobName('../escape', blobsDir), /invalid blob generation/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(blobsDir, { recursive: true, force: true });
  }
});

// ---- recycle-manager integration over a real backup -----------------------

async function setupRealBackup() {
  const root = mkdtempSync(join(tmpdir(), 'wb-seams-recycle-real-'));
  const dir = join(root, 'owned');
  const opened = openSqliteAdapter({ directory: dir, name: 'app' });
  const db = opened.handle;
  for (const sql of generateFrameworkDDL()) db.exec(sql);
  db.exec('CREATE TABLE Photo (id TEXT PRIMARY KEY, data TEXT)');
  const blobs = createBlobStore({ root: join(dir, 'blobs'), db });
  const seams = createBlobSeams({ db, blobs, census: photoCensus() });
  const uploaded = blobs.upload({ bytes: BYTES, id: 'gen-recycle' });
  db.exec('BEGIN IMMEDIATE');
  blobs.adopt(db, uploaded.id);
  db.exec('COMMIT');
  blobs.finalize(uploaded.id);
  db.prepare('INSERT INTO Photo (id, data) VALUES (?, ?)').run('p1', uploaded.id);

  const coordinator = createWriteQueue();
  opened.writeCoordinator = coordinator;
  const manager = createBackupManager({ source: opened, writeCoordinator: coordinator, blobs: seams });
  const result = await manager.backup();
  if (!result.ok || result.status !== 'complete') throw new Error('setup backup did not complete');
  return {
    root,
    dir,
    opened,
    seams,
    backupDir: result.directory,
    backupId: result.directory.split(/[\\/]/).pop(),
  };
}

test('recycle bin + restore works through the real seam over a real backup', async () => {
  const { root, dir, opened, seams, backupDir, backupId } = await setupRealBackup();
  try {
    const recycle = createRecycleManager({ root: dir, blobs: seams });

    const binned = await recycle.bin({ generations: ['gen-recycle'] });
    assert.equal(binned.ok, true, 'binning a generation from a real backup succeeds');
    assert.deepEqual(binned.binned, [{ backupId, generations: ['gen-recycle'] }]);
    assert.equal(existsSync(join(backupDir, 'blobs', 'gen-recycle')), false, 'the byte file moved out of the backup');
    assert.equal(existsSync(join(dir, 'recycle', backupId, 'gen-recycle', 'gen-recycle')), true, 'the bytes landed in the bin');

    // The re-marked manifest still records the census truthfully (never rewrites
    // blobGenerations) — the bin entry carries the seam-resolved name.
    const listing = recycle.list();
    assert.equal(listing.length, 1);
    assert.equal(listing[0].name, 'gen-recycle', 'the bin records the exact name resolveBackupBlobName resolved');
    assert.equal(listing[0].size, BYTES.length);

    const restored = await recycle.restore({ backupId, generation: 'gen-recycle' });
    assert.equal(restored.ok, true, 'restore moves the bytes back');
    assert.equal(readFileSync(join(backupDir, 'blobs', 'gen-recycle'), 'utf8'), 'recycle me');
    assert.equal(existsSync(join(backupDir, 'blobs', blobGenerationDigestFileName('gen-recycle'))), true, 'the digest sidecar survived for re-verification');
    assert.equal(seams.resolveBackupBlobName('gen-recycle', join(backupDir, 'blobs')), 'gen-recycle', 'the backup is resolvable again after restore');
  } finally {
    opened.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('recycle bin refuses fail-closed when a referenced generation cannot be resolved', async () => {
  const { root, dir, opened, seams, backupDir } = await setupRealBackup();
  try {
    rmSync(join(backupDir, 'blobs', 'gen-recycle'), { force: true });
    rmSync(join(backupDir, 'blobs', blobGenerationDigestFileName('gen-recycle')), { force: true });
    const recycle = createRecycleManager({ root: dir, blobs: seams });
    const binned = await recycle.bin({ generations: ['gen-recycle'] });
    assert.equal(binned.ok, false, 'an unresolvable generation fails the bin closed');
    assert.equal(binned.binned.length, 0);
    assert.equal(binned.failed.length, 1);
    assert.match(binned.failed[0].error, /gen-recycle/);
    assert.equal(existsSync(join(dir, 'recycle')), true, 'recycle dir exists but holds nothing for this backup');
  } finally {
    opened.close();
    rmSync(root, { recursive: true, force: true });
  }
});

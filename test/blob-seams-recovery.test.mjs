// blob-seams-recovery.test.mjs — S6/A6 (workbench#97) the recovery side of the
// real blob seams: verifyBackupGeneration / materializeRestoreGeneration /
// censusAfterRestore against real backup + target directories, with missing,
// corrupt, extra, and mismatched bytes. Also the real recovery-manager
// integration: recoverIntoFreshDirectory restores the DB + blob bytes (with
// the digest sidecar) and refuses when a referenced generation's bytes are
// missing or corrupt — before activation, never marking the restore complete.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateFrameworkDDL } from '../build/ddl.mjs';
import { compileBlobCensus } from '../build/blob-census.mjs';
import { createBlobStore } from '../build/blob-store.mjs';
import { createBlobSeams, blobGenerationDigestFileName } from '../build/blob-seams.mjs';
import { openSqliteAdapter } from '../build/sqlite-adapter.mjs';
import { createWriteQueue } from '../build/write-queue.mjs';
import { createBackupManager } from '../build/backup.mjs';
import { createRecoveryManager } from '../build/recovery.mjs';

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

// The seams over a real store — the recovery methods (verify/materialize/
// census) are filesystem-only, so each unit test builds its own backup blobs/
// directory and exercises the seam against real files.
async function setupSeams() {
  const root = mkdtempSync(join(tmpdir(), 'wb-seams-recovery-'));
  const db = new DatabaseSync(':memory:');
  for (const sql of generateFrameworkDDL()) db.exec(sql);
  db.exec('CREATE TABLE IF NOT EXISTS Photo (id TEXT PRIMARY KEY, data TEXT)');
  const blobs = createBlobStore({ root, db });
  const seams = createBlobSeams({ db, blobs, census: photoCensus() });
  return { root, db, blobs, seams };
}

// Build a backup-like blobs/ directory: byte file + digest sidecar.
function makeBackupBlobs(generation, bytes) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-backupblobs-'));
  writeFileSync(join(dir, generation), bytes);
  writeFileSync(join(dir, blobGenerationDigestFileName(generation)), `${sha256hex(bytes)}\n`);
  return dir;
}

// A real backup via the backup manager (snapshot + manifest + blobs/), used by
// the recovery-manager integration tests.
async function setupRealBackup() {
  const root = mkdtempSync(join(tmpdir(), 'wb-seams-recover-'));
  const dir = join(root, 'owned');
  const opened = openSqliteAdapter({ directory: dir, name: 'app' });
  const db = opened.handle;
  for (const sql of generateFrameworkDDL()) db.exec(sql);
  db.exec('CREATE TABLE Photo (id TEXT PRIMARY KEY, data TEXT)');
  const blobs = createBlobStore({ root: join(dir, 'blobs'), db });
  const seams = createBlobSeams({ db, blobs, census: photoCensus() });
  const uploaded = blobs.upload({ bytes: Buffer.from('restore me'), id: 'gen-restore' });
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
    db,
    blobs,
    seams,
    backupDir: result.directory,
    backupId: result.directory.split(/[\\/]/).pop(),
    uploaded,
  };
}

function recoveryManager(opened, seams) {
  const coordinator = createWriteQueue();
  opened.writeCoordinator = coordinator;
  return createRecoveryManager({ source: opened, writeCoordinator: coordinator, blobs: seams });
}

const BYTES = Buffer.from('restore me');

test('verifyBackupGeneration passes for a backed-up generation and throws on missing bytes', async () => {
  const { root, seams } = await setupSeams();
  const backupBlobs = makeBackupBlobs('gen-restore', BYTES);
  try {
    seams.verifyBackupGeneration('gen-restore', backupBlobs); // no throw
    rmSync(join(backupBlobs, 'gen-restore'), { force: true });
    assert.throws(() => seams.verifyBackupGeneration('gen-restore', backupBlobs), /unavailable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(backupBlobs, { recursive: true, force: true });
  }
});

test('verifyBackupGeneration throws on corrupt bytes and on a missing/mismatched digest sidecar', async () => {
  const { root, seams } = await setupSeams();
  const backupBlobs = makeBackupBlobs('gen-restore', BYTES);
  try {
    // Same-size corruption: the digest sidecar catches it.
    writeFileSync(join(backupBlobs, 'gen-restore'), Buffer.from('TAMPERED!!'));
    assert.throws(() => seams.verifyBackupGeneration('gen-restore', backupBlobs), /failed digest verification/);

    // A mismatched sidecar (claims a different digest) is refused too.
    writeFileSync(join(backupBlobs, 'gen-restore'), BYTES);
    writeFileSync(join(backupBlobs, blobGenerationDigestFileName('gen-restore')), `${'0'.repeat(64)}\n`);
    assert.throws(() => seams.verifyBackupGeneration('gen-restore', backupBlobs), /failed digest verification/);

    // A missing sidecar is unverifiable → fail closed.
    rmSync(join(backupBlobs, blobGenerationDigestFileName('gen-restore')), { force: true });
    assert.throws(() => seams.verifyBackupGeneration('gen-restore', backupBlobs), /digest sidecar/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(backupBlobs, { recursive: true, force: true });
  }
});

test('materializeRestoreGeneration restores verified bytes + sidecar into the target blobs layout', async () => {
  const { root, seams } = await setupSeams();
  const backupBlobs = makeBackupBlobs('gen-restore', BYTES);
  const target = mkdtempSync(join(tmpdir(), 'wb-target-'));
  const destBlobs = join(target, 'blobs');
  mkdirSync(destBlobs);
  try {
    const report = seams.materializeRestoreGeneration('gen-restore', backupBlobs, destBlobs);
    assert.deepEqual(report, [{ name: 'gen-restore', size: BYTES.length }]);
    assert.equal(readFileSync(join(destBlobs, 'gen-restore'), 'utf8'), 'restore me');
    assert.equal(existsSync(join(destBlobs, blobGenerationDigestFileName('gen-restore'))), true, 'the target holds the digest sidecar too');

    // A corrupt backup byte file is refused before anything lands in the target.
    writeFileSync(join(backupBlobs, 'gen-restore'), Buffer.from('TAMPERED!!'));
    const target2 = mkdtempSync(join(tmpdir(), 'wb-target-'));
    const dest2 = join(target2, 'blobs');
    mkdirSync(dest2);
    assert.throws(() => seams.materializeRestoreGeneration('gen-restore', backupBlobs, dest2), /failed digest verification/);
    assert.equal(existsSync(join(dest2, 'gen-restore')), false, 'corrupt bytes never reach the target');
    rmSync(target2, { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(backupBlobs, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test('censusAfterRestore passes when every referenced generation is present, tolerating extra files', async () => {
  const { root, seams } = await setupSeams();
  const target = mkdtempSync(join(tmpdir(), 'wb-target-'));
  const destBlobs = join(target, 'blobs');
  mkdirSync(destBlobs);
  try {
    writeFileSync(join(destBlobs, 'gen-restore'), BYTES);
    writeFileSync(join(destBlobs, blobGenerationDigestFileName('gen-restore')), `${sha256hex(BYTES)}\n`);
    // Extra, unreferenced files in the target are not the census's business.
    writeFileSync(join(destBlobs, 'gen-extra'), Buffer.from('extra bytes'));
    writeFileSync(join(destBlobs, 'unrelated.txt'), Buffer.from('not a blob'));
    seams.censusAfterRestore(['gen-restore'], target); // no throw
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test('censusAfterRestore throws on missing and on mismatched target bytes', async () => {
  const { root, seams } = await setupSeams();
  const target = mkdtempSync(join(tmpdir(), 'wb-target-'));
  const destBlobs = join(target, 'blobs');
  mkdirSync(destBlobs);
  try {
    // Missing generation → the restored store cannot serve → throw.
    assert.throws(() => seams.censusAfterRestore(['gen-restore'], target), /unavailable in the restored store/);

    // Same-size tampered bytes → digest mismatch → throw.
    writeFileSync(join(destBlobs, 'gen-restore'), Buffer.from('TAMPERED!!'));
    writeFileSync(join(destBlobs, blobGenerationDigestFileName('gen-restore')), `${sha256hex(BYTES)}\n`);
    assert.throws(() => seams.censusAfterRestore(['gen-restore'], target), /failed digest verification/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

// ---- recovery-manager integration ----------------------------------------

test('recoverIntoFreshDirectory restores the DB and blob bytes with the seam, census-before-serve', async () => {
  const { root, opened, seams, backupId, uploaded } = await setupRealBackup();
  try {
    const fresh = join(root, 'fresh');
    const recovery = recoveryManager(opened, seams);
    const out = await recovery.recoverIntoFreshDirectory({ backupId, directory: fresh });
    assert.equal(out.ok, true, 'fresh restore completes with the real seam');
    assert.equal(out.status, 'restored');
    assert.equal(existsSync(join(fresh, 'data.sqlite')), true, 'the restored database is installed');
    assert.equal(readFileSync(join(fresh, 'blobs', 'gen-restore'), 'utf8'), 'restore me', 'restored blob bytes are the verified bytes');
    assert.equal(existsSync(join(fresh, 'blobs', blobGenerationDigestFileName('gen-restore'))), true);
    assert.equal(out.census.blobs.ok, true, 'the blob census passed before serving');
    assert.equal(out.census.schema.ok, true, 'the schema census passed before serving');
    assert.ok(out.census.blobs.reason === undefined, 'no blob census failure recorded');
    assert.equal(uploaded.sha256, sha256hex(BYTES));
  } finally {
    opened.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('recoverIntoFreshDirectory refuses when a referenced generation bytes are missing', async () => {
  const { root, opened, seams, backupId, backupDir } = await setupRealBackup();
  try {
    rmSync(join(backupDir, 'blobs', 'gen-restore'), { force: true });
    rmSync(join(backupDir, 'blobs', blobGenerationDigestFileName('gen-restore')), { force: true });
    const fresh = join(root, 'fresh');
    const recovery = recoveryManager(opened, seams);
    const out = await recovery.recoverIntoFreshDirectory({ backupId, directory: fresh });
    assert.equal(out.ok, false, 'a backup with missing referenced bytes is refused');
    assert.equal(out.status, 'rejected');
    assert.match(JSON.stringify(out.validation ?? []), /gen-restore/);
    assert.equal(existsSync(fresh), false, 'the disposable fresh directory is not left behind');
  } finally {
    opened.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('recoverIntoFreshDirectory refuses when a referenced generation bytes are corrupt', async () => {
  const { root, opened, seams, backupId, backupDir } = await setupRealBackup();
  try {
    writeFileSync(join(backupDir, 'blobs', 'gen-restore'), Buffer.from('TAMPERED!!'));
    const fresh = join(root, 'fresh');
    const recovery = recoveryManager(opened, seams);
    const out = await recovery.recoverIntoFreshDirectory({ backupId, directory: fresh });
    assert.equal(out.ok, false, 'corrupt referenced bytes are refused before activation');
    assert.equal(out.status, 'rejected');
    assert.match(JSON.stringify(out.validation ?? []), /gen-restore/);
  } finally {
    opened.close();
    rmSync(root, { recursive: true, force: true });
  }
});

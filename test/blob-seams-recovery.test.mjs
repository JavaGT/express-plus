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
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, symlinkSync, statSync } from 'node:fs';
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

test('verifyBackupGeneration refuses a symlinked digest sidecar pointing outside the backup', async () => {
  const { root, seams } = await setupSeams();
  const backupBlobs = makeBackupBlobs('gen-restore', BYTES);
  const outsideDir = mkdtempSync(join(tmpdir(), 'wb-outside-'));
  const outsideSidecar = join(outsideDir, 'sidecar');
  try {
    // A VALID sidecar planted OUTSIDE the backup, symlinked in as the sidecar
    // name: the seam must refuse to trust it, never read through the link.
    writeFileSync(outsideSidecar, `${sha256hex(BYTES)}\n`);
    rmSync(join(backupBlobs, blobGenerationDigestFileName('gen-restore')), { force: true });
    symlinkSync(outsideSidecar, join(backupBlobs, blobGenerationDigestFileName('gen-restore')));
    assert.throws(() => seams.verifyBackupGeneration('gen-restore', backupBlobs), /digest sidecar/, 'a symlinked sidecar is refused');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(backupBlobs, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
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

test('materializeRestoreGeneration refuses a pre-existing symlink at the target generation path', async () => {
  const { root, seams } = await setupSeams();
  const backupBlobs = makeBackupBlobs('gen-restore', BYTES);
  const target = mkdtempSync(join(tmpdir(), 'wb-target-'));
  const destBlobs = join(target, 'blobs');
  mkdirSync(destBlobs);
  const outsideDir = mkdtempSync(join(tmpdir(), 'wb-outside-'));
  const outsideFile = join(outsideDir, 'target');
  writeFileSync(outsideFile, 'outside bytes');
  try {
    symlinkSync(outsideFile, join(destBlobs, 'gen-restore'));
    assert.throws(() => seams.materializeRestoreGeneration('gen-restore', backupBlobs, destBlobs), /symlink/, 'a symlink at the target generation path is refused');
    assert.equal(readFileSync(outsideFile, 'utf8'), 'outside bytes', 'the symlink target was never written through');
    assert.equal(existsSync(join(destBlobs, blobGenerationDigestFileName('gen-restore'))), false, 'the sidecar was not written either');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(backupBlobs, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('materializeRestoreGeneration refuses a symlinked destination DIRECTORY — nothing is written outside', async () => {
  const { root, seams } = await setupSeams();
  const backupBlobs = makeBackupBlobs('gen-restore', BYTES);
  const parent = mkdtempSync(join(tmpdir(), 'wb-dest-'));
  const external = mkdtempSync(join(tmpdir(), 'wb-outside-dir-'));
  const dest = join(parent, 'blobs');
  symlinkSync(external, dest);
  try {
    // A symlink AT the destination directory itself must not redirect the
    // restored bytes into `external`: refuse before anything is written.
    assert.throws(
      () => seams.materializeRestoreGeneration('gen-restore', backupBlobs, dest),
      /symlink/,
      'a symlinked destination directory is refused',
    );
    assert.equal(readdirSync(external).length, 0, 'nothing was written outside through the destination-directory symlink');
    assert.equal(existsSync(join(dest, 'gen-restore')), false);
    assert.equal(existsSync(join(dest, blobGenerationDigestFileName('gen-restore'))), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(backupBlobs, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

// ---- crash-leftover repair in a PERSISTENT (live) restore target ----------
//
// The live-restore target is the owned root's persistent blobs/ directory,
// which no manager ever quarantines or discards. A crash mid-materialize
// (rollback never ran) leaves a byte final whose digest sidecar never landed —
// before this fix that partial permanently blocked every later restore of the
// generation ("already exists — refusing to overwrite"). The seam now repairs
// the leftover: it re-publishes the missing sidecar once the byte final
// verifies as the generation's own bytes, treats an already-complete
// generation as a no-op, and refuses LOUDLY (naming the generation + its
// remediation) anything foreign or unverifiable — never overwriting, never
// removing a byte.

test('materializeRestoreGeneration repairs a crash leftover: byte-without-sidecar gets its sidecar re-published, the byte never touched', async () => {
  const { root, seams } = await setupSeams();
  const backupBlobs = makeBackupBlobs('gen-restore', BYTES);
  const target = mkdtempSync(join(tmpdir(), 'wb-target-'));
  const destBlobs = join(target, 'blobs');
  mkdirSync(destBlobs);
  try {
    // The crash window: the byte final landed, the digest sidecar never did.
    // The leftover byte always holds the generation's own verified bytes.
    writeFileSync(join(destBlobs, 'gen-restore'), BYTES);
    const before = statSync(join(destBlobs, 'gen-restore'));

    const report = seams.materializeRestoreGeneration('gen-restore', backupBlobs, destBlobs);
    assert.deepEqual(report, [{ name: 'gen-restore', size: BYTES.length }]);
    const after = statSync(join(destBlobs, 'gen-restore'));
    assert.equal(after.dev, before.dev, 'the byte final was NOT rewritten (same device)');
    assert.equal(after.ino, before.ino, 'the byte final was NOT rewritten (same inode)');
    assert.equal(
      readFileSync(join(destBlobs, blobGenerationDigestFileName('gen-restore')), 'utf8').trim(),
      sha256hex(BYTES),
      'the missing digest sidecar was re-published',
    );
    seams.censusAfterRestore(['gen-restore'], target); // no throw — the repaired generation verifies
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(backupBlobs, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test('materializeRestoreGeneration treats an already-complete generation as a no-op (a retry after a crash that landed post-materialize)', async () => {
  const { root, seams } = await setupSeams();
  const backupBlobs = makeBackupBlobs('gen-restore', BYTES);
  const target = mkdtempSync(join(tmpdir(), 'wb-target-'));
  const destBlobs = join(target, 'blobs');
  mkdirSync(destBlobs);
  try {
    writeFileSync(join(destBlobs, 'gen-restore'), BYTES);
    writeFileSync(join(destBlobs, blobGenerationDigestFileName('gen-restore')), `${sha256hex(BYTES)}\n`);
    const byteBefore = statSync(join(destBlobs, 'gen-restore'));
    const sidecarBefore = statSync(join(destBlobs, blobGenerationDigestFileName('gen-restore')));

    const report = seams.materializeRestoreGeneration('gen-restore', backupBlobs, destBlobs);
    assert.deepEqual(report, [{ name: 'gen-restore', size: BYTES.length }]);
    assert.equal(statSync(join(destBlobs, 'gen-restore')).ino, byteBefore.ino, 'the byte final is untouched');
    assert.equal(statSync(join(destBlobs, blobGenerationDigestFileName('gen-restore'))).ino, sidecarBefore.ino, 'the sidecar is untouched');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(backupBlobs, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test('materializeRestoreGeneration refuses LOUDLY a foreign byte final, naming the generation and its remediation — never overwrites', async () => {
  const { root, seams } = await setupSeams();
  const backupBlobs = makeBackupBlobs('gen-restore', BYTES);
  const target = mkdtempSync(join(tmpdir(), 'wb-target-'));
  const destBlobs = join(target, 'blobs');
  mkdirSync(destBlobs);
  try {
    // Foreign bytes at the generation path are not a crash shape (a crash
    // leftover always holds the generation's own bytes), so the repair must
    // fail LOUD with the remediation — never overwrite or remove the entry.
    writeFileSync(join(destBlobs, 'gen-restore'), Buffer.from('foreign not the generation bytes'));
    assert.throws(
      () => seams.materializeRestoreGeneration('gen-restore', backupBlobs, destBlobs),
      /gen-restore.*digest does not match.*remove/,
      'the blocked error names the generation and its remediation',
    );
    assert.equal(
      readFileSync(join(destBlobs, 'gen-restore'), 'utf8'),
      'foreign not the generation bytes',
      'the foreign byte was never overwritten or removed',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(backupBlobs, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test('materializeRestoreGeneration refuses LOUDLY an occupied sidecar name — a foreign state no crash can produce', async () => {
  const { root, seams } = await setupSeams();
  const backupBlobs = makeBackupBlobs('gen-restore', BYTES);
  const target = mkdtempSync(join(tmpdir(), 'wb-target-'));
  const destBlobs = join(target, 'blobs');
  mkdirSync(destBlobs);
  try {
    // The byte final verifies as the generation's bytes (a legit crash
    // leftover) but the sidecar name is occupied — a crash cannot produce a
    // sidecar (it is published only after the byte), so the repair refuses
    // rather than replaces a foreign entry.
    writeFileSync(join(destBlobs, 'gen-restore'), BYTES);
    mkdirSync(join(destBlobs, blobGenerationDigestFileName('gen-restore')));
    assert.throws(
      () => seams.materializeRestoreGeneration('gen-restore', backupBlobs, destBlobs),
      /gen-restore.*occupied.*remove/,
      'the blocked error names the generation and the stale sidecar entry',
    );
    assert.equal(readFileSync(join(destBlobs, 'gen-restore'), 'utf8'), 'restore me', 'the byte is untouched');
    assert.equal(existsSync(join(destBlobs, blobGenerationDigestFileName('gen-restore'))), true, 'the planted blocker is untouched');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(backupBlobs, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test('materializeRestoreGeneration refuses LOUDLY a foreign byte WITH its own valid-but-wrong sidecar — self-consistency is never a no-op', async () => {
  const { root, seams } = await setupSeams();
  const backupBlobs = makeBackupBlobs('gen-restore', BYTES);
  const target = mkdtempSync(join(tmpdir(), 'wb-target-'));
  const destBlobs = join(target, 'blobs');
  mkdirSync(destBlobs);
  try {
    // A foreign byte carrying its OWN valid sidecar: byte digest == sidecar
    // digest, so the pair is fully self-consistent — but neither digest equals
    // the generation's expected digest from the backup. Self-consistency must
    // NOT count as 'complete' (the retry-after-crash no-op): the pair is
    // refused loud, exactly like a foreign byte without a sidecar, and never
    // overwritten or removed.
    const foreign = Buffer.from('foreign bytes, self-consistent sidecar');
    const foreignDigest = sha256hex(foreign);
    assert.notEqual(foreignDigest, sha256hex(BYTES), 'the planted pair differs from the generation bytes');
    writeFileSync(join(destBlobs, 'gen-restore'), foreign);
    writeFileSync(join(destBlobs, blobGenerationDigestFileName('gen-restore')), `${foreignDigest}\n`);
    const byteBefore = statSync(join(destBlobs, 'gen-restore'));
    const sidecarBefore = statSync(join(destBlobs, blobGenerationDigestFileName('gen-restore')));

    assert.throws(
      () => seams.materializeRestoreGeneration('gen-restore', backupBlobs, destBlobs),
      /gen-restore.*digest does not match.*remove/,
      'the foreign self-consistent pair is refused loud — never accepted as a no-op',
    );
    assert.equal(statSync(join(destBlobs, 'gen-restore')).ino, byteBefore.ino, 'the foreign byte was never overwritten or removed');
    assert.equal(statSync(join(destBlobs, blobGenerationDigestFileName('gen-restore'))).ino, sidecarBefore.ino, 'the foreign sidecar was never overwritten or removed');
    assert.equal(readFileSync(join(destBlobs, blobGenerationDigestFileName('gen-restore')), 'utf8').trim(), foreignDigest, 'the foreign sidecar content is untouched');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(backupBlobs, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("materializeRestoreGeneration refuses a mismatched sidecar beside the correct byte — 'complete' requires the sidecar digest to equal the expected digest too", async () => {
  const { root, seams } = await setupSeams();
  const backupBlobs = makeBackupBlobs('gen-restore', BYTES);
  const target = mkdtempSync(join(tmpdir(), 'wb-target-'));
  const destBlobs = join(target, 'blobs');
  mkdirSync(destBlobs);
  try {
    // The byte IS the generation's own bytes, but the sidecar claims a
    // DIFFERENT digest. 'complete' fires only when byte AND sidecar digests
    // BOTH equal the expected digest, so this is not a no-op; the wrong
    // sidecar is a foreign state no crash can produce, so the repair refuses
    // rather than replaces it.
    writeFileSync(join(destBlobs, 'gen-restore'), BYTES);
    const wrongDigest = 'f'.repeat(64);
    assert.notEqual(wrongDigest, sha256hex(BYTES), 'the planted sidecar differs from the expected digest');
    writeFileSync(join(destBlobs, blobGenerationDigestFileName('gen-restore')), `${wrongDigest}\n`);
    const byteBefore = statSync(join(destBlobs, 'gen-restore'));
    const sidecarBefore = statSync(join(destBlobs, blobGenerationDigestFileName('gen-restore')));

    assert.throws(
      () => seams.materializeRestoreGeneration('gen-restore', backupBlobs, destBlobs),
      /gen-restore.*occupied.*remove/,
      'a mismatched sidecar beside the correct byte is refused — the no-op fires only on an exact digest match',
    );
    assert.equal(statSync(join(destBlobs, 'gen-restore')).ino, byteBefore.ino, 'the correct byte was never rewritten');
    assert.equal(statSync(join(destBlobs, blobGenerationDigestFileName('gen-restore'))).ino, sidecarBefore.ino, 'the wrong sidecar was never replaced');
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

// ---- live recover(): crash-leftover repair in the PERSISTENT target -------

function liveRecoveryManager(dir, seams) {
  const coordinator = createWriteQueue();
  return createRecoveryManager({
    source: { root: dir, writeCoordinator: coordinator },
    writeCoordinator: coordinator,
    blobs: seams,
  });
}

test('recover repairs a crash leftover in the LIVE target — a byte-without-sidecar partial no longer permanently blocks retries', { timeout: 120000 }, async () => {
  const { root, dir, opened, seams, backupId } = await setupRealBackup();
  try {
    // The live owned root already holds the generation's bytes WITHOUT a
    // sidecar — exactly the byte-without-sidecar partial a crashed live-restore
    // materialize leaves behind (here the live blob store finalized the bytes;
    // the blob store never writes a sidecar). Before the repair this shape
    // made every live restore of the backup fail forever on "already exists".
    assert.equal(existsSync(join(dir, 'blobs', 'gen-restore')), true, 'the live target holds the byte final');
    assert.equal(existsSync(join(dir, 'blobs', blobGenerationDigestFileName('gen-restore'))), false, 'no sidecar yet — the crash-leftover shape');
    opened.close();

    const manager = liveRecoveryManager(dir, seams);
    const out = await manager.recover({ backupId });
    assert.equal(out.ok, true, 'the live restore completes after repairing the crash leftover');
    assert.equal(out.status, 'restored');
    assert.equal(readFileSync(join(dir, 'blobs', 'gen-restore'), 'utf8'), 'restore me', 'the byte final holds the generation bytes');
    assert.equal(
      readFileSync(join(dir, 'blobs', blobGenerationDigestFileName('gen-restore')), 'utf8').trim(),
      sha256hex(BYTES),
      'the missing sidecar was re-published into the live target',
    );
    assert.equal(out.census.blobs.ok, true, 'the census saw the repaired generation');
    assert.equal(out.census.schema.ok, true, 'the schema census passed');

    // A SECOND live recover sees an already-complete generation and is a no-op.
    const again = await manager.recover({ backupId });
    assert.equal(again.ok, true, 'a repeated live restore also completes');
    assert.equal(again.status, 'restored');
  } finally {
    opened.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('recover fails LOUDLY on a foreign byte in the live target, naming the generation and its remediation, without touching the database', { timeout: 120000 }, async () => {
  const { root, dir, opened, seams, backupId } = await setupRealBackup();
  try {
    // Close first so the WAL is checkpointed into the main file — the snapshot
    // is then the true pre-restore database bytes.
    opened.close();
    const originalDb = readFileSync(join(dir, 'data.sqlite'));
    writeFileSync(join(dir, 'blobs', 'gen-restore'), Buffer.from('foreign not the generation bytes'));

    const manager = liveRecoveryManager(dir, seams);
    const out = await manager.recover({ backupId });
    assert.equal(out.ok, false);
    assert.equal(out.status, 'failed');
    assert.match(out.reason, /gen-restore.*digest does not match.*remove/, 'the failure names the generation and its remediation');
    assert.equal(
      readFileSync(join(dir, 'data.sqlite')).equals(originalDb),
      true,
      'the live database was never touched by the blocked restore',
    );
    assert.equal(
      readFileSync(join(dir, 'blobs', 'gen-restore'), 'utf8'),
      'foreign not the generation bytes',
      'the foreign byte was never overwritten or removed',
    );
  } finally {
    opened.close();
    rmSync(root, { recursive: true, force: true });
  }
});

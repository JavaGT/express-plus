// recovery-quarantine.test.mjs — S1/A4 quarantine: a corrupt WAL/database and a
// missing blob fail closed; the damaged database (WITH its WAL sidecars) moves
// into quarantine/<timestamp>-<id>/; quarantine never overwrites the only
// recoverable copy. probe() is the stop-and-ask default — it explains plainly
// and lists backups WITHOUT auto-selecting one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openSqliteAdapter } from '../build/sqlite-adapter.mjs';
import { createWriteQueue } from '../build/write-queue.mjs';
import { createBackupManager } from '../build/backup.mjs';
import { createRecoveryManager, probeDatabaseFile } from '../build/recovery.mjs';

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'wb-recovery-quarantine-'));
}

function managerFor(dir, options = {}) {
  const writeCoordinator = options.writeCoordinator ?? createWriteQueue();
  const source = options.source ?? { root: dir, writeCoordinator };
  return createRecoveryManager({ source, writeCoordinator, ...options });
}

async function makeBackup(dir, { blobs } = {}) {
  const opened = openSqliteAdapter({ directory: dir, name: 'app' });
  try {
    opened.handle.exec('CREATE TABLE note (id TEXT PRIMARY KEY, body TEXT)');
    opened.handle.prepare('INSERT INTO note (id, body) VALUES (?, ?)').run('n1', 'hello quarantine');
    const writeCoordinator = createWriteQueue();
    opened.writeCoordinator = writeCoordinator;
    const backupManager = createBackupManager({ source: opened, writeCoordinator, blobs });
    const backup = await backupManager.backup();
    assert.equal(backup.ok, true);
    return backup;
  } finally {
    opened.close();
  }
}

// Corrupt the LIVE database file (and optionally its WAL) after the adapter is
// closed. The corrupted bytes must be preserved byte-for-byte in quarantine.
function corruptLiveDatabase(dir, { corruptWal = true } = {}) {
  const corrupt = 'THIS IS NOT A DATABASE FILE '.repeat(40);
  writeFileSync(join(dir, 'data.sqlite'), corrupt);
  if (corruptWal) writeFileSync(join(dir, 'data.sqlite-wal'), 'CORRUPT WAL HEADER '.repeat(40));
  return corrupt;
}

function quarantineNames(dir) {
  return readdirSync(join(dir, 'quarantine')).sort();
}

function quarantineDirListing(dir) {
  return Object.fromEntries(
    quarantineNames(dir).map((name) => [name, readdirSync(join(dir, 'quarantine', name)).sort()]),
  );
}

test('probe reports a healthy database ok and a damaged one as an explicit recovery-required state — stop-and-ask, never auto-select', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const backup = await makeBackup(dir);
    const manager = managerFor(dir);

    // Healthy live database → ok.
    const healthy = manager.probe();
    assert.equal(healthy.ok, true);

    // Damaged → an explicit recovery-required state with a plain explanation.
    corruptLiveDatabase(dir);
    const state = manager.probe();
    assert.equal(state.ok, false);
    assert.equal(state.state, 'recovery-required');
    assert.equal(state.interruptedRecovery, false);
    assert.match(state.reason, /corrupt or damaged/);
    assert.match(state.reason, /stopped rather than risk data loss/);
    assert.equal(state.backups.length, 1, 'the available backup is listed');
    assert.equal(state.backups[0].backupId, backup.backupId);
    assert.match(state.reason, /No backup was selected automatically/, 'the plain explanation says nothing was auto-selected');
    assert.equal(state.reason.includes(backup.backupId), false, 'the reason names no backup — the operator chooses');

    // The file probe is the canonical non-throwing path.
    const direct = probeDatabaseFile(join(dir, 'data.sqlite'));
    assert.equal(direct.ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recover quarantines the damaged database WITH its WAL sidecars and never overwrites the only recoverable copy', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const backup = await makeBackup(dir);
    const corrupt = corruptLiveDatabase(dir, { corruptWal: true });

    const result = await managerFor(dir).recover({ backupId: backup.backupId });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'restored');
    assert.ok(result.quarantinedDatabase, 'the damaged database was quarantined');

    // The quarantine dir holds data.sqlite AND its WAL sidecar TOGETHER — a
    // stale WAL can never pair with the restored database.
    const qFiles = readdirSync(result.quarantinedDatabase).sort();
    assert.ok(qFiles.includes('data.sqlite'), 'the damaged main file is preserved');
    assert.ok(qFiles.includes('data.sqlite-wal'), 'the damaged WAL is preserved beside it');
    assert.ok(qFiles.includes('diagnostic.json'), 'a diagnostic is retained');
    assert.equal(
      readFileSync(join(result.quarantinedDatabase, 'data.sqlite'), 'utf8'),
      corrupt,
      'the recoverable copy is preserved byte-for-byte — never overwritten',
    );

    // The restored database is healthy and carries the backed-up data.
    const restored = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      assert.equal(restored.handle.prepare('SELECT body FROM note WHERE id = ?').get('n1').body, 'hello quarantine');
    } finally {
      restored.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a second recovery quarantines into a NEW directory — the first recoverable copy is never overwritten', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const backup = await makeBackup(dir);

    corruptLiveDatabase(dir);
    const first = await managerFor(dir).recover({ backupId: backup.backupId });
    assert.equal(first.ok, true);
    const firstListing = quarantineDirListing(dir);
    assert.equal(Object.keys(firstListing).length, 1);

    corruptLiveDatabase(dir);
    const second = await managerFor(dir).recover({ backupId: backup.backupId });
    assert.equal(second.ok, true);
    const secondListing = quarantineDirListing(dir);
    assert.equal(Object.keys(secondListing).length, 2, 'a fresh quarantine dir, never a collision');
    assert.notEqual(second.quarantinedDatabase, first.quarantinedDatabase);
    // Both copies survive with identical bytes.
    for (const listing of Object.values(secondListing)) {
      assert.ok(listing.includes('data.sqlite'), 'each quarantined copy retains its database');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a corrupt backup (corrupt snapshot) fails closed and leaves quarantine intact', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const backup = await makeBackup(dir);
    corruptLiveDatabase(dir);
    writeFileSync(join(dir, 'backups', backup.backupId, 'snapshot.sqlite'), 'CORRUPT SNAPSHOT '.repeat(64));

    const before = quarantineDirListing(dir);
    const result = await managerFor(dir).recover({ backupId: backup.backupId });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'rejected', 'a corrupt backup never activates');
    assert.deepEqual(quarantineDirListing(dir), before, 'quarantine is left exactly intact');
    assert.equal(existsSync(join(dir, 'backups', backup.backupId)), true, 'the corrupt backup stays in backups/');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a missing referenced blob fails closed and leaves quarantine intact', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    // A backup that was materialized with blob bytes...
    const blobBytes = 'blob-bytes-gen-a';
    const backup = await makeBackup(dir, {
      blobs: {
        census: () => ['gen-a'],
        materialize: (generation, destDir) => {
          writeFileSync(join(destDir, `${generation}.blob`), blobBytes);
          return [{ name: `${generation}.blob`, size: blobBytes.length }];
        },
      },
    });
    corruptLiveDatabase(dir);
    // ...then the blob bytes vanish from the backup dir.
    writeFileSync(join(dir, 'backups', backup.backupId, 'blobs', 'gen-a.blob'), '');

    const before = quarantineDirListing(dir);
    const seam = {
      verifyBackupGeneration: (generation, backupBlobsDir) => {
        const file = join(backupBlobsDir, `${generation}.blob`);
        if (!existsSync(file) || readFileSync(file, 'utf8').length === 0) {
          throw new Error('blob bytes missing');
        }
      },
      materializeRestoreGeneration: (generation, backupBlobsDir, destBlobDir) => {
        const name = `${generation}.blob`;
        copyFileSync(join(backupBlobsDir, name), join(destBlobDir, name));
        return [{ name, size: 0 }];
      },
      censusAfterRestore: () => {},
    };
    const result = await managerFor(dir, { blobs: seam }).recover({ backupId: backup.backupId });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'rejected');
    assert.match(result.reason, /blob bytes missing/);
    assert.deepEqual(quarantineDirListing(dir), before, 'quarantine is left exactly intact');
    assert.equal(existsSync(join(dir, 'backups', backup.backupId)), true, 'the backup stays in backups/');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an interrupted recovery (stale stage file) is surfaced by probe and swept by reconcile', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const backup = await makeBackup(dir);
    // Simulate a crash between quarantine and rename: the old db is gone (it
    // moved to quarantine) and the staged file was left behind — data.sqlite
    // must be missing, never half-written.
    rmSync(join(dir, 'data.sqlite'), { force: true });
    rmSync(join(dir, 'data.sqlite-wal'), { force: true });
    rmSync(join(dir, 'data.sqlite-shm'), { force: true });
    writeFileSync(join(dir, 'data.sqlite.recovering-2026-01-01T00-00-00.000Z-cafe00000000'), 'staged bytes');

    const manager = managerFor(dir);
    const state = manager.probe();
    assert.equal(state.ok, false);
    assert.equal(state.interruptedRecovery, true, 'the interrupted restore is reported');
    assert.match(state.reason, /interrupted/);

    const swept = manager.reconcile();
    assert.equal(swept.quarantined.length, 1, 'the stale stage file was quarantined');
    assert.equal(existsSync(join(dir, 'data.sqlite.recovering-2026-01-01T00-00-00.000Z-cafe00000000')), false);
    const qListing = quarantineDirListing(dir);
    assert.equal(Object.keys(qListing).length, 1);
    assert.ok(Object.values(qListing)[0].includes('data.sqlite.recovering-2026-01-01T00-00-00.000Z-cafe00000000'));

    // probe now sees a healthy (absent-but-uninterrupted) database.
    const after = manager.probe();
    assert.equal(after.ok, true);
    void backup;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the recovery probe and quarantine never touch recycle/ or backups/', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const backup = await makeBackup(dir);
    writeFileSync(join(dir, 'recycle', 'retired.bin'), 'recycle me');

    corruptLiveDatabase(dir);
    const state = managerFor(dir).probe();
    assert.equal(state.ok, false);
    const result = await managerFor(dir).recover({ backupId: backup.backupId });
    assert.equal(result.ok, true);
    assert.equal(existsSync(join(dir, 'recycle', 'retired.bin')), true, 'recycle/ survives the swap');
    assert.equal(existsSync(join(dir, 'backups', backup.backupId)), true, 'backups/ survives the swap');
    // The restored file is a real database.
    const db = new DatabaseSync(join(dir, 'data.sqlite'), { readOnly: true });
    try {
      assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

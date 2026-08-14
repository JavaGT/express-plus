// recovery-swap.test.mjs — S1/A4 swap durability + fresh-directory restore:
// the restore-swap crash injection never leaves a half-activated database in
// the owned directory; recoverIntoFreshDirectory passes the full schema + blob
// census (validating the migration ledger that EXISTS) before serving, and
// fails closed when the census fails; a reset (adapter teardown) never wipes
// backups/, quarantine/, or recycle/.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openSqliteAdapter } from '../build/sqlite-adapter.mjs';
import { createWriteQueue } from '../build/write-queue.mjs';
import { createBackupManager } from '../build/backup.mjs';
import { createRecoveryManager, runRecoveryCli } from '../build/recovery.mjs';

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'wb-recovery-swap-'));
}

function managerFor(dir, options = {}) {
  const writeCoordinator = options.writeCoordinator ?? createWriteQueue();
  const source = options.source ?? { root: dir, writeCoordinator };
  return createRecoveryManager({ source, writeCoordinator, ...options });
}

async function makeBackup(dir, { blobs, withLedger = false } = {}) {
  const opened = openSqliteAdapter({ directory: dir, name: 'app' });
  try {
    if (withLedger) {
      opened.handle.exec(`CREATE TABLE _SchemaMigration (
        namespace TEXT NOT NULL,
        version INTEGER NOT NULL,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        appliedAt TEXT NOT NULL,
        suppliedBy TEXT,
        PRIMARY KEY (namespace, version)
      )`);
      opened.handle.prepare('INSERT INTO _SchemaMigration (namespace, version, name, checksum, appliedAt, suppliedBy) VALUES (?, ?, ?, ?, ?, ?)').run('alpha', 1, 'a1', 'c1', '2026-01-01T00:00:00.000Z', null);
      opened.handle.prepare('INSERT INTO _SchemaMigration (namespace, version, name, checksum, appliedAt, suppliedBy) VALUES (?, ?, ?, ?, ?, ?)').run('alpha', 2, 'a2', 'c2', '2026-01-02T00:00:00.000Z', null);
    }
    opened.handle.exec('CREATE TABLE note (id TEXT PRIMARY KEY, body TEXT)');
    opened.handle.prepare('INSERT INTO note (id, body) VALUES (?, ?)').run('n1', 'hello swap');
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

function corruptLiveDatabase(dir) {
  const corrupt = 'THIS IS NOT A DATABASE FILE '.repeat(40);
  writeFileSync(join(dir, 'data.sqlite'), corrupt);
  return corrupt;
}

function stageFilesIn(dir) {
  return readdirSync(dir).filter((entry) => entry.startsWith('data.sqlite.recovering-'));
}

test('a crash between quarantine and rename never leaves a half-activated database and the quarantine survives', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const backup = await makeBackup(dir);
    const corrupt = corruptLiveDatabase(dir);

    const crashing = managerFor(dir, {
      faults: {
        beforeRename: () => {
          throw new Error('simulated crash between quarantine and rename');
        },
      },
    });
    const result = await crashing.recover({ backupId: backup.backupId });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed');
    assert.match(result.reason, /activation/);
    assert.equal(existsSync(join(dir, 'data.sqlite')), false, 'no half-activated data.sqlite in the owned directory');
    assert.equal(stageFilesIn(dir).length, 0, 'the staged copy was quarantined too');
    assert.ok(result.quarantined.length >= 2, 'the damaged database AND the attempt were both quarantined');
    assert.ok(
      result.quarantined.some((q) => readdirSync(q).includes('data.sqlite')),
      'the damaged database is preserved in quarantine',
    );
    assert.ok(
      result.quarantined.some((q) => readdirSync(q).some((entry) => entry.startsWith('data.sqlite.recovering-'))),
      'the failed attempt is preserved in quarantine',
    );

    // A clean recovery now completes — the crash left no debris that blocks it.
    const clean = await managerFor(dir).recover({ backupId: backup.backupId });
    assert.equal(clean.ok, true, 'the retry restores cleanly');
    assert.equal(clean.status, 'restored');
    const restored = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      assert.equal(restored.handle.prepare('SELECT body FROM note WHERE id = ?').get('n1').body, 'hello swap');
    } finally {
      restored.close();
    }
    void corrupt;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a crash before the stage leaves the damaged database untouched', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const backup = await makeBackup(dir);
    const corrupt = corruptLiveDatabase(dir);

    const crashing = managerFor(dir, {
      faults: {
        beforeStage: () => {
          throw new Error('simulated crash before the stage copy');
        },
      },
    });
    const result = await crashing.recover({ backupId: backup.backupId });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed');
    assert.match(result.reason, /stage/);
    assert.equal(readFileSync(join(dir, 'data.sqlite'), 'utf8'), corrupt, 'the damaged database is byte-identical (untouched)');
    assert.equal(stageFilesIn(dir).length, 0, 'no stage file lingers');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a crash before quarantine leaves the damaged database untouched and the stage quarantined', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const backup = await makeBackup(dir);
    const corrupt = corruptLiveDatabase(dir);

    const crashing = managerFor(dir, {
      faults: {
        beforeQuarantine: () => {
          throw new Error('simulated crash before the damaged db was quarantined');
        },
      },
    });
    const result = await crashing.recover({ backupId: backup.backupId });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed');
    assert.equal(readFileSync(join(dir, 'data.sqlite'), 'utf8'), corrupt, 'the damaged database is untouched');
    assert.equal(stageFilesIn(dir).length, 0, 'the staged copy was quarantined');
    assert.ok(result.quarantined.length >= 1, 'the failed attempt was quarantined');
    assert.ok(
      result.quarantined.some((q) => readdirSync(q).some((entry) => entry.startsWith('data.sqlite.recovering-'))),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fresh-directory restore passes the full schema + blob census before serving, validating the migration ledger that exists', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  const fresh = join(root, 'fresh-owned');
  try {
    const blobBytes = 'blob-bytes-gen-a';
    const censusCalls = [];
    const backup = await makeBackup(dir, {
      withLedger: true,
      blobs: {
        census: () => ['gen-a'],
        materialize: (generation, destDir) => {
          writeFileSync(join(destDir, `${generation}.blob`), blobBytes);
          return [{ name: `${generation}.blob`, size: blobBytes.length }];
        },
      },
    });
    assert.deepEqual(backup.manifest.migrationLedgerState.appliedVersions, [
      { namespace: 'alpha', version: 1 },
      { namespace: 'alpha', version: 2 },
    ]);

    const seam = {
      verifyBackupGeneration: (generation, backupBlobsDir) => {
        assert.equal(existsSync(join(backupBlobsDir, `${generation}.blob`)), true);
      },
      materializeRestoreGeneration: (generation, backupBlobsDir, destBlobDir) => {
        const name = `${generation}.blob`;
        copyFileSync(join(backupBlobsDir, name), join(destBlobDir, name));
        return [{ name, size: blobBytes.length }];
      },
      censusAfterRestore: (generations, targetRoot) => {
        censusCalls.push([generations, targetRoot]);
        // The verified bytes were materialized into the target BEFORE the
        // census — the census sees the restored generation, not an empty or
        // stale blob store (review #83).
        assert.equal(
          readFileSync(join(targetRoot, 'blobs', 'gen-a.blob'), 'utf8'),
          blobBytes,
          'the generation bytes are present in the target blob layout before the census',
        );
      },
    };
    const result = await managerFor(dir, { blobs: seam }).recoverIntoFreshDirectory({ backupId: backup.backupId, directory: fresh });
    assert.equal(result.ok, true, 'the fresh restore completes');
    assert.equal(result.status, 'restored');
    assert.equal(result.census.schema.ok, true, 'the schema census passed before serving');
    assert.equal(result.census.blobs.ok, true, 'the blob census passed before serving');

    // The fresh directory is a full managed layout with a serving database.
    const layout = readdirSync(fresh).sort();
    assert.ok(layout.includes('data.sqlite'), 'the fresh directory holds a database');
    for (const sub of ['backups', 'quarantine', 'recycle', 'blobs', 'staging']) {
      assert.ok(layout.includes(sub), `the fresh layout has ${sub}/`);
    }

    // The fresh database carries the data AND the migration ledger that existed.
    const db = new DatabaseSync(join(fresh, 'data.sqlite'), { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT body FROM note WHERE id = ?').get('n1').body, 'hello swap');
      assert.deepEqual(
        db.prepare('SELECT namespace, version FROM _SchemaMigration ORDER BY namespace, version').all().map((row) => ({ namespace: row.namespace, version: row.version })),
        [
          { namespace: 'alpha', version: 1 },
          { namespace: 'alpha', version: 2 },
        ],
        'the migration ledger that EXISTS was restored and validated',
      );
      assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    } finally {
      db.close();
    }
    assert.deepEqual(
      censusCalls,
      [[['gen-a'], fresh]],
      'the blob census consumed the S6 generation interface against the fresh target',
    );

    // The original directory's backups were not consumed by the fresh restore.
    assert.equal(existsSync(join(dir, 'backups', backup.backupId)), true, 'backups/ in the source dir survives');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fresh-directory restore fails closed when the census fails and removes the disposable directory', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  const fresh = join(root, 'fresh-owned');
  try {
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
    const seam = {
      verifyBackupGeneration: () => {},
      materializeRestoreGeneration: (generation, backupBlobsDir, destBlobDir) => {
        const name = `${generation}.blob`;
        copyFileSync(join(backupBlobsDir, name), join(destBlobDir, name));
        return [{ name, size: blobBytes.length }];
      },
      censusAfterRestore: () => {
        throw new Error('blob census failed after restore');
      },
    };
    const result = await managerFor(dir, { blobs: seam }).recoverIntoFreshDirectory({ backupId: backup.backupId, directory: fresh });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed');
    assert.match(result.reason, /blob census failed/);
    assert.equal(result.census.blobs.ok, false, 'the failing census is reported');
    assert.equal(existsSync(fresh), false, 'the disposable fresh directory was removed — never a half-restored serve');
    assert.equal(existsSync(join(dir, 'backups', backup.backupId)), true, 'the source backup is untouched');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fresh-directory restore refuses a non-empty target', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  const fresh = join(root, 'fresh-owned');
  try {
    const backup = await makeBackup(dir);
    mkdirSync(fresh, { recursive: true });
    writeFileSync(join(fresh, 'pre-existing.txt'), 'not empty');

    const result = await managerFor(dir).recoverIntoFreshDirectory({ backupId: backup.backupId, directory: fresh });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'rejected');
    assert.match(result.reason, /not empty/);
    assert.equal(existsSync(join(fresh, 'pre-existing.txt')), true, 'the non-empty target is untouched');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the CLI entry drives the library API (probe / --list-backups / --recover)', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  const originalLog = console.log;
  const originalError = console.error;
  const logged = [];
  const erred = [];
  try {
    const backup = await makeBackup(dir);
    console.log = (...args) => logged.push(args.join(' '));
    console.error = (...args) => erred.push(args.join(' '));

    // Healthy probe → ok, exit 0.
    assert.equal(await runRecoveryCli(['--dir', dir]), 0);
    assert.ok(logged.some((line) => /no recovery required/.test(line)), 'the healthy probe prints plainly');

    // --list-backups prints the available backups without selecting one.
    assert.equal(await runRecoveryCli(['--dir', dir, '--list-backups']), 0);
    assert.ok(logged.some((line) => line.includes(backup.backupId)), 'the backup is listed');

    // Damaged database → recovery-required, exit 1, never an auto-selected id.
    corruptLiveDatabase(dir);
    assert.equal(await runRecoveryCli(['--dir', dir]), 1);
    assert.ok(erred.some((line) => /corrupt or damaged/.test(line)), 'the CLI explains the damage plainly');
    assert.ok(erred.some((line) => /No backup was selected automatically/.test(line)), 'the CLI says backups are never auto-selected');
    assert.ok(
      erred.every((line) => !line.includes(`restored backup`)),
      'no restore ran implicitly',
    );

    // --recover <backupId> drives the same programmatic recover() API.
    assert.equal(await runRecoveryCli(['--dir', dir, '--recover', backup.backupId]), 0);
    assert.ok(logged.some((line) => /restored backup/.test(line)), 'the CLI reports the restore');

    // Usage errors → exit 2.
    assert.equal(await runRecoveryCli([]), 2);
    assert.equal(await runRecoveryCli(['--bogus']), 2);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    rmSync(root, { recursive: true, force: true });
  }
});

test('reset (adapter teardown) clears database state but never wipes backups/, quarantine/, or recycle/', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const backup = await makeBackup(dir);
    // A quarantined damaged database from a real recovery attempt.
    corruptLiveDatabase(dir);
    const recovery = await managerFor(dir).recover({ backupId: backup.backupId });
    assert.equal(recovery.ok, true);
    const quarantineBefore = readdirSync(join(dir, 'quarantine')).sort();
    assert.ok(quarantineBefore.length > 0, 'quarantine holds the damaged database');
    writeFileSync(join(dir, 'recycle', 'retired.bin'), 'recycle me');

    // The adapter teardown (the platform's reset path) removes only the db
    // file, -wal/-shm, and lock — recovery/backup material survives.
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    opened.teardown();

    assert.equal(existsSync(join(dir, 'data.sqlite')), false, 'database state was cleared');
    assert.equal(existsSync(join(dir, 'lock.sqlite')), false, 'the ownership lock was cleared');
    assert.equal(existsSync(join(dir, 'backups', backup.backupId)), true, 'backups/ survives the reset');
    assert.deepEqual(readdirSync(join(dir, 'quarantine')).sort(), quarantineBefore, 'quarantine/ survives the reset');
    assert.equal(existsSync(join(dir, 'recycle', 'retired.bin')), true, 'recycle/ survives the reset');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

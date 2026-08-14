// backup-crash.test.mjs — S1/A3 crash boundaries: a crash at creation /
// manifest write / byte copy leaves either a valid complete backup or a
// quarantined partial — never a false-complete backup. The manifest is written
// LAST, so the reconcile sweep can decide a directory's fate from its manifest
// alone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openSqliteAdapter } from '../build/sqlite-adapter.mjs';
import { createWriteQueue } from '../build/write-queue.mjs';
import { createBackupManager } from '../build/backup.mjs';

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'wb-backup-crash-'));
}

// Bind the freshly-created coordinator to the source (the ownership seam,
// review #82 finding 3) and construct the manager with that same coordinator.
function managerFor(opened, options = {}) {
  const writeCoordinator = options.writeCoordinator ?? createWriteQueue();
  opened.writeCoordinator = writeCoordinator;
  return createBackupManager({ source: opened, writeCoordinator, ...options });
}

function completeManifest(overrides = {}) {
  return JSON.stringify({
    formatVersion: 1,
    platformSchemaIdentity: 'x',
    appSchemaIdentity: [],
    migrationLedgerState: { app: { table: '_Migration', appliedVersions: [], maxVersion: 0 }, workbench: { table: '_WorkbenchMigration', appliedVersions: [], maxVersion: 0 } },
    integrityResult: { ok: true, checkedAt: '2026-01-01T00:00:00.000Z', findings: [] },
    blobGenerations: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:00.000Z',
    status: 'complete',
    encryption: 'none',
    ...overrides,
  });
}

// A crash leftover: a directory that was mid-creation when the process died.
function craftLeftover(dir, name, { manifest, snapshot } = {}) {
  const backupDir = join(dir, 'backups', name);
  mkdirSync(backupDir, { recursive: true });
  if (manifest !== undefined) writeFileSync(join(backupDir, 'manifest.json'), manifest);
  if (snapshot !== undefined) writeFileSync(join(backupDir, 'snapshot.sqlite'), snapshot);
  return backupDir;
}

function quarantineNames(dir) {
  try {
    return readdirSync(join(dir, 'quarantine'));
  } catch {
    return [];
  }
}

test('reconcile quarantines a crash at creation (no manifest, no snapshot)', { timeout: 120000 }, () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      const leftover = craftLeftover(dir, '2026-01-01T00-00-00.000Z-deadbeef0001', {});
      writeFileSync(join(leftover, 'stray.bin'), 'partial bytes');

      const result = managerFor(opened).reconcile();
      assert.deepEqual(result.quarantined, [join(dir, 'quarantine', '2026-01-01T00-00-00.000Z-deadbeef0001')]);
      assert.equal(readdirSync(join(dir, 'backups')).length, 0, 'backups/ no longer holds the leftover');
      const diagnostic = JSON.parse(readFileSync(join(dir, 'quarantine', '2026-01-01T00-00-00.000Z-deadbeef0001', 'diagnostic.json'), 'utf8'));
      assert.equal(diagnostic.stage, 'quarantine');
      assert.match(diagnostic.error, /incomplete backup directory/);
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reconcile quarantines a crash at manifest write (truncated manifest)', { timeout: 120000 }, () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      // The process died partway through writing manifest.json — truncated JSON,
      // so the dir must never be treated as complete.
      craftLeftover(dir, '2026-01-01T01-00-00.000Z-deadbeef0002', {
        manifest: '{"formatVersion":1,"status":"comp',
        snapshot: 'not-a-real-snapshot',
      });

      managerFor(opened).reconcile();
      assert.equal(readdirSync(join(dir, 'backups')).length, 0, 'the truncated-manifest dir was quarantined');
      assert.ok(quarantineNames(dir).some((name) => name.includes('deadbeef0002')), 'it landed in quarantine/');
      // A truncated manifest is a false-complete hazard — the sweep removed it.
      assert.equal(
        readdirSync(join(dir, 'quarantine', quarantineNames(dir).find((name) => name.includes('deadbeef0002'))))
          .includes('diagnostic.json'),
        true,
        'diagnostics retained',
      );
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reconcile quarantines a partial manifest (byte copy interrupted)', { timeout: 120000 }, () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      // The byte copy was interrupted and the manifest recorded the truth:
      // status partial. A partial backup is a quarantined backup — restore
      // must never pick it up.
      craftLeftover(dir, '2026-01-01T02-00-00.000Z-deadbeef0003', {
        manifest: completeManifest({ status: 'partial' }),
        snapshot: 'not-a-real-snapshot',
      });

      managerFor(opened).reconcile();
      assert.equal(readdirSync(join(dir, 'backups')).length, 0, 'the partial dir was quarantined');
      assert.ok(quarantineNames(dir).some((name) => name.includes('deadbeef0003')), 'it landed in quarantine/');
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reconcile leaves a genuinely complete backup in place', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      opened.handle.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
      const result = await managerFor(opened).backup();
      assert.equal(result.ok, true);
      const backupId = result.backupId;

      const again = managerFor(opened).reconcile();
      assert.deepEqual(again.quarantined, [], 'a complete backup survives reconcile');
      assert.deepEqual(readdirSync(join(dir, 'backups')), [backupId], 'backups/ still holds exactly the complete backup');
      assert.equal(existsSync(join(result.directory, 'manifest.json')), true);
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a fresh backup still succeeds and quarantines pre-existing leftovers', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      craftLeftover(dir, '2026-01-01T03-00-00.000Z-deadbeef0004', {
        snapshot: 'half-written',
      });
      opened.handle.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
      opened.handle.prepare('INSERT INTO t DEFAULT VALUES').run();

      const result = await managerFor(opened).backup();
      assert.equal(result.ok, true, 'the fresh backup succeeded despite the leftover');
      assert.equal(result.status, 'complete');
      // The leftover was swept on the way in.
      assert.deepEqual(readdirSync(join(dir, 'backups')), [result.backupId], 'backups/ holds only the fresh complete backup');
      assert.ok(quarantineNames(dir).some((name) => name.includes('deadbeef0004')), 'the leftover was quarantined');
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a live byte-copy failure leaves no false-complete backup anywhere', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      const blobs = {
        census: () => ['gen-a'],
        materialize: () => { throw new Error('crash during byte copy'); },
      };
      const result = await managerFor(opened, { blobs }).backup();
      assert.equal(result.ok, false);
      assert.equal(result.status, 'partial');
      assert.equal(result.quarantined, true);

      // No manifest anywhere on disk claims 'complete'.
      for (const quarantine of readdirSync(join(dir, 'quarantine'))) {
        const manifestPath = join(dir, 'quarantine', quarantine, 'manifest.json');
        if (existsSync(manifestPath)) {
          assert.equal(JSON.parse(readFileSync(manifestPath, 'utf8')).status, 'partial');
        }
      }
      assert.equal(readdirSync(join(dir, 'backups')).length, 0, 'backups/ holds no backup after the failure');
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// backup-retention.test.mjs — S1/A3 retention: keep N daily + M recent hourly
// (defaults 7/3, configurable, never hardcoded) with a fail-closed trim that
// rejects instead of reporting success when a directory cannot be removed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openSqliteAdapter } from '../build/sqlite-adapter.mjs';
import { createWriteQueue } from '../build/write-queue.mjs';
import { createBackupManager, DEFAULT_RETENTION } from '../build/backup.mjs';

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'wb-backup-retention-'));
}

function managerFor(opened, options = {}) {
  return createBackupManager({ source: opened, writeCoordinator: createWriteQueue(), ...options });
}

// The dir name is the retention clock: backups/<timestamp>-<id> where
// <timestamp> is the fixed-width ISO form (colons → dashes) and <id> is hex.
function nameFor(iso, id) {
  return `${iso.replace(/:/g, '-')}-${id}`;
}

function craftBackup(dir, iso, id) {
  const backupDir = join(dir, 'backups', nameFor(iso, id));
  mkdirSync(backupDir, { recursive: true });
  mkdirSync(join(backupDir, 'blobs'), { recursive: true });
  writeFileSync(join(backupDir, 'snapshot.sqlite'), 'snapshot');
  writeFileSync(join(backupDir, 'manifest.json'), JSON.stringify({
    formatVersion: 1,
    status: 'complete',
    createdAt: iso,
    completedAt: iso,
    encryption: 'none',
    platformSchemaIdentity: 'x',
    appSchemaIdentity: [],
    migrationLedgerState: { app: { table: '_Migration', appliedVersions: [], maxVersion: 0 }, workbench: { table: '_WorkbenchMigration', appliedVersions: [], maxVersion: 0 } },
    integrityResult: { ok: true, checkedAt: iso, findings: [] },
    blobGenerations: [],
  }));
  return backupDir;
}

// Eight backups: four on day D, two on D+1, one on D+2, one on D+3.
function craftEight(dir) {
  const crafted = [
    ['2026-01-01T00:00:00.000Z', 'a1a1a1a1a1a1'],
    ['2026-01-01T06:00:00.000Z', 'b2b2b2b2b2b2'],
    ['2026-01-01T12:00:00.000Z', 'c3c3c3c3c3c3'],
    ['2026-01-01T18:00:00.000Z', 'd4d4d4d4d4d4'],
    ['2026-01-02T01:00:00.000Z', 'e5e5e5e5e5e5'],
    ['2026-01-02T20:00:00.000Z', 'f6f6f6f6f6f6'],
    ['2026-01-03T10:00:00.000Z', '010101010101'],
    ['2026-01-04T10:00:00.000Z', '020202020202'],
  ];
  for (const [iso, id] of crafted) craftBackup(dir, iso, id);
  return crafted.map(([iso, id]) => nameFor(iso, id));
}

test('the default retention keeps N daily + M hourly (7/3)', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      assert.deepEqual(DEFAULT_RETENTION, { daily: 7, hourly: 3 });
      const names = craftEight(dir);

      const result = await managerFor(opened).trim();
      assert.equal(result.removed.length, 1, 'exactly one backup is trimmed');
      assert.equal(result.retained, 7, '7 retained = 4 daily keepers + 3 hourly keepers');
      assert.deepEqual(result.removed, [names[0]], 'the oldest of the oldest day is trimmed');

      const kept = readdirSync(join(dir, 'backups'));
      assert.deepEqual(kept.sort(), names.slice(1).sort(), 'every other backup survives');
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an overridden retention config wins over the default (daily 1, hourly 1)', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      const names = craftEight(dir);
      const result = await managerFor(opened, { retention: { daily: 1, hourly: 1 } }).trim();
      assert.equal(result.retained, 2, '1 daily keeper + 1 hourly keeper');
      assert.equal(result.removed.length, 6);
      // daily:1 keeps the newest of the single most recent day (d3); hourly:1
      // keeps the next most recent (d2). The six older backups are removed.
      assert.deepEqual(result.removed.sort(), names.slice(0, 6).sort());
      const kept = readdirSync(join(dir, 'backups'));
      assert.deepEqual(kept.sort(), names.slice(-2).sort(), 'only the two newest survive');
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('retention keeps fewer than N daily when the history is shallow', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      craftBackup(dir, '2026-01-01T00-00-00.000Z', 'only-a');
      craftBackup(dir, '2026-01-02T00-00-00.000Z', 'only-b');
      const result = await managerFor(opened).trim();
      assert.equal(result.removed.length, 0, 'a shallow history trims nothing');
      assert.equal(result.retained, 2);
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('retention ignores incomplete (non-complete-manifest) directories', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      const names = craftEight(dir);
      // A leftover that never finished is not a candidate for retention — and
      // the sweep quarantines it rather than counting it.
      mkdirSync(join(dir, 'backups', nameFor('2026-01-01T00:00:00.000Z', '0badbadbad0c')), { recursive: true });

      const result = await managerFor(opened).trim();
      assert.equal(result.removed.length, 1, 'the zombie is not counted as a daily/hourly candidate');
      assert.equal(existsSync(join(dir, 'backups', nameFor('2026-01-01T00:00:00.000Z', '0badbadbad0c'))), false, 'the zombie was swept to quarantine');
      assert.deepEqual(result.removed, [names[0]]);
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('trim fails closed when a directory cannot be removed — it never reports success', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      const names = craftEight(dir);
      // Lock the OLDEST dir that is selected for removal so the trim MUST fail
      // partway — the recursive removal cannot read a read-only directory.
      const victim = join(dir, 'backups', names[0]);
      chmodSync(victim, 0o500);

      await assert.rejects(() => managerFor(opened).trim(), /ENOTEMPTY|EACCES|EPERM|ENOTDIR/, 'a trim that cannot finish must reject');
      // Fail closed means no success result was returned — and the other
      // directories were not silently reported as trimmed.
      const remaining = readdirSync(join(dir, 'backups'));
      assert.ok(remaining.length >= 7, 'no trim was reported done without doing it');
      chmodSync(victim, 0o700);
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

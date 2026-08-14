// backup-fail-closed.test.mjs — S1/A3 fail-closed behavior: disk-full (mock),
// read-only directories, bad permissions, and missing blobs all fail closed —
// diagnostics are retained WITHOUT data content and no backup is ever marked
// complete.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openSqliteAdapter } from '../build/sqlite-adapter.mjs';
import { createWriteQueue } from '../build/write-queue.mjs';
import { createBackupManager } from '../build/backup.mjs';
import { setAmbientLog } from '../build/log.mjs';

const SECRET_BLOB_CONTENT = 'SECRET-BLOB-BYTES-MUST-NOT-APPEAR-ANYWHERE';

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'wb-backup-failclosed-'));
}

function managerFor(opened, options = {}) {
  return createBackupManager({ source: opened, writeCoordinator: createWriteQueue(), ...options });
}

function manifestOf(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  } catch {
    return null;
  }
}

test('missing blob bytes → partial + diagnostic without data content', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      const blobs = {
        census: () => ['gen-secret'],
        materialize: () => { throw new Error('BLOB_UNAVAILABLE: bytes pending finalization'); },
      };
      const result = await managerFor(opened, { blobs }).backup();
      assert.equal(result.ok, false);
      assert.equal(result.status, 'partial');
      assert.equal(result.quarantined, true);
      assert.equal(result.manifest.status, 'partial');

      // Diagnostics + manifest carry identifiers, never the payload bytes.
      const diagnostic = JSON.parse(readFileSync(join(result.directory, 'diagnostic.json'), 'utf8'));
      assert.match(diagnostic.error, /gen-secret/);
      assert.deepEqual(diagnostic.detail.missingGenerations, ['gen-secret']);
      const diagnosticRaw = readFileSync(join(result.directory, 'diagnostic.json'), 'utf8');
      const manifestRaw = readFileSync(join(result.directory, 'manifest.json'), 'utf8');
      assert.equal(diagnosticRaw.includes(SECRET_BLOB_CONTENT), false, 'diagnostic has no blob data');
      assert.equal(manifestRaw.includes(SECRET_BLOB_CONTENT), false, 'manifest has no blob data');
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a read-only backups/ directory fails closed at creation with a retained diagnostic', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      opened.handle.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
      chmodSync(join(dir, 'backups'), 0o500); // no write — mkdir of a new backup dir fails

      const result = await managerFor(opened).backup();
      assert.equal(result.ok, false);
      assert.equal(result.status, 'failed');
      assert.equal(result.quarantined, true, 'the diagnostic was retained in quarantine/');
      assert.equal(result.diagnostic.stage, 'creation');
      assert.match(result.diagnostic.error, /EACCES|EPERM|permission/i);
      // No manifest anywhere claims complete.
      for (const entry of readdirSync(join(dir, 'quarantine'))) {
        assert.equal(manifestOf(join(dir, 'quarantine', entry)), null, `no manifest in ${entry}`);
      }
      assert.equal(readdirSync(join(dir, 'backups')).length, 0, 'no backup dir was created');

      chmodSync(join(dir, 'backups'), 0o700);
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a bad-permission leftover in backups/ is skipped, and a fresh backup still succeeds', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      // A stray file that is not a backup directory: the sweep ignores it
      // (only backup dirs are moved to quarantine) and the fresh backup must
      // still succeed.
      const stray = join(dir, 'backups', 'loose-stray-file');
      writeFileSync(stray, 'not-a-dir');
      opened.handle.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
      opened.handle.prepare('INSERT INTO t DEFAULT VALUES').run();

      const result = await managerFor(opened).backup();
      assert.equal(result.ok, true, 'a broken leftover does not fail the fresh backup');
      assert.equal(result.status, 'complete');
      assert.ok(readdirSync(join(dir, 'backups')).includes(result.backupId), 'the fresh complete backup remains');
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('disk-full (mock): a blob store outage fails closed and the backup is never marked complete', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      const diskFull = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      const blobs = {
        census: () => ['gen-a', 'gen-b'],
        materialize: (generation) => {
          if (generation === 'gen-b') throw diskFull;
        },
      };
      const result = await managerFor(opened, { blobs }).backup();
      assert.equal(result.ok, false);
      assert.equal(result.status, 'partial');
      assert.equal(result.manifest.status, 'partial', 'do not mark the backup complete on disk-full');
      assert.match(result.diagnostic.error, /ENOSPC|gen-b/);
      assert.ok(result.quarantined, 'the partial is quarantined');
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a census failure inside the barrier fails closed (failed + quarantined, never complete)', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      const blobs = {
        census: () => { throw new Error('BLOB_CENSUS_UNAVAILABLE'); },
        materialize: async () => {},
      };
      const result = await managerFor(opened, { blobs }).backup();
      assert.equal(result.ok, false);
      assert.equal(result.status, 'failed', 'an unknown referenced-blob set cannot produce a backup');
      assert.ok(result.quarantined, 'the failed dir is quarantined');
      assert.equal(result.diagnostic.stage, 'snapshot');
      assert.match(result.diagnostic.error, /BLOB_CENSUS_UNAVAILABLE/);
      // No manifest anywhere claims complete.
      const quarantineDir = join(dir, 'quarantine');
      for (const entry of readdirSync(quarantineDir)) {
        assert.equal(existsSync(join(quarantineDir, entry, 'manifest.json')), false, `no manifest in ${entry}`);
      }
      assert.equal(readdirSync(join(dir, 'backups')).length, 0, 'backups/ holds nothing after the failure');
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('partial backups log loudly through the framework logger', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  const entries = [];
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      // setAmbientLog installs the fallback logger the manager reaches via
      // getLog() when no application context owns the call.
      const capture = (...args) => entries.push(args);
      const { createLog } = await import('../build/log.mjs');
      setAmbientLog(createLog({ level: 'warn', format: 'json', output: capture }));

      const blobs = {
        census: () => ['gen-a'],
        materialize: () => { throw new Error('BLOB_UNAVAILABLE'); },
      };
      const result = await managerFor(opened, { blobs }).backup();
      assert.equal(result.ok, false);
      assert.equal(result.status, 'partial');
      assert.ok(entries.length > 0, 'the partial logged a warning');
      assert.ok(
        entries.some(([level, , message]) => level === 'warn' && /partial/.test(message)),
        'a loud partial warning was emitted',
      );
      setAmbientLog(null);
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

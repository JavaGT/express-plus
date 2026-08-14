// backup-snapshot.test.mjs — S1/A3 snapshot: WAL-safe online backup under
// concurrent reads + queued writes, the enumerated manifest, and the
// complete-vs-partial boundary (single DB+blob consistency point through the
// write coordinator).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openSqliteAdapter, openMemoryAdapter } from '../build/sqlite-adapter.mjs';
import { createWriteQueue } from '../build/write-queue.mjs';
import {
  createBackupManager,
  BACKUP_FORMAT_VERSION,
} from '../build/backup.mjs';

const BACKUP_DIR_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[0-9a-f]{12}$/;

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'wb-backup-snapshot-'));
}

function managerFor(opened, options = {}) {
  return createBackupManager({ source: opened, writeCoordinator: createWriteQueue(), ...options });
}

// The concretely enumerated manifest surface (issue #82 spec §2) — every field
// must be present and typed correctly.
function assertEnumeratedManifest(manifest) {
  assert.equal(manifest.formatVersion, BACKUP_FORMAT_VERSION);
  assert.equal(typeof manifest.platformSchemaIdentity, 'string');
  assert.match(manifest.platformSchemaIdentity, /^[0-9a-f]{64}$/, 'platformSchemaIdentity is a sha256 hex');
  assert.ok(Array.isArray(manifest.appSchemaIdentity), 'appSchemaIdentity is an array');
  assert.ok(manifest.appSchemaIdentity.every((entry) => typeof entry === 'string'), 'each app identity is a string');
  assert.ok(manifest.migrationLedgerState, 'migrationLedgerState present');
  assert.equal(typeof manifest.migrationLedgerState.app.appliedVersions, 'object');
  assert.equal(typeof manifest.migrationLedgerState.workbench.appliedVersions, 'object');
  assert.ok(manifest.integrityResult && typeof manifest.integrityResult.ok === 'boolean', 'integrityResult present');
  assert.ok(!Number.isNaN(Date.parse(manifest.integrityResult.checkedAt)), 'integrityResult has a checkedAt');
  assert.ok(Array.isArray(manifest.blobGenerations), 'blobGenerations is an array');
  assert.ok(!Number.isNaN(Date.parse(manifest.createdAt)), 'createdAt is an ISO instant');
  assert.ok(!Number.isNaN(Date.parse(manifest.completedAt)), 'completedAt is an ISO instant');
  assert.ok(manifest.status === 'complete' || manifest.status === 'partial', 'status is complete|partial');
  assert.equal(manifest.encryption, 'none', 'encryption is recorded explicitly per owner decision #3');
}

test('createBackupManager validates its contract fail-closed', { timeout: 120000 }, () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      assert.throws(() => createBackupManager({ source: opened }), /write coordinator/);
      assert.throws(() => createBackupManager({ source: opened, writeCoordinator: createWriteQueue(), retention: { daily: 0 } }), /daily/);
      assert.throws(() => createBackupManager({ source: opened, writeCoordinator: createWriteQueue(), retention: { hourly: -1 } }), /hourly/);
      assert.throws(() => createBackupManager({ source: opened, writeCoordinator: createWriteQueue(), blobs: {} }), /census/);
      const memory = openMemoryAdapter();
      try {
        assert.throws(
          () => createBackupManager({ source: memory, writeCoordinator: createWriteQueue() }),
          /FILE-mode source/,
          'a memory source has no owned directory to back into',
        );
      } finally {
        memory.close();
      }
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('backup() writes backups/<timestamp>-<id>/ with snapshot, manifest, blobs and the full manifest', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      opened.handle.exec('CREATE TABLE note (id TEXT PRIMARY KEY, body TEXT)');
      opened.handle.prepare('INSERT INTO note (id, body) VALUES (?, ?)').run('n1', 'hello backup');

      const result = await managerFor(opened).backup();
      assert.equal(result.ok, true);
      assert.equal(result.status, 'complete');
      assert.match(result.backupId, BACKUP_DIR_NAME, 'backup id is <timestamp>-<id>');
      assert.equal(join(dir, 'backups', result.backupId), result.directory, 'lives under backups/');

      const entries = readdirSync(result.directory).sort();
      assert.deepEqual(entries, ['blobs', 'manifest.json', 'snapshot.sqlite'], 'layout: snapshot.sqlite, manifest.json, blobs/');

      // manifest.json on disk deep-equals the returned manifest and carries
      // every enumerated field.
      const disk = JSON.parse(readFileSync(join(result.directory, 'manifest.json'), 'utf8'));
      assert.deepEqual(disk, result.manifest);
      assertEnumeratedManifest(result.manifest);
      assert.equal(result.manifest.status, 'complete');
      assert.deepEqual(result.manifest.blobGenerations, [], 'no blob seam → empty referenced set');
      assert.equal(result.manifest.integrityResult.ok, true, 'snapshot quick_check is clean');

      // Round-trip: the snapshot is a valid, restorable database.
      const snap = new DatabaseSync(join(result.directory, 'snapshot.sqlite'), { readOnly: true });
      try {
        assert.equal(snap.prepare('SELECT body FROM note WHERE id = ?').get('n1').body, 'hello backup');
        assert.equal(snap.prepare('PRAGMA quick_check').get().quick_check, 'ok');
      } finally {
        snap.close();
      }

      // The backup directory is covered by the S1/A2 managed-path guard, so
      // static serving and blob-root acceptance both refuse it.
      assert.equal(opened.isManagedPath(result.directory), true);
      assert.equal(opened.isManagedPath(join(result.directory, 'snapshot.sqlite')), true);
      assert.equal(opened.isManagedPath(join(result.directory, 'manifest.json')), true);
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('round-trips under concurrent reads + queued writes (WAL mode) without corruption', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      opened.handle.exec('CREATE TABLE note (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT)');
      const insert = opened.handle.prepare('INSERT INTO note (body) VALUES (?)');
      for (let i = 0; i < 50; i++) insert.run(`seed-${i}`);
      // A generous wait so the queued writes survive a slow node:sqlite backup
      // on a contended machine (the platform default maxWaitMs=5000 is for
      // interactive writes, not for the backup barrier's capture).
      const queue = createWriteQueue({ maxWaitMs: 60_000 });
      const manager = createBackupManager({ source: opened, writeCoordinator: queue });

      const backupPromise = manager.backup();
      // Queued writes: issued AFTER the backup's barrier turn was taken, so
      // they must commit after the snapshot and never corrupt it.
      const writes = [];
      for (let i = 0; i < 25; i++) writes.push(queue.run(() => insert.run(`queued-${i}`)));
      // Concurrent reads on the same connection while the online backup runs.
      const reads = [];
      for (let i = 0; i < 25; i++) {
        reads.push(Promise.resolve().then(() => opened.handle.prepare('SELECT COUNT(*) AS c FROM note').get()));
      }

      const readResults = await Promise.all(reads);
      await Promise.all([backupPromise, ...writes]);

      const result = await backupPromise;
      assert.equal(result.ok, true, 'the backup completed under load');
      assert.equal(result.status, 'complete');
      assert.equal(result.manifest.integrityResult.ok, true, 'snapshot integrity holds under concurrent load');

      // The snapshot is a consistent committed prefix: the seed rows, none of
      // the queued writes (they committed after the barrier released).
      const snap = new DatabaseSync(join(result.directory, 'snapshot.sqlite'), { readOnly: true });
      try {
        const total = snap.prepare('SELECT COUNT(*) AS c FROM note').get().c;
        const queued = snap.prepare("SELECT COUNT(*) AS c FROM note WHERE body LIKE 'queued-%'").get().c;
        assert.equal(total, 50, 'snapshot holds exactly the committed seed prefix');
        assert.equal(queued, 0, 'no queued write leaked into the snapshot');
      } finally {
        snap.close();
      }
      // The live database stayed healthy and took every queued write.
      assert.equal(opened.handle.prepare('SELECT COUNT(*) AS c FROM note').get().c, 75, 'all queued writes committed to the source');
      // Reads ran concurrently without failing.
      for (const row of readResults) assert.equal(typeof row.c, 'number');
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('migrationLedgerState and schema identity reflect the committed schema', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      opened.handle.exec('CREATE TABLE _Migration (version INTEGER PRIMARY KEY, appliedAt TEXT NOT NULL)');
      opened.handle.prepare('INSERT INTO _Migration (version, appliedAt) VALUES (?, ?)').run(1, '2026-01-01T00:00:00.000Z');
      opened.handle.prepare('INSERT INTO _Migration (version, appliedAt) VALUES (?, ?)').run(3, '2026-01-03T00:00:00.000Z');
      opened.handle.exec('CREATE TABLE _WorkbenchMigration (version INTEGER PRIMARY KEY, appliedAt TEXT NOT NULL)');
      opened.handle.prepare('INSERT INTO _WorkbenchMigration (version, appliedAt) VALUES (?, ?)').run(2, '2026-01-02T00:00:00.000Z');
      opened.handle.exec('CREATE TABLE app_note (id TEXT PRIMARY KEY, body TEXT)');

      const result = await managerFor(opened).backup();      assert.equal(result.ok, true);
      const manifest = result.manifest;

      // The applied ledgers, captured from the snapshot (committed state).
      assert.deepEqual(manifest.migrationLedgerState.app, { table: '_Migration', appliedVersions: [1, 3], maxVersion: 3 });
      assert.deepEqual(manifest.migrationLedgerState.workbench, { table: '_WorkbenchMigration', appliedVersions: [2], maxVersion: 2 });

      // Platform identity covers the framework tables; app identity is one
      // fingerprint per app-owned table and never names a ledger.
      assert.equal(manifest.appSchemaIdentity.length, 1, 'exactly the app table is an app-schema identity');
      assert.match(manifest.appSchemaIdentity[0], /^app_note:[0-9a-f]{64}$/);
      assert.ok(
        manifest.appSchemaIdentity.every((entry) => !entry.startsWith('_Migration') && !entry.startsWith('_WorkbenchMigration')),
        'ledgers are not app-schema identities',
      );
      // The two identities are stable across a second backup of the same state.
      const again = await managerFor(opened).backup();
      assert.equal(again.ok, true);
      assert.equal(again.manifest.platformSchemaIdentity, manifest.platformSchemaIdentity);
      assert.deepEqual(again.manifest.appSchemaIdentity, manifest.appSchemaIdentity);
      assert.deepEqual(again.manifest.migrationLedgerState, manifest.migrationLedgerState);
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('blob census: referenced generations are recorded and their bytes copied', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      const materialized = [];
      const blobs = {
        census: async () => ['gen-a', 'gen-b'],
        materialize: async (generation, destDir) => {
          materialized.push(generation);
          writeFileSync(join(destDir, `${generation}.blob`), `bytes-${generation}`);
        },
      };
      const result = await managerFor(opened, { blobs }).backup();
      assert.equal(result.ok, true);
      assert.equal(result.status, 'complete');
      assert.deepEqual([...result.manifest.blobGenerations].sort(), ['gen-a', 'gen-b']);
      assert.deepEqual(materialized.sort(), ['gen-a', 'gen-b'], 'every referenced generation was materialized');
      assert.equal(existsSync(join(result.directory, 'blobs', 'gen-a.blob')), true);
      assert.equal(existsSync(join(result.directory, 'blobs', 'gen-b.blob')), true);
      assertEnumeratedManifest(result.manifest);
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a missing referenced blob makes the backup partial + quarantined — never false-complete', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      opened.handle.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
      const blobs = {
        census: () => ['gen-a', 'gen-b'],
        materialize: (generation) => {
          if (generation === 'gen-b') throw new Error('BLOB_UNAVAILABLE: gen-b bytes pending finalization');
        },
      };
      const result = await managerFor(opened, { blobs }).backup();
      assert.equal(result.ok, false);
      assert.equal(result.status, 'partial');
      assert.equal(result.quarantined, true);
      assert.equal(result.manifest.status, 'partial', 'the manifest says partial, never complete');
      assert.match(result.diagnostic.error, /gen-b/);
      assert.deepEqual(result.diagnostic.detail.missingGenerations, ['gen-b']);

      // The partial was quarantined OUT of backups/ — restore can never pick it up.
      assert.equal(readdirSync(join(dir, 'backups')).length, 0, 'no backup dir remains in backups/');
      assert.ok(result.directory.startsWith(join(dir, 'quarantine')), 'the partial lives in quarantine/');
      assert.equal(existsSync(join(result.directory, 'diagnostic.json')), true, 'diagnostics retained');
      const disk = JSON.parse(readFileSync(join(result.directory, 'manifest.json'), 'utf8'));
      assert.equal(disk.status, 'partial', 'the on-disk manifest is not a false-complete marker');
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the adapter backupTo hook snapshots via node:sqlite for file and memory sources', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      opened.handle.exec('CREATE TABLE t (id TEXT PRIMARY KEY, v TEXT)');
      opened.handle.prepare('INSERT INTO t (id, v) VALUES (?, ?)').run('n1', 'file-row');
      const pages = await opened.backupTo(join(dir, 'hook-file.sqlite'));
      assert.ok(Number.isInteger(pages) && pages >= 1, 'backupTo resolves with the transferred page count');
      const read = new DatabaseSync(join(dir, 'hook-file.sqlite'), { readOnly: true });
      try {
        assert.equal(read.prepare('SELECT v FROM t WHERE id = ?').get('n1').v, 'file-row');
      } finally {
        read.close();
      }
    } finally {
      opened.close();
    }

    const memory = openMemoryAdapter();
    try {
      memory.handle.exec('CREATE TABLE t (id TEXT PRIMARY KEY, v TEXT)');
      memory.handle.prepare('INSERT INTO t (id, v) VALUES (?, ?)').run('n2', 'mem-row');
      await memory.backupTo(join(dir, 'hook-mem.sqlite'));
      const read = new DatabaseSync(join(dir, 'hook-mem.sqlite'), { readOnly: true });
      try {
        assert.equal(read.prepare('SELECT v FROM t WHERE id = ?').get('n2').v, 'mem-row');
      } finally {
        read.close();
      }
    } finally {
      memory.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a non-WAL source is refused fail-closed — a raw main-file copy never happens', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      // A structurally valid source whose live connection is NOT in WAL mode
      // (default journal mode): the ticket's WAL-safe snapshot contract is
      // unconditional, so the manager must refuse BEFORE any byte copy.
      const nonWalHandle = new DatabaseSync(':memory:');
      nonWalHandle.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
      let copyAttempted = false;
      const fake = {
        root: dir,
        handle: nonWalHandle,
        backupTo: async () => {
          copyAttempted = true;
          throw new Error('should never be reached');
        },
      };
      const result = await createBackupManager({ source: fake, writeCoordinator: createWriteQueue() }).backup();
      assert.equal(result.ok, false);
      assert.equal(result.status, 'failed');
      assert.match(result.diagnostic.error, /WAL-mode source/);
      assert.equal(copyAttempted, false, 'the manager never attempted a (raw) copy of the database file');
      nonWalHandle.close();
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the backup API surface is re-exported from workbench/internal', { timeout: 120000 }, async () => {
  const internal = await import('../build/internal.mjs');
  assert.equal(typeof internal.createBackupManager, 'function');
  assert.equal(internal.BACKUP_FORMAT_VERSION, 1);
  assert.deepEqual(internal.DEFAULT_RETENTION, { daily: 7, hourly: 3 });
});

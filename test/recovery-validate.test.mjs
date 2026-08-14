// recovery-validate.test.mjs — S1/A4 validation gates: manifest shape,
// SQLite integrity, schema identity, migration ledger, and blob availability
// are ALL verified before activation; encryption !== 'none' is rejected; any
// failure aborts with the backup left untouched (abort-on-failure).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openSqliteAdapter } from '../build/sqlite-adapter.mjs';
import { createWriteQueue } from '../build/write-queue.mjs';
import { createBackupManager } from '../build/backup.mjs';
import { createRecoveryManager } from '../build/recovery.mjs';

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'wb-recovery-validate-'));
}

// A recovery manager over a plain { root } source — the corrupt-db path where
// the adapter cannot open (its fail-closed quick_check throws). Mirrors the
// backup tests' managerFor binding pattern.
function managerFor(dir, options = {}) {
  const writeCoordinator = options.writeCoordinator ?? createWriteQueue();
  const source = options.source ?? { root: dir, writeCoordinator };
  return createRecoveryManager({ source, writeCoordinator, ...options });
}

// Produce a real, complete backup (snapshot + manifest + blobs/) in dir.
async function makeBackup(dir, { blobs } = {}) {
  const opened = openSqliteAdapter({ directory: dir, name: 'app' });
  try {
    opened.handle.exec('CREATE TABLE note (id TEXT PRIMARY KEY, body TEXT)');
    opened.handle.prepare('INSERT INTO note (id, body) VALUES (?, ?)').run('n1', 'hello recovery');
    const writeCoordinator = createWriteQueue();
    opened.writeCoordinator = writeCoordinator;
    const backupManager = createBackupManager({ source: opened, writeCoordinator, blobs });
    const backup = await backupManager.backup();
    assert.equal(backup.ok, true, 'the seed backup completes');
    return backup;
  } finally {
    opened.close();
  }
}

function manifestPath(dir, backupId) {
  return join(dir, 'backups', backupId, 'manifest.json');
}

function readManifest(dir, backupId) {
  return JSON.parse(readFileSync(manifestPath(dir, backupId), 'utf8'));
}

function quarantineNames(dir) {
  try {
    return readdirSync(join(dir, 'quarantine')).sort();
  } catch {
    return [];
  }
}

test('createRecoveryManager validates its contract fail-closed', { timeout: 120000 }, () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const queue = createWriteQueue();
    const source = { root: dir, writeCoordinator: queue };
    assert.throws(() => createRecoveryManager(), /options object/);
    assert.throws(() => createRecoveryManager({ source: { root: '' }, writeCoordinator: queue }), /owned directory/);
    assert.throws(() => createRecoveryManager({ source, writeCoordinator: undefined }), /write coordinator/);
    assert.throws(() => createRecoveryManager({ source: { root: dir }, writeCoordinator: queue }), /declare the write coordinator/);
    assert.throws(
      () => createRecoveryManager({ source, writeCoordinator: createWriteQueue() }),
      /foreign write coordinator/,
      'a different coordinator is refused',
    );
    assert.throws(
      () => createRecoveryManager({ source: { root: dir, writeCoordinator: queue }, writeCoordinator: { run: async (fn) => fn() } }),
      /foreign write coordinator/,
      'a run-shaped object without ownership is refused',
    );
    assert.throws(() => createRecoveryManager({ source, writeCoordinator: queue, blobs: {} }), /verifyBackupGeneration/);
    assert.throws(() => createRecoveryManager({ source, writeCoordinator: queue, validateMigrationLedger: 'no' }), /must be a function/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a complete healthy backup passes every gate and restores', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const backup = await makeBackup(dir);
    // The writer's canonical UTC ISO-8601 timestamps round-trip exactly and are
    // therefore accepted by the manifest shape gate.
    for (const field of ['createdAt', 'completedAt']) {
      assert.equal(new Date(backup.manifest[field]).toISOString(), backup.manifest[field], `${field} is canonical`);
    }
    assert.equal(
      new Date(backup.manifest.integrityResult.checkedAt).toISOString(),
      backup.manifest.integrityResult.checkedAt,
      'integrityResult.checkedAt is canonical',
    );
    const result = await managerFor(dir).recover({ backupId: backup.backupId });
    assert.equal(result.ok, true, 'a healthy backup restores');
    assert.equal(result.status, 'restored');
    assert.equal(result.census.schema.ok, true, 'schema census passes');
    assert.equal(result.census.blobs.ok, true, 'blob census passes');
    const restored = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      assert.equal(restored.handle.prepare('SELECT body FROM note WHERE id = ?').get('n1').body, 'hello recovery');
    } finally {
      restored.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('encryption !== "none" is rejected and the backup is left untouched', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const backup = await makeBackup(dir);
    const manifest = readManifest(dir, backup.backupId);
    writeFileSync(manifestPath(dir, backup.backupId), JSON.stringify({ ...manifest, encryption: 'aes-256' }, null, 2));

    const before = quarantineNames(dir);
    const result = await managerFor(dir).recover({ backupId: backup.backupId });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'rejected', 'an encrypted backup is refused before anything is touched');
    assert.match(result.reason, /encryption "aes-256"/);
    assert.equal(existsSync(join(dir, 'backups', backup.backupId)), true, 'the rejected backup stays in backups/');
    assert.deepEqual(quarantineNames(dir), before, 'quarantine is untouched by the rejection');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a corrupt snapshot (bad integrity) is rejected with the backup left untouched', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const backup = await makeBackup(dir);
    writeFileSync(join(dir, 'backups', backup.backupId, 'snapshot.sqlite'), 'THIS IS NOT A VALID SQLITE FILE '.repeat(64));

    const before = quarantineNames(dir);
    const result = await managerFor(dir).recover({ backupId: backup.backupId });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'rejected');
    assert.ok(result.validation.length > 0, 'structured validation failures are reported');
    assert.match(result.reason, /could not be opened|could not be restored|integrity/i);
    assert.equal(existsSync(join(dir, 'backups', backup.backupId)), true, 'the corrupt backup stays in backups/');
    assert.deepEqual(quarantineNames(dir), before, 'quarantine is untouched');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a snapshot whose recomputed schema identity does not match the manifest is rejected', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const backup = await makeBackup(dir);
    const manifest = readManifest(dir, backup.backupId);
    writeFileSync(
      manifestPath(dir, backup.backupId),
      JSON.stringify({ ...manifest, platformSchemaIdentity: '0'.repeat(64) }, null, 2),
    );

    const result = await managerFor(dir).recover({ backupId: backup.backupId });
    assert.equal(result.ok, false);
    assert.match(result.reason, /schema identity does not match/);
    assert.equal(existsSync(join(dir, 'backups', backup.backupId)), true, 'the mismatched backup stays in backups/');
    assert.deepEqual(quarantineNames(dir), [], 'quarantine is untouched');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a migration ledger that does not match the snapshot is rejected — the ledger that EXISTS, never a fresh reset', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    // A source db with a REAL applied migration ledger.
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
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
    opened.handle.exec('CREATE TABLE note (id TEXT PRIMARY KEY, body TEXT)');
    opened.handle.prepare('INSERT INTO note (id, body) VALUES (?, ?)').run('n1', 'hello');
    const writeCoordinator = createWriteQueue();
    opened.writeCoordinator = writeCoordinator;
    const backup = await createBackupManager({ source: opened, writeCoordinator }).backup();
    opened.close();
    assert.equal(backup.ok, true);
    const manifest = readManifest(dir, backup.backupId);
    assert.deepEqual(manifest.migrationLedgerState.appliedVersions, [{ namespace: 'alpha', version: 1 }], 'the backup captured the applied ledger');

    // Lie about the ledger: the manifest claims no migrations were ever applied.
    const lied = {
      ...manifest,
      migrationLedgerState: {
        table: '_SchemaMigration',
        appliedVersions: [],
        maxVersion: 0,
      },
    };
    writeFileSync(manifestPath(dir, backup.backupId), JSON.stringify(lied, null, 2));

    const result = await managerFor(dir).recover({ backupId: backup.backupId });
    assert.equal(result.ok, false);
    assert.match(result.reason, /migration ledger does not match/);
    assert.equal(existsSync(join(dir, 'backups', backup.backupId)), true, 'the ledger-mismatched backup stays in backups/');
    assert.deepEqual(quarantineNames(dir), [], 'quarantine is untouched');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an internally inconsistent migration ledger is rejected', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const backup = await makeBackup(dir);
    const manifest = readManifest(dir, backup.backupId);
    // No ledgers exist in this snapshot, but the manifest claims versions are
    // applied out of order and its maxVersion is a lie — internally impossible.
    const badLedger = {
      table: '_SchemaMigration',
      appliedVersions: [
        { namespace: 'alpha', version: 3 },
        { namespace: 'alpha', version: 1 },
        { namespace: 'alpha', version: 2 },
      ],
      maxVersion: 2,
    };
    writeFileSync(manifestPath(dir, backup.backupId), JSON.stringify({ ...manifest, migrationLedgerState: badLedger }, null, 2));

    const result = await managerFor(dir).recover({ backupId: backup.backupId });
    assert.equal(result.ok, false);
    assert.match(result.reason, /migration ledger/i);
    assert.equal(existsSync(join(dir, 'backups', backup.backupId)), true, 'the rejected backup stays in backups/');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the declared-identity migration validator seam gates the restore', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const backup = await makeBackup(dir);

    // A declared identity that rejects the ledger the backup holds → refused,
    // backup untouched (S1/A4: declared schema identity matches the ledger that
    // EXISTS; ScopeSchemaVersion stays Scope-owned, so this is a seam).
    const rejecting = managerFor(dir, {
      validateMigrationLedger: () => {
        throw new Error('declared schema expects a different migration ledger');
      },
    });
    const refused = await rejecting.recover({ backupId: backup.backupId });
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /declared schema expects a different migration ledger/);
    assert.equal(existsSync(join(dir, 'backups', backup.backupId)), true, 'a seam-rejected backup stays in backups/');

    // An accepting declared identity → the same backup restores.
    const accepting = managerFor(dir, {
      validateMigrationLedger: () => {},
    });
    const restored = await accepting.recover({ backupId: backup.backupId });
    assert.equal(restored.ok, true);
    assert.equal(restored.status, 'restored');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a backup referencing blob generations without a seam is refused fail-closed', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
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
    assert.deepEqual(backup.manifest.blobGenerations, ['gen-a']);

    // No recovery seam → the referenced bytes cannot be verified pre-activation.
    const result = await managerFor(dir).recover({ backupId: backup.backupId });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'rejected');
    assert.match(result.reason, /no recovery blob seam/);
    assert.equal(existsSync(join(dir, 'backups', backup.backupId)), true, 'the backup stays in backups/');
    assert.deepEqual(quarantineNames(dir), [], 'quarantine is untouched');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a blob seam that cannot verify a referenced generation is rejected with the backup untouched', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
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

    const failingSeam = {
      verifyBackupGeneration: () => {
        throw new Error('gen-a bytes missing from backup');
      },
      materializeRestoreGeneration: () => [],
      censusAfterRestore: () => {},
    };
    const result = await managerFor(dir, { blobs: failingSeam }).recover({ backupId: backup.backupId });
    assert.equal(result.ok, false);
    assert.match(result.reason, /gen-a/);
    assert.match(result.reason, /unavailable/);
    assert.equal(existsSync(join(dir, 'backups', backup.backupId)), true, 'the backup stays in backups/');
    assert.deepEqual(quarantineNames(dir), [], 'quarantine is untouched');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a blob seam that lacks materialization is refused fail-closed (like the no-seam rule)', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
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
    assert.deepEqual(backup.manifest.blobGenerations, ['gen-a']);

    // Verification alone is never enough: the referenced bytes must also be
    // materialized into the target, or the census would see nothing.
    const incompleteSeam = {
      verifyBackupGeneration: () => {},
      censusAfterRestore: () => {},
    };
    const result = await managerFor(dir, { blobs: incompleteSeam }).recover({ backupId: backup.backupId });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'rejected');
    assert.match(result.reason, /materializeRestoreGeneration|incomplete/);
    assert.equal(existsSync(join(dir, 'backups', backup.backupId)), true, 'the backup stays in backups/');
    assert.deepEqual(quarantineNames(dir), [], 'quarantine is untouched');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a manifest with integrityResult removed is refused', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const backup = await makeBackup(dir);
    const manifest = readManifest(dir, backup.backupId);
    const { integrityResult, ...without } = manifest;
    assert.ok(integrityResult, 'the real manifest records an integrityResult');
    writeFileSync(manifestPath(dir, backup.backupId), JSON.stringify(without, null, 2));

    const result = await managerFor(dir).recover({ backupId: backup.backupId });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'rejected');
    assert.match(result.reason, /integrityResult/);
    assert.equal(existsSync(join(dir, 'backups', backup.backupId)), true, 'the backup stays in backups/');
    assert.deepEqual(quarantineNames(dir), [], 'quarantine is untouched');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a manifest with a falsified integrityResult is refused', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const backup = await makeBackup(dir);
    const manifest = readManifest(dir, backup.backupId);
    // The snapshot is healthy, but the manifest claims integrity failed — a
    // fabricated record a complete backup can never hold.
    writeFileSync(
      manifestPath(dir, backup.backupId),
      JSON.stringify(
        {
          ...manifest,
          integrityResult: {
            ok: false,
            checkedAt: '2026-01-01T00:00:00.000Z',
            findings: [{ severity: 'error', message: 'fabricated failure' }],
          },
        },
        null,
        2,
      ),
    );

    const result = await managerFor(dir).recover({ backupId: backup.backupId });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'rejected');
    assert.match(result.reason, /failed integrity check/);
    assert.equal(existsSync(join(dir, 'backups', backup.backupId)), true, 'the backup stays in backups/');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a manifest with a malformed (falsified) platformSchemaIdentity is refused', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const backup = await makeBackup(dir);
    const manifest = readManifest(dir, backup.backupId);
    writeFileSync(
      manifestPath(dir, backup.backupId),
      JSON.stringify({ ...manifest, platformSchemaIdentity: 'not-a-schema-fingerprint' }, null, 2),
    );

    const result = await managerFor(dir).recover({ backupId: backup.backupId });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'rejected');
    assert.match(result.reason, /platformSchemaIdentity/);
    assert.equal(existsSync(join(dir, 'backups', backup.backupId)), true, 'the backup stays in backups/');
    assert.deepEqual(quarantineNames(dir), [], 'quarantine is untouched');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a manifest with a rolled-over (impossible) createdAt is refused', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const backup = await makeBackup(dir);
    const manifest = readManifest(dir, backup.backupId);
    // 2026-02-30T00:00:00.000Z satisfies the ISO-8601 UTC SHAPE, but Date.parse
    // silently normalizes it to March 2 — only the round-trip check refuses the
    // rollover (Date.parse alone would accept it).
    writeFileSync(
      manifestPath(dir, backup.backupId),
      JSON.stringify({ ...manifest, createdAt: '2026-02-30T00:00:00.000Z' }, null, 2),
    );

    const result = await managerFor(dir).recover({ backupId: backup.backupId });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'rejected');
    assert.match(result.reason, /createdAt is not a valid ISO-8601 UTC timestamp/);
    assert.equal(existsSync(join(dir, 'backups', backup.backupId)), true, 'the backup stays in backups/');
    assert.deepEqual(quarantineNames(dir), [], 'quarantine is untouched');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a manifest with a non-ISO createdAt is refused', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const backup = await makeBackup(dir);
    const manifest = readManifest(dir, backup.backupId);
    writeFileSync(
      manifestPath(dir, backup.backupId),
      JSON.stringify({ ...manifest, createdAt: 'yesterday' }, null, 2),
    );

    const result = await managerFor(dir).recover({ backupId: backup.backupId });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'rejected');
    assert.match(result.reason, /createdAt is not a valid ISO-8601 UTC timestamp/);
    assert.equal(existsSync(join(dir, 'backups', backup.backupId)), true, 'the backup stays in backups/');
    assert.deepEqual(quarantineNames(dir), [], 'quarantine is untouched');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a manifest with rolled-over completedAt and integrityResult.checkedAt is refused', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const backup = await makeBackup(dir);
    const manifest = readManifest(dir, backup.backupId);
    writeFileSync(
      manifestPath(dir, backup.backupId),
      JSON.stringify(
        {
          ...manifest,
          completedAt: '2026-02-30T00:00:00.000Z',
          integrityResult: { ...manifest.integrityResult, checkedAt: '2026-02-30T00:00:00.000Z' },
        },
        null,
        2,
      ),
    );

    const result = await managerFor(dir).recover({ backupId: backup.backupId });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'rejected');
    assert.match(result.reason, /completedAt is not a valid ISO-8601 UTC timestamp/);
    assert.match(result.reason, /checkedAt is not a valid ISO-8601 UTC timestamp/);
    assert.equal(existsSync(join(dir, 'backups', backup.backupId)), true, 'the backup stays in backups/');
    assert.deepEqual(quarantineNames(dir), [], 'quarantine is untouched');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a manifest declaring a third (unsupported) migration ledger table is refused', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const backup = await makeBackup(dir);
    const manifest = readManifest(dir, backup.backupId);
    writeFileSync(
      manifestPath(dir, backup.backupId),
      JSON.stringify(
        {
          ...manifest,
          migrationLedgerState: {
            ...manifest.migrationLedgerState,
            table: '_OtherMigration',
          },
        },
        null,
        2,
      ),
    );

    const result = await managerFor(dir).recover({ backupId: backup.backupId });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'rejected');
    assert.match(result.reason, /unsupported ledger table|_OtherMigration/);
    assert.equal(existsSync(join(dir, 'backups', backup.backupId)), true, 'the backup stays in backups/');
    assert.deepEqual(quarantineNames(dir), [], 'quarantine is untouched');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an incomplete backup dir is quarantined by recovery and never restored', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const leftover = '2026-01-01T00-00-00.000Z-deadbeef00aa';
    const backupDir = join(dir, 'backups', leftover);
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(join(backupDir, 'snapshot.sqlite'), 'partial bytes');

    const result = await managerFor(dir).recover({ backupId: leftover });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'rejected');
    assert.match(result.reason, /incomplete/);
    assert.equal(readdirSync(join(dir, 'backups')).length, 0, 'the incomplete dir no longer sits in backups/');
    assert.ok(
      quarantineNames(dir).some((name) => name.includes('deadbeef00aa')),
      'the incomplete dir landed in quarantine/',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an invalid backupId (path traversal) is rejected before touching anything', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const result = await managerFor(dir).recover({ backupId: '../not-a-backup' });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'rejected');
    assert.match(result.reason, /invalid backupId/);
    assert.deepEqual(quarantineNames(dir), [], 'nothing was moved');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

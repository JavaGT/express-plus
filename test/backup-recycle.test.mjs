// backup-recycle.test.mjs — S1/A6 the recycling bin (issue #85): the single
// deletion path for content whose bytes exist in a retained backup. delete →
// bin → backup re-mark; force-delete-earlier purge by backupId/generation;
// default/configurable recovery-period expiry; operator list/restore;
// fail-closed binning (disk-full/permission never reports the backup cleaned).
// The uniform erasure-vs-ordinary path is structural: `bin()` takes ONLY the
// deleted generations (one bin, no erasure flag, no per-backup markers).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openSqliteAdapter } from '../build/sqlite-adapter.mjs';
import { createWriteQueue } from '../build/write-queue.mjs';
import { createBackupManager } from '../build/backup.mjs';
import {
  createRecycleManager,
  DEFAULT_RECYCLE_RETENTION_DAYS,
  RECYCLE_FORMAT_VERSION,
} from '../build/backup/recycle.mjs';

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'wb-backup-recycle-'));
}

// Bind the freshly-created coordinator to the source (the ownership seam,
// review #82 finding 3) and construct the manager with that same coordinator.
function managerFor(opened, options = {}) {
  const writeCoordinator = options.writeCoordinator ?? createWriteQueue();
  opened.writeCoordinator = writeCoordinator;
  return createBackupManager({ source: opened, writeCoordinator, ...options });
}

// A backup blob seam that materializes each generation as `<gen>.blob` (the
// S6 seam shape the backup module consumes) and the matching recycle
// resolution seam (S1/A6): resolveBackupBlobName must return the file name the
// materializer wrote inside the backup's blobs/ dir.
function blobSeam(generations) {
  return {
    census: async () => [...generations],
    materialize: async (generation, destDir) => {
      const name = `${generation}.blob`;
      writeFileSync(join(destDir, name), `bytes-${generation}`);
      return [{ name, size: `bytes-${generation}`.length }];
    },
  };
}
const resolveSeam = { resolveBackupBlobName: (generation) => `${generation}.blob` };

function manifestOf(backupDir) {
  return JSON.parse(readFileSync(join(backupDir, 'manifest.json'), 'utf8'));
}

test('delete → bin → backup re-mark: bytes move to recycle/, the backup is re-marked, nothing is destroyed silently', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      opened.handle.exec('CREATE TABLE note (id TEXT PRIMARY KEY, body TEXT)');
      opened.handle.prepare('INSERT INTO note (id, body) VALUES (?, ?)').run('n1', 'hello');
      const result = await managerFor(opened, { blobs: blobSeam(['gen-a', 'gen-b']) }).backup();
      assert.equal(result.ok, true);
      const backupDir = result.directory;
      assert.equal(existsSync(join(backupDir, 'blobs', 'gen-a.blob')), true, 'the backup holds the to-be-deleted bytes');

      const recycle = createRecycleManager({ root: dir, blobs: resolveSeam });
      const binResult = await recycle.bin({ generations: ['gen-a'] });
      assert.equal(binResult.ok, true);
      assert.deepEqual(binResult.binned, [{ backupId: result.backupId, generations: ['gen-a'] }]);
      assert.deepEqual(binResult.failed, []);

      // The affected bytes MOVED to recycle/<backupId>/<generation>/ — never
      // silently destroyed.
      const entryDir = join(dir, 'recycle', result.backupId, 'gen-a');
      assert.equal(readFileSync(join(entryDir, 'gen-a.blob'), 'utf8'), 'bytes-gen-a', 'the deleted bytes are in the bin');
      assert.equal(existsSync(join(entryDir, 'entry.json')), true, 'the bin entry records the origin');
      assert.equal(existsSync(join(backupDir, 'blobs', 'gen-a.blob')), false, 'the backup no longer holds the deleted bytes');
      assert.equal(existsSync(join(backupDir, 'blobs', 'gen-b.blob')), true, 'untouched generations stay in the backup');

      // The backup is RE-MARKED: content no longer reachable from the backup,
      // while the census (blobGenerations) stays truthful.
      const manifest = manifestOf(backupDir);
      assert.equal(manifest.status, 'complete', 're-marking never flips a complete backup to partial');
      assert.deepEqual(manifest.blobGenerations, ['gen-a', 'gen-b'], 'the captured census is not rewritten');
      assert.equal(manifest.binnedGenerations.length, 1);
      assert.equal(manifest.binnedGenerations[0].generation, 'gen-a');
      assert.equal(manifest.binnedGenerations[0].name, 'gen-a.blob');
      assert.equal(manifest.binnedGenerations[0].size, 'bytes-gen-a'.length);
      assert.ok(!Number.isNaN(Date.parse(manifest.binnedGenerations[0].binnedAt)), 'the re-mark is timestamped');
      assert.equal(manifest.binnedGenerations[0].purgedAt, undefined, 'not yet destroyed');

      // The bin entry.json is canonical (round-trip: format, origin, bytes).
      const entry = JSON.parse(readFileSync(join(entryDir, 'entry.json'), 'utf8'));
      assert.equal(entry.formatVersion, RECYCLE_FORMAT_VERSION);
      assert.equal(entry.backupId, result.backupId);
      assert.equal(entry.generation, 'gen-a');
      assert.equal(entry.name, 'gen-a.blob');
      assert.equal(entry.size, 'bytes-gen-a'.length);
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('binning a generation no retained backup references bins nothing and reports ok', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      opened.handle.exec('CREATE TABLE note (id TEXT PRIMARY KEY)');
      const result = await managerFor(opened, { blobs: blobSeam(['gen-a']) }).backup();
      assert.equal(result.ok, true);

      const recycle = createRecycleManager({ root: dir, blobs: resolveSeam });
      const binResult = await recycle.bin({ generations: ['gen-zzz'] });
      assert.equal(binResult.ok, true, 'content absent from every retained backup has nothing to preserve');
      assert.deepEqual(binResult.binned, []);
      assert.deepEqual(binResult.failed, []);
      assert.equal(existsSync(join(dir, 'recycle', result.backupId)), false, 'no bin entry was created');
      assert.equal(manifestOf(result.directory).binnedGenerations, undefined, 'the backup was not re-marked');
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('binning is idempotent — a generation already binned for a backup is skipped, never double-binned', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      opened.handle.exec('CREATE TABLE note (id TEXT PRIMARY KEY)');
      const result = await managerFor(opened, { blobs: blobSeam(['gen-a']) }).backup();
      const recycle = createRecycleManager({ root: dir, blobs: resolveSeam });
      assert.equal((await recycle.bin({ generations: ['gen-a'] })).ok, true);
      assert.equal(recycle.list().length, 1);
      const again = await recycle.bin({ generations: ['gen-a'] });
      assert.equal(again.ok, true, 'a re-delete of already-binned content is not an error');
      assert.deepEqual(again.binned, [{ backupId: result.backupId, generations: [] }], 'nothing was re-binned');
      assert.equal(recycle.list().length, 1, 'there is still exactly one bin entry');
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('binning fails closed per backup — a generation that cannot be located leaves the whole backup untouched, never cleaned', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      opened.handle.exec('CREATE TABLE note (id TEXT PRIMARY KEY)');
      const result = await managerFor(opened, { blobs: blobSeam(['gen-a', 'gen-b']) }).backup();
      assert.equal(result.ok, true);
      const backupDir = result.directory;

      // The seam cannot locate gen-b's bytes (pending finalization, missing).
      const failing = {
        resolveBackupBlobName: (generation) => {
          if (generation === 'gen-b') throw new Error('BLOB_UNAVAILABLE: gen-b bytes pending finalization');
          return `${generation}.blob`;
        },
      };
      const recycle = createRecycleManager({ root: dir, blobs: failing });
      const binResult = await recycle.bin({ generations: ['gen-a', 'gen-b'] });
      assert.equal(binResult.ok, false);
      assert.equal(binResult.failed.length, 1, 'the backup is reported failed');
      assert.equal(binResult.failed[0].backupId, result.backupId);
      assert.deepEqual(binResult.failed[0].generations.sort(), ['gen-a', 'gen-b'], 'the whole backup is failed, not partially cleaned');
      assert.match(binResult.failed[0].error, /gen-b/);

      // Nothing moved, nothing re-marked: a half-clean is never reported done.
      assert.equal(existsSync(join(dir, 'recycle', result.backupId)), false, 'no partial bin entry exists');
      assert.equal(existsSync(join(backupDir, 'blobs', 'gen-a.blob')), true, 'gen-a bytes are still in the backup');
      assert.equal(existsSync(join(backupDir, 'blobs', 'gen-b.blob')), true);
      assert.equal(manifestOf(backupDir).binnedGenerations, undefined, 'the backup was never re-marked cleaned');

      // With a working seam, the identical delete then succeeds.
      const working = createRecycleManager({ root: dir, blobs: resolveSeam });
      assert.equal((await working.bin({ generations: ['gen-a', 'gen-b'] })).ok, true);
      assert.equal(working.list().length, 2);
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a permission/disk-full failure during binning fails closed — the backup is never reported cleaned', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      opened.handle.exec('CREATE TABLE note (id TEXT PRIMARY KEY)');
      const result = await managerFor(opened, { blobs: blobSeam(['gen-a']) }).backup();
      assert.equal(result.ok, true);
      const backupDir = result.directory;
      const blobsDir = join(backupDir, 'blobs');

      // Remove write permission on the backup's blobs dir: the byte rename out
      // of it must fail (the binning equivalent of disk-full/permission).
      chmodSync(blobsDir, 0o500);
      const recycle = createRecycleManager({ root: dir, blobs: resolveSeam });
      const binResult = await recycle.bin({ generations: ['gen-a'] });
      chmodSync(blobsDir, 0o700);
      assert.equal(binResult.ok, false);
      assert.equal(binResult.failed.length, 1);
      assert.equal(binResult.failed[0].backupId, result.backupId);
      assert.match(binResult.failed[0].error, /EACCES|EPERM|ENOTEMPTY|EISDIR/, `binning failure surfaced: ${binResult.failed[0].error}`);
      assert.equal(existsSync(join(dir, 'recycle', result.backupId)), false, 'no bin entry was left behind');
      assert.equal(existsSync(join(blobsDir, 'gen-a.blob')), true, 'the bytes stayed in the backup');
      assert.equal(manifestOf(backupDir).binnedGenerations, undefined, 'the backup was not reported cleaned');

      // Once the directory is writable again the same delete succeeds.
      assert.equal((await recycle.bin({ generations: ['gen-a'] })).ok, true);
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a recycle manager without a blob seam refuses to bin byte-carrying backups fail-closed', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      opened.handle.exec('CREATE TABLE note (id TEXT PRIMARY KEY)');
      const result = await managerFor(opened, { blobs: blobSeam(['gen-a']) }).backup();
      assert.equal(result.ok, true);

      const recycle = createRecycleManager({ root: dir });
      const binResult = await recycle.bin({ generations: ['gen-a'] });
      assert.equal(binResult.ok, false);
      assert.equal(binResult.failed.length, 1);
      assert.match(binResult.failed[0].error, /no blob seam/);
      assert.equal(manifestOf(result.directory).binnedGenerations, undefined, 'never re-marked, never guessed at file names');
      assert.equal(existsSync(join(dir, 'recycle', result.backupId)), false);
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('purge({ backupId | generation }) force-deletes earlier than the recovery period', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      opened.handle.exec('CREATE TABLE note (id TEXT PRIMARY KEY)');
      const backup1 = await managerFor(opened, { blobs: blobSeam(['gen-a', 'gen-b']) }).backup();
      const backup2 = await managerFor(opened, { blobs: blobSeam(['gen-a']) }).backup();
      assert.equal(backup1.ok && backup2.ok, true);

      const recycle = createRecycleManager({ root: dir, blobs: resolveSeam });
      const binResult = await recycle.bin({ generations: ['gen-a', 'gen-b'] });
      assert.equal(binResult.ok, true);
      assert.equal(recycle.list().length, 3, 'backup1 holds gen-a + gen-b, backup2 holds gen-a');

      // Force-delete by origin backup: only backup1's entries go, immediately.
      const byBackup = await recycle.purge({ backupId: backup1.backupId });
      assert.equal(byBackup.removed, 2);
      assert.equal(existsSync(join(dir, 'recycle', backup1.backupId)), false, 'backup1 bin is empty');
      assert.equal(existsSync(join(dir, 'recycle', backup2.backupId, 'gen-a')), true, 'backup2 entry untouched');
      assert.equal(recycle.list().length, 1);

      // Force-delete by generation: the remaining gen-a goes, immediately.
      const byGeneration = await recycle.purge({ generation: 'gen-a' });
      assert.equal(byGeneration.removed, 1);
      assert.equal(recycle.list().length, 0);
      assert.equal(existsSync(join(dir, 'recycle', backup2.backupId)), false);

      // The origin manifests record the destruction so an operator can tell
      // destroyed content from restorable content.
      const m1 = manifestOf(backup1.directory);
      assert.equal(m1.binnedGenerations.length, 2);
      assert.ok(m1.binnedGenerations.every((r) => typeof r.purgedAt === 'string' && !Number.isNaN(Date.parse(r.purgedAt))));
      const m2 = manifestOf(backup2.directory);
      assert.equal(m2.binnedGenerations.length, 1);
      assert.equal(m2.binnedGenerations[0].generation, 'gen-a');
      assert.ok(typeof m2.binnedGenerations[0].purgedAt === 'string');
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the default recovery period (7 days, configurable, never hardcoded) sweeps expired binned content', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      opened.handle.exec('CREATE TABLE note (id TEXT PRIMARY KEY)');
      let tick = new Date('2026-01-10T00:00:00.000Z');
      const now = () => tick;
      assert.equal(DEFAULT_RECYCLE_RETENTION_DAYS, 7, 'the default recovery period is 7 days');

      const result = await managerFor(opened, { blobs: blobSeam(['gen-a', 'gen-b']) }).backup();
      assert.equal(result.ok, true);
      const recycle = createRecycleManager({ root: dir, blobs: resolveSeam, now });
      await recycle.bin({ generations: ['gen-a'] });
      assert.equal(recycle.list().length, 1);

      // Inside the recovery period the expiry sweep destroys nothing.
      tick = new Date('2026-01-16T23:59:59.999Z');
      assert.equal((await recycle.purge()).removed, 0, 'a day before the period ends nothing is swept');
      assert.equal(recycle.list().length, 1);

      // At/after the 7-day period the sweep destroys the binned content.
      tick = new Date('2026-01-17T00:00:00.000Z');
      const swept = await recycle.purge();
      assert.equal(swept.removed, 1, 'after 7 full days the recovery period has elapsed');
      assert.equal(recycle.list().length, 0);
      assert.equal(existsSync(join(dir, 'recycle', result.backupId, 'gen-a')), false);
      assert.ok(typeof manifestOf(result.directory).binnedGenerations[0].purgedAt === 'string', 'the swept entry is marked destroyed');

      // Configurable: a 1-day recovery period sweeps at its own horizon. A
      // DIFFERENT generation is used — the already-destroyed gen-a cannot be
      // re-binned (its re-mark persists), by design.
      tick = new Date('2026-02-01T00:00:00.000Z');
      const short = createRecycleManager({ root: dir, blobs: resolveSeam, retentionDays: 1, now });
      await short.bin({ generations: ['gen-b'] });
      assert.equal(short.list().length, 1);
      tick = new Date('2026-02-01T12:00:00.000Z');
      assert.equal((await short.purge()).removed, 0, '12h < 1 day recovery period');
      assert.equal(short.list().length, 1);
      tick = new Date('2026-02-02T00:00:00.000Z');
      assert.equal((await short.purge()).removed, 1, '24h >= 1 day recovery period');
      assert.equal(short.list().length, 0);
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recycle.list() is operator-accessible and restore() moves bytes back and un-marks the backup', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      opened.handle.exec('CREATE TABLE note (id TEXT PRIMARY KEY)');
      const result = await managerFor(opened, { blobs: blobSeam(['gen-a', 'gen-b']) }).backup();
      assert.equal(result.ok, true);
      const backupDir = result.directory;
      const recycle = createRecycleManager({ root: dir, blobs: resolveSeam });
      await recycle.bin({ generations: ['gen-a'] });

      // list() is the operator-visible directory + API surface.
      const entries = recycle.list();
      assert.equal(entries.length, 1);
      assert.equal(entries[0].backupId, result.backupId);
      assert.equal(entries[0].generation, 'gen-a');
      assert.equal(entries[0].name, 'gen-a.blob');
      assert.equal(entries[0].size, 'bytes-gen-a'.length);
      assert.ok(!Number.isNaN(Date.parse(entries[0].binnedAt)));
      assert.equal(recycle.root, join(dir, 'recycle'), 'the bin directory is exposed for operator access');

      // restore() returns the bytes to the origin backup and un-marks it.
      const restored = await recycle.restore({ backupId: result.backupId, generation: 'gen-a' });
      assert.equal(restored.ok, true);
      assert.equal(restored.backupId, result.backupId);
      assert.equal(restored.generation, 'gen-a');
      assert.equal(readFileSync(join(backupDir, 'blobs', 'gen-a.blob'), 'utf8'), 'bytes-gen-a', 'the bytes are back in the backup');
      assert.equal(existsSync(join(dir, 'recycle', result.backupId, 'gen-a')), false, 'the bin entry is gone');
      assert.equal(manifestOf(backupDir).binnedGenerations, undefined, 'the backup is un-marked');
      assert.equal(recycle.list().length, 0);

      // Restoring a missing entry fails closed.
      const missing = await recycle.restore({ backupId: result.backupId, generation: 'gen-a' });
      assert.equal(missing.ok, false);
      assert.match(missing.error, /no binned entry/);
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('restore fails closed rather than overwriting bytes or restoring into a vanished backup', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      opened.handle.exec('CREATE TABLE note (id TEXT PRIMARY KEY)');
      const result = await managerFor(opened, { blobs: blobSeam(['gen-a']) }).backup();
      assert.equal(result.ok, true);
      const backupDir = result.directory;
      const recycle = createRecycleManager({ root: dir, blobs: resolveSeam });
      await recycle.bin({ generations: ['gen-a'] });

      // A file already named gen-a.blob in the backup is never overwritten.
      writeFileSync(join(backupDir, 'blobs', 'gen-a.blob'), 'someone-elses-bytes');
      const overwrite = await recycle.restore({ backupId: result.backupId, generation: 'gen-a' });
      assert.equal(overwrite.ok, false);
      assert.match(overwrite.error, /refusing to overwrite/);
      assert.equal(readFileSync(join(backupDir, 'blobs', 'gen-a.blob'), 'utf8'), 'someone-elses-bytes', 'the existing bytes were untouched');
      rmSync(join(backupDir, 'blobs', 'gen-a.blob'));

      // A backup that is gone (retention-trimmed) cannot be restored into.
      await recycle.bin({ generations: ['gen-a'] });
      rmSync(backupDir, { recursive: true, force: true });
      const vanished = await recycle.restore({ backupId: result.backupId, generation: 'gen-a' });
      assert.equal(vanished.ok, false);
      assert.match(vanished.error, /no longer exists/);
      assert.equal(recycle.list().length, 1, 'the entry stays in the bin for an operator to recover manually');
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('purge fails closed when a binned entry cannot be removed', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      opened.handle.exec('CREATE TABLE note (id TEXT PRIMARY KEY)');
      const result = await managerFor(opened, { blobs: blobSeam(['gen-a']) }).backup();
      assert.equal(result.ok, true);
      const recycle = createRecycleManager({ root: dir, blobs: resolveSeam });
      await recycle.bin({ generations: ['gen-a'] });

      // A read-only bin entry directory makes the recursive removal throw —
      // the purge rejects instead of reporting success.
      const entryDir = join(dir, 'recycle', result.backupId, 'gen-a');
      chmodSync(entryDir, 0o500);
      await assert.rejects(() => recycle.purge({ backupId: result.backupId }), /EACCES|EPERM|ENOTEMPTY/);
      chmodSync(entryDir, 0o700);
      assert.equal(recycle.list().length, 1, 'nothing was reported removed that was not removed');
      assert.equal(manifestOf(result.directory).binnedGenerations[0].purgedAt, undefined, 'the surviving entry was not marked destroyed');
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recycle/ is covered by the S1/A2 managed-path guard, and the recycle API is re-exported from workbench/internal', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const opened = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      opened.handle.exec('CREATE TABLE note (id TEXT PRIMARY KEY)');
      const result = await managerFor(opened, { blobs: blobSeam(['gen-a']) }).backup();
      assert.equal(result.ok, true);
      const recycle = createRecycleManager({ root: dir, blobs: resolveSeam });
      await recycle.bin({ generations: ['gen-a'] });

      // The S1/A2 managed-path guard is what excludes the bin from static-file
      // serving and blob-root acceptance (wired in app.ts/views.ts).
      assert.equal(opened.isManagedPath(join(dir, 'recycle')), true, 'the bin directory is managed');
      assert.equal(opened.isManagedPath(join(dir, 'recycle', result.backupId, 'gen-a')), true, 'binned content is managed');
      assert.equal(opened.isManagedPath(join(dir, 'recycle', result.backupId, 'gen-a', 'gen-a.blob')), true, 'binned bytes are managed');

      const internal = await import('../build/internal.mjs');
      assert.equal(typeof internal.createRecycleManager, 'function', 'the recycle manager is re-exported from the internal API');
      assert.equal(internal.RECYCLE_FORMAT_VERSION, RECYCLE_FORMAT_VERSION);
      assert.equal(internal.DEFAULT_RECYCLE_RETENTION_DAYS, DEFAULT_RECYCLE_RETENTION_DAYS);
    } finally {
      opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// backup-app.test.mjs — S1/A3 backup × app ownership binding (review #82
// finding 2): the app binds its ONE write coordinator onto the adapter-opened
// source on BOTH open paths — the immediate config open and the deferred
// adapter open — so `createBackupManager({ source: app._dbAdapter,
// writeCoordinator: app.writeCoordinator })` constructs without manual
// mutation. The binding is per-source identity: the app's coordinator on a
// DIFFERENT source is still a foreign coordinator and refuses at construction.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openSqliteAdapter, createSqliteAdapter } from '../build/sqlite-adapter.mjs';
import { createWriteQueue } from '../build/write-queue.mjs';
import { createBackupManager } from '../build/backup.mjs';
import workbench from '../build/internal.mjs';

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'wb-backup-app-'));
}

test('an immediately-opened app source: createBackupManager over app.writeCoordinator + app._dbAdapter constructs and backs up without manual binding', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const app = workbench({ db: { directory: dir, name: 'app', mode: 'file' } });
    try {
      // The app opened the db BEFORE its coordinator existed, so the binding
      // fills the opened source in now (immediate-path ownership binding).
      assert.equal(app._dbAdapter.writeCoordinator, app.writeCoordinator, 'the app bound its coordinator onto the immediately-opened source');
      const manager = createBackupManager({ source: app._dbAdapter, writeCoordinator: app.writeCoordinator });
      const result = await manager.backup();
      assert.equal(result.ok, true, 'a backup over the app-bound source completes');
      assert.equal(result.status, 'complete');
      assert.equal(result.manifest.status, 'complete');
    } finally {
      await app.shutdown();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a deferred adapter-backed app source: app.ready binds the coordinator and createBackupManager constructs without manual binding', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const app = workbench({ db: createSqliteAdapter({ directory: dir, name: 'app', mode: 'file' }) });
    try {
      // The deferred open lands AFTER the coordinator exists; awaiting app.ready
      // runs the open and the deferred-path ownership binding.
      await app.ready;
      assert.ok(app.db, 'the deferred open installed the handle');
      assert.equal(app._dbAdapter.writeCoordinator, app.writeCoordinator, 'the deferred open bound the app coordinator onto the opened source');
      const manager = createBackupManager({ source: app._dbAdapter, writeCoordinator: app.writeCoordinator });
      const result = await manager.backup();
      assert.equal(result.ok, true, 'a backup over the deferred-opened app source completes');
      assert.equal(result.status, 'complete');
    } finally {
      await app.shutdown();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a coordinator bound to a DIFFERENT source still refuses at construction — the app binding is per-source, not global', { timeout: 120000 }, async () => {
  const root = tempRoot();
  const dir = join(root, 'owned');
  try {
    const app = workbench({ db: { directory: dir, name: 'app', mode: 'file' } });
    try {
      // A separately-opened source that declares ITS OWN coordinator: the app's
      // coordinator is not its owner, so construction must refuse.
      const otherDir = join(root, 'other');
      const other = openSqliteAdapter({ directory: otherDir, name: 'app' });
      try {
        other.writeCoordinator = createWriteQueue();
        assert.throws(
          () => createBackupManager({ source: other, writeCoordinator: app.writeCoordinator }),
          /foreign write coordinator/,
          'the app coordinator on a foreign source is refused',
        );
      } finally {
        other.close();
      }
      // A source that never declared an owner fails closed with the app's
      // coordinator too — an unbound source proves nothing.
      const unbound = openSqliteAdapter({ directory: join(root, 'unbound'), name: 'app' });
      try {
        assert.throws(
          () => createBackupManager({ source: unbound, writeCoordinator: app.writeCoordinator }),
          /declare the write coordinator that owns it/,
          'an unbound source is refused even with the app coordinator',
        );
      } finally {
        unbound.close();
      }
      // And the app's OWN source still refuses any other coordinator.
      assert.throws(
        () => createBackupManager({ source: app._dbAdapter, writeCoordinator: createWriteQueue() }),
        /foreign write coordinator/,
        'a different coordinator cannot claim the app-owned source',
      );
    } finally {
      await app.shutdown();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

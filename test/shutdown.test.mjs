// shutdown.test.mjs — S1/A2 clean-shutdown wiring: `app.shutdown()` checkpoints
// the WAL and closes the adapter (checkpoint-then-close), releases the OS-backed
// ownership lock, and stays idempotent. The file adapter's checkpoint-then-close
// ordering is observable: after shutdown the WAL is drained into the main file
// and the handle no longer accepts statements.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openSqliteAdapter, SQLITE_DATA_FILENAME } from '../build/sqlite-adapter.mjs';
import workbench from '../build/internal.mjs';

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), 'wb-shutdown-'));
}

// A conforming DbAdapter (A1 contract) stub whose opened database close() fails
// — used to prove app.shutdown() propagates the failure instead of swallowing it.
function failingCloseAdapter() {
  return {
    // Memory-mode adapter: declares root: null so the app does not fail closed
    // on the missing owned-directory declaration (review #93).
    root: null,
    readMirror() {
      return { kind: 'read-mirror', mode: 'read-only', readOnly: true, connectionString: 'file::memory:?mode=ro' };
    },
    open() {
      const db = new DatabaseSync(':memory:');
      return Promise.resolve({
        handle: db,
        capabilities: {
          transactionalDdl: false, onlineBackup: false, readOnlyConnections: false,
          integrityCheck: false, maintenance: false, encryption: false,
        },
        checkpoint() {},
        close() {
          try { db.close(); } catch { /* the stub fails regardless */ }
          throw new Error('checkpoint failed (stub)');
        },
        integrityCheck() { return { ok: true, checkedAt: new Date().toISOString(), findings: [] }; },
      });
    },
  };
}

test('app.shutdown() checkpoints the WAL and closes the file adapter, releasing the lock', async () => {
  const root = tempRoot();
  const dir = path.join(root, 'owned');
  try {
    const app = workbench({ db: { directory: dir, name: 'app', mode: 'file' } });
    // A committed write gives the WAL something to checkpoint.
    app.db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    app.db.exec("INSERT INTO t (v) VALUES ('durable')");
    const walFile = path.join(dir, SQLITE_DATA_FILENAME + '-wal');
    assert.equal(existsSync(walFile), true, 'WAL exists after a write');
    assert.ok(statSync(walFile).size > 0, 'WAL holds un-checkpointed content');

    await app.shutdown();

    // checkpoint-then-close: the WAL was drained into the main file...
    if (existsSync(walFile)) {
      assert.equal(statSync(walFile).size, 0, 'shutdown checkpointed the WAL');
    }
    const main = openSqliteAdapter({ directory: dir, name: 'app' });
    try {
      const row = main.handle.prepare('SELECT v FROM t WHERE id = 1').get();
      assert.equal(row.v, 'durable', 'committed data survives in the main file');
    } finally {
      main.close();
    }
    // ...the handle no longer accepts statements...
    assert.throws(() => app.db.prepare('SELECT 1'), /not open/i, 'adapter handle closed');
    // ...and the ownership lock was released (a fresh adapter can open).
    const reopened = openSqliteAdapter({ directory: dir, name: 'app' });
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('app.shutdown() is idempotent for the file adapter', async () => {
  const root = tempRoot();
  const dir = path.join(root, 'owned');
  try {
    const app = workbench({ db: { directory: dir, name: 'app', mode: 'file' } });
    app.db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    await app.shutdown();
    await app.shutdown();
    assert.throws(() => app.db.prepare('SELECT 1'), /not open/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('app.shutdown() closes a memory-adapter app cleanly', async () => {
  const app = workbench({ db: ':memory:' });
  app.db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
  await app.shutdown();
  assert.throws(() => app.db.prepare('SELECT 1'), /not open/i);
});

test('app.shutdown() leaves raw-handle apps untouched (no adapter to close)', async () => {
  const root = tempRoot();
  try {
    const db = new (await import('node:sqlite')).DatabaseSync(':memory:');
    const app = workbench({ db });
    app.db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    await app.shutdown();
    // A raw-handle app keeps its handle open — the caller owns it.
    assert.doesNotThrow(() => app.db.prepare('SELECT 1'));
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('app.shutdown() propagates an adapter close failure instead of swallowing it', async () => {
  const app = workbench({ db: failingCloseAdapter() });
  await app.ready;
  await assert.rejects(
    () => app.shutdown(),
    /checkpoint failed \(stub\)/,
    'a checkpoint/close failure surfaces to app.shutdown()\'s caller',
  );
});

test('a construction failure closes the adapter the app opened (ownership lock released)', () => {
  const root = tempRoot();
  const dir = path.join(root, 'owned');
  try {
    assert.throws(
      () => workbench({ db: { directory: dir, name: 'app', mode: 'file' }, schema: {} }),
      /schema must be a SqliteSchemaResult/,
    );
    // The failed construction released the OS-backed ownership lock: a fresh
    // adapter can open the same directory.
    const reopened = openSqliteAdapter({ directory: dir, name: 'app' });
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

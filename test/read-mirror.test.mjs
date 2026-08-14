// read-mirror.test.mjs — the controlled read-mirror connection (epic scope#23,
// S1/A5). A read mirror must be read-only at the ENGINE (mode=ro) AND wrapped
// by a query-class rejector that refuses write / DDL / PRAGMA-mutating
// statements with a clear error — belt and suspenders, not merely documented
// rejection. It never exposes a write path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import workbench from '../build/internal.mjs';
import { createSqliteAdapter } from '../build/sqlite-adapter.mjs';
import { openReadMirror, ReadMirrorError } from '../build/index.mjs';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'workbench-read-mirror-'));
}

test('adapter readMirror() returns a pinned read-only description with mode=ro', async () => {
  const dir = tempDir();
  try {
    const adapter = createSqliteAdapter({ directory: dir, name: 'app' });
    const description = adapter.readMirror();
    assert.equal(description.kind, 'read-mirror');
    assert.equal(description.mode, 'read-only');
    assert.equal(description.readOnly, true);
    assert.match(description.connectionString, /\?mode=ro$/);
    assert.match(description.connectionString, /data\.sqlite/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openReadMirror reads the writer\'s committed data from a file adapter', async () => {
  const dir = tempDir();
  try {
    const adapter = createSqliteAdapter({ directory: dir, name: 'app' });
    const opened = await adapter.open();
    opened.handle.exec('CREATE TABLE note (id TEXT PRIMARY KEY, body TEXT)');
    opened.handle.prepare('INSERT INTO note (id, body) VALUES (?, ?)').run('n1', 'committed');

    const mirror = openReadMirror(adapter.readMirror());
    const rows = mirror.prepare('SELECT * FROM note').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].body, 'committed');

    mirror.close();
    opened.close();
    opened.teardown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mode=ro is enforced at the engine even bypassing the rejector', async () => {
  const dir = tempDir();
  try {
    const adapter = createSqliteAdapter({ directory: dir, name: 'app' });
    const opened = await adapter.open();
    opened.handle.exec('CREATE TABLE t (a INTEGER)');
    opened.handle.prepare('INSERT INTO t VALUES (1)').run();

    const mirror = openReadMirror(adapter.readMirror());
    // The rejector-wrapped surface must not leak an unrestricted raw handle.
    assert.equal('raw' in mirror, false, 'the mirror never exposes a raw engine handle');

    // A consumer that bypasses the rejector by opening the description's
    // connectionString directly is still read-only at the ENGINE: the
    // description pins mode=ro, so SQLite itself refuses writes and DDL.
    const bypassed = new DatabaseSync(adapter.readMirror().connectionString);
    assert.throws(
      () => bypassed.prepare('INSERT INTO t VALUES (2)').run(),
      /readonly/i,
      'the pinned mode=ro connection refuses a write at the engine',
    );
    assert.throws(
      () => bypassed.exec('CREATE TABLE x (a)'),
      /readonly/i,
      'the pinned mode=ro connection refuses DDL at the engine',
    );
    bypassed.close();

    mirror.close();
    opened.close();
    opened.teardown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the rejector refuses write, DDL, and PRAGMA-mutating statements', async () => {
  const mirror = openReadMirror({ kind: 'read-mirror', mode: 'read-only', readOnly: true, connectionString: 'file::memory:?mode=ro' });
  try {
    const write = () => mirror.prepare('INSERT INTO t (a) VALUES (1)');
    assert.throws(write, (err) => err instanceof ReadMirrorError && err.kind === 'write');
    assert.throws(() => mirror.exec('UPDATE t SET a = 1'), (err) => err.kind === 'write');
    assert.throws(() => mirror.exec('DELETE FROM t'), (err) => err.kind === 'write');
    assert.throws(() => mirror.exec('REPLACE INTO t VALUES (1)'), (err) => err.kind === 'write');

    assert.throws(() => mirror.exec('CREATE TABLE t (a)'), (err) => err.kind === 'ddl');
    assert.throws(() => mirror.exec('ALTER TABLE t ADD COLUMN b'), (err) => err.kind === 'ddl');
    assert.throws(() => mirror.exec('DROP TABLE t'), (err) => err.kind === 'ddl');

    assert.throws(() => mirror.exec('PRAGMA foreign_keys = OFF'), (err) => err.kind === 'pragma');
    assert.throws(() => mirror.exec('PRAGMA journal_mode = WAL'), (err) => err.kind === 'pragma');
    assert.throws(() => mirror.exec('PRAGMA query_only = ON'), (err) => err.kind === 'pragma');
  } finally {
    mirror.close();
  }
});

test('a write hidden behind a CTE or a trailing statement is still refused', async () => {
  const mirror = openReadMirror({ kind: 'read-mirror', mode: 'read-only', readOnly: true, connectionString: 'file::memory:?mode=ro' });
  try {
    assert.throws(
      () => mirror.exec('WITH c AS (SELECT 1) INSERT INTO t SELECT * FROM c'),
      (err) => err instanceof ReadMirrorError && err.kind === 'write',
      'a WITH-prefixed write must classify as a write, not a read',
    );
    assert.throws(
      () => mirror.exec('SELECT 1; INSERT INTO t VALUES (2)'),
      (err) => err instanceof ReadMirrorError && /one statement/.test(err.message),
      'multi-statement exec is refused wholesale',
    );
  } finally {
    mirror.close();
  }
});

test('read statements pass the rejector, including snapshot transaction control', async () => {
  const mirror = openReadMirror({ kind: 'read-mirror', mode: 'read-only', readOnly: true, connectionString: 'file::memory:?mode=ro' });
  try {
    mirror.exec('BEGIN');
    mirror.exec('COMMIT');
    assert.equal(mirror.prepare('SELECT 42 AS v').get().v, 42);
    assert.equal(mirror.prepare('WITH x AS (SELECT 7 AS v) SELECT v FROM x').get().v, 7);
    assert.equal(mirror.prepare('VALUES (1), (2)').all().length, 2);
    assert.ok(Array.isArray(mirror.prepare('EXPLAIN QUERY PLAN SELECT 1').all()));
    mirror.prepare('PRAGMA table_info(note)').all();
  } finally {
    mirror.close();
  }
});

test('openReadMirror refuses a description that is not pinned read-only', () => {
  assert.throws(
    () => openReadMirror({ kind: 'read-mirror', mode: 'read-write', readOnly: false, connectionString: 'file::memory:' }),
    /read-only/,
  );
  assert.throws(() => openReadMirror({ connectionString: 'file::memory:' }), /description/);
});

test('app.readMirror() exposes the controlled description on adapter-backed apps', async () => {
  const dir = tempDir();
  try {
    const app = workbench({ db: createSqliteAdapter({ directory: dir, name: 'app' }) });
    const description = app.readMirror();
    assert.equal(description.readOnly, true);
    assert.match(description.connectionString, /\?mode=ro$/);
    await app.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('app.readMirror() fails closed on a raw-handle app', () => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db });
  assert.throws(() => app.readMirror(), /adapter-backed database/);
  db.close();
});

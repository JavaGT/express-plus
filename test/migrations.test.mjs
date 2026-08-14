// Priority 4 — migrations (eng-review spec #9, #17, test plan 709-711). Versioned
// schema migrations run at startup, pre-traffic, stop-the-world for writes. The
// migration's DDL + the namespaced ledger-record bump land in ONE transaction; a
// mid-flight crash rolls BOTH back, so on restart the pending migration re-runs
// cleanly (its idempotent ALTER/INDEX is a no-op against the rolled-back state).
// A failed migration (e.g. a unique index on duplicate data) leaves the schema and
// the ledger untouched. Identity is (namespace, version) — S2/A4, workbench#90.

import { text } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import workbench, { entity } from '../build/internal.mjs';
import { runMigrations, ensureMigrationTable, ledgerRows, appliedVersionsByNamespace } from '../build/migrations.mjs';

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, body TEXT)');
  return db;
}

function applied(db, namespace = 'app') {
  return appliedVersionsByNamespace(db).get(namespace) ?? [];
}

test('migrations: fresh db reports no applied versions and creates the namespaced ledger', () => {
  const db = freshDb();
  assert.deepEqual(applied(db), [], 'no versions applied');
  assert.ok(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_SchemaMigration'").get(),
    '_SchemaMigration ledger table created',
  );
  db.close();
});

test('migrations: a migration ALTER lands + bumps the ledger version', () => {
  const db = freshDb();
  runMigrations(db, [
    { namespace: 'app', name: 'done-column', version: 1, up: (d) => d.exec('ALTER TABLE Note ADD COLUMN done INTEGER DEFAULT 0') },
  ]);
  const cols = db.prepare("SELECT name FROM pragma_table_info('Note')").all().map((r) => r.name);
  assert.ok(cols.includes('done'), 'ALTER added the column');
  assert.deepEqual(applied(db), [1]);
  db.close();
});

test('migrations: re-running is idempotent (pending versions skipped)', () => {
  const db = freshDb();
  const m1 = { namespace: 'app', name: 'a', version: 1, up: (d) => d.exec('ALTER TABLE Note ADD COLUMN a TEXT') };
  runMigrations(db, [m1]);
  // Re-running with the SAME immutable migration is a no-op — the version is
  // already applied and its checksum matches, so up() must not run again.
  let calls = 0;
  runMigrations(db, [m1]);
  assert.equal(calls, 0, 'version 1 was skipped on re-run');
  assert.deepEqual(applied(db), [1]);
  // Re-declaring the SAME version with a DIFFERENT body is refused (the
  // already-applied migration's immutable source changed — #90 checksum guard).
  assert.throws(
    () => runMigrations(db, [{ ...m1, up: (d) => { calls += 1; d.exec('ALTER TABLE Note ADD COLUMN a TEXT'); } }]),
    /different checksum/,
  );
  assert.equal(calls, 0, 'the mutated re-declaration never ran');
  db.close();
});

test('migrations: a failed migration rolls back — schema + ledger unchanged, runner throws', () => {
  const db = freshDb();
  db.prepare('INSERT INTO Note (id, body) VALUES (?, ?)').run('1', 'dupe');
  db.prepare('INSERT INTO Note (id, body) VALUES (?, ?)').run('2', 'dupe');
  // First apply a good migration so the ledger has a baseline.
  runMigrations(db, [{ namespace: 'app', name: 'baseline', version: 1, up: (d) => d.exec('ALTER TABLE Note ADD COLUMN x TEXT') }]);
  assert.deepEqual(applied(db), [1]);
  // version 2 fails: a unique index on the duplicated `body` column.
  assert.throws(
    () => runMigrations(db, [
      { namespace: 'app', name: 'unique', version: 2, up: (d) => d.exec('CREATE UNIQUE INDEX idx_note_body ON Note(body)') },
    ]),
    /migration app@2 failed/,
  );
  assert.deepEqual(applied(db), [1], 'ledger version NOT bumped on failure');
  assert.ok(
    !db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_note_body'").get(),
    'failed index was rolled back (not created)',
  );
  db.close();
});

test('migrations: a mid-up failure rolls back the partial DDL (atomicity)', () => {
  const db = freshDb();
  runMigrations(db, [{ namespace: 'app', name: 'baseline', version: 1, up: (d) => d.exec('ALTER TABLE Note ADD COLUMN x TEXT') }]);
  assert.deepEqual(applied(db), [1]);
  // version 2: ALTER succeeds, THEN up throws. Without a transaction the ALTER
  // would persist (autocommit); with the per-migration txn it MUST roll back
  // together with the unwritten ledger bump.
  assert.throws(
    () => runMigrations(db, [
      { namespace: 'app', name: 'boom', version: 2, up: (d) => {
        d.exec('ALTER TABLE Note ADD COLUMN y TEXT');
        throw new Error('boom mid-migration');
      } },
    ]),
    /migration app@2 failed/,
  );
  const cols = db.prepare("SELECT name FROM pragma_table_info('Note')").all().map((r) => r.name);
  assert.ok(!cols.includes('y'), 'partial ALTER was rolled back with the failed migration');
  assert.deepEqual(applied(db), [1], 'ledger version not bumped for the failed migration');
  db.close();
});

test('migrations: run in version order regardless of declaration order', () => {
  const db = freshDb();
  const seq = [];
  runMigrations(db, [
    { namespace: 'app', name: 'v3', version: 3, up: (d) => { seq.push(3); d.exec('CREATE TABLE IF NOT EXISTS T3 (id TEXT PRIMARY KEY)'); } },
    { namespace: 'app', name: 'v1', version: 1, up: (d) => { seq.push(1); d.exec('ALTER TABLE Note ADD COLUMN c1 TEXT'); } },
    { namespace: 'app', name: 'v2', version: 2, up: (d) => { seq.push(2); d.exec('ALTER TABLE Note ADD COLUMN c2 TEXT'); } },
  ]);
  assert.deepEqual(seq, [1, 2, 3]);
  assert.deepEqual(applied(db), [1, 2, 3]);
  db.close();
});

test('migrations: the ledger row records the migration name and a checksum', () => {
  const db = freshDb();
  runMigrations(db, [
    { namespace: 'app', name: 'audited', version: 1, up: (d) => d.exec('ALTER TABLE Note ADD COLUMN x INTEGER') },
  ]);
  const rows = ledgerRows(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'audited');
  assert.match(rows[0].checksum, /^[0-9a-f]{64}$/);
  assert.ok(Number.isInteger(rows[0].version));
  db.close();
});

test('migrations: wired through app.ready at startup (pre-traffic)', async (t) => {
  const db = new DatabaseSync(':memory:');
  const Note = entity('Note', { body: text(), grant: () => [] });
  const app = workbench({
    db,
    migrations: [{ namespace: 'app', name: 'archived', version: 1, up: (d) => d.exec('ALTER TABLE Note ADD COLUMN archived INTEGER DEFAULT 0') }],
  });
  app.mount('/notes', Note).listen(0);
  await app.ready;
  t.after(() => { app.httpServer.close(); db.close(); });

  const cols = db.prepare("SELECT name FROM pragma_table_info('Note')").all().map((r) => r.name);
  assert.ok(cols.includes('archived'), 'app.ready ran the migration after creating the entity table');
  assert.deepEqual(applied(db), [1]);
});

test('migrations: app.ddl compatibility path and app.ready share one schema preparation', async (t) => {
  const db = new DatabaseSync(':memory:');
  const Note = entity('Note', { body: text(), grant: () => [] });
  let calls = 0;
  const app = workbench({
    db,
    migrations: [{
      namespace: 'app',
      name: 'archived',
      version: 1,
      up: (d) => {
        calls += 1;
        d.exec('ALTER TABLE Note ADD COLUMN archived INTEGER DEFAULT 0');
      },
    }],
  });
  app.mount('/notes', Note);
  await app.ddl();
  app.listen(0);
  await app.ready;
  t.after(() => { app.httpServer.close(); db.close(); });

  assert.equal(calls, 1, 'schema preparation is cached across app.ddl() and app.ready');
  assert.deepEqual(applied(db), [1]);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_SchemaMigration'").get());
  void ensureMigrationTable;
});

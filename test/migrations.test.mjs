// Priority 4 — migrations (eng-review spec #9, #17, test plan 709-711). Versioned
// schema migrations run at startup, pre-traffic, stop-the-world for writes. The
// migration's DDL + the meta-version bump land in ONE transaction; a mid-flight
// crash rolls BOTH back, so on restart the pending migration re-runs cleanly
// (its idempotent ALTER/INDEX is a no-op against the rolled-back state). A
// failed migration (e.g. a unique index on duplicate data) leaves the schema and
// the meta-table untouched.

import { text } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import workbench, { entity } from '../build/internal.mjs';
import { runMigrations, appliedVersion, ensureMigrationTable } from '../build/migrations.mjs';

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, body TEXT)');
  return db;
}

test('migrations: fresh db reports version 0 and creates the meta table', () => {
  const db = freshDb();
  assert.equal(appliedVersion(db), 0);
  assert.ok(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_Migration'").get(),
    '_Migration table created',
  );
  db.close();
});

test('migrations: a migration ALTER lands + bumps the meta version', () => {
  const db = freshDb();
  runMigrations(db, [
    { version: 1, up: (d) => d.exec('ALTER TABLE Note ADD COLUMN done INTEGER DEFAULT 0') },
  ]);
  const cols = db.prepare("SELECT name FROM pragma_table_info('Note')").all().map((r) => r.name);
  assert.ok(cols.includes('done'), 'ALTER added the column');
  assert.equal(appliedVersion(db), 1);
  db.close();
});

test('migrations: re-running is idempotent (pending versions skipped)', () => {
  const db = freshDb();
  const m1 = { version: 1, up: (d) => d.exec('ALTER TABLE Note ADD COLUMN a TEXT') };
  runMigrations(db, [m1]);
  // Seed a count; a non-idempotent up() would double-apply. Guard proves skip.
  let calls = 0;
  runMigrations(db, [{ ...m1, up: (d) => { calls += 1; d.exec('ALTER TABLE Note ADD COLUMN a TEXT'); } }]);
  // The second run skips version 1 (already applied) — IF NOT EXISTS-style ALTER would no-op,
  // but a bare ALTER ADD COLUMN would THROW if it ran. It must NOT run.
  assert.equal(calls, 0, 'version 1 was skipped on re-run');
  assert.equal(appliedVersion(db), 1);
  db.close();
});

test('migrations: a failed migration rolls back — schema + meta unchanged, runner throws', () => {
  const db = freshDb();
  db.prepare('INSERT INTO Note (id, body) VALUES (?, ?)').run('1', 'dupe');
  db.prepare('INSERT INTO Note (id, body) VALUES (?, ?)').run('2', 'dupe');
  // First apply a good migration so the meta table has a baseline.
  runMigrations(db, [{ version: 1, up: (d) => d.exec('ALTER TABLE Note ADD COLUMN x TEXT') }]);
  assert.equal(appliedVersion(db), 1);
  // version 2 fails: a unique index on the duplicated `body` column.
  assert.throws(
    () => runMigrations(db, [
      { version: 2, up: (d) => d.exec('CREATE UNIQUE INDEX idx_note_body ON Note(body)') },
    ]),
    /migration 2 failed/,
  );
  assert.equal(appliedVersion(db), 1, 'meta version NOT bumped on failure');
  assert.ok(
    !db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_note_body'").get(),
    'failed index was rolled back (not created)',
  );
  db.close();
});

test('migrations: a mid-up failure rolls back the partial DDL (atomicity)', () => {
  const db = freshDb();
  runMigrations(db, [{ version: 1, up: (d) => d.exec('ALTER TABLE Note ADD COLUMN x TEXT') }]);
  assert.equal(appliedVersion(db), 1);
  // version 2: ALTER succeeds, THEN up throws. Without a transaction the ALTER
  // would persist (autocommit); with the per-migration txn it MUST roll back
  // together with the unwritten meta bump.
  assert.throws(
    () => runMigrations(db, [
      { version: 2, up: (d) => {
        d.exec('ALTER TABLE Note ADD COLUMN y TEXT');
        throw new Error('boom mid-migration');
      } },
    ]),
    /migration 2 failed/,
  );
  const cols = db.prepare("SELECT name FROM pragma_table_info('Note')").all().map((r) => r.name);
  assert.ok(!cols.includes('y'), 'partial ALTER was rolled back with the failed migration');
  assert.equal(appliedVersion(db), 1, 'meta version not bumped for the failed migration');
  db.close();
});

test('migrations: run in version order regardless of declaration order', () => {
  const db = freshDb();
  const seq = [];
  runMigrations(db, [
    { version: 3, up: () => { seq.push(3); } },
    { version: 1, up: (d) => { seq.push(1); d.exec('ALTER TABLE Note ADD COLUMN c1 TEXT'); } },
    { version: 2, up: (d) => { seq.push(2); d.exec('ALTER TABLE Note ADD COLUMN c2 TEXT'); } },
  ]);
  assert.deepEqual(seq, [1, 2, 3]);
  assert.equal(appliedVersion(db), 3);
  db.close();
});

test('migrations: wired through app.ready at startup (pre-traffic)', async (t) => {
  const db = new DatabaseSync(':memory:');
  const Note = entity('Note', { body: text(), grant: () => [] });
  const app = workbench({
    db,
    migrations: [{ version: 1, up: (d) => d.exec('ALTER TABLE Note ADD COLUMN archived INTEGER DEFAULT 0') }],
  });
  app.mount('/notes', Note).listen(0);
  await app.ready;
  t.after(() => { app.httpServer.close(); db.close(); });

  const cols = db.prepare("SELECT name FROM pragma_table_info('Note')").all().map((r) => r.name);
  assert.ok(cols.includes('archived'), 'app.ready ran the migration after creating the entity table');
  assert.equal(appliedVersion(db), 1);
});

test('migrations: app.ddl compatibility path and app.ready share one schema preparation', async (t) => {
  const db = new DatabaseSync(':memory:');
  const Note = entity('Note', { body: text(), grant: () => [] });
  let calls = 0;
  const app = workbench({
    db,
    migrations: [{
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
  assert.equal(appliedVersion(db), 1);
});

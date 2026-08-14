import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import workbench from '../build/internal.mjs';
import { defineSqliteSchema } from '../build/server.mjs';

function schema() {
  return defineSqliteSchema({
    name: 'lifecycle-test',
    tables: [{
      name: 'Task',
      columns: [{ name: 'id', type: 'text', primaryKey: true }, { name: 'title', type: 'text', notNull: true }],
      indexes: [{ name: 'idx_task_title', columns: ['title'] }],
      triggers: [{ name: 'task_audit', timing: 'after', event: 'insert', body: 'SELECT 1;' }],
    }],
  });
}

test('schema lifecycle creates a complete machine-readable census and is idempotent on reboot', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const app = workbench({ db, schema: schema() });
    await app.prepareSchema();
    const first = app.schemaReport();
    assert.ok(first);
    assert.equal(first.objects.find((entry) => entry.name === 'Task')?.state, 'present');
    assert.equal(first.objects.find((entry) => entry.name === 'idx_task_title')?.lifecyclePhase, 'indexes-and-constraints');
    assert.equal(first.objects.find((entry) => entry.name === 'task_audit')?.state, 'present');

    const triggerSql = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = 'task_audit'").get().sql;
    await app.prepareSchema();
    assert.equal(db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = 'task_audit'").get().sql, triggerSql);
    assert.deepEqual(app.schemaReport().ledger, first.ledger);
  } finally {
    db.close();
  }
});

test('a failed lifecycle migration leaves its table and ledger record absent', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const app = workbench({ db, migrations: [{
      namespace: 'lifecycle-test', name: 'fails', version: 1,
      up(inner) { inner.exec('CREATE TABLE migration_should_roll_back (id TEXT)'); throw new Error('stop'); },
    }] });
    await assert.rejects(app.prepareSchema(), /migration lifecycle-test@1 failed: stop/);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'migration_should_roll_back'").get(), undefined);
    assert.equal(db.prepare("SELECT 1 FROM _SchemaMigration WHERE namespace = 'lifecycle-test' AND version = 1").get(), undefined);
  } finally {
    db.close();
  }
});

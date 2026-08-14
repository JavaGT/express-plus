import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

test('frameworkCursorSchema declares _ProjectedCursor and _ConsumerCursor via defineSqliteSchema', async () => {
  const { frameworkCursorSchema } = await import('../build/ddl.mjs');
  const schema = frameworkCursorSchema();

  assert.equal(typeof schema, 'object');
  assert.equal(schema.name, 'framework-cursors');
  assert.ok(Array.isArray(schema.ddl));
  assert.ok(schema.ddl.length >= 2);

  const allSql = schema.ddl.join('\n');
  assert.ok(allSql.includes('_ProjectedCursor'), 'includes ProjectedCursor table');
  assert.ok(allSql.includes('_ConsumerCursor'), 'includes ConsumerCursor table');

  // DDL is valid SQLite — can execute against an in-memory db
  const db = new DatabaseSync(':memory:');
  try {
    schema.prepare(db);

    // Both tables exist and accept rows
    db.prepare(
      'INSERT INTO _ProjectedCursor (entity, field, lastSeq) VALUES (?, ?, ?)',
    ).run('Post', 'hotRank', 0);

    db.prepare(
      'INSERT INTO _ConsumerCursor (consumer, scope, lastSeq) VALUES (?, ?, ?)',
    ).run('projected.async', 'Post:p1', 0);

    const pcRow = db.prepare(
      "SELECT entity, field, lastSeq FROM _ProjectedCursor WHERE entity = 'Post'",
    ).get();
    assert.equal(pcRow.entity, 'Post');
    assert.equal(pcRow.field, 'hotRank');
    assert.equal(pcRow.lastSeq, 0);

    const ccRow = db.prepare(
      "SELECT consumer, scope, lastSeq FROM _ConsumerCursor WHERE consumer = 'projected.async'",
    ).get();
    assert.equal(ccRow.consumer, 'projected.async');
    assert.equal(ccRow.scope, 'Post:p1');
    assert.equal(ccRow.lastSeq, 0);
  } finally {
    db.close();
  }
});

test('generateFrameworkDDL still includes cursor tables (backwards compatible)', async () => {
  const { generateFrameworkDDL } = await import('../build/ddl.mjs');
  const frameworkDdl = generateFrameworkDDL();
  const joined = frameworkDdl.join('\n');

  assert.ok(joined.includes('_ProjectedCursor'), 'generateFrameworkDDL includes ProjectedCursor');
  assert.ok(joined.includes('_ConsumerCursor'), 'generateFrameworkDDL includes ConsumerCursor');

  // Cursor tables appear EXACTLY ONCE (no dupes from both hand-written and schema)
  const pcCount = joined.split('_ProjectedCursor').length - 1;
  assert.equal(pcCount, 1, '_ProjectedCursor must appear exactly once in generateFrameworkDDL');
});

test('the 5 package migrations run under the reserved workbench namespace on a fresh DB (S2/A4 re-home)', async () => {
  const { runWorkbenchMigrations, appliedWorkbenchVersion, WORKBENCH_SUPPLIED_BY } = await import('../build/workbench-migrations.mjs');
  const { ledgerRows, MIGRATION_LEDGER_TABLE } = await import('../build/migrations.mjs');
  const db = new DatabaseSync(':memory:');
  try {
    runWorkbenchMigrations(db);
    assert.equal(appliedWorkbenchVersion(db), 5);

    const rows = ledgerRows(db);
    assert.equal(rows.length, 5, 'all five package migrations recorded');
    assert.ok(rows.every((row) => row.namespace === 'workbench'), 'every package migration lives in the workbench namespace');
    assert.deepEqual(
      rows.map((row) => row.version).sort((a, b) => a - b),
      [1, 2, 3, 4, 5],
    );
    assert.ok(rows.every((row) => row.name.length > 0), 'every package migration records a name');
    assert.ok(rows.every((row) => /^[0-9a-f]{64}$/.test(row.checksum)), 'every package migration records a checksum');
    assert.ok(rows.every((row) => row.suppliedBy === WORKBENCH_SUPPLIED_BY), 'the package lane records its suppliedBy');

    // Re-running is a no-op (idempotent) and the reserved namespace is the only
    // lane the package owns — no other namespace was touched.
    runWorkbenchMigrations(db);
    assert.equal(appliedWorkbenchVersion(db), 5);
    assert.equal(db.prepare(`SELECT COUNT(*) AS c FROM ${MIGRATION_LEDGER_TABLE}`).get().c, 5);

    // The framework census derives the single namespaced ledger table.
    const { frameworkTableNames } = await import('../build/schema-table-census.mjs');
    assert.ok(
      frameworkTableNames.includes('_SchemaMigration'),
      'the namespaced ledger table is a framework-owned table',
    );
    assert.ok(!frameworkTableNames.includes('_Migration'), 'the legacy app ledger table is gone from the census');
    assert.ok(!frameworkTableNames.includes('_WorkbenchMigration'), 'the legacy workbench ledger table is gone from the census');
  } finally {
    db.close();
  }
});

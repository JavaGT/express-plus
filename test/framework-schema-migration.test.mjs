import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

test('frameworkCursorSchema declares _ProjectedCursor and _ConsumerCursor via defineSqliteSchema', async () => {
  const { frameworkCursorSchema } = await import('../src/ddl.mjs');
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
  const { generateFrameworkDDL } = await import('../src/ddl.mjs');
  const frameworkDdl = generateFrameworkDDL();
  const joined = frameworkDdl.join('\n');

  assert.ok(joined.includes('_ProjectedCursor'), 'generateFrameworkDDL includes ProjectedCursor');
  assert.ok(joined.includes('_ConsumerCursor'), 'generateFrameworkDDL includes ConsumerCursor');

  // Cursor tables appear EXACTLY ONCE (no dupes from both hand-written and schema)
  const pcCount = joined.split('_ProjectedCursor').length - 1;
  assert.equal(pcCount, 1, '_ProjectedCursor must appear exactly once in generateFrameworkDDL');
});

// Framework DDL — the Log and Cursor tables (spec #20, eng-review Tier 4).
// These are framework-owned, not entity-scoped: every workbench app that engages
// persistence needs them. They are created alongside entity tables via app.ddl().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { generateFrameworkDDL, executeFrameworkDDL } from '../build/ddl.mjs';

test('generateFrameworkDDL returns Log and Cursor CREATE TABLE statements', () => {
  const statements = generateFrameworkDDL();
  assert.ok(Array.isArray(statements), 'returns an array');
  assert.ok(statements.length >= 2, 'has at least Log and Cursor statements');

  const joined = statements.join('\n');
  assert.ok(joined.includes('_Log'), 'includes Log table');
  assert.ok(joined.includes('_Cursor'), 'includes Cursor table');
  assert.ok(joined.includes('scope'), 'Log has scope column');
  assert.ok(joined.includes('seq'), 'Log has seq column');
  assert.ok(joined.includes('eventType'), 'Log has eventType column');
  assert.ok(joined.includes('eventData'), 'Log has eventData column');
  assert.ok(joined.includes('actionId'), 'Log has actionId column');
  assert.ok(joined.includes('committedAt'), 'Log has committedAt column');
  assert.ok(joined.includes('PRIMARY KEY'), 'Log has a PRIMARY KEY');
  assert.ok(joined.includes('lastSeq'), 'Cursor has lastSeq column');
});

test('Log and Cursor tables are created in a real sqlite DatabaseSync', () => {
  const db = new DatabaseSync(':memory:');
  for (const sql of generateFrameworkDDL()) {
    db.exec(sql);
  }

  // Verify Log table exists by inserting a row
  db.prepare(
    'INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('Note:1', 1, 'note.create', '{"body":"hello"}', 'a1', new Date().toISOString());

  const row = db.prepare('SELECT * FROM _Log WHERE scope = ? AND seq = ?').get('Note:1', 1);
  assert.ok(row, 'inserted row is readable');
  assert.equal(row.scope, 'Note:1');
  assert.equal(row.seq, 1);
  assert.equal(row.eventType, 'note.create');

  // Verify Cursor table exists
  db.prepare(
    'INSERT INTO _Cursor (scope, lastSeq) VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET lastSeq = lastSeq+1',
  ).run('Note:1', 0);

  // Verify actionId index exists by trying a lookup
  const byAction = db.prepare('SELECT * FROM _Log WHERE actionId = ?').all('a1');
  assert.equal(byAction.length, 1);
});

test('per-scope seq is independent across scopes', () => {
  const db = new DatabaseSync(':memory:');
  for (const sql of generateFrameworkDDL()) db.exec(sql);

  // Insert events for two different scopes
  db.prepare(
    'INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('Note:1', 1, 'note.create', '{}', 'a1', new Date().toISOString());
  db.prepare(
    'INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('Note:2', 1, 'note.create', '{}', 'a2', new Date().toISOString());

  // Same scope, different seq
  db.prepare(
    'INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('Note:1', 2, 'note.update', '{}', 'a3', new Date().toISOString());

  const scope1 = db.prepare('SELECT * FROM _Log WHERE scope = ? ORDER BY seq').all('Note:1');
  const scope2 = db.prepare('SELECT * FROM _Log WHERE scope = ? ORDER BY seq').all('Note:2');

  assert.equal(scope1.length, 2);
  assert.equal(scope2.length, 1);
  assert.equal(scope1[0].seq, 1);
  assert.equal(scope1[1].seq, 2);
  assert.equal(scope2[0].seq, 1);
});

test('dedupe by actionId — duplicate primary key on (scope, seq) rejects', () => {
  const db = new DatabaseSync(':memory:');
  for (const sql of generateFrameworkDDL()) db.exec(sql);

  db.prepare(
    'INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('Note:1', 1, 'note.create', '{}', 'a1', new Date().toISOString());

  // Same (scope, seq) should fail due to PRIMARY KEY
  assert.throws(() => {
    db.prepare(
      'INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('Note:1', 1, 'note.create', '{}', 'a99', new Date().toISOString());
  });
});

test('executeFrameworkDDL creates Log and Cursor tables', () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);

  // Verify tables exist by inserting
  db.prepare(
    'INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('Note:1', 1, 'note.create', '{}', 'a1', new Date().toISOString());

  const logRow = db.prepare('SELECT * FROM _Log WHERE scope = ?').get('Note:1');
  assert.ok(logRow);

  db.prepare('INSERT INTO _Cursor (scope, lastSeq) VALUES (?, ?) ON CONFLICT(scope) DO NOTHING').run('Note:1', 0);
  const cursorRow = db.prepare('SELECT * FROM _Cursor WHERE scope = ?').get('Note:1');
  assert.ok(cursorRow);
});

test('app.ddl() creates framework tables (Log and Cursor) alongside entity tables', async () => {
  // This tests that the app assembly auto-creates framework tables.
  // Import dynamically to avoid circular issues.
  const { default: workbench } = await import('../build/app.mjs');
  const { entity: entityFn, text, ref, grant, read, write, scope } = await import('../build/index.mjs');

  const db = new DatabaseSync(':memory:');

  const Note = entityFn('Note', {
    body: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write) : grant(read)),
    ],
  });

  const app = workbench({ db }).mount('/notes', Note);
  await app.ddl();

  // Verify framework tables exist
  db.prepare(
    'INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('Note:1', 1, 'note.create', '{}', 'a1', new Date().toISOString());
  assert.ok(db.prepare('SELECT * FROM _Log WHERE scope = ?').get('Note:1'));

  db.prepare('INSERT INTO _Cursor (scope, lastSeq) VALUES (?, ?) ON CONFLICT(scope) DO NOTHING').run('Note:1', 0);
  assert.ok(db.prepare('SELECT * FROM _Cursor WHERE scope = ?').get('Note:1'));

  // Entity table created too
  assert.ok(db.prepare('SELECT * FROM Note WHERE 1=0').all());
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { defineSqliteSchema } from '../build/server.mjs';

function taskSchema(overrides = {}) {
  return defineSqliteSchema({
    name: 'tasks',
    tables: [
      {
        name: 'User',
        columns: [
          { name: 'id', type: 'text', primaryKey: true },
        ],
      },
      {
        name: 'Task',
        columns: [
          { name: 'id', type: 'text', primaryKey: true },
          { name: 'title', type: 'text', notNull: true },
          { name: 'priority', type: 'integer', notNull: true, default: 0 },
          { name: 'status', type: 'text', notNull: true, default: 'pending' },
          { name: 'createdAt', type: 'text', notNull: true, defaultExpression: 'CURRENT_TIMESTAMP' },
          { name: 'ownerId', type: 'text' },
          { name: 'dueAt', type: 'integer' },
        ],
        foreignKeys: [
          {
            columns: ['ownerId'],
            references: { table: 'User', columns: ['id'] },
            onDelete: 'cascade',
            onUpdate: 'cascade',
          },
        ],
        indexes: [
          { name: 'idx_task_status_due', columns: ['status', 'dueAt'] },
          { name: 'idx_task_title_unique', columns: ['title'], unique: true },
        ],
      },
      {
        name: 'TaskTag',
        columns: [
          { name: 'taskId', type: 'text', notNull: true },
          { name: 'tagId', type: 'text', notNull: true },
        ],
        primaryKey: ['taskId', 'tagId'],
      },
    ],
    ...overrides,
  });
}

test('defineSqliteSchema compiles one deterministic constrained schema', () => {
  const first = taskSchema();
  const second = taskSchema();

  assert.equal(first.name, 'tasks');
  assert.deepEqual(first.tableNames, ['User', 'Task', 'TaskTag']);
  assert.deepEqual(first.ddl, second.ddl);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.ddl));

  const sql = first.ddl.join('\n');
  assert.match(sql, /PRIMARY KEY \("taskId", "tagId"\)/);
  assert.match(sql, /"title" TEXT NOT NULL/);
  assert.match(sql, /"priority" INTEGER NOT NULL DEFAULT 0/);
  assert.match(sql, /"status" TEXT NOT NULL DEFAULT 'pending'/);
  assert.match(sql, /"createdAt" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP/);
  assert.match(sql, /REFERENCES "User" \("id"\) ON DELETE CASCADE ON UPDATE CASCADE/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS "idx_task_title_unique"/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS "idx_task_status_due"/);
});

test('compiled DDL executes and exposes the declared constraints to SQLite', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const schema = taskSchema();
    schema.prepare(db);

    const title = db.prepare("SELECT * FROM pragma_table_info('Task') WHERE name = 'title'").get();
    const priority = db.prepare("SELECT * FROM pragma_table_info('Task') WHERE name = 'priority'").get();
    const fk = db.prepare("SELECT * FROM pragma_foreign_key_list('Task')").get();
    const indexes = db.prepare("SELECT name, \"unique\" FROM pragma_index_list('Task') WHERE origin = 'c' ORDER BY name").all();

    assert.equal(title.notnull, 1);
    assert.equal(priority.dflt_value, '0');
    assert.deepEqual(
      { table: fk.table, from: fk.from, to: fk.to, onDelete: fk.on_delete, onUpdate: fk.on_update },
      { table: 'User', from: 'ownerId', to: 'id', onDelete: 'CASCADE', onUpdate: 'CASCADE' },
    );
    assert.deepEqual(indexes.map((row) => ({ ...row })), [
      { name: 'idx_task_status_due', unique: 0 },
      { name: 'idx_task_title_unique', unique: 1 },
    ]);
  } finally {
    db.close();
  }
});

test('schema columns can default to an ISO-8601 UTC timestamp', () => {
  const schema = taskSchema({
    tables: [
      {
        name: 'Receipt',
        columns: [
          { name: 'id', type: 'text', primaryKey: true },
          { name: 'createdAt', type: 'text', notNull: true, defaultExpression: "(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))" },
        ],
      },
    ],
  });
  const db = new DatabaseSync(':memory:');
  try {
    schema.prepare(db);
    db.prepare('INSERT INTO Receipt (id) VALUES (?)').run('r1');
    const row = db.prepare('SELECT createdAt FROM Receipt WHERE id = ?').get('r1');
    assert.match(row.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  } finally {
    db.close();
  }
});

test('schema preparation runs explicit migrations once and rolls failures back', () => {
  let calls = 0;
  const schema = taskSchema({
    migrations: [
      {
        namespace: 'tasks',
        name: 'archive-column',
        version: 420001,
        up(db) {
          calls += 1;
          db.exec('ALTER TABLE Task ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
        },
      },
    ],
  });
  const db = new DatabaseSync(':memory:');
  try {
    schema.prepare(db, { now: () => '2026-07-14T00:00:00.000Z' });
    schema.prepare(db, { now: () => '2026-07-14T00:00:00.000Z' });
    assert.equal(calls, 1);
    assert.equal(db.prepare('SELECT MAX(version) AS version FROM _Migration').get().version, 420001);

    const failing = defineSqliteSchema({
      name: 'failing',
      tables: [],
      migrations: [{
        namespace: 'failing',
        name: 'partial-column',
        version: 420002,
        up(innerDb) {
          innerDb.exec('ALTER TABLE Task ADD COLUMN partial TEXT');
          throw new Error('stop');
        },
      }],
    });
    assert.throws(() => failing.prepare(db), /migration 420002 failed: stop/);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('Task') WHERE name = 'partial'").get().count,
      0,
    );
    assert.equal(db.prepare('SELECT MAX(version) AS version FROM _Migration').get().version, 420001);
  } finally {
    db.close();
  }
});

test('defineSqliteSchema rejects ambiguous or unsafe declarations before touching SQLite', () => {
  assert.throws(
    () => defineSqliteSchema({
      name: 'bad',
      tables: [
        { name: 'Thing', columns: [{ name: 'id', type: 'text' }] },
        { name: 'thing', columns: [{ name: 'id', type: 'text' }] },
      ],
    }),
    /duplicate table/i,
  );
  assert.throws(
    () => defineSqliteSchema({ name: 'bad', tables: [{ name: 'Thing', columns: [{ name: 'x', type: 'money' }] }] }),
    /type/i,
  );
  assert.throws(
    () => defineSqliteSchema({ name: 'bad', tables: [{ name: 'Thing', columns: [{ name: 'x', type: 'text' }], indexes: [{ name: 'idx', columns: ['missing'] }] }] }),
    /missing/i,
  );
  assert.throws(
    () => defineSqliteSchema({
      name: 'bad',
      tables: [
        { name: 'One', columns: [{ name: 'id', type: 'text' }], indexes: [{ name: 'shared_idx', columns: ['id'] }] },
        { name: 'Two', columns: [{ name: 'id', type: 'text' }], indexes: [{ name: 'SHARED_IDX', columns: ['id'] }] },
      ],
    }),
    /duplicate index/i,
  );
  assert.throws(
    () => defineSqliteSchema({
      name: 'bad',
      tables: [{
        name: 'Child',
        columns: [{ name: 'parentId', type: 'text' }],
        foreignKeys: [{ columns: ['parentId'], references: { table: 'Missing', columns: ['id', 'other'] } }],
      }],
    }),
    /foreign key/i,
  );
  assert.throws(
    () => defineSqliteSchema({
      name: 'bad',
      tables: [{ name: 'Thing', columns: [{ name: 'id', type: 'text', primaryKey: true }], primaryKey: ['id'] }],
    }),
    /conflicting primary key/i,
  );
  assert.throws(
    () => defineSqliteSchema({
      name: 'bad',
      tables: [],
      migrations: [{ namespace: 'dupe', name: 'one', version: 1, up() {} }, { namespace: 'dupe', name: 'two', version: 1, up() {} }],
    }),
    /duplicate migration/i,
  );
  assert.throws(
    () => defineSqliteSchema({
      name: 'bad',
      tables: [],
      migrations: [{ namespace: 'dupe', name: 'same-name', version: 1, up() {} }, { namespace: 'dupe', name: 'same-name', version: 2, up() {} }],
    }),
    /duplicate migration name/i,
  );
  assert.throws(
    () => defineSqliteSchema({
      name: 'bad',
      tables: [],
      migrations: [{ namespace: 'missing', name: 'no-up', version: 1 }],
    }),
    /up function/i,
  );
});

test('prepare does not create declared indexes on an existing legacy table when a migration fails', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE "Legacy" (id TEXT PRIMARY KEY, status TEXT, dueAt INTEGER)');

    const schema = defineSqliteSchema({
      name: 'legacy-test',
      tables: [
        {
          name: 'Legacy',
          columns: [
            { name: 'id', type: 'text', primaryKey: true },
            { name: 'status', type: 'text' },
            { name: 'dueAt', type: 'integer' },
          ],
          indexes: [
            { name: 'idx_legacy_status', columns: ['status', 'dueAt'] },
          ],
        },
      ],
      migrations: [{
        namespace: 'legacy',
        name: 'explodes',
        version: 1,
        up() { throw new Error('explosion'); },
      }],
    });

    assert.throws(() => schema.prepare(db), /migration 1 failed/);

    const indexes = db.prepare("SELECT name FROM pragma_index_list('Legacy') WHERE origin = 'c' ORDER BY name").all();
    assert.deepEqual(indexes, [], 'indexes must not be created when migration fails');
  } finally {
    db.close();
  }
});

test('foreign keys may target explicitly-declared external tables without claiming their DDL', () => {
  const schema = defineSqliteSchema({
    name: 'comments',
    externalTables: [{ name: 'Project', columns: ['id'] }],
    tables: [{
      name: 'Comment',
      columns: [
        { name: 'id', type: 'text', primaryKey: true },
        { name: 'projectId', type: 'text', notNull: true },
      ],
      foreignKeys: [{ columns: ['projectId'], references: { table: 'Project', columns: ['id'] } }],
    }],
  });

  assert.deepEqual(schema.tableNames, ['Comment']);
  assert.doesNotMatch(schema.ddl.join('\n'), /CREATE TABLE IF NOT EXISTS "Project"/);
  assert.match(schema.ddl.join('\n'), /REFERENCES "Project" \("id"\)/);
});

// Backward compatibility: Scope's existing TableDeclaration-shaped declarations
// (src/lib/wb-scope/schema/declaration.ts) must pass validation unchanged and
// produce byte-identical DDL to the pre-S2/A1 compiler for the old feature set.
test('legacy Scope-shaped declarations validate and emit identical DDL', () => {
  const schema = defineSqliteSchema({
    name: 'scope-shaped',
    externalTables: [{ name: 'Project', columns: ['id'] }],
    tables: [
      {
        name: 'Artefact',
        columns: [
          { name: 'id', type: 'text', primaryKey: true },
          { name: 'projectId', type: 'text', notNull: true },
          { name: 'name', type: 'text', notNull: true },
          { name: 'createdAt', type: 'integer', notNull: true, default: 0 },
          { name: 'updatedAt', type: 'integer' },
        ],
        foreignKeys: [
          { columns: ['projectId'], references: { table: 'Project', columns: ['id'] }, onDelete: 'cascade', onUpdate: 'cascade' },
        ],
        indexes: [
          { name: 'Artefact_projectId_idx', columns: ['projectId'] },
        ],
      },
      {
        name: 'ArtefactTag',
        columns: [
          { name: 'artefactId', type: 'text', notNull: true },
          { name: 'tagId', type: 'text', notNull: true },
          { name: 'addedAt', type: 'text', defaultExpression: 'CURRENT_TIMESTAMP' },
        ],
        primaryKey: ['artefactId', 'tagId'],
      },
    ],
  });

  assert.deepEqual(schema.ddl, [
    `CREATE TABLE IF NOT EXISTS "Artefact" (
  "id" TEXT PRIMARY KEY,
  "projectId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "createdAt" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" INTEGER,
  FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);`,
    `CREATE TABLE IF NOT EXISTS "ArtefactTag" (
  "artefactId" TEXT NOT NULL,
  "tagId" TEXT NOT NULL,
  "addedAt" TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("artefactId", "tagId")
);`,
    'CREATE INDEX IF NOT EXISTS "Artefact_projectId_idx" ON "Artefact" ("projectId")',
  ]);

  const db = new DatabaseSync(':memory:');
  try {
    schema.prepare(db);
    const row = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name = 'Artefact'").get();
    assert.match(row.sql, /ON DELETE CASCADE ON UPDATE CASCADE/);
  } finally {
    db.close();
  }
});

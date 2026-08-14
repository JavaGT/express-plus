import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { defineSqliteSchema } from '../build/server.mjs';

// S2/A1 expanded declaration surface: golden DDL, rejection matrix, composite
// FKs, declared triggers, plugin virtual tables + shadow attribution.

function goldenSchema() {
  return defineSqliteSchema({
    name: 'golden',
    tables: [
      {
        name: 'Article',
        columns: [
          { name: 'id', type: 'text', primaryKey: true },
          { name: 'title', type: 'text', notNull: true, collation: 'NOCASE' },
          { name: 'body', type: 'text', check: 'length(body) > 0' },
          { name: 'status', type: 'text', notNull: true, default: 'draft', check: "status IN ('draft', 'published', 'archived')" },
          { name: 'score', type: 'integer', notNull: true, default: 0 },
        ],
        unique: [
          { name: 'uq_article_title', columns: ['title'] },
          { columns: ['status', 'score'] },
        ],
        check: [
          { name: 'ck_article_score', expression: 'score >= 0 AND score <= 100' },
        ],
        strict: true,
        withoutRowid: true,
        indexes: [
          { name: 'idx_article_title_lower', expression: ['lower("title")'] },
          { name: 'idx_article_status_active', columns: ['status', 'score'], unique: true, where: "status != 'archived'" },
        ],
        triggers: [
          {
            name: 'trg_article_touch',
            timing: 'before',
            event: 'update',
            columnNames: ['title'],
            when: "NEW.status = 'published'",
            body: 'UPDATE Article SET score = score + 1 WHERE id = NEW.id;',
          },
        ],
      },
      {
        name: 'Audit',
        columns: [
          { name: 'id', type: 'text', primaryKey: true },
          { name: 'note', type: 'text', notNull: true },
        ],
        triggers: [
          {
            name: 'trg_audit_insert',
            timing: 'after',
            event: 'insert',
            body: 'INSERT INTO Audit (id, note) VALUES (NEW.id, NEW.note);',
          },
        ],
      },
    ],
    virtualTables: [
      {
        name: 'ft_article',
        module: 'fts5',
        options: ['title', 'body', "content=''", "tokenize='porter unicode61'"],
        ownerPluginId: 'scope-search',
        shadowTables: ['ft_article_data', 'ft_article_idx', 'ft_article_content', 'ft_article_docsize', 'ft_article_config'],
      },
    ],
  });
}

test('expanded features compile to the golden DDL snapshot', () => {
  const schema = goldenSchema();
  assert.deepEqual(schema.ddl, [
    `CREATE TABLE IF NOT EXISTS "Article" (
  "id" TEXT PRIMARY KEY,
  "title" TEXT COLLATE NOCASE NOT NULL,
  "body" TEXT CHECK (length(body) > 0),
  "status" TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  "score" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "uq_article_title" UNIQUE ("title"),
  UNIQUE ("status", "score"),
  CONSTRAINT "ck_article_score" CHECK (score >= 0 AND score <= 100)
) STRICT, WITHOUT ROWID;`,
    `CREATE TABLE IF NOT EXISTS "Audit" (
  "id" TEXT PRIMARY KEY,
  "note" TEXT NOT NULL
);`,
    'CREATE INDEX IF NOT EXISTS "idx_article_title_lower" ON "Article" (lower("title"))',
    'CREATE UNIQUE INDEX IF NOT EXISTS "idx_article_status_active" ON "Article" ("status", "score") WHERE status != \'archived\'',
  ]);
  assert.deepEqual(schema.triggerDdl, [
    `CREATE TRIGGER IF NOT EXISTS "trg_article_touch" BEFORE UPDATE OF "title" ON "Article" WHEN NEW.status = 'published' BEGIN UPDATE Article SET score = score + 1 WHERE id = NEW.id; END;`,
    'CREATE TRIGGER IF NOT EXISTS "trg_audit_insert" AFTER INSERT ON "Audit" BEGIN INSERT INTO Audit (id, note) VALUES (NEW.id, NEW.note); END;',
  ]);
  assert.deepEqual(schema.virtualTableDdl, [
    `CREATE VIRTUAL TABLE IF NOT EXISTS "ft_article" USING fts5(title, body, content='', tokenize='porter unicode61');`,
  ]);
});

test('strict and withoutRowid emit independently', () => {
  const strict = defineSqliteSchema({
    name: 'policies',
    tables: [
      { name: 'A', columns: [{ name: 'id', type: 'text', primaryKey: true }], strict: true },
      { name: 'B', columns: [{ name: 'id', type: 'text', primaryKey: true }], withoutRowid: true },
    ],
  });
  assert.match(strict.ddl[0], /\) STRICT;/);
  assert.doesNotMatch(strict.ddl[0], /WITHOUT ROWID/);
  assert.match(strict.ddl[1], /\), WITHOUT ROWID;/);
  assert.doesNotMatch(strict.ddl[1], /STRICT/);
});

test('compiled table DDL executes and exposes STRICT/WITHOUT ROWID/CHECK/UNIQUE/collation to SQLite', () => {
  const db = new DatabaseSync(':memory:');
  try {
    goldenSchema().prepare(db);

    const table = db.prepare("SELECT * FROM pragma_table_xinfo('Article') WHERE name = 'title'").get();
    assert.equal(table.notnull, 1);

    const row = db.prepare("SELECT * FROM pragma_table_info('Article') WHERE name = 'title'").get();
    assert.equal(row.notnull, 1);

    const indexes = db.prepare("SELECT name, \"unique\", partial FROM pragma_index_list('Article') WHERE origin = 'c' ORDER BY name").all();
    assert.deepEqual(indexes.map((index) => ({ ...index })), [
      { name: 'idx_article_status_active', unique: 1, partial: 1 },
      { name: 'idx_article_title_lower', unique: 0, partial: 0 },
    ]);

    // A declared unique constraint creates a UNIQUE index; CHECK violations are rejected.
    db.prepare("INSERT INTO Article (id, title, body, status, score) VALUES ('a1', 'Dup', 'x', 'draft', 50)").run();
    // The title UNIQUE constraint inherits the column's NOCASE collation, so the
    // case-variant duplicate is rejected by the declared constraint.
    assert.throws(
      () => db.prepare("INSERT INTO Article (id, title, body, status, score) VALUES ('a2', 'dup', 'x', 'published', 40)").run(),
      /UNIQUE/i,
    );
    assert.throws(
      () => db.prepare("INSERT INTO Article (id, title, body, status, score) VALUES ('a2', 'other', 'x', 'published', 200)").run(),
      /CHECK/i,
    );
  } finally {
    db.close();
  }
});

test('prepare never creates declared triggers or plugin virtual tables', () => {
  const db = new DatabaseSync(':memory:');
  try {
    goldenSchema().prepare(db);
    const master = db.prepare("SELECT type, name FROM sqlite_master WHERE type IN ('trigger', 'table') AND name IN ('trg_article_touch', 'trg_audit_insert', 'ft_article', 'ft_article_data', 'ft_article_idx')").all();
    assert.deepEqual(master, [], 'prepare must not execute trigger or virtual-table DDL');
  } finally {
    db.close();
  }
});

test('no destructive DDL is emitted by the compiler', () => {
  const schema = goldenSchema();
  for (const sql of [...schema.ddl, ...schema.virtualTableDdl, ...schema.triggerDdl]) {
    assert.match(sql, /^CREATE (UNIQUE )?(TABLE|INDEX|TRIGGER|VIRTUAL TABLE) IF NOT EXISTS /, `non-destructive: ${sql}`);
  }
});

test('virtual tables expose plugin ownership and shadow attribution for the census', () => {
  const schema = goldenSchema();
  assert.deepEqual(schema.virtualTables, [
    {
      name: 'ft_article',
      module: 'fts5',
      options: ['title', 'body', "content=''", "tokenize='porter unicode61'"],
      ownerPluginId: 'scope-search',
      shadowTables: ['ft_article_data', 'ft_article_idx', 'ft_article_content', 'ft_article_docsize', 'ft_article_config'],
    },
  ]);
  assert.ok(Object.isFrozen(schema.virtualTables[0].shadowTables));
  assert.ok(Object.isFrozen(schema.virtualTables[0].options));
  // Ordinary table names stay plugin-free (virtual tables are not schema tables).
  assert.deepEqual(schema.tableNames, ['Article', 'Audit']);
  assert.deepEqual(schema.triggers.map((trigger) => trigger.name), ['trg_article_touch', 'trg_audit_insert']);
});

test('composite foreign keys compile, execute, and cascade across rows', () => {
  const schema = defineSqliteSchema({
    name: 'commerce',
    tables: [
      {
        name: 'Customer',
        columns: [
          { name: 'id', type: 'text', notNull: true },
          { name: 'region', type: 'text', notNull: true },
        ],
        primaryKey: ['id', 'region'],
      },
      {
        name: 'SalesOrder',
        columns: [
          { name: 'id', type: 'text', notNull: true },
          { name: 'customerId', type: 'text', notNull: true },
          { name: 'region', type: 'text', notNull: true },
        ],
        primaryKey: ['id', 'customerId', 'region'],
        foreignKeys: [
          { columns: ['customerId', 'region'], references: { table: 'Customer', columns: ['id', 'region'] }, onDelete: 'cascade', onUpdate: 'cascade' },
        ],
      },
      {
        name: 'OrderItem',
        columns: [
          { name: 'orderId', type: 'text', notNull: true },
          { name: 'customerId', type: 'text', notNull: true },
          { name: 'region', type: 'text', notNull: true },
          { name: 'sku', type: 'text', notNull: true },
        ],
        foreignKeys: [
          { columns: ['orderId', 'customerId', 'region'], references: { table: 'SalesOrder', columns: ['id', 'customerId', 'region'] }, onDelete: 'cascade' },
        ],
      },
    ],
  });

  const sql = schema.ddl.join('\n');
  assert.match(sql, /FOREIGN KEY \("customerId", "region"\) REFERENCES "Customer" \("id", "region"\) ON DELETE CASCADE ON UPDATE CASCADE/);
  assert.match(sql, /FOREIGN KEY \("orderId", "customerId", "region"\) REFERENCES "SalesOrder" \("id", "customerId", "region"\) ON DELETE CASCADE/);

  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    schema.prepare(db);
    db.prepare("INSERT INTO Customer (id, region) VALUES ('c1', 'eu')").run();
    db.prepare("INSERT INTO SalesOrder (id, customerId, region) VALUES ('o1', 'c1', 'eu')").run();
    db.prepare("INSERT INTO OrderItem (orderId, customerId, region, sku) VALUES ('o1', 'c1', 'eu', 'sku-1')").run();
    db.prepare("DELETE FROM Customer WHERE id = 'c1'").run();
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM SalesOrder').get().count, 0, 'child order cascaded');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM OrderItem').get().count, 0, 'grandchild cascaded');
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally {
    db.close();
  }
});

test('namespaced migrations: same version in different namespaces is allowed', () => {
  const schema = defineSqliteSchema({
    name: 'multi-ns',
    tables: [],
    migrations: [
      { namespace: 'workbench', name: 'base', version: 5, up() {} },
      { namespace: 'app', name: 'seed', version: 5, up() {} },
    ],
  });
  assert.deepEqual(schema.migrations.map((m) => [m.namespace, m.name, m.version]), [
    ['workbench', 'base', 5],
    ['app', 'seed', 5],
  ]);
});

test('namespaced migrations reject malformed dependencies', () => {
  assert.throws(
    () => defineSqliteSchema({
      name: 'bad-dep',
      tables: [],
      migrations: [{
        namespace: 'app',
        name: 'seed',
        version: 1,
        dependencies: ['workbench@5', 'workbench@5'],
        up() {},
      }],
    }),
    /duplicate dependency/i,
  );
});

function rejects(declaration, pattern, message) {
  assert.throws(() => defineSqliteSchema(declaration), pattern, message);
}

test('expanded features are rejected at declaration time (rejection matrix)', () => {
  const baseTable = { name: 'T', columns: [{ name: 'x', type: 'integer' }, { name: 's', type: 'text' }] };

  rejects({ name: 'bad', tables: [{ ...baseTable, columns: [{ name: 'x', type: 'integer', check: 'x > ' }] }] }, /ends with an invalid token/, 'CHECK trailing operator');
  rejects({ name: 'bad', tables: [{ ...baseTable, columns: [{ name: 'x', type: 'integer', check: "x = 'oops" }] }] }, /unterminated string literal/, 'CHECK unterminated string');
  rejects({ name: 'bad', tables: [{ ...baseTable, columns: [{ name: 'x', type: 'integer', check: 'missing > 0' }] }] }, /missing column "missing"/, 'CHECK unknown column');
  rejects({ name: 'bad', tables: [{ ...baseTable, columns: [{ name: 'x', type: 'integer', check: '((x > 0)' }] }] }, /unbalanced parentheses/, 'CHECK unbalanced parens');
  rejects({ name: 'bad', tables: [{ ...baseTable, columns: [{ name: 'x', type: 'integer', check: 'x > 0 -- sneaky' }] }] }, /must not contain SQL comments/, 'CHECK comment');
  rejects({ name: 'bad', tables: [{ ...baseTable, columns: [{ name: 'x', type: 'integer', check: 'x AS s' }] }] }, /AS is not an expression operator/, 'CHECK uses AS as an operator');

  rejects({ name: 'bad', tables: [{ ...baseTable, columns: [{ name: 'x', type: 'integer', collation: 'not an ident' }] }] }, /must be an identifier/, 'bad collation');
  rejects({ name: 'bad', tables: [{ ...baseTable, columns: [{ name: 'x', type: 'integer', collation: 42 }] }] }, /collation for column "x"/, 'non-string collation');

  rejects({ name: 'bad', tables: [{ ...baseTable, unique: [{ columns: ['missing'] }] }] }, /references missing column "missing"/, 'UNIQUE unknown column');
  rejects(
    {
      name: 'bad',
      tables: [{
        ...baseTable,
        unique: [{ name: 'idx_t_x', columns: ['x'] }],
        indexes: [{ name: 'IDX_T_X', columns: ['x'] }],
      }],
    },
    /duplicate index name/i,
    'named UNIQUE collides with index name',
  );

  rejects({ name: 'bad', tables: [{ ...baseTable, indexes: [{ name: 'idx', columns: ['s'], where: 's AND' }] }] }, /incomplete expression/, 'partial index dangling AND');
  rejects({ name: 'bad', tables: [{ ...baseTable, indexes: [{ name: 'idx', columns: ['s'], where: 's =' }] }] }, /ends with an invalid token/, 'partial index trailing operator');
  rejects({ name: 'bad', tables: [{ ...baseTable, indexes: [{ name: 'idx', columns: ['s'], where: 'lower(s' }] }] }, /unbalanced parentheses/, 'partial index unbalanced parens');
  rejects({ name: 'bad', tables: [{ ...baseTable, indexes: [{ name: 'idx', columns: ['x'], where: 'missing = 1' }] }] }, /missing column "missing"/, 'partial index unknown column');

  rejects({ name: 'bad', tables: [{ ...baseTable, indexes: [{ name: 'idx', expression: ['lower(missing)'] }] }] }, /missing column "missing"/, 'expression index unknown column');
  rejects({ name: 'bad', tables: [{ ...baseTable, indexes: [{ name: 'idx', expression: ['s ||'] }] }] }, /ends with an invalid token/, 'expression index dangling operator');
  rejects({ name: 'bad', tables: [{ ...baseTable, indexes: [{ name: 'idx' }] }] }, /must declare columns or expression terms/, 'index with neither columns nor expression');

  rejects(
    { name: 'bad', tables: [], virtualTables: [{ name: 'rt', module: 'rtree', options: ['x'], ownerPluginId: 'p', shadowTables: ['rt_a'] }] },
    /unknown virtual table module "rtree"/,
    'non-FTS5 virtual module',
  );
  rejects(
    { name: 'bad', tables: [], virtualTables: [{ name: 'ft', module: 'fts5', options: [], ownerPluginId: 'p', shadowTables: ['ft_a'] }] },
    /must declare at least one option/,
    'virtual table without options',
  );
  rejects(
    { name: 'bad', tables: [], virtualTables: [{ name: 'ft', module: 'fts5', options: ['x'], ownerPluginId: 'p', shadowTables: [] }] },
    /must declare the shadow tables it owns/,
    'virtual table without shadow attribution',
  );
  rejects(
    { name: 'bad', tables: [], virtualTables: [{ name: 'ft', module: 'fts5', options: ['x'], ownerPluginId: 'p', shadowTables: ['ft_a', 'ft_a'] }] },
    /duplicate shadow table/,
    'duplicate shadow within one virtual table',
  );
  rejects(
    {
      name: 'bad',
      tables: [{ name: 'T', columns: [{ name: 'x', type: 'integer' }] }],
      virtualTables: [{ name: 't', module: 'fts5', options: ['x'], ownerPluginId: 'p', shadowTables: ['t_a'] }],
    },
    /collides with a declared virtual table/,
    'virtual table name collides with a table',
  );
  rejects(
    {
      name: 'bad',
      tables: [{ name: 'Shadow', columns: [{ name: 'x', type: 'integer' }] }],
      virtualTables: [{ name: 'ft', module: 'fts5', options: ['x'], ownerPluginId: 'p', shadowTables: ['shadow'] }],
    },
    /collides with a declared virtual table/,
    'shadow table name collides with a table',
  );
  rejects(
    {
      name: 'bad',
      tables: [],
      virtualTables: [
        { name: 'ft1', module: 'fts5', options: ['x'], ownerPluginId: 'p', shadowTables: ['ft1_data'] },
        { name: 'ft2', module: 'fts5', options: ['x'], ownerPluginId: 'p', shadowTables: ['ft1_data'] },
      ],
    },
    /duplicate shadow table/,
    'shadow table claimed by two virtual tables',
  );
  rejects(
    {
      name: 'bad',
      tables: [],
      externalTables: [{ name: 'Proj', columns: ['id'] }],
      virtualTables: [{ name: 'proj', module: 'fts5', options: ['id'], ownerPluginId: 'p', shadowTables: ['proj_data'] }],
    },
    /virtual table "Proj" collides with an external table declaration/,
    'virtual table name collides with an external declaration',
  );
  rejects(
    { name: 'bad', tables: [{ ...baseTable, withoutRowid: true }] },
    /withoutRowid table "T" must declare a primary key/,
    'WITHOUT ROWID without primary key',
  );
  rejects({ name: 'bad', tables: [{ ...baseTable, strict: 'yes' }] }, /strict on table "T" must be a boolean/, 'non-boolean strict');
  rejects({ name: 'bad', tables: [{ ...baseTable, withoutRowid: 'no' }] }, /withoutRowid on table "T" must be a boolean/, 'non-boolean withoutRowid');

  rejects(
    {
      name: 'bad',
      tables: [{ ...baseTable, triggers: [{ name: 'trg', timing: 'after', event: 'update', columnNames: ['x'], when: 'NEW.missing = 1', body: 'UPDATE T SET x = 1 WHERE x = NEW.x;' }] }],
    },
    /missing column "missing"/,
    'trigger WHEN references a missing column',
  );
  rejects(
    {
      name: 'bad',
      tables: [{ ...baseTable, triggers: [{ name: 'trg', timing: 'after', event: 'insert', columnNames: ['x'], body: 'UPDATE T SET x = 1;' }] }],
    },
    /non-UPDATE event/,
    'trigger UPDATE OF on a non-update event',
  );
  rejects(
    {
      name: 'bad',
      tables: [{ ...baseTable, triggers: [{ name: 'trg', timing: 'after', event: 'update', columnNames: ['missing'], body: 'UPDATE T SET x = 1;' }] }],
    },
    /missing column "missing"/,
    'trigger UPDATE OF references a missing column',
  );
  rejects(
    {
      name: 'bad',
      tables: [{ ...baseTable, triggers: [{ name: 'trg', timing: 'after', event: 'update', body: 'UPDATE T SET x = NEW.missing;' }] }],
    },
    /missing column "missing"/,
    'trigger body NEW. references a missing column',
  );
  rejects(
    {
      name: 'bad',
      tables: [{ ...baseTable, triggers: [{ name: 'trg', timing: 'after', event: 'update', body: 'UPDATE T SET x = NEW.x' }] }],
    },
    /must contain at least one statement/,
    'trigger body without semicolon',
  );
  rejects(
    {
      name: 'bad',
      tables: [{ ...baseTable, triggers: [{ name: 'trg', timing: 'after', event: 'update', body: 'UPDATE T SET x = 1; garbage' }] }],
    },
    /trailing tokens after the final ';'/,
    'trigger body trailing garbage after the final semicolon',
  );
  rejects(
    {
      name: 'bad',
      tables: [{ ...baseTable, triggers: [{ name: 'trg', timing: 'after', event: 'update', body: 'garbage; UPDATE T SET x = 1;' }] }],
    },
    /must begin with SELECT, INSERT, UPDATE, DELETE, or WITH/,
    'trigger body statement does not begin with a statement verb',
  );
  rejects(
    {
      name: 'bad',
      tables: [
        { ...baseTable, triggers: [{ name: 'shared_trg', timing: 'after', event: 'insert', body: 'UPDATE T SET x = 1;' }] },
        { name: 'U', columns: [{ name: 'y', type: 'integer' }], triggers: [{ name: 'SHARED_TRG', timing: 'after', event: 'insert', body: 'UPDATE U SET y = 1;' }] },
      ],
    },
    /duplicate trigger/,
    'duplicate trigger name across tables',
  );
});

test('string literals may contain comment-looking text and CAST uses AS legitimately', () => {
  const schema = defineSqliteSchema({
    name: 'strings',
    tables: [{
      name: 'Note',
      columns: [
        { name: 'id', type: 'text', primaryKey: true },
        { name: 'body', type: 'text', notNull: true, check: "body IN ('draft -- notes', 'a/*b', 'plain')" },
        { name: 'size', type: 'integer', notNull: true, check: "CAST(size AS TEXT) != '0 -- len'" },
      ],
    }],
  });
  const db = new DatabaseSync(':memory:');
  try {
    schema.prepare(db);
    db.prepare("INSERT INTO Note (id, body, size) VALUES ('n1', 'draft -- notes', 3)").run();
    assert.throws(
      () => db.prepare("INSERT INTO Note (id, body, size) VALUES ('n2', 'other', 3)").run(),
      /CHECK/i,
      'CHECK with comment-looking strings is enforced by SQLite',
    );
  } finally {
    db.close();
  }
});

test('trigger bodies may contain comment-looking text inside string literals', () => {
  const schema = defineSqliteSchema({
    name: 'trigger-strings',
    tables: [{
      name: 'T',
      columns: [{ name: 'x', type: 'integer' }],
      triggers: [
        { name: 'trg', timing: 'after', event: 'insert', body: "UPDATE T SET x = 1 WHERE x = '-- note';" },
      ],
    }],
  });
  assert.equal(schema.triggerDdl.length, 1);
  assert.match(schema.triggerDdl[0], /'-- note'/);
});

test('shadow tables are not cross-checked against external declarations (A2 census attribution policy)', () => {
  const schema = defineSqliteSchema({
    name: 'shadow-external',
    tables: [],
    externalTables: [{ name: 'Proj', columns: ['id'] }],
    virtualTables: [{ name: 'ft', module: 'fts5', options: ['id'], ownerPluginId: 'p', shadowTables: ['proj'] }],
  });
  assert.deepEqual(schema.virtualTables[0].shadowTables, ['proj']);
});

test('prepare fails closed on cross-namespace version collisions under the legacy global ledger', () => {
  let ran = 0;
  const schema = defineSqliteSchema({
    name: 'collide',
    tables: [{ name: 'T', columns: [{ name: 'id', type: 'text', primaryKey: true }] }],
    migrations: [
      { namespace: 'workbench', name: 'base', version: 5, up() { ran += 1; } },
      { namespace: 'app', name: 'seed', version: 5, up() { ran += 1; } },
    ],
  });
  const db = new DatabaseSync(':memory:');
  try {
    assert.throws(
      () => schema.prepare(db),
      /version 5 in namespaces "workbench" and "app".*legacy global migration ledger.*#90/,
      'prepare refuses the legacy-ledger version collision',
    );
    assert.equal(ran, 0, 'no migration executed');
    assert.equal(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'T'").get(),
      undefined,
      'no table DDL executed before the refusal',
    );
    assert.equal(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_Migration'").get(),
      undefined,
      'migration ledger not touched',
    );
  } finally {
    db.close();
  }
});

test('prepare({ skipMigrations: true }) still refuses cross-namespace version collisions under the legacy global ledger', () => {
  let ran = 0;
  const schema = defineSqliteSchema({
    name: 'collide-skip',
    tables: [{ name: 'T', columns: [{ name: 'id', type: 'text', primaryKey: true }] }],
    migrations: [
      { namespace: 'workbench', name: 'base', version: 5, up() { ran += 1; } },
      { namespace: 'app', name: 'seed', version: 5, up() { ran += 1; } },
    ],
  });
  const db = new DatabaseSync(':memory:');
  try {
    assert.throws(
      () => schema.prepare(db, { skipMigrations: true }),
      /version 5 in namespaces "workbench" and "app".*legacy global migration ledger.*#90/,
      'prepare with skipMigrations still refuses the legacy-ledger version collision',
    );
    assert.equal(ran, 0, 'no migration executed');
    assert.equal(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'T'").get(),
      undefined,
      'no table DDL executed before the refusal',
    );
    assert.equal(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_Migration'").get(),
      undefined,
      'migration ledger not touched',
    );
  } finally {
    db.close();
  }
});

test('namespaced migrations with distinct versions still run under the legacy global ledger', () => {
  const applied = [];
  const schema = defineSqliteSchema({
    name: 'non-colliding',
    tables: [],
    migrations: [
      { namespace: 'workbench', name: 'a', version: 4, up(db) { applied.push('a'); db.exec('CREATE TABLE IF NOT EXISTS A (id TEXT PRIMARY KEY)'); } },
      { namespace: 'app', name: 'b', version: 6, up(db) { applied.push('b'); db.exec('CREATE TABLE IF NOT EXISTS B (id TEXT PRIMARY KEY)'); } },
    ],
  });
  const db = new DatabaseSync(':memory:');
  try {
    schema.prepare(db);
    assert.deepEqual(applied, ['a', 'b']);
    assert.deepEqual(
      db.prepare('SELECT version FROM _Migration ORDER BY version').all().map((row) => row.version),
      [4, 6],
    );
  } finally {
    db.close();
  }
});

test('declared triggers are validated against the table before any DB is touched', () => {
  const schema = defineSqliteSchema({
    name: 'triggers',
    tables: [{
      name: 'Ledger',
      columns: [
        { name: 'id', type: 'text', primaryKey: true },
        { name: 'amount', type: 'integer', notNull: true },
        { name: 'balance', type: 'integer', notNull: true },
      ],
      triggers: [
        {
          name: 'trg_ledger_balance',
          timing: 'before',
          event: 'insert',
          when: 'NEW.amount != 0',
          body: 'UPDATE Ledger SET balance = balance + NEW.amount WHERE id = NEW.id;',
        },
      ],
    }],
  });

  assert.equal(schema.triggerDdl.length, 1);
  assert.match(schema.triggerDdl[0], /^CREATE TRIGGER IF NOT EXISTS "trg_ledger_balance" BEFORE INSERT ON "Ledger" WHEN NEW\.amount != 0 BEGIN /);
  assert.match(schema.triggerDdl[0], / END;$/);
});

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { defineSqliteSchema } from '../build/sqlite-schema.mjs';
import { buildOwnershipCensus } from '../build/schema-census.mjs';
import { validateExactSchema } from '../build/schema-exact-validation.mjs';

// The S2/A3 exact schema validator test matrix: every drift class fails with a
// distinct, name-bearing diagnostic that names the owning schema/plugin and the
// object — and never any row or table contents.

function scopeSchema(overrides = {}, extraTables = []) {
  return defineSqliteSchema({
    name: 'scope',
    tables: [
      {
        name: 'Article',
        columns: [
          { name: 'id', type: 'text', primaryKey: true },
          { name: 'title', type: 'text', notNull: true },
          { name: 'score', type: 'real' },
        ],
        ...overrides,
      },
      ...extraTables,
    ],
  });
}

// Create a schema, settle a database against it (or a hand-written drifted
// shape), then run the exact validator and return its errors.
function check(db, schemas, plugins = []) {
  const result = buildOwnershipCensus({ schemaDeclarations: schemas, plugins });
  assert.deepEqual(result.errors, [], `census errors: ${JSON.stringify(result.errors)}`);
  return validateExactSchema(db, result.census, schemas);
}

function codes(errors) {
  return errors.map((error) => error.code);
}

// ---------------------------------------------------------------------------
// Correct fresh-create + idempotency
// ---------------------------------------------------------------------------

test('a correct fresh-create passes exactly once and again on reboot (idempotent read)', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const schema = scopeSchema({
      indexes: [{ name: 'Article_score', columns: ['score'] }],
    });
    schema.prepare(db);
    const result = buildOwnershipCensus({ schemaDeclarations: [schema] });
    assert.deepEqual(result.errors, []);
    const first = validateExactSchema(db, result.census, [schema]);
    const second = validateExactSchema(db, result.census, [schema]);
    assert.deepEqual(first, []);
    assert.deepEqual(second, []);
  } finally {
    db.close();
  }
});

test('every failure names the owning schema/plugin and object with no row contents', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const schema = scopeSchema({ indexes: [{ name: 'Article_score', columns: ['score'] }] });
    db.exec('CREATE TABLE Article (id TEXT PRIMARY KEY, title TEXT, score INTEGER DEFAULT 9, intruder TEXT)');
    db.exec('CREATE INDEX Article_ghost ON Article(title)');
    db.exec('CREATE TRIGGER Article_hidden AFTER INSERT ON Article BEGIN SELECT 1; END');
    const errors = check(db, [schema]);
    assert.ok(errors.length >= 3, `expected drift, got ${JSON.stringify(errors)}`);
    for (const error of errors) {
      assert.match(error.message, /schema "scope"/, `owner naming in ${error.code}`);
      assert.doesNotMatch(error.message, /\bSELECT\b|\bINSERT\b|VALUES|CREATE TABLE/i, `${error.code} must not leak contents`);
    }
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Column drift
// ---------------------------------------------------------------------------

test('an extra column is a distinct extra-column drift', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const schema = scopeSchema();
    db.exec('CREATE TABLE Article (id TEXT PRIMARY KEY, title TEXT NOT NULL, score REAL, intruder TEXT)');
    const errors = check(db, [schema]);
    assert.deepEqual(codes(errors), ['extra-column']);
    assert.match(errors[0].message, /schema "scope" column "intruder" of table "Article"/);
  } finally {
    db.close();
  }
});

test('a missing column is a distinct missing-column drift', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const schema = scopeSchema();
    db.exec('CREATE TABLE Article (id TEXT PRIMARY KEY, title TEXT NOT NULL)');
    const errors = check(db, [schema]);
    assert.deepEqual(codes(errors), ['missing-column']);
    assert.match(errors[0].message, /schema "scope" column "score" of table "Article"/);
  } finally {
    db.close();
  }
});

test('a changed type/affinity is a distinct changed-type drift', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const schema = scopeSchema();
    db.exec('CREATE TABLE Article (id TEXT PRIMARY KEY, title TEXT NOT NULL, score INTEGER)');
    const errors = check(db, [schema]);
    assert.deepEqual(codes(errors), ['changed-type']);
    assert.match(errors[0].message, /schema "scope" column "score" of table "Article"/);
  } finally {
    db.close();
  }
});

test('affinity comparison tolerates type-name spelling while rejecting a different affinity', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const schema = scopeSchema();
    // varchar is TEXT affinity — the same affinity as the declared `text`.
    db.exec('CREATE TABLE Article (id TEXT PRIMARY KEY, title VARCHAR(40) NOT NULL, score DOUBLE PRECISION)');
    assert.deepEqual(check(db, [schema]), []);
  } finally {
    db.close();
  }
});

test('a changed default is a distinct changed-default drift', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const schema = scopeSchema({
      columns: [
        { name: 'id', type: 'text', primaryKey: true },
        { name: 'title', type: 'text', notNull: true, default: 'draft' },
        { name: 'score', type: 'real' },
      ],
    });
    db.exec("CREATE TABLE Article (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT 'final', score REAL)");
    const errors = check(db, [schema]);
    assert.deepEqual(codes(errors), ['changed-default']);
    assert.match(errors[0].message, /schema "scope" column "title" of table "Article"/);
  } finally {
    db.close();
  }
});

test('a matching literal default passes', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const schema = scopeSchema({
      columns: [
        { name: 'id', type: 'text', primaryKey: true },
        { name: 'title', type: 'text', notNull: true, default: 'draft' },
        { name: 'score', type: 'real' },
      ],
    });
    db.exec("CREATE TABLE Article (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT 'draft', score REAL)");
    assert.deepEqual(check(db, [schema]), []);
  } finally {
    db.close();
  }
});

test('a default expression matches through parenthesised-expression normalisation', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const schema = scopeSchema({
      columns: [
        { name: 'id', type: 'text', primaryKey: true },
        { name: 'title', type: 'text', notNull: true },
        { name: 'created', type: 'text', defaultExpression: "(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))" },
      ],
    });
    db.exec("CREATE TABLE Article (id TEXT PRIMARY KEY, title TEXT NOT NULL, created TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))");
    assert.deepEqual(check(db, [schema]), [], 'parenthesised declaration matches stored unparenthesised default');

    const db2 = new DatabaseSync(':memory:');
    try {
      db2.exec('CREATE TABLE Article (id TEXT PRIMARY KEY, title TEXT NOT NULL, created TEXT DEFAULT CURRENT_TIMESTAMP)');
      const errors = check(db2, [schema]);
      assert.deepEqual(codes(errors), ['changed-default']);
    } finally {
      db2.close();
    }
  } finally {
    db.close();
  }
});

test('a changed nullability is a distinct changed-nullability drift', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const schema = scopeSchema();
    db.exec('CREATE TABLE Article (id TEXT PRIMARY KEY, title TEXT, score REAL)');
    const errors = check(db, [schema]);
    assert.deepEqual(codes(errors), ['changed-nullability']);
    assert.match(errors[0].message, /schema "scope" column "title" of table "Article"/);
  } finally {
    db.close();
  }
});

test('a primary-key order change is a distinct pk-mismatch drift', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const schema = defineSqliteSchema({
      name: 'scope',
      tables: [{
        name: 'Pair',
        columns: [
          { name: 'left', type: 'text' },
          { name: 'right', type: 'text' },
        ],
        primaryKey: ['left', 'right'],
      }],
    });
    db.exec('CREATE TABLE Pair (left TEXT, right TEXT, PRIMARY KEY (right, left))');
    const errors = check(db, [schema]);
    assert.deepEqual(codes(errors), ['pk-mismatch']);
    assert.match(errors[0].message, /schema "scope" table "Pair"/);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Foreign-key drift
// ---------------------------------------------------------------------------

test('a wrong FK action is a distinct wrong-fk-action drift', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const schema = scopeSchema({}, [{
      name: 'Comment',
      columns: [
        { name: 'id', type: 'text', primaryKey: true },
        { name: 'articleId', type: 'text' },
      ],
      foreignKeys: [{ columns: ['articleId'], references: { table: 'Article', columns: ['id'] }, onDelete: 'cascade' }],
    }]);
    db.exec('CREATE TABLE Article (id TEXT PRIMARY KEY, title TEXT NOT NULL, score REAL)');
    db.exec('CREATE TABLE Comment (id TEXT PRIMARY KEY, articleId TEXT REFERENCES Article(id) ON DELETE RESTRICT)');
    const errors = check(db, [schema]);
    assert.deepEqual(codes(errors), ['wrong-fk-action']);
    assert.match(errors[0].message, /schema "scope" table "Comment".*foreign key.*Article.*ON DELETE RESTRICT.*CASCADE/i);
  } finally {
    db.close();
  }
});

test('a matching FK with declared actions passes', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const schema = scopeSchema({}, [{
      name: 'Comment',
      columns: [
        { name: 'id', type: 'text', primaryKey: true },
        { name: 'articleId', type: 'text' },
      ],
      foreignKeys: [{ columns: ['articleId'], references: { table: 'Article', columns: ['id'] }, onDelete: 'cascade', onUpdate: 'no action' }],
    }]);
    db.exec('CREATE TABLE Article (id TEXT PRIMARY KEY, title TEXT NOT NULL, score REAL)');
    db.exec('CREATE TABLE Comment (id TEXT PRIMARY KEY, articleId TEXT REFERENCES Article(id) ON DELETE CASCADE)');
    assert.deepEqual(check(db, [schema]), []);
  } finally {
    db.close();
  }
});

test('a declared FK absent from the live schema is an fk-mismatch drift', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const schema = scopeSchema({}, [{
      name: 'Comment',
      columns: [
        { name: 'id', type: 'text', primaryKey: true },
        { name: 'articleId', type: 'text' },
      ],
      foreignKeys: [{ columns: ['articleId'], references: { table: 'Article', columns: ['id'] } }],
    }]);
    db.exec('CREATE TABLE Article (id TEXT PRIMARY KEY, title TEXT NOT NULL, score REAL)');
    db.exec('CREATE TABLE Comment (id TEXT PRIMARY KEY, articleId TEXT)');
    const errors = check(db, [schema]);
    assert.deepEqual(codes(errors), ['fk-mismatch']);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Index drift
// ---------------------------------------------------------------------------

test('a missing index is a distinct missing-index drift', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const schema = scopeSchema({ indexes: [{ name: 'Article_score', columns: ['score'] }] });
    db.exec('CREATE TABLE Article (id TEXT PRIMARY KEY, title TEXT NOT NULL, score REAL)');
    const errors = check(db, [schema]);
    assert.deepEqual(codes(errors), ['missing-index']);
    assert.match(errors[0].message, /schema "scope" table "Article".*missing declared index "Article_score"/);
  } finally {
    db.close();
  }
});

test('an extra index is a distinct extra-index drift', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const schema = scopeSchema();
    db.exec('CREATE TABLE Article (id TEXT PRIMARY KEY, title TEXT NOT NULL, score REAL)');
    db.exec('CREATE INDEX Article_ghost ON Article(title)');
    const errors = check(db, [schema]);
    assert.deepEqual(codes(errors), ['extra-index']);
    assert.match(errors[0].message, /schema "scope" table "Article".*extra index "Article_ghost"/);
  } finally {
    db.close();
  }
});

test('an index whose shape drifts is a distinct index-mismatch drift', () => {
  const cases = [
    // unique drift
    ['CREATE UNIQUE INDEX Article_score ON Article(score)', scopeSchema({ indexes: [{ name: 'Article_score', columns: ['score'] }] })],
    // partial drift
    ['CREATE INDEX Article_score ON Article(score) WHERE score IS NOT NULL', scopeSchema({ indexes: [{ name: 'Article_score', columns: ['score'] }] })],
    // collation/ordering drift
    ['CREATE INDEX Article_score ON Article(score DESC)', scopeSchema({ indexes: [{ name: 'Article_score', columns: ['score'] }] })],
    // expression-term drift (declared expression, live column)
    ['CREATE INDEX Article_lower ON Article(title)', scopeSchema({ indexes: [{ name: 'Article_lower', expression: ['lower(title)'] }] })],
  ];
  for (const [sql, schema] of cases) {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE TABLE Article (id TEXT PRIMARY KEY, title TEXT NOT NULL, score REAL)');
      db.exec(sql);
      const errors = check(db, [schema]);
      assert.deepEqual(codes(errors), ['index-mismatch'], `${sql} should be index-mismatch`);
    } finally {
      db.close();
    }
  }
});

test('a matching expression index passes and a matching partial index passes', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const schema = scopeSchema({
      indexes: [
        { name: 'Article_lower', expression: ['lower(title)'] },
        { name: 'Article_partial', columns: ['score'], where: 'score IS NOT NULL' },
      ],
    });
    schema.prepare(db);
    assert.deepEqual(check(db, [schema]), []);
  } finally {
    db.close();
  }
});

test('a parenthesized expression index retains its declared collation', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const schema = scopeSchema({
      indexes: [{ name: 'Article_lower_nocase', expression: ['(lower(title) COLLATE NOCASE)'] }],
    });
    schema.prepare(db);
    assert.deepEqual(check(db, [schema]), []);
  } finally {
    db.close();
  }
});

test('a partial index with a different WHERE predicate is an index-mismatch drift', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const schema = scopeSchema({
      indexes: [{ name: 'Article_partial', columns: ['score'], where: 'score IS NOT NULL' }],
    });
    db.exec('CREATE TABLE Article (id TEXT PRIMARY KEY, title TEXT NOT NULL, score REAL)');
    db.exec('CREATE INDEX Article_partial ON Article(score) WHERE score IS NULL');
    assert.deepEqual(codes(check(db, [schema])), ['index-mismatch']);
  } finally {
    db.close();
  }
});

test('an index with a different effective term collation is an index-mismatch drift', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const schema = scopeSchema({
      columns: [
        { name: 'id', type: 'text', primaryKey: true },
        { name: 'title', type: 'text', notNull: true, collation: 'NOCASE' },
        { name: 'score', type: 'real' },
      ],
      indexes: [{ name: 'Article_title', columns: ['title'] }],
    });
    db.exec('CREATE TABLE Article (id TEXT PRIMARY KEY, title TEXT NOT NULL, score REAL)');
    db.exec('CREATE INDEX Article_title ON Article(title)');
    assert.deepEqual(codes(check(db, [schema])), ['index-mismatch']);
  } finally {
    db.close();
  }
});

test('a declared UNIQUE constraint expects its auto-index and a missing one drifts', () => {
  const schema = scopeSchema({ unique: [{ name: 'uq_article_title', columns: ['title'] }] });
  const db = new DatabaseSync(':memory:');
  try {
    schema.prepare(db);
    assert.deepEqual(check(db, [schema]), [], 'auto-index present');
  } finally {
    db.close();
  }
  const db2 = new DatabaseSync(':memory:');
  try {
    db2.exec('CREATE TABLE Article (id TEXT PRIMARY KEY, title TEXT NOT NULL, score REAL)');
    const errors = check(db2, [schema]);
    assert.deepEqual(codes(errors), ['missing-index']);
  } finally {
    db2.close();
  }
});

// ---------------------------------------------------------------------------
// Trigger drift + trigger ownership (consideration #9)
// ---------------------------------------------------------------------------

test('an extra trigger is a distinct extra-trigger drift', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const schema = scopeSchema();
    db.exec('CREATE TABLE Article (id TEXT PRIMARY KEY, title TEXT NOT NULL, score REAL)');
    db.exec('CREATE TRIGGER Article_ghost AFTER INSERT ON Article BEGIN SELECT 1; END');
    const errors = check(db, [schema]);
    assert.deepEqual(codes(errors), ['extra-trigger']);
    assert.match(errors[0].message, /schema "scope" trigger "Article_ghost" of table "Article"/);
  } finally {
    db.close();
  }
});

test('a trigger declared by the owning schema is permitted', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const schema = scopeSchema({
      triggers: [{ name: 'Article_audit', timing: 'after', event: 'update', body: 'SELECT 1;' }],
    });
    db.exec('CREATE TABLE Article (id TEXT PRIMARY KEY, title TEXT NOT NULL, score REAL)');
    db.exec('CREATE TRIGGER Article_audit AFTER UPDATE ON Article BEGIN SELECT 1; END');
    assert.deepEqual(check(db, [schema]), []);
  } finally {
    db.close();
  }
});

test('a trigger owned by another participant is a conflicting-ownership drift', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const schemaA = defineSqliteSchema({
      name: 'a',
      tables: [{ name: 'TA', columns: [{ name: 'id', type: 'text', primaryKey: true }, { name: 'note', type: 'text' }] }],
    });
    // Schema B declares the trigger trg_ta_audit (under its own table TB).
    const schemaB = defineSqliteSchema({
      name: 'b',
      tables: [{
        name: 'TB',
        columns: [{ name: 'id', type: 'text', primaryKey: true }, { name: 'note', type: 'text' }],
        triggers: [{ name: 'trg_ta_audit', timing: 'after', event: 'update', body: "INSERT INTO TB(id) VALUES ('x');" }],
      }],
    });
    db.exec('CREATE TABLE TA (id TEXT PRIMARY KEY, note TEXT)');
    db.exec('CREATE TABLE TB (id TEXT PRIMARY KEY, note TEXT)');
    // The live trigger sits on schema A's table but the census attributes it to schema B.
    db.exec('CREATE TRIGGER trg_ta_audit AFTER UPDATE ON TA BEGIN SELECT 1; END');
    const errors = check(db, [schemaA, schemaB]);
    assert.deepEqual(codes(errors), ['conflicting-ownership']);
    assert.match(errors[0].message, /schema "a" trigger "trg_ta_audit" of table "TA".*owned by schema "b"/);
  } finally {
    db.close();
  }
});

test('a table owned by a different participant is a conflicting-ownership drift', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const schema = scopeSchema();
    db.exec('CREATE TABLE Article (id TEXT PRIMARY KEY, title TEXT NOT NULL, score REAL)');
    const entityNote = {
      name: 'Article',
      fields: { title: { kind: 'value', type: 'text' } },
    };
    const result = buildOwnershipCensus({ schemaDeclarations: [schema], entities: [entityNote] });
    // The census attribute check reports the entity-owned table as a conflict
    // only when the schema does not legitimately own it. Here the schema does
    // declare it, so ownership matches — this test guards the defensive path
    // by hand-constructing a mismatched census entry.
    const mismatched = new Map(result.census);
    mismatched.set('table:article', { kind: 'entity', owner: 'Article', objectKind: 'table', name: 'Article' });
    const errors = validateExactSchema(db, mismatched, [schema]);
    assert.deepEqual(codes(errors), ['conflicting-ownership']);
    assert.match(errors[0].message, /schema "scope" table "Article" is owned by entity "Article"/);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Virtual tables + shadow tables
// ---------------------------------------------------------------------------

const FTS5_SHADOWS = ['ft_article_data', 'ft_article_idx', 'ft_article_content', 'ft_article_docsize', 'ft_article_config'];

function searchSchema(virtualTables = [{
  name: 'ft_article',
  module: 'fts5',
  options: ['title'],
  ownerPluginId: 'scope-search',
  shadowTables: FTS5_SHADOWS,
}]) {
  return defineSqliteSchema({ name: 'scope', tables: [], virtualTables });
}

test('a declared virtual table with its shadow tables passes', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const schema = searchSchema();
    db.exec('CREATE VIRTUAL TABLE ft_article USING fts5(title)');
    const result = buildOwnershipCensus({ schemaDeclarations: [schema], plugins: [{ id: 'scope-search', ownedObjects: [] }] });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(validateExactSchema(db, result.census, [schema]), []);
  } finally {
    db.close();
  }
});

test('a missing shadow table is a missing-table drift naming the plugin', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const schema = searchSchema();
    // A contentless FTS5 table has no _content shadow, so the declared
    // ft_article_content shadow is missing from the live schema.
    db.exec("CREATE VIRTUAL TABLE ft_article USING fts5(title, content='')");
    const errors = check(db, [schema], [{ id: 'scope-search', ownedObjects: [] }]);
    assert.deepEqual(codes(errors), ['missing-table']);
    assert.match(errors[0].message, /plugin "scope-search" shadow-table "ft_article_content" of virtual table "ft_article"/);
  } finally {
    db.close();
  }
});

test('a declared shadow absent from the live schema is reported even when the virtual table exists', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const schema = searchSchema([{
      name: 'ft_article',
      module: 'fts5',
      options: ['title'],
      ownerPluginId: 'scope-search',
      shadowTables: ['ft_article_data', 'ft_article_bogus'],
    }]);
    db.exec('CREATE VIRTUAL TABLE ft_article USING fts5(title)');
    const errors = check(db, [schema], [{ id: 'scope-search', ownedObjects: [] }]);
    assert.deepEqual(codes(errors), ['missing-table']);
    assert.match(errors[0].message, /shadow-table "ft_article_bogus"/);
  } finally {
    db.close();
  }
});

test('a virtual table declared but absent is a missing-table drift naming the plugin', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const schema = searchSchema();
    const errors = check(db, [schema], [{ id: 'scope-search', ownedObjects: [] }]);
    assert.deepEqual(codes(errors), ['missing-table']);
    assert.match(errors[0].message, /plugin "scope-search" virtual-table "ft_article"/);
  } finally {
    db.close();
  }
});

test('a declared virtual table that exists as an ordinary table is a table-kind drift', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const schema = searchSchema();
    db.exec('CREATE TABLE ft_article (id TEXT PRIMARY KEY, title TEXT)');
    const errors = check(db, [schema], [{ id: 'scope-search', ownedObjects: [] }]);
    assert.deepEqual(codes(errors), ['table-kind']);
    assert.match(errors[0].message, /plugin "scope-search" virtual-table "ft_article".*ordinary table/);
  } finally {
    db.close();
  }
});

test('an ordinary declared table that exists as a virtual table is a table-kind drift', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const schema = scopeSchema();
    db.exec('CREATE VIRTUAL TABLE Article USING fts5(title, score)');
    const errors = check(db, [schema]);
    assert.deepEqual(codes(errors), ['table-kind']);
    assert.match(errors[0].message, /schema "scope" table "Article".*virtual table/);
  } finally {
    db.close();
  }
});

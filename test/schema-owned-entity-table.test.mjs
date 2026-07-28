import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import workbench, { entity, number, text } from '../src/index.mjs';
import { defineSqliteSchema } from '../src/server.mjs';

const Note = entity('SchemaNote', { title: text(), score: number({ optional: true }) });

function noteSchema(columns = [
  { name: 'id', type: 'text', primaryKey: true },
  { name: 'title', type: 'text', notNull: true },
  { name: 'score', type: 'real' },
]) {
  return defineSqliteSchema({ name: 'schema-note', tables: [{ name: 'SchemaNote', columns }] });
}

async function rejectsHostileTable(sql, message) {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(sql);
    const app = workbench({ db, schema: noteSchema(), entities: [Note] });
    await assert.rejects(app.prepareSchema(), message);
  } finally {
    db.close();
  }
}

test('schema owns an entity main table while Workbench generates only framework storage', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const schema = noteSchema();
    const app = workbench({ db, schema, entities: [Note] });
    await app.prepareSchema();

    assert.match(db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'SchemaNote'").get().sql, /"title" TEXT NOT NULL/);
    assert.ok(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = '_Log'").get());
  } finally {
    db.close();
  }
});

test('schema-owned entity table validation rejects incompatible declared physical shape', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const app = workbench({ db, schema: noteSchema([
      { name: 'id', type: 'text', primaryKey: true },
      { name: 'title', type: 'integer', notNull: true },
      { name: 'score', type: 'real' },
      { name: 'intruder', type: 'text' },
    ]), entities: [Note] });
    await assert.rejects(app.prepareSchema(), /incompatible type|undeclared or missing columns/i);
  } finally {
    db.close();
  }
});

test('schema-owned entity table validation rejects write-altering triggers', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const schema = noteSchema();
    schema.prepare(db);
    db.exec('CREATE TRIGGER SchemaNote_hostile AFTER INSERT ON SchemaNote BEGIN DELETE FROM SchemaNote WHERE id = NEW.id; END');
    const app = workbench({ db, schema, entities: [Note] });
    await assert.rejects(app.prepareSchema(), /must not have trigger/i);
  } finally {
    db.close();
  }
});

test('schema-owned entity table validation rejects undeclared CHECK constraints', async () => {
  await rejectsHostileTable(
    'CREATE TABLE SchemaNote (id TEXT PRIMARY KEY, title TEXT NOT NULL CHECK(length(title) < 4), score REAL)',
    /must not contain CHECK constraints/i,
  );
});

test('schema-owned entity table validation does not mistake quoted CHECK text for a constraint', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const schema = noteSchema([
      { name: 'id', type: 'text', primaryKey: true },
      { name: 'title', type: 'text', notNull: true, default: "it's CHECK" },
      { name: 'score', type: 'real' },
    ]);
    const app = workbench({ db, schema, entities: [Note] });
    await app.prepareSchema();
  } finally {
    db.close();
  }
});

test('schema-owned entity table validation does not mistake commented CHECK text for a constraint', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE SchemaNote (id TEXT PRIMARY KEY, title TEXT NOT NULL /* CHECK(length(title) < 4) */, score REAL)');
    const app = workbench({ db, schema: noteSchema(), entities: [Note] });
    await app.prepareSchema();
  } finally {
    db.close();
  }
});

test('schema-owned entity table validation rejects virtual tables and TEMP shadows', async () => {
  await rejectsHostileTable(
    'CREATE VIRTUAL TABLE SchemaNote USING fts5(id, title, score)',
    /must not be virtual/i,
  );

  const db = new DatabaseSync(':memory:');
  try {
    const schema = noteSchema();
    schema.prepare(db);
    db.exec('CREATE TEMP TABLE SchemaNote (id TEXT PRIMARY KEY, title TEXT NOT NULL, score REAL)');
    const app = workbench({ db, schema, entities: [Note] });
    await assert.rejects(app.prepareSchema(), /must not have a TEMP shadow/i);
  } finally {
    db.close();
  }
});

test('schema-owned entity table validation rejects generated columns', async () => {
  await rejectsHostileTable(
    'CREATE TABLE SchemaNote (id TEXT PRIMARY KEY, title TEXT NOT NULL, score REAL, title_length INTEGER GENERATED ALWAYS AS (length(title)) STORED)',
    /hidden or generated columns/i,
  );
});

test('schema-owned entity table validation rejects unexpected indexes', async () => {
  for (const sql of [
    'CREATE UNIQUE INDEX SchemaNote_unique_title ON SchemaNote(title)',
    'CREATE INDEX SchemaNote_partial_title ON SchemaNote(title) WHERE score IS NOT NULL',
    'CREATE INDEX SchemaNote_expression_title ON SchemaNote(lower(title))',
  ]) {
    const db = new DatabaseSync(':memory:');
    try {
      const schema = noteSchema();
      schema.prepare(db);
      db.exec(sql);
      const app = workbench({ db, schema, entities: [Note] });
      await assert.rejects(app.prepareSchema(), /unexpected index/i);
    } finally {
      db.close();
    }
  }
});

test('schema-owned entity table validation rejects table-level UNIQUE constraints', async () => {
  await rejectsHostileTable(
    'CREATE TABLE SchemaNote (id TEXT PRIMARY KEY, title TEXT NOT NULL, score REAL, UNIQUE(title))',
    /unexpected index/i,
  );
});

test('schema-owned entity table validation rejects foreign key mismatches', async () => {
  await rejectsHostileTable(
    'CREATE TABLE SchemaNote (id TEXT PRIMARY KEY, title TEXT NOT NULL, score REAL, FOREIGN KEY (title) REFERENCES SchemaNote(id))',
    /foreign keys do not match/i,
  );
});

test('schema-owned entity table validation runs after migrations', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const schema = defineSqliteSchema({
      name: 'schema-note',
      tables: noteSchema().tables,
      migrations: [{ version: 17, up(innerDb) {
        innerDb.exec('CREATE TRIGGER SchemaNote_late AFTER INSERT ON SchemaNote BEGIN DELETE FROM SchemaNote WHERE id = NEW.id; END');
      } }],
    });
    const app = workbench({ db, schema, entities: [Note] });
    await assert.rejects(app.prepareSchema(), /must not have trigger/i);
  } finally {
    db.close();
  }
});

test('schema and application migrations use one version stream', () => {
  const schema = defineSqliteSchema({
    name: 'schema-note', tables: [], migrations: [{ version: 17, up() {} }],
  });
  assert.throws(() => workbench({ schema, migrations: [{ version: 17, up() {} }] }), /duplicate migration version/i);
});

test('schema migration may add a declared entity column before indexes and validation', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE SchemaNote (id TEXT PRIMARY KEY, title TEXT NOT NULL)');
    const schema = defineSqliteSchema({
      name: 'schema-note',
      tables: [{
        name: 'SchemaNote',
        columns: [
          { name: 'id', type: 'text', primaryKey: true },
          { name: 'title', type: 'text', notNull: true },
          { name: 'score', type: 'real' },
        ],
        indexes: [{ name: 'SchemaNote_score', columns: ['score'] }],
      }],
      migrations: [{ version: 18, up(innerDb) { innerDb.exec('ALTER TABLE SchemaNote ADD COLUMN score REAL'); } }],
    });
    const app = workbench({ db, schema, entities: [Note] });
    await app.prepareSchema();
    assert.ok(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'SchemaNote_score'").get());
  } finally {
    db.close();
  }
});

test('schema cannot claim a framework or generated entity side table', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const schema = defineSqliteSchema({ name: 'bad-owner', tables: [{ name: '_Log', columns: [{ name: 'id', type: 'text' }] }] });
    const app = workbench({ db, schema });
    await assert.rejects(app.prepareSchema(), /framework table/i);
  } finally {
    db.close();
  }
});

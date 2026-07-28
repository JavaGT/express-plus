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

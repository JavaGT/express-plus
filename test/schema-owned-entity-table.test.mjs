import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import workbench, { entity, number, text } from '../build/index.mjs';
import { defineSqliteSchema } from '../build/server.mjs';

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

test('app boot refuses a schema that impersonates the reserved workbench namespace — before executing any migration', async () => {
  const db = new DatabaseSync(':memory:');
  let ran = 0;
  try {
    const schema = defineSqliteSchema({
      name: 'boot-collide',
      tables: [{ name: 'T', columns: [{ name: 'id', type: 'text', primaryKey: true }] }],
      migrations: [
        { namespace: 'workbench', name: 'base', version: 5, up() { ran += 1; } },
        { namespace: 'app', name: 'seed', version: 5, up() { ran += 1; } },
      ],
    });
    assert.throws(
      () => workbench({ db, schema }),
      /reserved namespace "workbench".*only the Workbench package may own it/i,
      'the app boot path refuses the reserved-namespace schema',
    );
    assert.equal(ran, 0, 'no migration executed');
    assert.equal(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'T'").get(),
      undefined,
      'no schema table DDL executed before the refusal',
    );
    assert.equal(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_SchemaMigration'").get(),
      undefined,
      'migration ledger not touched',
    );
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
    await assert.rejects(app.prepareSchema(), /undeclared trigger/i);
  } finally {
    db.close();
  }
});

test('schema-owned entity table validation rejects undeclared CHECK constraints', async () => {
  await rejectsHostileTable(
    'CREATE TABLE SchemaNote (id TEXT PRIMARY KEY, title TEXT NOT NULL CHECK(length(title) < 4), score REAL)',
    /must not contain unsupported constraints or table options/i,
  );
});

test('schema-owned entity table validation rejects undeclared write and identity clauses', async () => {
  for (const sql of [
    'CREATE TABLE SchemaNote (id TEXT PRIMARY KEY ON CONFLICT REPLACE, title TEXT NOT NULL, score REAL)',
    'CREATE TABLE SchemaNote (id TEXT PRIMARY KEY, title TEXT NOT NULL ON CONFLICT IGNORE, score REAL)',
    'CREATE TABLE SchemaNote (id TEXT PRIMARY KEY COLLATE NOCASE, title TEXT NOT NULL, score REAL)',
    'CREATE TABLE SchemaNote (id TEXT PRIMARY KEY DESC, title TEXT NOT NULL, score REAL)',
    'CREATE TABLE SchemaNote (id TEXT, title TEXT NOT NULL, score REAL, PRIMARY KEY (id DESC))',
    'CREATE TABLE SchemaNote (id TEXT PRIMARY KEY, title TEXT NOT NULL, score REAL, FOREIGN KEY (title) REFERENCES SchemaNote(id) DEFERRABLE INITIALLY DEFERRED)',
    'CREATE TABLE SchemaNote (id TEXT PRIMARY KEY, title TEXT NOT NULL, score REAL, FOREIGN KEY (title) REFERENCES SchemaNote(id) MATCH FULL)',
    'CREATE TABLE SchemaNote (id TEXT PRIMARY KEY, title TEXT NOT NULL, score REAL) STRICT',
    'CREATE TABLE SchemaNote (id TEXT PRIMARY KEY, title TEXT NOT NULL, score REAL) WITHOUT ROWID',
  ]) {
    await rejectsHostileTable(sql, /must not contain unsupported constraints or table options/i);
  }
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
      migrations: [{ namespace: 'schema-note', name: 'late-trigger', version: 17, up(innerDb) {
        innerDb.exec('CREATE TRIGGER SchemaNote_late AFTER INSERT ON SchemaNote BEGIN DELETE FROM SchemaNote WHERE id = NEW.id; END');
      } }],
    });
    const app = workbench({ db, schema, entities: [Note] });
    await assert.rejects(app.prepareSchema(), /undeclared trigger/i);
  } finally {
    db.close();
  }
});

test('schema-owned entity table validation permits a trigger declared by the owning schema', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const schema = defineSqliteSchema({
      name: 'schema-note',
      tables: [{
        name: 'SchemaNote',
        columns: [
          { name: 'id', type: 'text', primaryKey: true },
          { name: 'title', type: 'text', notNull: true },
          { name: 'score', type: 'real' },
        ],
        triggers: [{ name: 'SchemaNote_audit', timing: 'after', event: 'insert', body: 'SELECT 1;' }],
      }],
    });
    schema.prepare(db);
    db.exec('CREATE TRIGGER SchemaNote_audit AFTER INSERT ON SchemaNote BEGIN SELECT 1; END');
    const app = workbench({ db, schema, entities: [Note] });
    await app.prepareSchema();
    assert.ok(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name = 'SchemaNote_audit'").get());
  } finally {
    db.close();
  }
});

test('schema-owned entity table validation permits a trigger owned by a registered plugin', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const schema = noteSchema();
    schema.prepare(db);
    db.exec('CREATE TRIGGER SchemaNote_plugin_audit AFTER INSERT ON SchemaNote BEGIN SELECT 1; END');
    const app = workbench({ db, schema, entities: [Note] });
    app.registerSearchPlugin({
      contractVersion: 1,
      id: 'note-audit',
      version: '1',
      ownedObjects: [{
        kind: 'trigger',
        name: 'SchemaNote_plugin_audit',
        ddl: ['CREATE TRIGGER SchemaNote_plugin_audit AFTER INSERT ON SchemaNote BEGIN SELECT 1; END'],
      }],
      sourceInterests: [],
      stalenessKey() { return null; },
      prepare() {},
      validate() {},
      reconcile() { return {}; },
      rebuild() { return {}; },
      search() { return { hits: [] }; },
    });
    await app.prepareSchema();
  } finally {
    db.close();
  }
});

test('schema and application migrations are namespaced — same version in different namespaces is legitimate (workbench#90)', () => {
  const schema = defineSqliteSchema({
    name: 'schema-note', tables: [], migrations: [{ namespace: 'schema-note', name: 'seed', version: 17, up() {} }],
  });
  // The same version in a DIFFERENT namespace is fine (no global integer merge).
  const app = workbench({ schema, migrations: [{ namespace: 'app', name: 'seed', version: 17, up() {} }] });
  assert.ok(app, 'a namespaced app migration sharing a version with a schema migration is accepted');
  // The same (namespace, version) declared in BOTH places is a duplicate.
  assert.throws(
    () => workbench({ schema, migrations: [{ namespace: 'schema-note', name: 'dup', version: 17, up() {} }] }),
    /duplicate migration version 17 in namespace "schema-note"/,
  );
  // A legacy un-namespaced app migration is refused (migrations are namespaced now).
  assert.throws(
    () => workbench({ migrations: [{ version: 17, up() {} }] }),
    /migration namespace/,
  );
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
      migrations: [{ namespace: 'schema-note', name: 'add-score', version: 18, up(innerDb) { innerDb.exec('ALTER TABLE SchemaNote ADD COLUMN score REAL'); } }],
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

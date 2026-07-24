import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { annotatedText, text, boolean, number, ref, date, json, annotation, protectingAnnotation, measurement, annotationAction } from '../src/index.mjs';
import { entity, generateDDL } from '../src/internal.mjs';
import { validateAnnotatedTextDeclaration, annotatedTextDDL, getAnnotatedTextCompiledMetadata, registerAnnotatedTextContract, registerAnnotatedTextStructuralExtension, resolveDeclarationMeasurementExtension } from '../src/annotated-text-field.mjs';

function makeFields() {
  return {
    title: text(),
    project: ref('Project'),
    owner: ref('User'),
  };
}

function fd(blockAnnotations, annotations, measurements) {
  const frozenBlock = {};
  for (const [k, v] of Object.entries(blockAnnotations || {})) frozenBlock[k] = Object.freeze({ ...v });

  const annList = [];
  for (const [family, fields] of Object.entries(annotations || {})) {
    const ff = {};
    for (const [k, v] of Object.entries(fields)) ff[k] = Object.freeze({ ...v });
    annList.push(annotation(family, { fields: ff }));
  }

  const measList = [];
  for (const [name, config] of Object.entries(measurements || { audio: { formatVersion: 1 } })) {
    measList.push(measurement(name, { formatVersion: config.formatVersion }));
  }

  return {
    project: 'project',
    owner: 'owner',
    block: frozenBlock,
    annotations: annList,
    measurements: measList,
  };
}

test('annotatedText() returns a frozen descriptor with kind annotatedText', () => {
  const d = annotatedText({ project: 'p', owner: 'o', annotations: [annotation('note')], measurements: [measurement('m', { formatVersion: 1 })] });
  assert.equal(d.kind, 'annotatedText');
  assert.equal(d.type, 'annotatedText');
  assert.ok(Object.isFrozen(d));
});

test('valid entity declaration with annotatedText, owner/project refs', () => {
  const block = { source: { kind: 'value', type: 'text' }, score: { kind: 'value', type: 'number' } };
  const annotations = [
    annotation('highlight', { fields: { col1: Object.freeze({ kind: 'value', type: 'text' }) } }),
    annotation('tag', { fields: { col2: Object.freeze({ kind: 'value', type: 'text' }) } }),
  ];
  const measurements = [measurement('audio', { formatVersion: 1 }), measurement('sentiment', { formatVersion: 2 })];
  const descriptor = fd(block, { highlight: { col1: Object.freeze({ kind: 'value', type: 'text' }) }, tag: { col2: Object.freeze({ kind: 'value', type: 'text' }) } }, { audio: { formatVersion: 1 }, sentiment: { formatVersion: 2 } });
  const fields = makeFields();
  const result = validateAnnotatedTextDeclaration('Doc', 'body', descriptor, fields);
  assert.deepEqual(result.blockFields, ['score', 'source']);
  assert.deepEqual(result.families, ['highlight', 'tag']);
  assert.deepEqual(result.measurements, ['audio', 'sentiment']);
});

test('DDL generates correct table count and names', () => {
  const descriptor = fd(
    { source: { kind: 'value', type: 'text' }, score: { kind: 'value', type: 'number' } },
    { highlight: { col1: { kind: 'value', type: 'text' } }, tag: { col2: { kind: 'value', type: 'text' } } },
  );
  const fields = makeFields();
  const ddl = annotatedTextDDL('Doc', 'body', descriptor, fields);
  const tables = ddl.filter(s => s.startsWith('CREATE TABLE'));
  const indexes = ddl.filter(s => s.startsWith('CREATE INDEX') || s.startsWith('CREATE UNIQUE INDEX'));

  assert.equal(tables.length, 8);
  assert.ok(tables.some(s => s.includes('Doc_body_block')));
  assert.ok(tables.some(s => s.includes('Doc_body_state')));
  assert.ok(tables.some(s => s.includes('Doc_body_annotation')));
  assert.ok(tables.some(s => s.includes('Doc_body_annotation_highlight')));
  assert.ok(tables.some(s => s.includes('Doc_body_annotation_tag')));
  assert.ok(tables.some(s => s.includes('Doc_body_membership')));
  assert.ok(tables.some(s => s.includes('Doc_body_measurement')));
  assert.ok(tables.some(s => s.includes('Doc_body_annotation_orphan_state')));
  assert.equal(indexes.length, 6);
});

test('block table has correct columns, constraints, and FKs', () => {
  const ddl = annotatedTextDDL('Doc', 'body', fd(
    { source: { kind: 'value', type: 'text' }, score: { kind: 'value', type: 'number' } },
    { highlight: { col1: { kind: 'value', type: 'text' } } },
  ), makeFields());
  const block = ddl.find(s => s.includes('Doc_body_block'));
  assert.ok(block.includes('id TEXT PRIMARY KEY'));
  assert.ok(block.includes('document_id TEXT NOT NULL'));
  assert.ok(block.includes('project_id TEXT NOT NULL'));
  assert.ok(block.includes('owner_id TEXT NOT NULL'));
  assert.ok(block.includes('position TEXT NOT NULL'));
  assert.ok(block.includes('epoch INTEGER NOT NULL DEFAULT 1 CHECK (epoch > 0)'));
  assert.ok(block.includes('structure_version INTEGER NOT NULL DEFAULT 1 CHECK (structure_version > 0)'));
  assert.ok(block.includes('source TEXT NOT NULL'));
  assert.ok(block.includes('score REAL NOT NULL'));
  assert.ok(block.includes('FOREIGN KEY (document_id) REFERENCES Doc(id) ON DELETE CASCADE'));
  assert.ok(block.includes('FOREIGN KEY (project_id) REFERENCES Project(id) ON DELETE CASCADE'));
  assert.ok(block.includes('FOREIGN KEY (owner_id) REFERENCES User(id) ON DELETE CASCADE'));
  assert.ok(!block.includes('body_checkpoint'));
});

test('family state is the sole canonical checkpoint relation', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('CREATE TABLE Doc (id TEXT PRIMARY KEY)');
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY)');
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY)');
  for (const sql of annotatedTextDDL('Doc', 'body', fd(
    {}, { highlight: { col1: { kind: 'value', type: 'text' } } },
  ), makeFields())) db.exec(sql);
  db.exec("INSERT INTO Doc (id) VALUES ('d1')");
  db.exec("INSERT INTO Doc_body_state (document_id, structure_version, family_checkpoint) VALUES ('d1', 0, '{}')");

  assert.throws(() => db.exec("INSERT INTO Doc_body_state (document_id, structure_version, family_checkpoint) VALUES ('d1', 0, '{}')"));
  assert.throws(() => db.exec("INSERT INTO Doc_body_state (document_id, structure_version, family_checkpoint) VALUES ('d2', -1, '{}')"));
  assert.throws(() => db.exec("INSERT INTO Doc_body_state (document_id, structure_version, family_checkpoint) VALUES ('d2', 0, 'not-json')"));
  db.exec("DELETE FROM Doc WHERE id = 'd1'");
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM Doc_body_state').get().c, 0);
});

test('annotation table has correct columns, family CHECK, and FKs', () => {
  const ddl = annotatedTextDDL('Doc', 'body', fd(
    {},
    { highlight: { col1: { kind: 'value', type: 'text' } }, tag: { col2: { kind: 'value', type: 'text' } } },
  ), makeFields());
  const ann = ddl.find(s => s.includes('Doc_body_annotation'));
  assert.ok(ann.includes('id TEXT PRIMARY KEY'));
  assert.ok(ann.includes('family TEXT NOT NULL CHECK (family IN'));
  assert.ok(ann.includes("'highlight'"));
  assert.ok(ann.includes("'tag'"));
  assert.ok(ann.includes('FOREIGN KEY (document_id) REFERENCES Doc(id) ON DELETE CASCADE'));
  assert.ok(ann.includes('FOREIGN KEY (project_id) REFERENCES Project(id) ON DELETE CASCADE'));
  assert.ok(ann.includes('FOREIGN KEY (owner_id) REFERENCES User(id) ON DELETE CASCADE'));
});

test('annotation family tables have correct columns and FK cascade', () => {
  const ddl = annotatedTextDDL('Doc', 'body', fd(
    {},
    { highlight: { col1: { kind: 'value', type: 'text' } }, tag: { col2: { kind: 'value', type: 'text' } } },
  ), makeFields());
  const hl = ddl.find(s => s.includes('Doc_body_annotation_highlight'));
  assert.ok(hl.includes('annotation_id TEXT PRIMARY KEY'));
  assert.ok(hl.includes('FOREIGN KEY (annotation_id) REFERENCES Doc_body_annotation(id) ON DELETE CASCADE'));

  const tag = ddl.find(s => s.includes('Doc_body_annotation_tag'));
  assert.ok(tag.includes('annotation_id TEXT PRIMARY KEY'));
});

test('annotation family table with no extension fields has annotation_id PK and FK', () => {
  const descriptor = fd({}, { bare: {} });
  const ddl = annotatedTextDDL('Doc', 'body', descriptor, makeFields());
  const bare = ddl.find(s => s.includes('Doc_body_annotation_bare'));
  assert.ok(bare.includes('annotation_id TEXT PRIMARY KEY'));
  assert.ok(bare.includes('FOREIGN KEY (annotation_id) REFERENCES Doc_body_annotation(id) ON DELETE CASCADE'));
});

test('membership table has correct columns, PK, and FK cascades', () => {
  const ddl = annotatedTextDDL('Doc', 'body', fd(
    {}, { highlight: { col1: { kind: 'value', type: 'text' } } },
  ), makeFields());
  const mem = ddl.find(s => s.includes('Doc_body_membership'));
  assert.ok(mem.includes('annotation_id TEXT NOT NULL'));
  assert.ok(mem.includes('block_id TEXT NOT NULL'));
  assert.ok(mem.includes('ordinal INTEGER NOT NULL CHECK (ordinal >= 0)'));
  assert.ok(mem.includes('start_point TEXT NOT NULL CHECK (json_valid(start_point))'));
  assert.ok(mem.includes('end_point TEXT NOT NULL CHECK (json_valid(end_point))'));
  assert.ok(mem.includes('PRIMARY KEY (annotation_id, ordinal)'));
  assert.ok(mem.includes('FOREIGN KEY (annotation_id) REFERENCES Doc_body_annotation(id) ON DELETE CASCADE'));
  assert.ok(mem.includes('FOREIGN KEY (block_id) REFERENCES Doc_body_block(id) ON DELETE CASCADE'));
});

test('membership tables have block-once unique index and by-block index', () => {
  const ddl = annotatedTextDDL('Doc', 'body', fd(
    {}, { highlight: { col1: { kind: 'value', type: 'text' } } },
  ), makeFields());
  const once = ddl.find(s => s.includes('idx_Doc_body_membership_block_once'));
  assert.ok(once.includes('UNIQUE INDEX'));
  assert.ok(once.includes('(annotation_id, block_id)'));

  const byBlock = ddl.find(s => s.includes('idx_Doc_body_membership_by_block'));
  assert.ok(byBlock.includes('INDEX'));
  assert.ok(byBlock.includes('(block_id, annotation_id)'));
});

test('block order index and project index exist', () => {
  const ddl = annotatedTextDDL('Doc', 'body', fd(
    {}, { highlight: { col1: { kind: 'value', type: 'text' } } },
  ), makeFields());
  const order = ddl.find(s => s.includes('idx_Doc_body_block_order'));
  assert.ok(order.includes('(document_id, position)'));

  const proj = ddl.find(s => s.includes('idx_Doc_body_block_project'));
  assert.ok(proj.includes('(project_id, document_id, position, id)'));
});

test('measurement table has correct columns, constraints, and FK', () => {
  const ddl = annotatedTextDDL('Doc', 'body', fd(
    {}, { highlight: { col1: { kind: 'value', type: 'text' } } },
    { audio: { formatVersion: 1 }, sentiment: { formatVersion: 2 } },
  ), makeFields());
  const meas = ddl.find(s => s.includes('Doc_body_measurement'));
  assert.ok(meas.includes('id TEXT PRIMARY KEY'));
  assert.ok(meas.includes('block_id TEXT NOT NULL'));
  assert.ok(meas.includes('family TEXT NOT NULL CHECK (family IN'));
  assert.ok(meas.includes("'audio'"));
  assert.ok(meas.includes("'sentiment'"));
  assert.ok(meas.includes('format_version INTEGER NOT NULL CHECK (format_version > 0)'));
  assert.ok(meas.includes('payload TEXT NOT NULL CHECK (json_valid(payload))'));
  assert.ok(meas.includes('FOREIGN KEY (block_id) REFERENCES Doc_body_block(id) ON DELETE CASCADE'));
});

test('measurement index exists', () => {
  const ddl = annotatedTextDDL('Doc', 'body', fd(
    {}, { highlight: { col1: { kind: 'value', type: 'text' } } },
  ), makeFields());
  const once = ddl.find(s => s.includes('idx_Doc_body_measurement_once'));
  assert.ok(once.includes('UNIQUE INDEX'));
  assert.ok(once.includes('(block_id, family)'));

  const idx = ddl.find(s => s.includes('idx_Doc_body_measurement_block'));
  assert.ok(idx.includes('(block_id, family, id)'));
});

test('orphan rows are one-to-one annotation state and cascade on annotation deletion', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('CREATE TABLE Doc (id TEXT PRIMARY KEY)');
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY)');
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY)');
  for (const sql of annotatedTextDDL('Doc', 'body', fd({}, { note: {} }), makeFields())) db.exec(sql);
  db.exec("INSERT INTO Project VALUES ('p')");
  db.exec("INSERT INTO User VALUES ('u')");
  db.exec("INSERT INTO Doc VALUES ('d')");
  db.exec("INSERT INTO Doc_body_annotation VALUES ('a', 'd', 'p', 'u', 'note')");
  db.exec("INSERT INTO Doc_body_annotation_orphan_state VALUES ('a', 'saved', '[]')");
  assert.throws(() => db.exec("INSERT INTO Doc_body_annotation_orphan_state VALUES ('a', 'again', '[]')"));
  db.exec("DELETE FROM Doc_body_annotation WHERE id = 'a'");
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM Doc_body_annotation_orphan_state').get().count, 0);
});

test('forged annotation descriptors cannot bypass the closed empty policy', () => {
  const forged = Object.freeze({
    kind: 'annotation', annotationName: 'note', fields: Object.freeze({}), actions: Object.freeze([]), empty: 'retain',
  });
  assert.throws(() => validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
    project: 'project', owner: 'owner', annotations: [forged], measurements: [measurement('m')],
  }), makeFields()), /must be 'delete' or 'orphan'/);
});

test('generic orphan table does not collide with an orphan annotation family', () => {
  const ddl = annotatedTextDDL('Doc', 'body', fd({}, { orphan: {} }), makeFields());
  assert.ok(ddl.some(sql => sql.includes('CREATE TABLE IF NOT EXISTS Doc_body_annotation_orphan (')));
  assert.ok(ddl.some(sql => sql.includes('CREATE TABLE IF NOT EXISTS Doc_body_annotation_orphan_state (')));
});

test('reserved orphan state family cannot collide with the generic orphan table', () => {
  assert.throws(() => annotatedTextDDL('Doc', 'body', fd({}, { orphan_state: {} }), makeFields()), /reserved internal annotation family name/);
});

test('structure_version cannot be declared as a block extension field', () => {
  assert.throws(() => annotatedTextDDL('Doc', 'body', annotatedText({
    project: 'project', owner: 'owner', block: { structure_version: text() },
    annotations: [annotation('note')], measurements: [measurement('m')],
  }), makeFields()), /reserved/);
});

test('structure version and measurement family uniqueness are enforced by SQLite', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('CREATE TABLE Doc (id TEXT PRIMARY KEY)');
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY)');
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY)');
  for (const sql of annotatedTextDDL('Doc', 'body', fd({}, { note: {} }, { audio: { formatVersion: 1 }, words: { formatVersion: 1 } }), makeFields())) db.exec(sql);
  db.exec("INSERT INTO Project VALUES ('p')");
  db.exec("INSERT INTO User VALUES ('u')");
  db.exec("INSERT INTO Doc VALUES ('d')");
  db.exec("INSERT INTO Doc_body_block (id, document_id, project_id, owner_id, position) VALUES ('b', 'd', 'p', 'u', '1')");
  assert.equal(db.prepare('SELECT structure_version FROM Doc_body_block WHERE id = ?').get('b').structure_version, 1);
  assert.throws(() => db.exec("INSERT INTO Doc_body_block (id, document_id, project_id, owner_id, position, structure_version) VALUES ('bad', 'd', 'p', 'u', '2', 0)"));
  db.exec("INSERT INTO Doc_body_measurement VALUES ('m1', 'b', 'audio', 1, '{}')");
  assert.throws(() => db.exec("INSERT INTO Doc_body_measurement VALUES ('m2', 'b', 'audio', 1, '{}')"));
  db.exec("INSERT INTO Doc_body_measurement VALUES ('m3', 'b', 'words', 1, '{}')");
});

test('main entity table has no annotatedText column', () => {
  const Doc = entity('Doc', {
    title: text(),
    project: ref('Project'),
    owner: ref('User'),
    body: annotatedText({
      project: 'project', owner: 'owner',
      block: { source: text() },
      annotations: [annotation('hl')],
      measurements: [measurement('m', { formatVersion: 1 })],
    }),
  });
  const ddl = generateDDL(Doc);
  const mainDDL = ddl.find(s => s.startsWith('CREATE TABLE IF NOT EXISTS Doc'));
  assert.ok(mainDDL, 'main Doc table DDL should exist');
  assert.ok(mainDDL.includes('id TEXT PRIMARY KEY'));
  assert.ok(!mainDDL.includes('body'), 'annotatedText field should not appear in main table');
});

test('generated tables execute against real SQLite and accept inserts', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE Doc (id TEXT PRIMARY KEY, title TEXT)');
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY)');
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY)');

  const descriptor = fd(
    { source: { kind: 'value', type: 'text' }, score: { kind: 'value', type: 'number' } },
    { highlight: { col1: { kind: 'value', type: 'text' } }, tag: { col2: { kind: 'value', type: 'text' } } },
  );
  const fields = makeFields();
  const ddl = annotatedTextDDL('Doc', 'body', descriptor, fields);
  for (const sql of ddl) db.exec(sql);

  db.exec("INSERT INTO Project (id) VALUES ('p1')");
  db.exec("INSERT INTO User (id) VALUES ('u1')");
  db.exec("INSERT INTO Doc (id, title) VALUES ('d1', 'test')");

  db.exec([
    "INSERT INTO Doc_body_block (id, document_id, project_id, owner_id, position, source, score)",
    "VALUES ('b1', 'd1', 'p1', 'u1', '0001', 'src1', 0.5)",
  ].join(' '));

  db.exec("INSERT INTO Doc_body_annotation (id, document_id, project_id, owner_id, family) VALUES ('a1', 'd1', 'p1', 'u1', 'highlight')");
  db.exec("INSERT INTO Doc_body_annotation_highlight (annotation_id, col1) VALUES ('a1', 'v1')");
  db.exec("INSERT INTO Doc_body_membership (annotation_id, block_id, ordinal, start_point, end_point) VALUES ('a1', 'b1', 0, '[1,2]', '[1,3]')");
  db.exec("INSERT INTO Doc_body_measurement (id, block_id, family, format_version, payload) VALUES ('m1', 'b1', 'audio', 1, '{}')");

  const rows = db.prepare('SELECT id, document_id, project_id, owner_id FROM Doc_body_block').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'b1');
});

test('ON DELETE CASCADE removes child rows when parent document is deleted', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('CREATE TABLE Doc (id TEXT PRIMARY KEY, title TEXT)');
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY)');
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY)');

  const descriptor = fd(
    { source: { kind: 'value', type: 'text' } },
    { highlight: { col1: { kind: 'value', type: 'text' } } },
  );
  for (const sql of annotatedTextDDL('Doc', 'body', descriptor, makeFields())) db.exec(sql);

  db.exec("INSERT INTO Project (id) VALUES ('p1')");
  db.exec("INSERT INTO User (id) VALUES ('u1')");
  db.exec("INSERT INTO Doc (id, title) VALUES ('d1', 'test')");
  db.exec("INSERT INTO Doc_body_block (id, document_id, project_id, owner_id, position, source) VALUES ('b1', 'd1', 'p1', 'u1', '0001', 'src')");
  db.exec("INSERT INTO Doc_body_annotation (id, document_id, project_id, owner_id, family) VALUES ('a1', 'd1', 'p1', 'u1', 'highlight')");
  db.exec("INSERT INTO Doc_body_annotation_highlight (annotation_id, col1) VALUES ('a1', 'v1')");
  db.exec("INSERT INTO Doc_body_membership (annotation_id, block_id, ordinal, start_point, end_point) VALUES ('a1', 'b1', 0, '[1,2]', '[1,3]')");
  db.exec("INSERT INTO Doc_body_measurement (id, block_id, family, format_version, payload) VALUES ('m1', 'b1', 'audio', 1, '{}')");

  db.exec("DELETE FROM Doc WHERE id = 'd1'");

  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM Doc_body_block').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM Doc_body_state').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM Doc_body_annotation').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM Doc_body_annotation_highlight').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM Doc_body_membership').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM Doc_body_measurement').get().c, 0);
});

test('ON DELETE CASCADE removes annotation family and membership when annotation is deleted', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('CREATE TABLE Doc (id TEXT PRIMARY KEY, title TEXT)');
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY)');
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY)');

  for (const sql of annotatedTextDDL('Doc', 'body', fd(
    { source: { kind: 'value', type: 'text' } },
    { highlight: { col1: { kind: 'value', type: 'text' } } },
  ), makeFields())) db.exec(sql);

  db.exec("INSERT INTO Project (id) VALUES ('p1')");
  db.exec("INSERT INTO User (id) VALUES ('u1')");
  db.exec("INSERT INTO Doc (id, title) VALUES ('d1', 'test')");
  db.exec("INSERT INTO Doc_body_block (id, document_id, project_id, owner_id, position, source) VALUES ('b1', 'd1', 'p1', 'u1', '0001', 'src')");
  db.exec("INSERT INTO Doc_body_annotation (id, document_id, project_id, owner_id, family) VALUES ('a1', 'd1', 'p1', 'u1', 'highlight')");
  db.exec("INSERT INTO Doc_body_annotation_highlight (annotation_id, col1) VALUES ('a1', 'v1')");
  db.exec("INSERT INTO Doc_body_membership (annotation_id, block_id, ordinal, start_point, end_point) VALUES ('a1', 'b1', 0, '[1,2]', '[1,3]')");

  db.exec("DELETE FROM Doc_body_annotation WHERE id = 'a1'");

  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM Doc_body_annotation_highlight').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM Doc_body_membership').get().c, 0);
});

test('ON DELETE CASCADE removes membership and measurement when block is deleted', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('CREATE TABLE Doc (id TEXT PRIMARY KEY, title TEXT)');
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY)');
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY)');

  for (const sql of annotatedTextDDL('Doc', 'body', fd(
    { source: { kind: 'value', type: 'text' } },
    { highlight: { col1: { kind: 'value', type: 'text' } } },
  ), makeFields())) db.exec(sql);

  db.exec("INSERT INTO Project (id) VALUES ('p1')");
  db.exec("INSERT INTO User (id) VALUES ('u1')");
  db.exec("INSERT INTO Doc (id, title) VALUES ('d1', 'test')");
  db.exec("INSERT INTO Doc_body_block (id, document_id, project_id, owner_id, position, source) VALUES ('b1', 'd1', 'p1', 'u1', '0001', 'src')");
  db.exec("INSERT INTO Doc_body_annotation (id, document_id, project_id, owner_id, family) VALUES ('a1', 'd1', 'p1', 'u1', 'highlight')");
  db.exec("INSERT INTO Doc_body_annotation_highlight (annotation_id, col1) VALUES ('a1', 'v1')");
  db.exec("INSERT INTO Doc_body_membership (annotation_id, block_id, ordinal, start_point, end_point) VALUES ('a1', 'b1', 0, '[1,2]', '[1,3]')");
  db.exec("INSERT INTO Doc_body_measurement (id, block_id, family, format_version, payload) VALUES ('m1', 'b1', 'audio', 1, '{}')");

  db.exec("DELETE FROM Doc_body_block WHERE id = 'b1'");

  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM Doc_body_membership').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM Doc_body_measurement').get().c, 0);
});

test('rejects: project field does not name an existing ref field', () => {
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'nonexistent', owner: 'owner',
      annotations: [annotation('hl')],
      measurements: [measurement('m', { formatVersion: 1 })],
    }), makeFields());
  }, /must name an enclosing ref field/);
});

test('rejects: owner field does not name an existing ref field', () => {
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'nonexistent',
      annotations: [annotation('hl')],
      measurements: [measurement('m', { formatVersion: 1 })],
    }), makeFields());
  }, /must name an enclosing ref field/);
});

test('rejects: project field is a non-ref value field', () => {
  const fields = { title: text(), project: text(), owner: ref('User') };
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [annotation('hl')],
      measurements: [measurement('m', { formatVersion: 1 })],
    }), fields);
  }, /must name an enclosing ref field with a target/);
});

test('rejects: project field is a ref without a target', () => {
  const fields = { title: text(), project: ref(), owner: ref('User') };
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [annotation('hl')],
      measurements: [measurement('m', { formatVersion: 1 })],
    }), fields);
  }, /must name an enclosing ref field with a target/);
});

test('rejects: block field with unsupported non-scalar kind', () => {
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      block: { nested: Object.freeze({ kind: 'store', type: 'map' }) },
      annotations: [annotation('hl')],
      measurements: [measurement('m', { formatVersion: 1 })],
    }), makeFields());
  }, /must be a frozen persisted scalar Workbench field descriptor/);
});

test('rejects: block field with fts index', () => {
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      block: { content: Object.freeze({ kind: 'value', type: 'text', indexed: 'fts' }) },
      annotations: [annotation('hl')],
      measurements: [measurement('m', { formatVersion: 1 })],
    }), makeFields());
  }, /uses behavior unsupported/);
});

test('rejects: block field with reserved column name id', () => {
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      block: { id: text() },
      annotations: [annotation('hl')],
      measurements: [measurement('m', { formatVersion: 1 })],
    }), makeFields());
  }, /invalid or reserved identifier/);
});

test('rejects: block field with reserved column name document_id', () => {
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      block: { document_id: text() },
      annotations: [annotation('hl')],
      measurements: [measurement('m', { formatVersion: 1 })],
    }), makeFields());
  }, /invalid or reserved identifier/);
});

test('rejects: block field with reserved column name position', () => {
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      block: { position: text() },
      annotations: [annotation('hl')],
      measurements: [measurement('m', { formatVersion: 1 })],
    }), makeFields());
  }, /invalid or reserved identifier/);
});

test('rejects: annotation family with reserved column name annotation_id', () => {
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [annotation('hl', { fields: { annotation_id: Object.freeze({ kind: 'value', type: 'text' }) } })],
      measurements: [measurement('m', { formatVersion: 1 })],
    }), makeFields());
  }, /invalid or reserved identifier/);
});

test('rejects: annotation family with reserved column name family', () => {
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [annotation('hl', { fields: { family: Object.freeze({ kind: 'value', type: 'text' }) } })],
      measurements: [measurement('m', { formatVersion: 1 })],
    }), makeFields());
  }, /invalid or reserved identifier/);
});

test('rejects: annotations is empty array', () => {
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [],
      measurements: [measurement('m', { formatVersion: 1 })],
    }), makeFields());
  }, /must declare at least one annotation/);
});

test('rejects: annotations is not an array', () => {
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: 'not-an-array',
      measurements: [measurement('m', { formatVersion: 1 })],
    }), makeFields());
  }, /must be a non-empty array/);
});

test('rejects: measurements is empty array', () => {
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [annotation('hl')],
      measurements: [],
    }), makeFields());
  }, /must declare at least one measurement/);
});

test('rejects: measurements is not an array', () => {
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [annotation('hl')],
      measurements: 'bad',
    }), makeFields());
  }, /must be a non-empty array/);
});

test('rejects: measurement formatVersion is not a positive integer', () => {
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [annotation('hl')],
      measurements: [measurement('audio', { formatVersion: 0 })],
    }), makeFields());
  }, /must be a positive integer/);
});

test('rejects: annotation family name with invalid identifier', () => {
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [annotation('123invalid')],
      measurements: [measurement('m', { formatVersion: 1 })],
    }), makeFields());
  }, /valid identifier/);
});

test('rejects: block field name with invalid identifier', () => {
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      block: { 'bad-name': text() },
      annotations: [annotation('hl')],
      measurements: [measurement('m', { formatVersion: 1 })],
    }), makeFields());
  }, /invalid or reserved identifier/);
});

test('rejects: block field with role access', () => {
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      block: { secret: Object.freeze({ kind: 'value', type: 'text', role: 'owner' }) },
      annotations: [annotation('hl')],
      measurements: [measurement('m', { formatVersion: 1 })],
    }), makeFields());
  }, /uses behavior unsupported/);
});

test('rejects: block field with blob type', () => {
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      block: { data: Object.freeze({ kind: 'value', type: 'text', blob: true }) },
      annotations: [annotation('hl')],
      measurements: [measurement('m', { formatVersion: 1 })],
    }), makeFields());
  }, /uses behavior unsupported/);
});

test('rejects: block field with access function', () => {
  assert.throws(() => {
    const withAccess = Object.freeze({ kind: 'value', type: 'text', access: () => true });
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      block: { secret: withAccess },
      annotations: [annotation('hl')],
      measurements: [measurement('m', { formatVersion: 1 })],
    }), makeFields());
  }, /uses behavior unsupported/);
});

test('valid: empty block fields produce no extension columns', () => {
  const descriptor = fd({}, { hl: { col1: { kind: 'value', type: 'text' } } });
  const ddl = annotatedTextDDL('Doc', 'body', descriptor, makeFields());
  const block = ddl.find(s => s.includes('Doc_body_block'));
  const standardCols = ['id', 'document_id', 'project_id', 'owner_id', 'position', 'epoch'];
  for (const col of standardCols) {
    assert.ok(block.includes(col), `block should have standard column ${col}`);
  }
  assert.ok(!block.includes('col1'));
  assert.ok(!block.includes('extra'));
});

test('valid: nullable block field produces nullable column', () => {
  const descriptor = fd(
    { note: Object.freeze({ kind: 'value', type: 'text', nullable: true }) },
    { hl: { col1: { kind: 'value', type: 'text' } } },
  );
  const ddl = annotatedTextDDL('Doc', 'body', descriptor, makeFields());
  const block = ddl.find(s => s.includes('Doc_body_block'));
  assert.ok(block.includes('note TEXT'));
  assert.ok(!block.includes('note TEXT NOT NULL'));
});

test('valid: optional block field produces nullable column', () => {
  const descriptor = fd(
    { note: Object.freeze({ kind: 'value', type: 'text', optional: true }) },
    { hl: { col1: { kind: 'value', type: 'text' } } },
  );
  const ddl = annotatedTextDDL('Doc', 'body', descriptor, makeFields());
  const block = ddl.find(s => s.includes('Doc_body_block'));
  assert.ok(block.includes('note TEXT'));
  assert.ok(!block.includes('note TEXT NOT NULL'));
});

test('valid: annotation family fields produce extension columns', () => {
  const descriptor = fd(
    {},
    { seg: { severity: Object.freeze({ kind: 'value', type: 'number' }), source: Object.freeze({ kind: 'value', type: 'text' }) } },
  );
  const ddl = annotatedTextDDL('Doc', 'body', descriptor, makeFields());
  const seg = ddl.find(s => s.includes('Doc_body_annotation_seg'));
  assert.ok(seg, 'annotation family table DDL should exist');
  assert.ok(seg.includes('severity REAL NOT NULL'));
  assert.ok(seg.includes('source TEXT NOT NULL'));
});

test('valid: entity() compiles with annotatedText field', () => {
  const Doc = entity('Doc', {
    title: text(),
    project: ref('Project'),
    owner: ref('User'),
    body: annotatedText({
      project: 'project', owner: 'owner',
      block: { source: text() },
      annotations: [annotation('hl', { fields: { severity: number() } })],
      measurements: [measurement('audio', { formatVersion: 1 })],
    }),
  });
  assert.ok(Doc.fields.body);
  assert.equal(Doc.fields.body.kind, 'annotatedText');
  const ddl = generateDDL(Doc);
  assert.ok(ddl.some(s => s.includes('Doc_body_block')));
  assert.ok(ddl.some(s => s.includes('Doc_body_annotation_hl')));
  assert.ok(ddl.some(s => s.includes('Doc_body_measurement')));
});

// ---- New declarative API tests ----

test('annotation() returns a frozen descriptor with correct shape', () => {
  const a = annotation('highlight', { fields: { col1: text() } });
  assert.equal(a.kind, 'annotation');
  assert.equal(a.annotationName, 'highlight');
  assert.ok(Object.isFrozen(a));
  assert.ok(Object.isFrozen(a.fields));
  assert.deepEqual(Object.keys(a.fields), ['col1']);
  assert.deepEqual(a.actions, []);
  assert.equal(a.empty, 'delete');
});

test('annotation empty policy is closed and compiled into its static handle', () => {
  assert.throws(() => annotation('bad', { empty: null }), /must be 'delete' or 'orphan'/);
  assert.throws(() => protectingAnnotation('bad', { empty: 'retain' }), /must be 'delete' or 'orphan'/);
  const descriptor = annotatedText({
    project: 'project', owner: 'owner',
    annotations: [annotation('comment', { empty: 'orphan' })],
    measurements: [measurement('m')],
  });
  validateAnnotatedTextDeclaration('Doc', 'body', descriptor, makeFields());
  assert.equal(getAnnotatedTextCompiledMetadata(descriptor).annotationHandles.comment.empty, 'orphan');
});

test('protectingAnnotation() returns a frozen descriptor with protects', () => {
  const a = protectingAnnotation('full', { fields: {}, protects: 'base', actions: [] });
  assert.equal(a.kind, 'protectingAnnotation');
  assert.equal(a.annotationName, 'full');
  assert.equal(a.protects, 'base');
  assert.ok(Object.isFrozen(a));
});

test('protectingAnnotation() rejects malformed protects', () => {
  assert.throws(() => protectingAnnotation('bad', { protects: 'invalid name!' }), /must name a valid annotation family/);
});

test('protectingAnnotation with null protects is valid', () => {
  const a = protectingAnnotation('standalone', { protects: null });
  assert.equal(a.protects, null);
});

test('validation rejects protecting annotation that references undeclared family', () => {
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [
        annotation('base'),
        protectingAnnotation('child', { protects: 'nonexistent' }),
      ],
      measurements: [measurement('m', { formatVersion: 1 })],
    }), makeFields());
  }, /does not name a declared annotation family/);
});

test('validation accepts protecting annotation that references a declared family', () => {
  const result = validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
    project: 'project', owner: 'owner',
    annotations: [
      annotation('base'),
      protectingAnnotation('child', { protects: 'base' }),
    ],
    measurements: [measurement('m', { formatVersion: 1 })],
  }), makeFields());
  assert.deepEqual(result.families, ['base', 'child']);
});

test('measurement() returns a frozen descriptor with correct shape', () => {
  const m = measurement('audio', { extension: 'ext', formatVersion: 2, queries: ['q1'] });
  assert.equal(m.kind, 'measurement');
  assert.equal(m.measurementName, 'audio');
  assert.equal(m.extension, 'ext');
  assert.equal(m.formatVersion, 2);
  assert.deepEqual(m.queries, ['q1']);
  assert.ok(Object.isFrozen(m));
  assert.ok(Object.isFrozen(m.queries));
});

test('measurement() default formatVersion is 1', () => {
  const m = measurement('audio');
  assert.equal(m.formatVersion, 1);
});

test('measurement() rejects invalid formatVersion', () => {
  assert.throws(() => measurement('x', { formatVersion: 0 }), /positive integer/);
  assert.throws(() => measurement('x', { formatVersion: 1.5 }), /positive integer/);
  assert.throws(() => measurement('x', { formatVersion: -1 }), /positive integer/);
});

test('measurement() rejects invalid extension', () => {
  assert.throws(() => measurement('x', { extension: 'bad name' }), /valid identifier/);
});

test('measurement() rejects invalid query identifiers', () => {
  assert.throws(() => measurement('x', { queries: ['bad name'] }), /valid identifier/);
});

test('annotationAction() returns a frozen descriptor', () => {
  const a = annotationAction('resolve');
  assert.equal(a.kind, 'annotationAction');
  assert.equal(a.actionName, 'resolve');
  assert.ok(Object.isFrozen(a));
});

test('annotationAction() rejects invalid name', () => {
  assert.throws(() => annotationAction(''), /valid identifier/);
});

test('validation rejects duplicate annotation names', () => {
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [annotation('dup'), annotation('dup')],
      measurements: [measurement('m', { formatVersion: 1 })],
    }), makeFields());
  }, /duplicate annotation name/);
});

test('validation rejects duplicate measurement names', () => {
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [annotation('hl')],
      measurements: [measurement('dup'), measurement('dup')],
    }), makeFields());
  }, /duplicate measurement name/);
});

test('validation rejects unknown keys on descriptor', () => {
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', {
      project: 'project', owner: 'owner',
      block: {},
      annotations: [annotation('hl')],
      measurements: [measurement('m')],
      kind: 'annotatedText',
      type: 'annotatedText',
      unknownKey: true,
    }, makeFields());
  }, /unknown key/);
});

test('validation rejects unknown keys on annotation descriptors', () => {
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [Object.freeze({ ...annotation('hl'), unknownKey: true })],
      measurements: [measurement('m')],
    }), makeFields());
  }, /unknown key/);
});

test('validation rejects unknown keys on measurement descriptors', () => {
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [annotation('hl')],
      measurements: [Object.freeze({ ...measurement('m'), unknownKey: true })],
    }), makeFields());
  }, /unknown key/);
});

test('validation rejects handlers/reducers on annotation actions at T3', () => {
  assert.throws(() => {
    const badAction = Object.freeze({ kind: 'annotationAction', actionName: 'resolve', handler: () => {} });
    const badAnn = annotation('hl', { actions: [badAction] });
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [badAnn],
      measurements: [measurement('m')],
    }), makeFields());
  }, /T3 does not accept action handlers/);
});

test('validation rejects actions referencing unregistered contracts', () => {
  assert.throws(() => {
    const badAction = annotationAction('unregisteredContract');
    const badAnn = annotation('hl', { actions: [badAction] });
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [badAnn],
      measurements: [measurement('m')],
    }), makeFields());
  }, /not a registered contract/);
});

test('validation rejects queries referencing unregistered contracts', () => {
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [annotation('hl')],
      measurements: [measurement('m', { queries: ['unregisteredQuery'] })],
    }), makeFields());
  }, /not a registered contract/);
});

test('validation rejects measurement extension referencing unregistered contract', () => {
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [annotation('hl')],
      measurements: [measurement('m', { extension: 'unregisteredExt' })],
    }), makeFields());
  }, /not a registered contract/);
});

test('registerAnnotatedTextContract validates and stores contract', () => {
  registerAnnotatedTextContract('testContract', Object.freeze({ kind: 'measurement', schema: {} }));
  registerAnnotatedTextContract('testQuery', Object.freeze({ kind: 'measurement-query' }));
  assert.throws(() => registerAnnotatedTextContract('testContract', Object.freeze({ kind: 'measurement' })), /already registered/);
  assert.throws(() => registerAnnotatedTextContract('bad name', Object.freeze({ kind: 'measurement' })), /valid identifier/);
});

test('registered contract allows validation to pass', () => {
  registerAnnotatedTextContract('myExt', Object.freeze({ kind: 'measurement', version: '1' }));
  registerAnnotatedTextContract('myQuery', Object.freeze({ kind: 'measurement-query' }));
  registerAnnotatedTextContract('myAction', Object.freeze({ kind: 'annotation-action' }));
  const result = validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
    project: 'project', owner: 'owner',
    annotations: [annotation('hl', { actions: [annotationAction('myAction')] })],
    measurements: [measurement('m', { extension: 'myExt', queries: ['myQuery'] })],
  }), makeFields());
  assert.deepEqual(result.families, ['hl']);
  assert.deepEqual(result.measurements, ['m']);
});

test('registerAnnotatedTextStructuralExtension stores and resolves', () => {
  registerAnnotatedTextStructuralExtension('speech', Object.freeze({
    version: 1,
    validate: function validate() {},
    partition: function partition() {},
    combine: function combine() {},
  }));
  const resolved = resolveDeclarationMeasurementExtension(measurement('audio', { extension: 'speech' }));
  assert.ok(resolved);
  assert.equal(resolved.version, 1);
});

test('registerAnnotatedTextStructuralExtension rejects invalid name', () => {
  assert.throws(() => registerAnnotatedTextStructuralExtension('bad name', () => {}), /valid identifier/);
});

test('registerAnnotatedTextStructuralExtension rejects duplicate', () => {
  registerAnnotatedTextStructuralExtension('uniqueExt', Object.freeze({
    version: 1,
    validate: function validate() {},
    partition: function partition() {},
    combine: function combine() {},
  }));
  assert.throws(() => registerAnnotatedTextStructuralExtension('uniqueExt', Object.freeze({
    version: 1,
    validate: function validate() {},
    partition: function partition() {},
    combine: function combine() {},
  })), /already registered/);
});

test('registerAnnotatedTextStructuralExtension rejects non-function', () => {
  assert.throws(() => registerAnnotatedTextStructuralExtension('ext2', 'not-a-fn'), /requires a frozen spec object/);
});

test('resolveDeclarationMeasurementExtension returns null for non-measurement', () => {
  assert.equal(resolveDeclarationMeasurementExtension(null), null);
  assert.equal(resolveDeclarationMeasurementExtension({ kind: 'annotation' }), null);
});

test('resolveDeclarationMeasurementExtension returns null for unregistered extension', () => {
  assert.equal(resolveDeclarationMeasurementExtension(measurement('x', { extension: 'nonexistent' })), null);
});

test('getAnnotatedTextCompiledMetadata returns compiled metadata', () => {
  const d = annotatedText({
    project: 'project', owner: 'owner',
    annotations: [annotation('hl')],
    measurements: [measurement('m')],
  });
  validateAnnotatedTextDeclaration('Doc', 'body', d, makeFields());
  const meta = getAnnotatedTextCompiledMetadata(d);
  assert.ok(meta);
  assert.ok(meta.annotationHandles);
  assert.ok(meta.measurementHandles);
  assert.ok(meta.annotationHandles.hl);
  assert.equal(meta.annotationHandles.hl.family, 'hl');
  assert.ok(meta.measurementHandles.m);
  assert.equal(meta.measurementHandles.m.family, 'm');
  assert.deepEqual(meta.blockFields, []);
  assert.deepEqual(meta.families, ['hl']);
  assert.deepEqual(meta.measurementFamilyList, ['m']);
});

test('capabilities are validated and stored in compiled metadata', () => {
  const cap = Object.freeze({ name: 'read' });
  const d = annotatedText({
    project: 'project', owner: 'owner',
    annotations: [annotation('hl')],
    measurements: [measurement('m')],
    capabilities: { readTranscript: cap },
  });
  validateAnnotatedTextDeclaration('Doc', 'body', d, makeFields());
  const meta = getAnnotatedTextCompiledMetadata(d);
  assert.ok(meta.capabilities);
  assert.ok(meta.capabilityHandles);
  assert.equal(meta.capabilityHandles.readTranscript.name, 'readTranscript');
});

test('rejects: capabilities must be an object', () => {
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [annotation('hl')],
      measurements: [measurement('m')],
      capabilities: 'not-an-object',
    }), makeFields());
  }, /must be a non-empty object/);
});

test('rejects: capabilities must be frozen', () => {
  assert.throws(() => {
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [annotation('hl')],
      measurements: [measurement('m')],
      capabilities: { x: 'not-frozen' },
    }), makeFields());
  }, /must be a frozen descriptor/);
});

// ---- T3 action validation regression tests (P1) ----

test('T3 rejects action with wrong kind (not annotationAction)', () => {
  assert.throws(() => {
    const badAction = Object.freeze({ kind: 'measurement', actionName: 'myAction' });
    const badAnn = annotation('hl', { actions: [badAction] });
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [badAnn],
      measurements: [measurement('m')],
    }), makeFields());
  }, /expected annotationAction descriptor/);
});

test('T3 rejects action with no kind field', () => {
  assert.throws(() => {
    const badAction = Object.freeze({ actionName: 'myAction' });
    const badAnn = annotation('hl', { actions: [badAction] });
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [badAnn],
      measurements: [measurement('m')],
    }), makeFields());
  }, /expected annotationAction descriptor/);
});

test('T3 rejects action with extra unknown key', () => {
  assert.throws(() => {
    const badAction = Object.freeze({ kind: 'annotationAction', actionName: 'myAction', payload: 'extra' });
    const badAnn = annotation('hl', { actions: [badAction] });
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [badAnn],
      measurements: [measurement('m')],
    }), makeFields());
  }, /unknown key/);
});

test('T3 rejects action with SQL callback', () => {
  assert.throws(() => {
    const badAction = Object.freeze({ kind: 'annotationAction', actionName: 'myAction', sql: 'DELETE FROM x' });
    const badAnn = annotation('hl', { actions: [badAction] });
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [badAnn],
      measurements: [measurement('m')],
    }), makeFields());
  }, /T3 does not accept action handlers, reducers, or SQL callbacks/);
});

test('T3 rejects action with SQL uppercase callback', () => {
  assert.throws(() => {
    const badAction = Object.freeze({ kind: 'annotationAction', actionName: 'myAction', SQL: 'DELETE FROM x' });
    const badAnn = annotation('hl', { actions: [badAction] });
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [badAnn],
      measurements: [measurement('m')],
    }), makeFields());
  }, /T3 does not accept action handlers, reducers, or SQL callbacks/);
});

test('T3 rejects action with reducer callback', () => {
  assert.throws(() => {
    const badAction = Object.freeze({ kind: 'annotationAction', actionName: 'myAction', reducer: () => ({}) });
    const badAnn = annotation('hl', { actions: [badAction] });
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [badAnn],
      measurements: [measurement('m')],
    }), makeFields());
  }, /T3 does not accept action handlers, reducers, or SQL callbacks/);
});

test('T3 rejects unfrozen action descriptor', () => {
  assert.throws(() => {
    const badAction = { kind: 'annotationAction', actionName: 'myAction' };
    const badAnn = annotation('hl', { actions: [badAction] });
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [badAnn],
      measurements: [measurement('m')],
    }), makeFields());
  }, /each action must be a frozen object/);
});

test('T3 rejects action with invalid actionName identifier', () => {
  assert.throws(() => {
    const badAction = Object.freeze({ kind: 'annotationAction', actionName: 'bad name!' });
    const badAnn = annotation('hl', { actions: [badAction] });
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [badAnn],
      measurements: [measurement('m')],
    }), makeFields());
  }, /not a valid identifier/);
});

test('T3 rejects action with wrong contract kind', () => {
  registerAnnotatedTextContract('notAnAction', Object.freeze({ kind: 'measurement', schema: {} }));
  assert.throws(() => {
    const badAction = annotationAction('notAnAction');
    const badAnn = annotation('hl', { actions: [badAction] });
    validateAnnotatedTextDeclaration('Doc', 'body', annotatedText({
      project: 'project', owner: 'owner',
      annotations: [badAnn],
      measurements: [measurement('m')],
    }), makeFields());
  }, /not an 'annotation-action' contract/);
});

// ---- ON DELETE CASCADE tests for project/owner deletion ----

test('ON DELETE CASCADE removes block and annotation rows when project is deleted', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('CREATE TABLE Doc (id TEXT PRIMARY KEY, title TEXT)');
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY)');
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY)');

  const descriptor = fd(
    { source: { kind: 'value', type: 'text' } },
    { highlight: { col1: { kind: 'value', type: 'text' } } },
  );
  for (const sql of annotatedTextDDL('Doc', 'body', descriptor, makeFields())) db.exec(sql);

  db.exec("INSERT INTO Project (id) VALUES ('p1')");
  db.exec("INSERT INTO User (id) VALUES ('u1')");
  db.exec("INSERT INTO Doc (id, title) VALUES ('d1', 'test')");
  db.exec("INSERT INTO Doc_body_block (id, document_id, project_id, owner_id, position, source) VALUES ('b1', 'd1', 'p1', 'u1', '0001', 'src')");
  db.exec("INSERT INTO Doc_body_annotation (id, document_id, project_id, owner_id, family) VALUES ('a1', 'd1', 'p1', 'u1', 'highlight')");
  db.exec("INSERT INTO Doc_body_annotation_highlight (annotation_id, col1) VALUES ('a1', 'v1')");
  db.exec("INSERT INTO Doc_body_membership (annotation_id, block_id, ordinal, start_point, end_point) VALUES ('a1', 'b1', 0, '[1,2]', '[1,3]')");
  db.exec("INSERT INTO Doc_body_measurement (id, block_id, family, format_version, payload) VALUES ('m1', 'b1', 'audio', 1, '{}')");

  db.exec("DELETE FROM Project WHERE id = 'p1'");

  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM Doc_body_block').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM Doc_body_annotation').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM Doc_body_annotation_highlight').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM Doc_body_membership').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM Doc_body_measurement').get().c, 0);
});

test('ON DELETE CASCADE removes block and annotation rows when owner is deleted', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('CREATE TABLE Doc (id TEXT PRIMARY KEY, title TEXT)');
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY)');
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY)');

  const descriptor = fd(
    { source: { kind: 'value', type: 'text' } },
    { highlight: { col1: { kind: 'value', type: 'text' } } },
  );
  for (const sql of annotatedTextDDL('Doc', 'body', descriptor, makeFields())) db.exec(sql);

  db.exec("INSERT INTO Project (id) VALUES ('p1')");
  db.exec("INSERT INTO User (id) VALUES ('u1')");
  db.exec("INSERT INTO Doc (id, title) VALUES ('d1', 'test')");
  db.exec("INSERT INTO Doc_body_block (id, document_id, project_id, owner_id, position, source) VALUES ('b1', 'd1', 'p1', 'u1', '0001', 'src')");
  db.exec("INSERT INTO Doc_body_annotation (id, document_id, project_id, owner_id, family) VALUES ('a1', 'd1', 'p1', 'u1', 'highlight')");
  db.exec("INSERT INTO Doc_body_annotation_highlight (annotation_id, col1) VALUES ('a1', 'v1')");
  db.exec("INSERT INTO Doc_body_membership (annotation_id, block_id, ordinal, start_point, end_point) VALUES ('a1', 'b1', 0, '[1,2]', '[1,3]')");
  db.exec("INSERT INTO Doc_body_measurement (id, block_id, family, format_version, payload) VALUES ('m1', 'b1', 'audio', 1, '{}')");

  db.exec("DELETE FROM User WHERE id = 'u1'");

  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM Doc_body_block').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM Doc_body_annotation').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM Doc_body_annotation_highlight').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM Doc_body_membership').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM Doc_body_measurement').get().c, 0);
});

import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { entity, list, map, number, ref, text } from '../src/index.mjs';
import { generateDDL } from '../src/ddl.mjs';
import { describeEntityStorage, describeSqliteStorage } from '../src/server.mjs';

function executeEntityDdl(entityDeclaration) {
  const db = new DatabaseSync(':memory:');
  for (const sql of generateDDL(entityDeclaration)) db.exec(sql);
  return db;
}

describe('compiled entity storage descriptions', () => {
  test('normalises the exact SQLite shape produced by the entity DDL compiler', () => {
    const Document = entity('StorageDocument', {
      title: text(),
      score: number(),
      reviewers: map(ref('User'), { role: ['owner', 'reviewer'] }),
      paragraphs: list(text()),
    });

    const expected = describeEntityStorage(Document);
    const db = executeEntityDdl(Document);
    try {
      assert.deepEqual(describeSqliteStorage(db, expected.tableNames), expected);
      assert.deepEqual(expected.tableNames, [
        'StorageDocument',
        'StorageDocument_paragraphs',
        'StorageDocument_reviewers',
      ]);
      assert.deepEqual(
        expected.tables[0].columns.map(({ name, type, primaryKeyPosition }) => ({
          name,
          type,
          primaryKeyPosition,
        })),
        [
          { name: 'id', type: 'TEXT', primaryKeyPosition: 1 },
          { name: 'title', type: 'TEXT', primaryKeyPosition: 0 },
          { name: 'score', type: 'REAL', primaryKeyPosition: 0 },
        ],
      );
    } finally {
      db.close();
    }
  });

  test('returns a deeply immutable value suitable for parity gates', () => {
    const description = describeEntityStorage(entity('FrozenStorage', { title: text() }));

    assert.equal(Object.isFrozen(description), true);
    assert.equal(Object.isFrozen(description.tableNames), true);
    assert.equal(Object.isFrozen(description.tables), true);
    assert.equal(Object.isFrozen(description.tables[0]), true);
    assert.equal(Object.isFrozen(description.tables[0].columns), true);
    assert.equal(Object.isFrozen(description.tables[0].columns[0]), true);
    assert.throws(() => description.tables.push({}), TypeError);
  });

  test('preserves write-affecting table and index semantics', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE StrictDocument (
        id TEXT PRIMARY KEY,
        title TEXT COLLATE NOCASE NOT NULL CHECK (length(title) > 0),
        titleLength INTEGER GENERATED ALWAYS AS (length(title)) STORED
      ) STRICT;
      CREATE INDEX StrictDocument_search
        ON StrictDocument(title COLLATE NOCASE DESC, (titleLength + 1) ASC)
        WHERE titleLength > 0;
    `);
    try {
      const table = describeSqliteStorage(db, ['StrictDocument']).tables[0];

      assert.equal(table.strict, true);
      assert.match(table.sql, /CHECK \(length\(title\) > 0\)/);
      assert.match(table.sql, /GENERATED ALWAYS AS/);
      const index = table.indexes.find(({ name }) => name === 'StrictDocument_search');
      assert.deepEqual(index, {
        name: 'StrictDocument_search',
        unique: false,
        origin: 'c',
        partial: true,
        sql: 'CREATE INDEX StrictDocument_search\n        ON StrictDocument(title COLLATE NOCASE DESC, (titleLength + 1) ASC)\n        WHERE titleLength > 0',
        columns: ['title', null],
        terms: [
          { sequence: 0, columnId: 1, name: 'title', descending: true, collation: 'NOCASE', key: true },
          { sequence: 1, columnId: -2, name: null, descending: false, collation: 'BINARY', key: true },
        ],
      });
    } finally {
      db.close();
    }
  });

  test('normalises caller and SQLite metadata order deterministically', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE Parent (id TEXT PRIMARY KEY);
      CREATE TABLE Child (
        id TEXT PRIMARY KEY,
        parentB TEXT REFERENCES Parent(id),
        parentA TEXT REFERENCES Parent(id)
      );
    `);
    try {
      const description = describeSqliteStorage(db, ['Parent', 'Child']);
      assert.deepEqual(description.tableNames, ['Child', 'Parent']);
      assert.deepEqual(description.tables.map(({ name }) => name), ['Child', 'Parent']);
      assert.deepEqual(
        description.tables[0].foreignKeys.map(({ columns }) => columns),
        [['parentA'], ['parentB']],
      );
    } finally {
      db.close();
    }
  });

  test('rejects non-string table names before normalising duplicates', () => {
    const db = new DatabaseSync(':memory:');
    try {
      assert.throws(() => describeSqliteStorage(db, [null]), /tableNames.*non-empty strings/i);
    } finally {
      db.close();
    }
  });

  test('fails closed when an unknown field kind reaches the DDL boundary', () => {
    assert.throws(
      () => describeEntityStorage({
        name: 'UnknownStorage',
        fields: { mystery: { kind: 'future-kind', type: 'text' } },
      }),
      /unknown field kind.*future-kind.*UnknownStorage\.mystery/i,
    );
  });

  test('fails closed when an unknown field type reaches the DDL boundary', () => {
    assert.throws(
      () => describeEntityStorage({
        name: 'UnknownStorage',
        fields: { mystery: { kind: 'value', type: 'future-type' } },
      }),
      /unknown value field type.*future-type.*UnknownStorage\.mystery/i,
    );
  });
});

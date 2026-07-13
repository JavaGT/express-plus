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

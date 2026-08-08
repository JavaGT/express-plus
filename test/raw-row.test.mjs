import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { rawRow } from '../src/entity/query.mjs';

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE note (id TEXT PRIMARY KEY, title TEXT)');
  db.exec("INSERT INTO note (id, title) VALUES ('n1', 'hello'), ('n2', 'world')");
  return db;
}

test('rawRow returns the stored row without hydration', () => {
  const db = makeDb();
  const row = rawRow(db, { name: 'note' }, 'n1');
  assert.deepEqual({ ...row }, { id: 'n1', title: 'hello' });
});

test('rawRow accepts a bare table name string', () => {
  const db = makeDb();
  const row = rawRow(db, 'note', 'n2');
  assert.deepEqual({ ...row }, { id: 'n2', title: 'world' });
});

test('rawRow returns undefined for a missing id', () => {
  const db = makeDb();
  assert.equal(rawRow(db, 'note', 'nope'), undefined);
});

test('rawRow returns undefined when the db handle is null or undefined', () => {
  assert.equal(rawRow(null, 'note', 'n1'), undefined);
  assert.equal(rawRow(undefined, 'note', 'n1'), undefined);
});

test('rawRow does not hydrate or authorize', () => {
  const db = makeDb();
  const row = rawRow(db, 'note', 'n1');
  assert.equal(Object.prototype.hasOwnProperty.call(row, 'can'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(row, 'deserialized'), false);
});

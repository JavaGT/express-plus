import { test } from 'node:test';
import assert from 'node:assert/strict';

import { frameworkTableNames, collectTableNamesFromDdl } from '../src/schema-table-census.mjs';

test('frameworkTableNames is a frozen, sorted, duplicate-free array of persistent framework tables', () => {
  assert.ok(Array.isArray(frameworkTableNames), 'frameworkTableNames must be an array');

  const expected = [
    '_ActionReceipt',
    '_ConsumerCursor',
    '_Cursor',
    '_Job',
    '_Log',
    '_Migration',
    '_ProjectedCursor',
    '_ScheduleReceipt',
    '_Worker',
    'ApiKey',
    'BlobStore',
    'Credential',
    'Inbox',
    'Invitation',
    'Session',
    'TwoFactor',
    'User',
  ];

  assert.deepStrictEqual(frameworkTableNames, expected);
  assert.ok(Object.isFrozen(frameworkTableNames));
});

test('collectTableNamesFromDdl — extracts simple CREATE TABLE names', () => {
  const result = collectTableNamesFromDdl([
    { source: 'entity A', sql: 'CREATE TABLE Widget (id INTEGER PRIMARY KEY)' },
    { source: 'entity B', sql: 'CREATE TABLE Gizmo (name TEXT)' },
  ]);

  assert.deepStrictEqual(result, ['Gizmo', 'Widget']);
});

test('collectTableNamesFromDdl — ignores leading whitespace', () => {
  const result = collectTableNamesFromDdl([
    { source: 'ws', sql: '  CREATE TABLE Spaces (id INTEGER)' },
    { source: 'ws2', sql: '\tCREATE TABLE Tabs (id INTEGER)' },
  ]);

  assert.deepStrictEqual(result, ['Spaces', 'Tabs']);
});

test('collectTableNamesFromDdl — handles IF NOT EXISTS', () => {
  const result = collectTableNamesFromDdl([
    { source: 'safe', sql: 'CREATE TABLE IF NOT EXISTS MaybeThere (id INTEGER)' },
  ]);

  assert.deepStrictEqual(result, ['MaybeThere']);
});

test('collectTableNamesFromDdl — CREATE TABLE is case-insensitive', () => {
  const result = collectTableNamesFromDdl([
    { source: 'lower', sql: 'create table Lower (id INTEGER)' },
    { source: 'mixed', sql: 'Create Table Mixed (id INTEGER)' },
    { source: 'weird', sql: 'CREATE TABLE Weird (id INTEGER)' },
  ]);

  assert.deepStrictEqual(result, ['Lower', 'Mixed', 'Weird']);
});

test('collectTableNamesFromDdl — extracts CREATE VIRTUAL TABLE names', () => {
  const result = collectTableNamesFromDdl([
    { source: 'fts', sql: 'CREATE VIRTUAL TABLE Fts USING fts5(content=?, content_rowid=?)' },
  ]);

  assert.deepStrictEqual(result, ['Fts']);
});

test('collectTableNamesFromDdl — CREATE VIRTUAL TABLE is case-insensitive', () => {
  const result = collectTableNamesFromDdl([
    { source: 'v', sql: 'create virtual table Virt (id INTEGER)' },
  ]);

  assert.deepStrictEqual(result, ['Virt']);
});

test('collectTableNamesFromDdl — accepts quoted SQLite identifiers (backtick, double-quote, bracket)', () => {
  const result = collectTableNamesFromDdl([
    { source: 'bt', sql: 'CREATE TABLE `Backtick` (id INTEGER)' },
    { source: 'dq', sql: 'CREATE TABLE "DoubleQuote" (id INTEGER)' },
    { source: 'br', sql: 'CREATE TABLE [Bracket] (id INTEGER)' },
  ]);

  assert.deepStrictEqual(result, ['Backtick', 'Bracket', 'DoubleQuote']);
});

test('collectTableNamesFromDdl — ignores CREATE INDEX / CREATE VIEW / non-table statements', () => {
  const result = collectTableNamesFromDdl([
    { source: 'idx', sql: 'CREATE INDEX idx_widget ON Widget(name)' },
    { source: 'vw', sql: 'CREATE VIEW SomeView AS SELECT 1' },
    { source: 'tbl', sql: 'CREATE TABLE ActualTable (id INTEGER)' },
    { source: 'tri', sql: 'CREATE TRIGGER t AFTER INSERT ON Widget BEGIN SELECT 1; END' },
  ]);

  assert.deepStrictEqual(result, ['ActualTable']);
});

test('collectTableNamesFromDdl — ignores SQL line comments', () => {
  const result = collectTableNamesFromDdl([
    { source: 'com1', sql: '-- CREATE TABLE Commented (id INTEGER)' },
    { source: 'com2', sql: '  -- CREATE TABLE IndentedCommented (id INTEGER)' },
    { source: 'real', sql: 'CREATE TABLE RealTable (id INTEGER)' },
  ]);

  assert.deepStrictEqual(result, ['RealTable']);
});

test('collectTableNamesFromDdl — rejects duplicate declarations case-insensitively', () => {
  assert.throws(
    () => collectTableNamesFromDdl([
      { source: 'first', sql: 'CREATE TABLE User (id INTEGER)' },
      { source: 'second', sql: 'create table user (name TEXT)' },
    ]),
    /duplicate.*(?:User|user)/i,
  );
});

test('collectTableNamesFromDdl — sorts underscore-prefixed first, then lexical', () => {
  const result = collectTableNamesFromDdl([
    { source: 'a', sql: 'CREATE TABLE _Zebra (id INTEGER)' },
    { source: 'b', sql: 'CREATE TABLE Alpha (id INTEGER)' },
    { source: 'c', sql: 'CREATE TABLE _Alpha (id INTEGER)' },
    { source: 'd', sql: 'CREATE TABLE Beta (id INTEGER)' },
  ]);

  assert.deepStrictEqual(result, ['_Alpha', '_Zebra', 'Alpha', 'Beta']);
});

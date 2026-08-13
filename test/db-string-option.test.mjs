// db-string-option.test.mjs — the `db:` option accepts a string the framework
// opens itself (a bare path or ':memory:'), so an app never imports DatabaseSync
// just to hand the framework an instance it could open from the same string.
// PRAGMAs + schema DDL run through the same default-driver bootstrap a
// pre-built handle would, and a pre-built handle still works unchanged.

import { entity, text, ref, grant, read, write, subscribe, scope } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

import workbench from '../build/internal.mjs';

// A minimal owned entity (the note.mjs floor), used to confirm a string-opened
// db yields a working app whose entity table is created by prepareSchema.
function makeNote() {
  return entity('Note', {
        body: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read),
      ),
    ],
  });
}

test('workbench({ db: ":memory:" }) yields a working app whose entity table exists', async () => {
  const app = workbench({ db: ':memory:' }).mount('/notes', makeNote());
  await app.prepareSchema();
  const row = app.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='Note'").get();
  assert.ok(row, 'the Note entity table was created by prepareSchema');
  app.db.close();
});

test('a file-path db string creates the file on disk (parent dir auto-made)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'express-db-string-'));
  const file = path.join(dir, 'sub', 'todo.db');
  const app = workbench({ db: file }).mount('/notes', makeNote());
  await app.prepareSchema();
  try {
    assert.ok(existsSync(file), 'the database file was created at the nested path');
    // the app's handle is a real DatabaseSync the framework opened from the string
    assert.ok(app.db instanceof DatabaseSync, 'app.db is a DatabaseSync instance');
    const row = app.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='Note'").get();
    assert.ok(row, 'the entity table exists in the file-backed db');
  } finally {
    app.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('passing an existing DatabaseSync instance still works (unchanged behavior)', async () => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db }).mount('/notes', makeNote());
  await app.prepareSchema();
  try {
    assert.equal(app.db, db, 'a pre-built handle is passed through unchanged');
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='Note'").get();
    assert.ok(row, 'the entity table exists on the passed-in handle');
  } finally {
    db.close();
  }
});

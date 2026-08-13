// app-scoped-db.test.mjs — the app-scoped binding supersedes the dead ambient
// db.ts (epic scope#23, S1/A5). Multiple apps in one process must resolve
// separate dbs with no process-global binding; entity queries resolve through
// each app's runtime.db (entity/compile.ts) unchanged, and a query without an
// application database fails closed loudly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  entity,
  everyone,
  grant,
  read,
  scope,
  text,
  write,
} from '../build/internal.mjs';

function noteDeclaration(name = 'AmbientNote') {
  return entity(name, {
    title: text(),
    grant: () => [scope(() => everyone()).can(() => grant(read, write))],
  });
}

test('two apps in one process resolve separate dbs — no shared process-global binding', async () => {
  const Note = noteDeclaration('IsolatedAmbientNote');
  const appA = workbench({ db: new DatabaseSync(':memory:'), entities: [Note] });
  const appB = workbench({ db: new DatabaseSync(':memory:'), entities: [Note] });
  await Promise.all([appA.prepareSchema(), appB.prepareSchema()]);

  const notesA = appA.entity(Note);
  const notesB = appB.entity(Note);
  notesA.insert({ id: 'n1', title: 'from A' });
  notesB.insert({ id: 'n1', title: 'from B' });

  assert.equal(notesA.getOrFail('n1').title, 'from A');
  assert.equal(notesB.getOrFail('n1').title, 'from B');
  assert.notEqual(appA.db, appB.db, 'each app holds its own handle');

  // An unbound declaration must not query whichever app was constructed last.
  assert.equal(Note.findById, undefined);

  appA.db.close();
  appB.db.close();
});

test('the ambient binding API is gone from the public surface', async () => {
  const internal = await import('../build/internal.mjs');
  assert.equal(internal.setActiveDb, undefined, 'setActiveDb must no longer be exported');
  assert.equal(internal.getActiveDb, undefined, 'getActiveDb must no longer be exported');
  assert.equal(internal.resetActiveDb, undefined, 'resetActiveDb must no longer be exported');

  const index = await import('../build/index.mjs');
  assert.equal(index.setActiveDb, undefined, 'index must not re-export the ambient db');
  assert.equal(index.getActiveDb, undefined);

  // src/db.ts is deleted — the build must not carry an orphaned image of it.
  await assert.rejects(
    import('../build/db.mjs'),
    (err) => /Cannot find|MODULE_NOT_FOUND|no such file|ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED/.test(String(err)),
  );
});

test('an entity query without an application database fails closed', () => {
  const Note = noteDeclaration();
  const app = workbench({ entities: [Note] }); // no db
  const bound = app.entity(Note);

  assert.throws(
    () => bound.findById('nope'),
    /entity 'AmbientNote' database operation requires an application database/,
    'a query outside an app context throws loudly instead of silently operating on nothing',
  );
  assert.throws(() => bound.insert({ id: 'nope', title: 'x' }), /requires an application database/);
});

test('an adapter-backed app installs its handle at boot and queries resolve app-scoped', async () => {
  const Note = noteDeclaration('AdapterScopedNote');
  const { createSqliteAdapter } = await import('../build/sqlite-adapter.mjs');
  const app = workbench({ db: createSqliteAdapter({ mode: 'memory' }), entities: [Note] });
  assert.equal(app.db, null, 'no handle before the deferred open');
  await app.prepareSchema();
  const notes = app.entity(Note);
  const row = notes.insert({ id: 'adapter-1', title: 'installed' });
  assert.equal(row.title, 'installed');
  assert.equal(notes.getOrFail('adapter-1').title, 'installed');
  await app.shutdown();
});

// req.doc auto-loading: an entity-bound builder mounting a `:<entity>Id`
// subtree auto-loads the parent row onto req.<entity> for every descendant
// route. A missing parent row is a 404 (the resource the handler operates on
// does not exist), not an opaque 500 from a null deref.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import expressPlus, { entity, text, ref, map, grant, read, write, allowAnonymous, generateDDL } from '../src/index.mjs';

function makeDoc() {
  return entity('Doc', {
    fields: {
      title: text(),
      owner: ref('User', { role: 'owner', readonly: true }),
      collaborators: map(ref('User'), { role: ['viewer', 'editor'] }),
    },
    grant: () => grant(read, write),
    routes: (r) => {
      r.resource();
      // A child router under /:docId/shares — req.doc is auto-loaded.
      const shares = expressPlus.router();
      shares.get('/', async (req, res) => {
        res.json({ docId: req.doc.id, title: req.doc.title });
      });
      r.use('/:docId/shares', shares);
    },
  });
}

test('req.doc is auto-loaded for a route under /:docId', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS User (id INTEGER PRIMARY KEY, username TEXT, password TEXT)');
  const Doc = makeDoc();
  for (const sql of generateDDL(Doc)) db.exec(sql);
  db.prepare("INSERT INTO Doc (id, title, owner) VALUES (1, 'Hello', 1)").run();

  const app = expressPlus({ db }).mount('/docs', Doc);
  app.listen(0, { principalOf: () => ({ type: 'user', id: '1' }) });
  await app.ready;
  const { port } = app.httpServer.address();

  const r = await fetch(`http://127.0.0.1:${port}/docs/1/shares`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.docId, 1);
  assert.equal(body.title, 'Hello');

  app.httpServer.close();
});

test('a missing parent row is 404, not a null-deref 500', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS User (id INTEGER PRIMARY KEY, username TEXT, password TEXT)');
  const Doc = makeDoc();
  for (const sql of generateDDL(Doc)) db.exec(sql);

  const app = expressPlus({ db }).mount('/docs', Doc);
  app.listen(0, { principalOf: () => ({ type: 'user', id: '1' }) });
  await app.ready;
  const { port } = app.httpServer.address();

  const r = await fetch(`http://127.0.0.1:${port}/docs/999/shares`);
  assert.equal(r.status, 404);

  app.httpServer.close();
});

test('a generic router :userId param does NOT auto-load (no entity context)', async () => {
  // The share delete route uses :userId; it is declared in a GENERIC router, so
  // no auto-load fires and req.user is undefined. The handler reads the raw param.
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS User (id INTEGER PRIMARY KEY, username TEXT, password TEXT)');
  const Doc = entity('Doc', {
    fields: { title: text(), owner: ref('User', { role: 'owner', readonly: true }) },
    grant: () => grant(read, write),
    routes: (r) => {
      r.resource();
      const shares = expressPlus.router();
      shares.delete('/:userId', async (req, res) => {
        // req.user is NOT auto-loaded (generic router) — only req.doc is.
        assert.equal(req.user, undefined);
        res.sendStatus(204);
      });
      r.use('/:docId/shares', shares);
    },
  });
  for (const sql of generateDDL(Doc)) db.exec(sql);
  db.prepare("INSERT INTO Doc (id, title, owner) VALUES (1, 'Hello', 1)").run();

  const app = expressPlus({ db }).mount('/docs', Doc);
  app.listen(0, { principalOf: () => ({ type: 'user', id: '1' }) });
  await app.ready;
  const { port } = app.httpServer.address();

  const r = await fetch(`http://127.0.0.1:${port}/docs/1/shares/42`, { method: 'DELETE' });
  assert.equal(r.status, 204);

  app.httpServer.close();
});

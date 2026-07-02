// Demo smoke tests — each demo entity imports, generates DDL, and serves CRUD.
import { User } from '../src/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import workbench, { generateDDL } from '../src/internal.mjs';

// --- Note demo ---
import { Note } from '../note.mjs';

test('note.mjs imports, generates DDL, and note CRUD works', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS User (id TEXT PRIMARY KEY, username TEXT, password TEXT)`);
  db.exec("INSERT INTO User (id, username, password) VALUES (1, 'alice', 'hash')");
  executeDDL(Note, db);

  const app = workbench({ db });
  app.mount('/notes', Note);

  const alice = { type: 'user', id: '1' };
  app.listen(0, { principalOf: () => alice });
  await app.ready;
  const { port } = app.httpServer.address();
  const origin = `http://127.0.0.1:${port}`;

  try {
    const r = await fetch(`${origin}/notes`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'hello world' }),
    });
    assert.equal(r.status, 201, 'note create');
    const doc = await r.json();
    assert.equal(doc.body, 'hello world');
    assert.equal(doc.owner, '1');
  } finally {
    app.httpServer.close();
  }
});

// --- GDOC demo ---
import { Doc as GDoc } from '../gdoc.mjs';

test('gdoc.mjs imports, generates DDL, and gdoc CRUD works', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS User (id TEXT PRIMARY KEY, username TEXT, password TEXT)`);
  db.exec("INSERT INTO User (id, username, password) VALUES (1, 'alice', 'hash')");
  executeDDL(GDoc, db);

  const app = workbench({ db });
  app.mount('/docs', GDoc);

  // Start server (avoid conflict with note.mjs port 3000 export-side listen)
  const alice = { type: 'user', id: '1' };
  app.listen(0, { principalOf: () => alice });
  await app.ready;
  const { port } = app.httpServer.address();
  const origin = `http://127.0.0.1:${port}`;

  try {
    // Create
    const r = await fetch(`${origin}/docs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'My Doc' }),
    });
    assert.equal(r.status, 201, 'gdoc create');
    const doc = await r.json();
    assert.equal(doc.title, 'My Doc');
    assert.equal(doc.owner, '1');

    // Read
    const r2 = await fetch(`${origin}/docs/${doc.id}`);
    assert.equal(r2.status, 200);
    const read = await r2.json();
    assert.equal(read.title, 'My Doc');

    // List
    const r3 = await fetch(`${origin}/docs`);
    assert.equal(r3.status, 200);
    const list = await r3.json();
    assert.ok(list.some((d) => d.id === doc.id));
  } finally {
    app.httpServer.close();
  }
});

// --- Doc/comments demo (parent-child FK inheritance) ---
import { Doc } from '../doc.mjs';
import { Comment } from '../comment.mjs';

test('doc.mjs + comment.mjs: parent-child FK inheritance works', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS User (id TEXT PRIMARY KEY, username TEXT, password TEXT)`);
  db.exec("INSERT INTO User (id, username, password) VALUES (1, 'alice', 'hash')");
  executeDDL(Doc, db);
  executeDDL(Comment, db);

  const app = workbench({ db });
  app.mount('/docs', Doc);

  const alice = { type: 'user', id: '1' };
  app.listen(0, { principalOf: () => alice });
  await app.ready;
  const { port } = app.httpServer.address();
  const origin = `http://127.0.0.1:${port}`;

  try {
    // Create a parent Doc
    const r = await fetch(`${origin}/docs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Parent Doc' }),
    });
    assert.equal(r.status, 201);
    const doc = await r.json();

    // Create a Comment under the Doc
    const r2 = await fetch(`${origin}/docs/${doc.id}/comments`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'nice doc', doc: doc.id }),
    });
    assert.equal(r2.status, 201, `comment create failed (${r2.status})`);
    const comment = await r2.json();
    assert.equal(comment.body, 'nice doc');
    assert.equal(comment.doc, String(doc.id));
  } finally {
    app.httpServer.close();
  }
});

// Helper
function executeDDL(entity, db) {
  for (const sql of generateDDL(entity)) {
    db.exec(sql);
  }
}

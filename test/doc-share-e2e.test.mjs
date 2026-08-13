// doc.mjs share routes — the binding exemplar — end-to-end over HTTP.
//
// These routes tie together three features this session landed: req.doc
// auto-loading (/:docId), the map handle .set/.toArray (collaborators), and the
// findAll(predicate).sort().limit() query builder (the /feed route). Proving
// them against the REAL doc.mjs (not a re-declared stand-in) is the binding
// use-case validation.

import { User, Inbox } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import workbench, { executeDDL } from '../build/internal.mjs';
import { Doc } from '../projects/doc.mjs';

function setup() {
  const db = new DatabaseSync(':memory:');
  executeDDL(User, db);
  executeDDL(Doc, db);
  executeDDL(Inbox, db);
  // alice owns the doc; bob is the invitee.
  db.prepare("INSERT INTO User (id, username, password) VALUES (1, 'alice', 'salt:a')").run();
  db.prepare("INSERT INTO User (id, username, password) VALUES (2, 'bob', 'salt:b')").run();
  return db;
}

async function stopApp(app) {
  await app.shutdown();
}

test('doc.mjs share routes: list (empty), add, list (populated), remove', async (t) => {
  const db = setup();
  const app = workbench({ db }).mount('/docs', Doc);
  t.after(() => app.shutdown());
  app.listen(0, { principalOf: () => ({ type: 'user', id: '1' }) });
  await app.ready;
  const { port } = app.httpServer.address();
  const origin = `http://127.0.0.1:${port}`;

  try {
    // Create a doc as alice.
    const created = await fetch(`${origin}/docs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Shared Doc' }),
    });
    assert.equal(created.status, 201, await created.clone().text());
    const doc = await created.json();

    // List shares — empty.
    const empty = await fetch(`${origin}/docs/${doc.id}/shares`);
    assert.equal(empty.status, 200);
    assert.deepEqual((await empty.json()).shares, []);

    // Add bob as editor.
    const added = await fetch(`${origin}/docs/${doc.id}/shares`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: '2', role: 'editor' }),
    });
    assert.equal(added.status, 201, await added.clone().text());
    const addBody = await added.json();
    assert.equal(addBody.sharedWith.id, '2');
    assert.equal(addBody.sharedWith.role, 'editor');

    // List shares — bob appears, populated+hydrated (username, not a raw hash).
    const listed = await fetch(`${origin}/docs/${doc.id}/shares`);
    assert.equal(listed.status, 200);
    const shares = (await listed.json()).shares;
    assert.equal(shares.length, 1);
    assert.equal(shares[0].id, '2');
    assert.equal(shares[0].username, 'bob');
    assert.equal(shares[0].role, 'editor');

    // Remove bob.
    const removed = await fetch(`${origin}/docs/${doc.id}/shares/2`, { method: 'DELETE' });
    assert.equal(removed.status, 204);

    // List shares — empty again.
    const after = await fetch(`${origin}/docs/${doc.id}/shares`);
    assert.deepEqual((await after.json()).shares, []);
  } finally {
    await stopApp(app);
  }
});

test('doc.mjs /feed: owned + shared via findAll(predicate).sort().limit()', async (t) => {
  const db = setup();
  const app = workbench({ db }).mount('/docs', Doc);
  t.after(() => app.shutdown());
  app.listen(0, { principalOf: () => ({ type: 'user', id: '1' }) });
  await app.ready;
  const { port } = app.httpServer.address();
  const origin = `http://127.0.0.1:${port}`;

  try {
    // alice creates a doc; bob creates one and shares it back to alice.
    const a = await fetch(`${origin}/docs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Alices doc' }),
    });
    assert.equal(a.status, 201, await a.clone().text());
    const aDoc = await a.json();

    // bob creates a doc by swapping the principal via a second app on the same db.
    await stopApp(app);
    const app2 = workbench({ db }).mount('/docs', Doc);
    t.after(() => app2.shutdown());
    app2.listen(0, { principalOf: () => ({ type: 'user', id: '2' }) });
    await app2.ready;
    const port2 = app2.httpServer.address().port;
    const origin2 = `http://127.0.0.1:${port2}`;

    const b = await fetch(`${origin2}/docs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Bobs doc' }),
    });
    assert.equal(b.status, 201, await b.clone().text());
    const bDoc = await b.json();
    // bob shares bDoc with alice.
    const shared = await fetch(`${origin2}/docs/${bDoc.id}/shares`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: '1', role: 'viewer' }),
    });
    assert.equal(shared.status, 201, await shared.clone().text());
    await stopApp(app2);

    // Back as alice: /feed lists her owned doc AND the doc bob shared with her.
    const app3 = workbench({ db }).mount('/docs', Doc);
    t.after(() => app3.shutdown());
    app3.listen(0, { principalOf: () => ({ type: 'user', id: '1' }) });
    await app3.ready;
    const port3 = app3.httpServer.address().port;

    const feed = await fetch(`http://127.0.0.1:${port3}/docs/feed`);
    assert.equal(feed.status, 200);
    const body = await feed.json();
    assert.ok(body.owned.some((d) => d.id === aDoc.id), 'alice sees her own doc in owned');
    assert.ok(body.shared.some((d) => d.id === bDoc.id), 'alice sees bobs shared doc in shared');

    await stopApp(app3);
  } finally {
    // servers already closed above
  }
});

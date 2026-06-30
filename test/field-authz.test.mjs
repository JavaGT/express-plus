// Field-level capability authorization for map handles.
//
// A map field with `.can(fn)` stores an `access` function on its descriptor;
// this test proves that the access function IS evaluated at runtime when the
// row is loaded with a principal (the request path), and that the trusted
// query API (no principal) bypasses field authz — mirroring mayVerb, which
// also runs only in dispatch, never on the query API (DECISIONLOG #41).
//
// Tests 1-3 are the RED tests: they currently 201/200/204 because the access
// function has never been evaluated. After implementation, a principal who
// cannot even READ the doc is denied at the read-scope (404 — fail closed, no
// existence leak, consistent with snapshot/events-since: tests 1+2); a principal
// who CAN read but lacks the write/remove capability is denied by the field
// `.can` body (403: test 3).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import expressPlus, { executeDDL, User, Inbox, createServer, executeFrameworkDDL } from '../src/index.mjs';
import { Doc } from '../doc.mjs';
import { setActiveDb } from '../src/db.mjs';

// ---- helpers ---------------------------------------------------------------

function setup() {
  const db = new DatabaseSync(':memory:');
  executeDDL(User, db);
  executeDDL(Doc, db);
  executeDDL(Inbox, db);
  db.prepare("INSERT INTO User (id, username, password) VALUES (1, 'alice', 'salt:a')").run();
  db.prepare("INSERT INTO User (id, username, password) VALUES (2, 'bob', 'salt:b')").run();
  return db;
}

// Start an app with the given principal and return { app, origin, port }.
async function startApp(db, principalId) {
  const app = expressPlus({ db }).mount('/docs', Doc);
  app.listen(0, { principalOf: () => ({ type: 'user', id: principalId }) });
  await app.ready;
  const { port } = app.httpServer.address();
  return { app, origin: `http://127.0.0.1:${port}`, port };
}

// Create a doc via HTTP as the current principal and return { id }.
async function createDoc(origin) {
  const created = await fetch(`${origin}/docs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Authz Test Doc' }),
  });
  assert.equal(created.status, 201, 'expected 201 creating doc');
  return await created.json();
}

// ---- tests -----------------------------------------------------------------

test('Non-owner (non-reader) cannot add a collaborator (404, denied at read-scope)', async () => {
  const db = setup();
  // Create doc as alice.
  const aliceApp = await startApp(db, '1');
  const doc = await createDoc(aliceApp.origin);
  aliceApp.app.httpServer.close();

  // Try to add collaborator as bob. bob is neither owner nor collaborator, so
  // the read-scope excludes the doc entirely → 404 (fail closed: bob must not
  // even learn the doc exists), not 403 (which the pre-H1 bypass produced by
  // loading the row unscoped then denying downstream).
  const bobApp = await startApp(db, '2');
  try {
    const added = await fetch(`${bobApp.origin}/docs/${doc.id}/shares`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: '2', role: 'editor' }),
    });
    assert.equal(added.status, 404, 'non-reader must be denied at read-scope (404)');
  } finally {
    bobApp.app.httpServer.close();
  }
});

test('Non-owner (non-reader) cannot list shares (404, denied at read-scope)', async () => {
  const db = setup();
  // Create doc as alice.
  const aliceApp = await startApp(db, '1');
  const doc = await createDoc(aliceApp.origin);
  aliceApp.app.httpServer.close();

  // Try to list shares as bob (non-reader) → 404 at read-scope (fail closed).
  const bobApp = await startApp(db, '2');
  try {
    const listed = await fetch(`${bobApp.origin}/docs/${doc.id}/shares`);
    assert.equal(listed.status, 404, 'non-reader must be denied at read-scope (404)');
  } finally {
    bobApp.app.httpServer.close();
  }
});

test('Non-owner cannot remove a collaborator (403)', async () => {
  const db = setup();
  // Create doc as alice, add bob as editor.
  const aliceApp = await startApp(db, '1');
  const doc = await createDoc(aliceApp.origin);
  const added = await fetch(`${aliceApp.origin}/docs/${doc.id}/shares`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: '2', role: 'editor' }),
  });
  assert.equal(added.status, 201, 'owner must be able to add collaborator');
  aliceApp.app.httpServer.close();

  // Try to remove bob as bob.
  const bobApp = await startApp(db, '2');
  try {
    const removed = await fetch(`${bobApp.origin}/docs/${doc.id}/shares/2`, { method: 'DELETE' });
    assert.equal(removed.status, 403, 'non-owner removing collaborator must 403');
  } finally {
    bobApp.app.httpServer.close();
  }
});

test('Owner can manage collaborators (regression guard)', async () => {
  const db = setup();
  const { app, origin } = await startApp(db, '1');
  try {
    const doc = await createDoc(origin);

    // POST share bob → 201.
    const added = await fetch(`${origin}/docs/${doc.id}/shares`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: '2', role: 'editor' }),
    });
    assert.equal(added.status, 201);
    const addBody = await added.json();
    assert.equal(addBody.sharedWith.id, '2');
    assert.equal(addBody.sharedWith.role, 'editor');

    // GET shares → 200 with bob.
    const listed = await fetch(`${origin}/docs/${doc.id}/shares`);
    assert.equal(listed.status, 200);
    const shares = (await listed.json()).shares;
    assert.equal(shares.length, 1);
    assert.equal(shares[0].id, '2');
    assert.equal(shares[0].username, 'bob');
    assert.equal(shares[0].role, 'editor');

    // DELETE bob → 204.
    const removed = await fetch(`${origin}/docs/${doc.id}/shares/2`, { method: 'DELETE' });
    assert.equal(removed.status, 204);

    // GET shares → 200 [].
    const after = await fetch(`${origin}/docs/${doc.id}/shares`);
    assert.deepEqual((await after.json()).shares, []);
  } finally {
    app.httpServer.close();
  }
});

test('Trusted query API (no principal) bypasses field authz (mechanics)', async (t) => {
  const db = new DatabaseSync(':memory:');
  setActiveDb(db);
  executeFrameworkDDL(db);
  executeDDL(User, db);
  executeDDL(Doc, db);
  executeDDL(Inbox, db);
  db.prepare("INSERT INTO User (id, username, password) VALUES (1, 'alice', 'salt:a')").run();
  db.prepare("INSERT INTO User (id, username, password) VALUES (2, 'bob', 'salt:b')").run();
  // Insert a doc row directly — the trusted query API bypasses the create
  // dispatch, so owner must be set by raw SQL (the dispatch path owns the
  // principal→owner assignment; the query API is unscoped — DECISIONLOG #41).
  db.prepare("INSERT INTO Doc (id, title, owner) VALUES (1, 'Trusted Test', 1)").run();

  const server = await createServer({
    db,
    handlers: Doc.crudHandlers,
    projections: [Doc.projection],
    authorize: async () => true,
    postHandlerAuthorize: async () => true,
  });
  t.after(() => db.close());

  const doc = Doc.hydrate({ id: '1' }, null, server.dispatch);
  assert.ok(doc, 'doc must exist');

  // set with no principal: field authz is bypassed (trusted query path).
  await doc.collaborators.set('2', { role: 'viewer' });
  assert.equal(doc.collaborators.has('2'), true, 'trusted set must succeed');

  // Confirm it persists in the side-table.
  const sideRow = db.prepare('SELECT 1 FROM Doc_collaborators WHERE Doc_id = 1 AND member_id = \'2\'').get();
  assert.ok(sideRow, 'member must exist in side-table');
});
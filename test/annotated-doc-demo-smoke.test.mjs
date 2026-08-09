// Floor-demo smoke: create + insert through the annotated-doc public seams.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createAnnotatedTextHttpSession } from '../public/workbench-client.mjs';
import { createAnnotatedDocApp } from '../projects/annotated-doc/server.mjs';

test('annotated-doc migration adds a color for legacy comments', async (t) => {
  const db = new DatabaseSync(':memory:');
  const initial = createAnnotatedDocApp({ db });
  await initial.app.prepareSchema();
  db.exec(`
    DROP TABLE _Migration;
    DROP TABLE Doc_body_annotation_comment;
    CREATE TABLE Doc_body_annotation_comment (
      annotation_id TEXT PRIMARY KEY,
      FOREIGN KEY (annotation_id) REFERENCES Doc_body_annotation(id) ON DELETE CASCADE
    );
  `);
  const migrated = createAnnotatedDocApp({ db });
  await migrated.app.start();
  t.after(async () => migrated.app.shutdown());
  assert.deepEqual(
    db.prepare('PRAGMA table_info(Doc_body_annotation_comment)').all().map((column) => column.name),
    ['annotation_id', 'color'],
  );
});

test('annotated-doc migration rebuilds the annotation family CHECK to include sensitive and confidential', async (t) => {
  const db = new DatabaseSync(':memory:');
  const initial = createAnnotatedDocApp({ db });
  await initial.app.prepareSchema();
  db.exec(`
    DROP TABLE _Migration;
    DROP TABLE Doc_body_annotation;
    CREATE TABLE Doc_body_annotation (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      family TEXT NOT NULL CHECK (family IN ('comment')),
      FOREIGN KEY (document_id) REFERENCES Doc(id) ON DELETE CASCADE,
      FOREIGN KEY (project_id) REFERENCES Project(id) ON DELETE CASCADE,
      FOREIGN KEY (owner_id) REFERENCES User(id) ON DELETE CASCADE
    );
  `);
  const migrated = createAnnotatedDocApp({ db });
  await migrated.app.start();
  t.after(async () => migrated.app.shutdown());
  const sql = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'Doc_body_annotation'`).get().sql;
  assert.match(sql, /family IN \('comment', 'sensitive', 'confidential'\)/);
});

test('annotated-doc demo creates a document and inserts via the document session', async (t) => {
  const { app, principalOf } = createAnnotatedDocApp({ db: ':memory:' });
  app.listen(0, { principalOf });
  await app.ready;
  t.after(async () => {
    app.httpServer.closeAllConnections?.();
    await app.shutdown();
  });

  app.db.prepare(`INSERT OR IGNORE INTO User (id, username) VALUES ('demo', 'demo')`).run();
  app.db.prepare(`INSERT OR IGNORE INTO Project (id, owner) VALUES ('p1', 'demo')`).run();

  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;
  const handleSource = await (await fetch(`${origin}/client-handle.mjs`)).text();
  const handleUrl = `data:text/javascript;base64,${Buffer.from(handleSource).toString('base64')}`;
  const { DocClient } = await import(handleUrl);
  assert.deepEqual(Object.keys(DocClient.body.annotations), ['comment', 'sensitive', 'confidential']);
  assert.deepEqual(Object.keys(DocClient.body.measurements), []);

  const listEmpty = await fetch(`${origin}/docs`);
  assert.equal(listEmpty.status, 200);
  assert.deepEqual(await listEmpty.json(), { docs: [] });

  const created = await fetch(`${origin}/docs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: 'smoke-tab' }),
  });
  assert.equal(created.status, 201);
  const { id } = await created.json();
  assert.equal(typeof id, 'string');
  assert.ok(id.length > 0);

  let actionNumber = 0;
  const sources = [];
  const session = createAnnotatedTextHttpSession({
    baseUrl: `${origin}/live-delivery`,
    context: { entity: DocClient, field: DocClient.body, documentId: id },
    historySession: 'smoke-tab',
    createActionId: () => `smoke-${++actionNumber}`,
    eventSourceFactory: () => {
      const source = { close() {}, onmessage: null, onerror: null };
      sources.push(source);
      return source;
    },
  });
  t.after(() => session.close());

  await session.ready;
  assert.equal(session.document.text, '');

  // Per-keystroke inserts (distinct actors) — select-all delete must sort spans by op id.
  for (const ch of 'hello') {
    const inserted = await session.insert({
      mutationId: `smoke-ins-${ch}-${++actionNumber}`,
      at: { offset: session.document.text.length, affinity: 'right' },
      text: ch,
    });
    assert.equal(inserted.ok, true, inserted.failure?.message);
    assert.equal((await inserted.settlement.wait()).status, 'reconciled');
  }
  assert.equal(session.document.text, 'hello');

  const marked = await session.applyAnnotationAction(DocClient.body.annotations.comment.actions.compose, {
    mutationId: 'smoke-comment',
    from: { offset: 1, affinity: 'right' },
    to: { offset: 4, affinity: 'right' },
    values: { body: 'A smoke thread' },
  });
  assert.equal(marked.ok, true, marked.failure?.message);
  assert.equal((await marked.settlement.wait()).status, 'reconciled');
  assert.equal(session.document.annotations.length, 1);
  const annotationId = session.document.annotations[0].id;
  const threads = await (await fetch(`${origin}/docs/${encodeURIComponent(id)}`)).json();
  assert.deepEqual(threads.threads, [{
    annotationId,
    id: app.db.prepare('SELECT id FROM Comment').get().id,
    author: 'demo',
    body: 'A smoke thread',
    resolved: 0,
  }]);
  const commentId = threads.threads[0].id;
  const directComment = await fetch(`${origin}/snapshot/Comment/${encodeURIComponent(commentId)}`);
  assert.equal(directComment.status, 403);
  const unauthorizedComment = await fetch(`${origin}/snapshot/Comment/${encodeURIComponent(commentId)}?viewAs=reader`);
  assert.equal(unauthorizedComment.status, 403);

  // Select-all delete: clear the whole continuous document in one delete.
  const deleted = await session.delete({
    mutationId: 'smoke-del',
    from: { offset: 0, affinity: 'right' },
    to: { offset: session.document.text.length, affinity: 'right' },
  });
  assert.equal(deleted.ok, true, deleted.failure?.message);
  assert.equal((await deleted.settlement.wait()).status, 'reconciled');
  assert.equal(session.document.text, '');

  const listed = await (await fetch(`${origin}/docs`)).json();
  assert.equal(listed.docs.length, 1);
  assert.equal(listed.docs[0].id, id);
});

test('annotated-doc demo deletes a document via DELETE /docs/:id', async (t) => {
  const { app, principalOf } = createAnnotatedDocApp({ db: ':memory:' });
  app.listen(0, { principalOf });
  await app.ready;
  t.after(async () => {
    app.httpServer.closeAllConnections?.();
    await app.shutdown();
  });

  app.db.prepare(`INSERT OR IGNORE INTO User (id, username) VALUES ('demo', 'demo')`).run();
  app.db.prepare(`INSERT OR IGNORE INTO User (id, username) VALUES ('reader', 'reader')`).run();
  app.db.prepare(`INSERT OR IGNORE INTO Project (id, owner) VALUES ('p1', 'demo')`).run();

  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;

  const created = await fetch(`${origin}/docs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: 'delete-smoke' }),
  });
  assert.equal(created.status, 201);
  const { id } = await created.json();

  // The fixed reader principal is not the owner — delete is denied.
  const denied = await fetch(`${origin}/docs/${id}?viewAs=reader`, { method: 'DELETE' });
  assert.equal(denied.status, 403);

  // The owner (demo, default) can delete; the document leaves the list and the
  // erasure directive removes its receipts and events.
  const deleted = await fetch(`${origin}/docs/${id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { ok: true, id });

  const listed = await (await fetch(`${origin}/docs`)).json();
  assert.equal(listed.docs.length, 0);

  const receipts = app.db.prepare(
    `SELECT COUNT(*) AS count FROM _ActionReceipt WHERE json_extract(actionData, '$.id') = ?`,
  ).get(id).count;
  assert.equal(receipts, 0);

  // Re-deleting an already-deleted document fails cleanly.
  const again = await fetch(`${origin}/docs/${id}`, { method: 'DELETE' });
  assert.equal(again.status, 400);
});

test('annotated-doc demo deletes a document that carries a confidential span', async (t) => {
  const { app, principalOf } = createAnnotatedDocApp({ db: ':memory:' });
  app.listen(0, { principalOf });
  await app.ready;
  t.after(async () => {
    app.httpServer.closeAllConnections?.();
    await app.shutdown();
  });

  app.db.prepare(`INSERT OR IGNORE INTO User (id, username) VALUES ('demo', 'demo')`).run();
  app.db.prepare(`INSERT OR IGNORE INTO Project (id, owner) VALUES ('p1', 'demo')`).run();

  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;
  const handleSource = await (await fetch(`${origin}/client-handle.mjs`)).text();
  const handleUrl = `data:text/javascript;base64,${Buffer.from(handleSource).toString('base64')}`;
  const { DocClient } = await import(handleUrl);

  const created = await fetch(`${origin}/docs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: 'conf-delete' }),
  });
  const { id } = await created.json();

  let actionNumber = 0;
  const session = createAnnotatedTextHttpSession({
    baseUrl: `${origin}/live-delivery`,
    context: { entity: DocClient, field: DocClient.body, documentId: id },
    historySession: 'conf-delete',
    createActionId: () => `conf-delete-${++actionNumber}`,
    eventSourceFactory: () => ({ close() {}, onmessage: null, onerror: null }),
  });
  t.after(() => session.close());
  await session.ready;

  const text = 'classified secret';
  const inserted = await session.insert({
    mutationId: 'conf-insert',
    at: { offset: 0, affinity: 'right' },
    text,
  });
  assert.equal(inserted.ok, true, inserted.failure?.message);
  assert.equal((await inserted.settlement.wait()).status, 'reconciled');

  const sensitive = await session.applyAnnotation({
    mutationId: 'conf-sensitive',
    annotation: { id: 'conf-sensitive', family: 'sensitive', fields: {} },
    from: { offset: 0, affinity: 'right' },
    to: { offset: text.length, affinity: 'right' },
  });
  assert.equal(sensitive.ok, true, sensitive.failure?.message);
  assert.equal((await sensitive.settlement.wait()).status, 'reconciled');
  const confidential = await session.applyAnnotation({
    mutationId: 'conf-confidential',
    annotation: { id: 'conf-confidential', family: 'confidential', fields: {}, protectedTargetIds: ['conf-sensitive'] },
    from: { offset: 0, affinity: 'right' },
    to: { offset: text.length, affinity: 'right' },
  });
  assert.equal(confidential.ok, true, confidential.failure?.message);
  assert.equal((await confidential.settlement.wait()).status, 'reconciled');
  assert.equal(app.db.prepare(
    'SELECT COUNT(*) AS count FROM Doc_body_annotation_protected_target',
  ).get().count, 1);

  const deleted = await fetch(`${origin}/docs/${id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200, (await deleted.text()));
  assert.equal(app.db.prepare("SELECT COUNT(*) AS count FROM Doc WHERE id = ?").get(id).count, 0);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM Doc_body_annotation').get().count, 0);
});

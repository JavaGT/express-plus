// Floor-demo smoke: create + insert through the annotated-doc public seams.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createAnnotatedTextHttpSession } from '../public/workbench-client.mjs';
import { projectEndpointToOffset } from '../public/workbench-annotated-text-continuous.mjs';
import { createAnnotatedDocApp } from '../projects/annotated-doc/server.mjs';

function rangeOffsets(session, range) {
  if (!range) return range;
  if (typeof range.start === 'number') return { start: range.start, end: range.end };
  return {
    start: projectEndpointToOffset(session.family, range.start),
    end: projectEndpointToOffset(session.family, range.end),
  };
}

test('annotated-doc migration adds a color for legacy comments', async (t) => {
  const db = new DatabaseSync(':memory:');
  const initial = createAnnotatedDocApp({ db });
  await initial.app.prepareSchema();
  db.exec(`
    DROP TABLE _SchemaMigration;
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
    ['annotation_id', 'color', 'resolved'],
  );
});

test('annotated-doc migration rebuilds the annotation family CHECK to include sensitive, confidential, and code', async (t) => {
  const db = new DatabaseSync(':memory:');
  const initial = createAnnotatedDocApp({ db });
  await initial.app.prepareSchema();
  db.exec(`
    DROP TABLE _SchemaMigration;
    DROP TABLE _SchemaMaintenance;
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
  assert.match(sql, /family IN \('comment', 'sensitive', 'confidential', 'code'\)/);
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
  assert.deepEqual(Object.keys(DocClient.body.annotations), ['code', 'comment', 'sensitive', 'confidential']);
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

test('a composed comment keeps an end insert outside and absorbs a start insert, through fold and export', async (t) => {
  const { app, principalOf, Doc, Project } = createAnnotatedDocApp({ db: ':memory:' });
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
  const { exportAnnotatedText } = await import('../build/index.mjs');

  const created = await fetch(`${origin}/docs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: 'affinity-tab' }),
  });
  const { id } = await created.json();

  let actionNumber = 0;
  const session = createAnnotatedTextHttpSession({
    baseUrl: `${origin}/live-delivery`,
    context: { entity: DocClient, field: DocClient.body, documentId: id },
    historySession: 'affinity-tab',
    createActionId: () => `affinity-${++actionNumber}`,
    eventSourceFactory: () => ({ close() {}, onmessage: null, onerror: null }),
  });
  t.after(() => session.close());
  await session.ready;

  const inserted = await session.insert({
    mutationId: 'affinity-ins',
    at: { offset: 0, affinity: 'right' },
    text: '1234567890',
  });
  assert.equal(inserted.ok, true, inserted.failure?.message);
  assert.equal((await inserted.settlement.wait()).status, 'reconciled');

  const composed = await session.applyAnnotationAction(DocClient.body.annotations.comment.actions.compose, {
    mutationId: 'affinity-compose',
    from: { offset: 2, affinity: 'right' },
    to: { offset: 4, affinity: 'right' },
    values: { body: 'affinity' },
  });
  assert.equal(composed.ok, true, composed.failure?.message);
  assert.equal((await composed.settlement.wait()).status, 'reconciled');
  const annotationId = session.document.annotations[0].id;
  const rangeOf = () => session.document.ranges.find((candidate) => candidate.annotationId === annotationId);
  assert.deepEqual(rangeOffsets(session, rangeOf()), { start: 2, end: 4 });

  // The documented boundary contract (demo README): an insert AT the range
  // START joins the comment, an insert AT its END stays outside.
  const insertedStart = await session.insert({
    mutationId: 'affinity-start',
    at: { offset: 2, affinity: 'right' },
    text: 'L',
  });
  assert.equal(insertedStart.ok, true, insertedStart.failure?.message);
  assert.equal((await insertedStart.settlement.wait()).status, 'reconciled');
  assert.equal(session.document.text, '12L34567890');
  assert.deepEqual(rangeOffsets(session, rangeOf()), { start: 2, end: 5 }, 'start insert joins the comment');

  const insertedEnd = await session.insert({
    mutationId: 'affinity-end',
    at: { offset: 5, affinity: 'right' },
    text: 'R',
  });
  assert.equal(insertedEnd.ok, true, insertedEnd.failure?.message);
  assert.equal((await insertedEnd.settlement.wait()).status, 'reconciled');
  assert.equal(session.document.text, '12L34R567890');
  assert.deepEqual(rangeOffsets(session, rangeOf()), { start: 2, end: 5 }, 'end insert stays outside the comment');

  // The committed range survives canonical export with the same boundary.
  const exported = await exportAnnotatedText({
    app, entity: Doc, field: Doc.body, documentId: id,
    expectedOwningScope: { entity: Project, id: 'p1' },
    principal: { id: 'demo' },
  });
  const canonicalRange = exported.ranges.find((candidate) => candidate.annotationId === annotationId);
  assert.deepEqual({ start: canonicalRange.start, end: canonicalRange.end }, { start: 2, end: 5 });
  assert.equal(exported.text, '12L34R567890');
});

test('a confidential span keeps an end insert outside and absorbs a start insert, through fold and export', async (t) => {
  const { app, principalOf, Doc, Project } = createAnnotatedDocApp({ db: ':memory:' });
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
  const { exportAnnotatedText } = await import('../build/index.mjs');

  const created = await fetch(`${origin}/docs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: 'conf-aff-tab' }),
  });
  const { id } = await created.json();

  let actionNumber = 0;
  const session = createAnnotatedTextHttpSession({
    baseUrl: `${origin}/live-delivery`,
    context: { entity: DocClient, field: DocClient.body, documentId: id },
    historySession: 'conf-aff-tab',
    createActionId: () => `conf-aff-${++actionNumber}`,
    eventSourceFactory: () => ({ close() {}, onmessage: null, onerror: null }),
  });
  t.after(() => session.close());
  await session.ready;

  const inserted = await session.insert({
    mutationId: 'conf-aff-ins',
    at: { offset: 0, affinity: 'right' },
    text: 'hello secret world',
  });
  assert.equal(inserted.ok, true, inserted.failure?.message);
  assert.equal((await inserted.settlement.wait()).status, 'reconciled');

  // The demo's Mark confidential flow: a `sensitive` target applied over the
  // selection (its end leans 'right'), then a protecting `confidential` span
  // over the same range. The sensitive range is what projects to the reader's
  // redacted region.
  const sensitive = await session.applyAnnotation({
    mutationId: 'conf-aff-sens',
    annotation: { id: 'conf-aff-sensitive', family: 'sensitive', fields: {} },
    from: { offset: 6, affinity: 'right' },
    to: { offset: 12, affinity: 'right' },
  });
  assert.equal(sensitive.ok, true, sensitive.failure?.message);
  assert.equal((await sensitive.settlement.wait()).status, 'reconciled');
  const confidential = await session.applyAnnotation({
    mutationId: 'conf-aff-conf',
    annotation: { id: 'conf-aff-confidential', family: 'confidential', fields: {}, protectedTargetIds: ['conf-aff-sensitive'] },
    from: { offset: 6, affinity: 'right' },
    to: { offset: 12, affinity: 'right' },
  });
  assert.equal(confidential.ok, true, confidential.failure?.message);
  assert.equal((await confidential.settlement.wait()).status, 'reconciled');

  const sensitiveRange = () => session.document.ranges
    .find((candidate) => session.document.annotations.find((entry) => entry.id === candidate.annotationId)?.family === 'sensitive');
  assert.deepEqual(rangeOffsets(session, sensitiveRange()), { start: 6, end: 12 });

  // Boundary contract (same locked affinity as comments): an insert AT the
  // range START joins the confidential span, an insert AT its END stays
  // outside the redacted region.
  const insertedStart = await session.insert({
    mutationId: 'conf-aff-start',
    at: { offset: 6, affinity: 'right' },
    text: 'L',
  });
  assert.equal(insertedStart.ok, true, insertedStart.failure?.message);
  assert.equal((await insertedStart.settlement.wait()).status, 'reconciled');
  assert.equal(session.document.text, 'hello Lsecret world');
  assert.deepEqual(rangeOffsets(session, sensitiveRange()), { start: 6, end: 13 }, 'start insert joins the confidential span');

  const insertedEnd = await session.insert({
    mutationId: 'conf-aff-end',
    at: { offset: 13, affinity: 'right' },
    text: 'R',
  });
  assert.equal(insertedEnd.ok, true, insertedEnd.failure?.message);
  assert.equal((await insertedEnd.settlement.wait()).status, 'reconciled');
  assert.equal(session.document.text, 'hello LsecretR world');
  assert.deepEqual(rangeOffsets(session, sensitiveRange()), { start: 6, end: 13 }, 'end insert stays outside the confidential span');

  // The committed boundaries survive canonical export.
  const exported = await exportAnnotatedText({
    app, entity: Doc, field: Doc.body, documentId: id,
    expectedOwningScope: { entity: Project, id: 'p1' },
    principal: { id: 'demo' },
  });
  const canonical = exported.ranges
    .find((candidate) => exported.annotations.find((entry) => entry.id === candidate.annotationId)?.family === 'sensitive');
  assert.deepEqual({ start: canonical.start, end: canonical.end }, { start: 6, end: 13 });
  assert.equal(exported.text, 'hello LsecretR world');
});

test('annotated-doc resolve action toggles the comment marker field through the Commit loop', async (t) => {
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
  const resolveHandle = DocClient.body.annotations.comment.actions.resolve;
  assert.equal(resolveHandle.kind, 'annotationAction');
  assert.deepEqual(resolveHandle.inputNames, ['resolved']);

  const created = await fetch(`${origin}/docs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: 'resolve-tab' }),
  });
  const { id } = await created.json();

  let actionNumber = 0;
  const session = createAnnotatedTextHttpSession({
    baseUrl: `${origin}/live-delivery`,
    context: { entity: DocClient, field: DocClient.body, documentId: id },
    historySession: 'resolve-tab',
    createActionId: () => `resolve-${++actionNumber}`,
    eventSourceFactory: () => ({ close() {}, onmessage: null, onerror: null }),
  });
  t.after(() => session.close());
  await session.ready;

  const inserted = await session.insert({
    mutationId: 'resolve-ins',
    at: { offset: 0, affinity: 'right' },
    text: 'hello world',
  });
  assert.equal(inserted.ok, true, inserted.failure?.message);
  assert.equal((await inserted.settlement.wait()).status, 'reconciled');

  const composed = await session.applyAnnotationAction(DocClient.body.annotations.comment.actions.compose, {
    mutationId: 'resolve-compose',
    from: { offset: 0, affinity: 'right' },
    to: { offset: 5, affinity: 'right' },
    values: { body: 'resolve me' },
  });
  assert.equal(composed.ok, true, composed.failure?.message);
  assert.equal((await composed.settlement.wait()).status, 'reconciled');
  const annotationId = session.document.annotations[0].id;
  const range = session.document.ranges.find((candidate) => candidate.annotationId === annotationId);
  assert.deepEqual(rangeOffsets(session, range), { start: 0, end: 5 });
  const resolvedSpan = rangeOffsets(session, range);

  // Resolve: the action contributes only `resolved` over the current record.
  const resolved = await session.applyAnnotationAction(resolveHandle, {
    mutationId: 'resolve-set',
    from: { offset: resolvedSpan.start, affinity: 'right' },
    to: { offset: resolvedSpan.end, affinity: 'right' },
    values: { resolved: true },
  });
  assert.equal(resolved.ok, true, resolved.failure?.message);
  assert.equal((await resolved.settlement.wait()).status, 'reconciled');
  assert.equal(session.document.annotations.find((candidate) => candidate.id === annotationId).fields.resolved, true);

  // Reopen: the same action flips the field back and the color/comment refs survive.
  const reopened = await session.applyAnnotationAction(resolveHandle, {
    mutationId: 'resolve-unset',
    from: { offset: resolvedSpan.start, affinity: 'right' },
    to: { offset: resolvedSpan.end, affinity: 'right' },
    values: { resolved: false },
  });
  assert.equal(reopened.ok, true, reopened.failure?.message);
  assert.equal((await reopened.settlement.wait()).status, 'reconciled');
  assert.equal(session.document.annotations.find((candidate) => candidate.id === annotationId).fields.resolved, false);

  // The threads projection reads the marker field (one source of truth).
  const threads = await (await fetch(`${origin}/docs/${encodeURIComponent(id)}`)).json();
  assert.equal(threads.threads[0].resolved, 0);

  // Unknown or missing resolve input fails closed.
  const invalid = await session.applyAnnotationAction(resolveHandle, {
    mutationId: 'resolve-bad',
    from: { offset: 0, affinity: 'right' },
    to: { offset: 5, affinity: 'right' },
    values: { resolved: 'yes' },
  });
  assert.equal(invalid.ok, false);
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

test('the codebook stores code name + color centrally and code annotations reference it', async (t) => {
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
  const handleSource = await (await fetch(`${origin}/client-handle.mjs`)).text();
  const handleUrl = `data:text/javascript;base64,${Buffer.from(handleSource).toString('base64')}`;
  const { DocClient } = await import(handleUrl);
  assert.equal(DocClient.body.annotations.code.annotationName, 'code');
  assert.deepEqual(DocClient.body.annotations.code.actions, {});

  // The reader cannot change the codebook; the owner can create a code.
  const readerDenied = await fetch(`${origin}/codes?viewAs=reader`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Nope', color: '#fecaca' }),
  });
  assert.equal(readerDenied.status, 403);

  const empty = await (await fetch(`${origin}/codes`)).json();
  assert.deepEqual(empty, { codes: [] });

  const created = await fetch(`${origin}/codes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Question', color: '#bbf7d0' }),
  });
  assert.equal(created.status, 201);
  const { id: codeId } = await created.json();
  assert.equal(typeof codeId, 'string');
  const listed = await (await fetch(`${origin}/codes`)).json();
  assert.deepEqual(listed.codes, [{ id: codeId, name: 'Question', color: '#bbf7d0' }]);

  const createdDoc = await fetch(`${origin}/docs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: 'codebook-tab' }),
  });
  const { id } = await createdDoc.json();

  let actionNumber = 0;
  const session = createAnnotatedTextHttpSession({
    baseUrl: `${origin}/live-delivery`,
    context: { entity: DocClient, field: DocClient.body, documentId: id },
    historySession: 'codebook-tab',
    createActionId: () => `codebook-${++actionNumber}`,
    eventSourceFactory: () => ({ close() {}, onmessage: null, onerror: null }),
  });
  t.after(() => session.close());
  await session.ready;

  const inserted = await session.insert({
    mutationId: 'codebook-ins',
    at: { offset: 0, affinity: 'right' },
    text: 'hello world',
  });
  assert.equal(inserted.ok, true, inserted.failure?.message);
  assert.equal((await inserted.settlement.wait()).status, 'reconciled');

  // Apply the code to a range. The annotation stores only the Code row id.
  const applied = await session.applyAnnotation({
    mutationId: 'codebook-apply',
    annotation: { id: 'codebook-ann', family: 'code', fields: { code: codeId } },
    from: { offset: 0, affinity: 'right' },
    to: { offset: 5, affinity: 'right' },
  });
  assert.equal(applied.ok, true, applied.failure?.message);
  assert.equal((await applied.settlement.wait()).status, 'reconciled');
  const annotation = session.document.annotations.find((candidate) => candidate.id === 'codebook-ann');
  assert.equal(annotation.family, 'code');
  assert.deepEqual(annotation.fields, { code: codeId });
  const range = session.document.ranges.find((candidate) => candidate.annotationId === 'codebook-ann');
  assert.deepEqual(rangeOffsets(session, range), { start: 0, end: 5 });

  // Rename then recolor the code centrally (two separate updates, so the
  // annotation's Code reference stays the same row): every range tagged with it
  // follows automatically.
  const renamed = await fetch(`${origin}/codes/${encodeURIComponent(codeId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Urgent' }),
  });
  assert.equal(renamed.status, 200);
  const recolored = await fetch(`${origin}/codes/${encodeURIComponent(codeId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ color: '#fecaca' }),
  });
  assert.equal(recolored.status, 200);
  const after = await (await fetch(`${origin}/codes`)).json();
  assert.deepEqual(after.codes, [{ id: codeId, name: 'Urgent', color: '#fecaca' }]);
  assert.deepEqual(
    app.db.prepare('SELECT annotation_id, code FROM Doc_body_annotation_code').all().map((row) => ({ ...row })),
    [{ annotation_id: 'codebook-ann', code: codeId }],
  );

  // A code still applied to a range cannot be deleted (friendly 409, not a raw
  // FK error); after the annotation is removed the delete succeeds.
  const inUse = await fetch(`${origin}/codes/${encodeURIComponent(codeId)}`, { method: 'DELETE' });
  assert.equal(inUse.status, 409);
  const removed = await session.removeAnnotation({ mutationId: 'codebook-remove', annotationId: 'codebook-ann' });
  assert.equal(removed.ok, true, removed.failure?.message);
  assert.equal((await removed.settlement.wait()).status, 'reconciled');
  const deleted = await fetch(`${origin}/codes/${encodeURIComponent(codeId)}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await (await fetch(`${origin}/codes`)).json(), { codes: [] });
});

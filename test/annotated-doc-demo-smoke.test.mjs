// Floor-demo smoke: create + insert through the annotated-doc public seams.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createAnnotatedTextHttpSession } from '../public/workbench-client.mjs';
import { createAnnotatedDocApp } from '../projects/annotated-doc/server.mjs';

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
  assert.deepEqual(Object.keys(DocClient.body.annotations), ['comment']);
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
  assert.equal(session.document.blocks.length, 1);
  assert.equal(session.document.blocks[0].text, '');
  const blockId = session.document.blocks[0].id;

  // Per-keystroke inserts (distinct actors) — select-all delete must sort spans by op id.
  for (const ch of 'hello') {
    const block = session.document.blocks[0];
    const inserted = await session.insert({
      mutationId: `smoke-ins-${ch}-${++actionNumber}`,
      at: { blockId: block.id, offset: block.text.length, affinity: 'right' },
      text: ch,
    });
    assert.equal(inserted.ok, true, inserted.failure?.message);
    assert.equal((await inserted.settlement.wait()).status, 'reconciled');
  }
  assert.equal(session.document.blocks[0].text, 'hello');

  const marked = await session.applyAnnotation({
    mutationId: 'smoke-comment',
    annotation: { id: 'smoke-comment', family: 'comment', fields: {} },
    from: { blockId, offset: 1, affinity: 'right' },
    to: { blockId, offset: 4, affinity: 'right' },
  });
  assert.equal(marked.ok, true, marked.failure?.message);
  assert.equal((await marked.settlement.wait()).status, 'reconciled');
  assert.equal(session.document.annotations.length, 1);
  assert.equal(session.document.annotations[0].id, 'smoke-comment');

  const len = session.document.blocks[0].text.length;
  const deleted = await session.delete({
    mutationId: 'smoke-del-all',
    from: { blockId, offset: 0, affinity: 'right' },
    to: { blockId, offset: len, affinity: 'right' },
  });
  assert.equal(deleted.ok, true, deleted.failure?.message);
  assert.equal((await deleted.settlement.wait()).status, 'reconciled');
  assert.equal(session.document.blocks[0].text, '');

  const listed = await (await fetch(`${origin}/docs`)).json();
  assert.equal(listed.docs.length, 1);
  assert.equal(listed.docs[0].id, id);
});

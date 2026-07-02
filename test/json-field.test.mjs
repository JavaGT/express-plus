import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import workbench, { entity, json, scope, grant, read, write, subscribe } from '../src/index.mjs';
import { principal } from '../src/principal.mjs';

function documentEntity() {
  return entity('JsonDocument', {
    fields: {
      meta: json({ tags: 'string[]', nested: 'object' }),
    },
    grant: () => [
      scope(({ fields }) => fields.meta.is({ visible: true, rank: 1 }))
        .can(() => grant(read, write, subscribe)),
    ],
  });
}

async function serveJsonDocuments(t) {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db });
  const JsonDocument = documentEntity();
  app.mount('/json-documents', JsonDocument);
  await app.ddl();
  app.listen(0, { principalOf: () => principal({ type: 'user', id: 'alice' }) });
  await app.ready;
  t.after(() => {
    app.httpServer.close();
    db.close();
  });
  return { app, db, origin: `http://127.0.0.1:${app.httpServer.address().port}`, JsonDocument };
}

test('json fields store as TEXT and round-trip as objects over CRUD HTTP', async (t) => {
  const { db, origin } = await serveJsonDocuments(t);
  const meta = { visible: true, rank: 1 };

  const create = await fetch(`${origin}/json-documents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ meta }),
  });

  assert.equal(create.status, 201);
  const created = await create.json();
  assert.deepEqual(created.meta, meta);
  assert.equal(typeof db.prepare('SELECT meta FROM JsonDocument WHERE id = ?').get(created.id).meta, 'string');

  const readResult = await fetch(`${origin}/json-documents/${created.id}`);
  assert.equal(readResult.status, 200);
  assert.deepEqual((await readResult.json()).meta, meta);

  const nextMeta = { visible: true, rank: 1, tags: ['scope'], nested: { ok: true } };
  const update = await fetch(`${origin}/json-documents/${created.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ meta: nextMeta }),
  });
  assert.equal(update.status, 200);
  assert.deepEqual((await update.json()).meta, nextMeta);
});

test('json scope equality uses the same stored-cell serialization as writes', async (t) => {
  const { db, origin } = await serveJsonDocuments(t);
  db.prepare('INSERT INTO JsonDocument (id, meta) VALUES (?, ?)')
    .run('visible', JSON.stringify({ visible: true, rank: 1 }));
  db.prepare('INSERT INTO JsonDocument (id, meta) VALUES (?, ?)')
    .run('hidden', JSON.stringify({ visible: false, rank: 1 }));

  const response = await fetch(`${origin}/json-documents`);
  assert.equal(response.status, 200);
  const rows = await response.json();

  assert.deepEqual(rows.map((row) => row.id), ['visible']);
  assert.deepEqual(rows[0].meta, { visible: true, rank: 1 });
});

test('json fields deserialize through trusted query hydration', async (t) => {
  const { db, JsonDocument } = await serveJsonDocuments(t);
  const meta = { visible: true, rank: 1 };
  db.prepare('INSERT INTO JsonDocument (id, meta) VALUES (?, ?)')
    .run('visible', JSON.stringify(meta));

  const found = JsonDocument.getOrFail('visible');
  assert.deepEqual(found.meta, meta);

  const rows = await JsonDocument.findAll();
  assert.deepEqual(rows[0].meta, meta);
});

test('snapshot endpoint returns json fields as public objects', async (t) => {
  const { db, origin } = await serveJsonDocuments(t);
  const meta = { visible: true, rank: 1 };
  db.prepare('INSERT INTO JsonDocument (id, meta) VALUES (?, ?)')
    .run('visible', JSON.stringify(meta));

  const response = await fetch(`${origin}/snapshot/JsonDocument/visible`);
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.deepEqual(body.snapshot.meta, meta);
  assert.equal(body.seq, 0);
});

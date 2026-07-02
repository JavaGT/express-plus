// projected.async — stored computed fields updated by post-commit projection
// (ADR #12, SPEC §5.3).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  entity,
  text,
  number,
  projected,
  raster,
  polyline,
  enum_,
  ref,
  scope,
  grant,
  read,
  write,
  subscribe,
  never,
  everyone,
  resolveStrategy,
  validateMutation,
  ValidationError,
  createProjectedAsyncConsumer,
  resolveProjectedAsyncTriggerTypes,
} from '../src/index.mjs';
import { principal } from '../src/principal.mjs';
import { setActiveDb } from '../src/db.mjs';

// --- Slice 1: declaration + DDL ---

test('projected.async constructor validates compute is a function', () => {
  assert.throws(() => projected.async({}), /compute function/);
  assert.throws(() => projected.async({ compute: 'not a fn' }), /compute function/);
  const d = projected.async({ compute: async (row) => row.x });
  assert.equal(d.kind, 'projected');
  assert.equal(d.mode, 'async');
  assert.equal(d.readonly, true);
  assert.equal(typeof d.compute, 'function');
});

test('projected kind resolves to a strategy with validate, apply, diff, serialize, deserialize', () => {
  const s = resolveStrategy('projected');
  assert.equal(typeof s.validate, 'function');
  assert.equal(typeof s.apply, 'function');
  assert.equal(typeof s.diff, 'function');
  assert.equal(typeof s.serialize, 'function');
  assert.equal(typeof s.deserialize, 'function');
});

test('projected value serializes to JSON and back', () => {
  const s = resolveStrategy('projected');
  assert.equal(s.serialize(null), null);
  assert.equal(s.serialize(undefined), undefined);
  assert.equal(s.serialize(42), '42');
  assert.deepEqual(s.deserialize('42'), 42);
  assert.deepEqual(s.deserialize('[1,2]'), [1, 2]);
  assert.deepEqual(s.deserialize('{"a":1}'), { a: 1 });
  assert.equal(s.deserialize(null), null);
  assert.equal(s.deserialize(undefined), undefined);
});

test('an entity with a projected.async field compiles and generates DDL', () => {
  const Post = entity('Post', {
    fields: {
      title: text(),
      score: number(),
      hotRank: projected.async({ compute: async (row) => row?.score * 2 }),
    },
    grant: () => [scope(() => everyone()).can(() => grant(read))],
  });
  assert.equal(Post.name, 'Post');
  assert.deepEqual(Object.keys(Post.fields).sort(), ['hotRank', 'score', 'title']);
  assert.equal(Post.fields.hotRank.readonly, true);
  assert.equal(Post.fields.hotRank.kind, 'projected');
  assert.equal(Post.projectedAsyncFields.length, 1);
});

test('a projected field is readonly — validateMutation rejects client writes', () => {
  assert.throws(
    () => validateMutation(
      { fields: { rank: projected.async({ compute: async (r) => r }) } },
      { rank: 42 },
    ),
    ValidationError,
    'readonly projected field rejected',
  );
});

// --- Slice 2: post-commit compute + write-back ---

test('projected.async consumer owns trigger selection, compute, write-back, and cursor advance', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE PostDirect (id TEXT, title TEXT, score REAL, hotRank TEXT)');
  db.exec("INSERT INTO PostDirect (id, title, score) VALUES ('p1', 'Direct', 7)");
  const PostDirect = entity('PostDirect', {
    fields: {
      title: text(),
      score: number(),
      hotRank: projected.async({
        from: 'updated',
        compute: async (row, { db: computeDb }) => {
          assert.equal(computeDb, db);
          return row.score * 4;
        },
      }),
    },
    grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });
  const { executeFrameworkDDL } = await import('../src/ddl.mjs');
  executeFrameworkDDL(db);
  const consumer = createProjectedAsyncConsumer({ entities: new Map([[PostDirect.name, PostDirect]]) });

  await consumer([{ type: 'PostDirect.created', scope: 'PostDirect:p1', data: { id: 'p1' } }], { db });
  let row = db.prepare("SELECT hotRank FROM PostDirect WHERE id = 'p1'").get();
  assert.equal(row.hotRank, null);
  assert.deepEqual(resolveProjectedAsyncTriggerTypes(PostDirect.fields.hotRank, 'PostDirect'), ['PostDirect.updated']);

  await consumer([{ type: 'PostDirect.updated', scope: 'PostDirect:p1', data: { id: 'p1', score: 7 } }], { db });
  row = db.prepare("SELECT hotRank FROM PostDirect WHERE id = 'p1'").get();
  assert.equal(JSON.parse(row.hotRank), 28);
  const cursor = db.prepare(
    "SELECT lastSeq FROM _ProjectedCursor WHERE entity = 'PostDirect' AND field = 'hotRank'",
  ).get();
  assert.equal(cursor.lastSeq, 1);
  db.close();
});

test('projected.async value is computed and stored after create dispatch', async (t) => {
  const db = new DatabaseSync(':memory:');
  setActiveDb(db);
  db.exec('CREATE TABLE Post (id TEXT, title TEXT, score REAL, hotRank TEXT)');

  const Post = entity('Post', {
    fields: {
      title: text(),
      score: number(),
      hotRank: projected.async({
        compute: async (row) => (row.score ?? 0) * 2,
      }),
    },
    grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });

  const app = workbench({ db });
  app.mount('/posts', Post);
  app.listen(0, { principalOf: () => principal({ type: 'user', id: 'alice' }) });
  await app.ready;
  t.after(() => { app.httpServer.close(); db.close(); });
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;

  const res = await fetch(`${origin}/posts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Test', score: 42 }),
  });
  assert.equal(res.status, 201);

  await new Promise((resolve) => setTimeout(resolve, 100));

  const row = db.prepare('SELECT hotRank FROM Post WHERE title = :t').get({ t: 'Test' });
  assert.ok(row, 'row exists');
  assert.equal(JSON.parse(row.hotRank), 84, `hotRank should be 84, got ${row.hotRank}`);
});

test('projected.async compute receives the committed db handle', async (t) => {
  const appDb = new DatabaseSync(':memory:');
  const ambientDb = new DatabaseSync(':memory:');
  setActiveDb(appDb);
  appDb.exec('CREATE TABLE PostCtx (id TEXT, title TEXT, score REAL, hotRank TEXT)');
  ambientDb.exec('CREATE TABLE PostCtx (id TEXT, title TEXT, score REAL, hotRank TEXT)');

  const PostCtx = entity('PostCtx', {
    fields: {
      title: text(),
      score: number(),
      hotRank: projected.async({
        compute: async (row, { db }) => {
          assert.equal(db, appDb);
          assert.notEqual(db, ambientDb);
          const stored = db.prepare('SELECT score FROM PostCtx WHERE id = :id').get({ id: row.id });
          return stored.score * 2;
        },
      }),
    },
    grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });

  const app = workbench({ db: appDb });
  app.mount('/postctx', PostCtx);
  app.listen(0, { principalOf: () => principal({ type: 'user', id: 'alice' }) });
  await app.ready;
  t.after(() => { app.httpServer.close(); appDb.close(); ambientDb.close(); });
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;

  const res = await fetch(`${origin}/postctx`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Test', score: 21 }),
  });
  assert.equal(res.status, 201);

  await new Promise((resolve) => setTimeout(resolve, 100));

  const row = appDb.prepare('SELECT hotRank FROM PostCtx WHERE title = :t').get({ t: 'Test' });
  assert.ok(row, 'row exists');
  assert.equal(JSON.parse(row.hotRank), 42);
});

test('projected.async value is recomputed after update', async (t) => {
  const db = new DatabaseSync(':memory:');
  setActiveDb(db);
  db.exec('CREATE TABLE Post (id TEXT, title TEXT, score REAL, hotRank TEXT)');

  const Post = entity('Post', {
    fields: {
      title: text(),
      score: number(),
      hotRank: projected.async({
        compute: async (row) => (row.score ?? 0) * 3,
      }),
    },
    grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });

  const app = workbench({ db });
  app.mount('/posts', Post);
  app.listen(0, { principalOf: () => principal({ type: 'user', id: 'alice' }) });
  await app.ready;
  t.after(() => { app.httpServer.close(); db.close(); });
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;

  const r1 = await fetch(`${origin}/posts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Post', score: 10 }),
  });
  const created = await r1.json();
  // Wait for post-commit projection to finish and verify initial value
  let row;
  for (let i = 0; i < 20; i++) {
    row = db.prepare('SELECT hotRank FROM Post WHERE id = :id').get({ id: created.id });
    if (row?.hotRank != null) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(JSON.parse(row.hotRank), 30, `initial: should be 30, got ${row.hotRank}`);

  await fetch(`${origin}/posts/${created.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ score: 20 }),
  });
  for (let i = 0; i < 20; i++) {
    row = db.prepare('SELECT hotRank FROM Post WHERE id = :id').get({ id: created.id });
    if (row?.hotRank && JSON.parse(row.hotRank) === 60) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(JSON.parse(row.hotRank), 60, `after update should be 60, got ${row.hotRank}`);
});

test('projected.async compute failure leaves the column unchanged', async (t) => {
  const db = new DatabaseSync(':memory:');
  setActiveDb(db);
  db.exec('CREATE TABLE Post (id TEXT, title TEXT, score REAL, hotRank TEXT)');

  const Post = entity('Post', {
    fields: {
      title: text(),
      score: number(),
      hotRank: projected.async({
        compute: async (row) => {
          if (row.score < 0) throw new Error('negative');
          return row.score * 10;
        },
      }),
    },
    grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });

  const app = workbench({ db });
  app.mount('/posts', Post);
  app.listen(0, { principalOf: () => principal({ type: 'user', id: 'alice' }) });
  await app.ready;
  t.after(() => { app.httpServer.close(); db.close(); });
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;

  const r1 = await fetch(`${origin}/posts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Good', score: 5 }),
  });
  const created = await r1.json();
  let row;
  for (let i = 0; i < 20; i++) {
    row = db.prepare('SELECT hotRank FROM Post WHERE id = :id').get({ id: created.id });
    if (row?.hotRank != null) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(JSON.parse(row.hotRank), 50);

  await fetch(`${origin}/posts/${created.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ score: -1 }),
  });
  for (let i = 0; i < 20; i++) {
    row = db.prepare('SELECT hotRank FROM Post WHERE id = :id').get({ id: created.id });
    if (row?.hotRank != null && JSON.parse(row.hotRank) !== 50) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
    // If compute fails, value stays at 50 — wait for any change then check
  }
  await new Promise((resolve) => setTimeout(resolve, 50));

  row = db.prepare('SELECT hotRank FROM Post WHERE id = :id').get({ id: created.id });
  assert.equal(JSON.parse(row.hotRank), 50, 'failed compute did not overwrite');
});

test('projected.async field is rejected in client create payload (readonly)', async (t) => {
  const db = new DatabaseSync(':memory:');
  setActiveDb(db);
  db.exec('CREATE TABLE Post (id TEXT, title TEXT, score REAL, hotRank TEXT)');

  const Post = entity('Post', {
    fields: {
      title: text(),
      score: number(),
      hotRank: projected.async({
        compute: async (row) => row.score,
      }),
    },
    grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });

  const app = workbench({ db });
  app.mount('/posts', Post);
  app.listen(0, { principalOf: () => principal({ type: 'user', id: 'alice' }) });
  await app.ready;
  t.after(() => { app.httpServer.close(); db.close(); });
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;

  const res = await fetch(`${origin}/posts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Hack', score: 5, hotRank: 999 }),
  });
  assert.equal(res.status, 400, 'readonly projected field rejected');
});

// --- projected.inline tests ---

test('projected.inline constructor validates compute is a function', () => {
  assert.throws(() => projected.inline({}), /compute function/);
  const d = projected.inline({ compute: (row) => row.score * 2 });
  assert.equal(d.kind, 'projected');
  assert.equal(d.mode, 'inline');
  assert.equal(d.readonly, true);
  assert.equal(typeof d.compute, 'function');
});

test('projected.inline value is stored immediately in the create response', async (t) => {
  const db = new DatabaseSync(':memory:');
  setActiveDb(db);
  db.exec('CREATE TABLE Blog (id TEXT, title TEXT, score REAL, hotRank TEXT)');

  const Blog = entity('Blog', {
    fields: {
      title: text(),
      score: number(),
      hotRank: projected.inline({
        compute: (row) => (row.score ?? 0) * 2,
      }),
    },
    grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });

  const app = workbench({ db });
  app.mount('/blogs', Blog);
  app.listen(0, { principalOf: () => principal({ type: 'user', id: 'alice' }) });
  await app.ready;
  t.after(() => { app.httpServer.close(); db.close(); });
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;

  const res = await fetch(`${origin}/blogs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Post', score: 42 }),
  });
  assert.equal(res.status, 201);
  const created = await res.json();

  // Inline compute is synchronous with the transaction — value available immediately
  assert.equal(created.hotRank, 84, `hotRank should be 84 in response, got ${created.hotRank}`);

  const row = db.prepare('SELECT hotRank FROM Blog WHERE id = :id').get({ id: created.id });
  assert.equal(JSON.parse(row.hotRank), 84, `hotRank should be 84 in DB`);
});

test('projected.inline value is recomputed on update', async (t) => {
  const db = new DatabaseSync(':memory:');
  setActiveDb(db);
  db.exec('CREATE TABLE Blog (id TEXT, title TEXT, score REAL, hotRank TEXT)');

  const Blog = entity('Blog', {
    fields: {
      title: text(),
      score: number(),
      hotRank: projected.inline({
        compute: (row) => (row.score ?? 0) * 3,
      }),
    },
    grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });

  const app = workbench({ db });
  app.mount('/blogs', Blog);
  app.listen(0, { principalOf: () => principal({ type: 'user', id: 'alice' }) });
  await app.ready;
  t.after(() => { app.httpServer.close(); db.close(); });
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;

  const r1 = await fetch(`${origin}/blogs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Post', score: 10 }),
  });
  const created = await r1.json();
  assert.equal(created.hotRank, 30);

  const r2 = await fetch(`${origin}/blogs/${created.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ score: 20 }),
  });
  const updated = await r2.json();
  assert.equal(updated.hotRank, 60, `after update should be 60, got ${updated.hotRank}`);

  const row = db.prepare('SELECT hotRank FROM Blog WHERE id = :id').get({ id: created.id });
  assert.equal(JSON.parse(row.hotRank), 60);
});

test('projected.inline compute failure rolls back the mutation', async (t) => {
  const db = new DatabaseSync(':memory:');
  setActiveDb(db);
  db.exec('CREATE TABLE Blog (id TEXT, title TEXT, score REAL, hotRank TEXT)');

  const Blog = entity('Blog', {
    fields: {
      title: text(),
      score: number(),
      hotRank: projected.inline({
        compute: (row) => {
          if (row.score < 0) throw new Error('negative score');
          return row.score * 10;
        },
      }),
    },
    grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });

  const app = workbench({ db });
  app.mount('/blogs', Blog);
  app.listen(0, { principalOf: () => principal({ type: 'user', id: 'alice' }) });
  await app.ready;
  t.after(() => { app.httpServer.close(); db.close(); });
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;

  // Create with positive score — succeeds
  const r1 = await fetch(`${origin}/blogs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'OK', score: 5 }),
  });
  assert.equal(r1.status, 201);

  // Try to create with negative score — compute fails, transaction rolls back
  const r2 = await fetch(`${origin}/blogs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Bad', score: -1 }),
  });
  // The compute failure should result in a 500
  assert.ok(r2.status >= 400, `expected error status, got ${r2.status}`);

  // Row should NOT exist (rollback)
  const rows = db.prepare('SELECT id FROM Blog WHERE title = :t').all({ t: 'Bad' });
  assert.equal(rows.length, 0, 'failed create rolled back — no row');
});

// --- from trigger filtering ---

test('projected.async with from:created only recomputes on create, not update', async (t) => {
  const db = new DatabaseSync(':memory:');
  setActiveDb(db);
  db.exec('CREATE TABLE Post (id TEXT, title TEXT, score REAL, hotRank TEXT)');

  const Post = entity('Post', {
    fields: {
      title: text(),
      score: number(),
      hotRank: projected.async({
        from: 'created',
        compute: async (row) => (row.score ?? 0) * 2,
      }),
    },
    grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });

  const app = workbench({ db });
  app.mount('/posts', Post);
  app.listen(0, { principalOf: () => principal({ type: 'user', id: 'alice' }) });
  await app.ready;
  t.after(() => { app.httpServer.close(); db.close(); });
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;

  const r1 = await fetch(`${origin}/posts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Post', score: 10 }),
  });
  const created = await r1.json();
  await new Promise((resolve) => setTimeout(resolve, 50));

  let row = db.prepare('SELECT hotRank FROM Post WHERE id = :id').get({ id: created.id });
  assert.equal(JSON.parse(row.hotRank), 20, 'computed on create');

  // Update — should NOT trigger recompute because from is only 'created'
  await fetch(`${origin}/posts/${created.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ score: 50 }),
  });
  await new Promise((resolve) => setTimeout(resolve, 100));

  row = db.prepare('SELECT hotRank FROM Post WHERE id = :id').get({ id: created.id });
  assert.equal(JSON.parse(row.hotRank), 20, 'unchanged — from:created excludes update');
});

test('projected.async with from:updated only recomputes on update', async (t) => {
  const db = new DatabaseSync(':memory:');
  setActiveDb(db);
  db.exec('CREATE TABLE Post (id TEXT, title TEXT, score REAL, hotRank TEXT)');

  const Post = entity('Post', {
    fields: {
      title: text(),
      score: number(),
      hotRank: projected.async({
        from: 'Post.updated',
        compute: async (row) => (row.score ?? 0) * 3,
      }),
    },
    grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });

  const app = workbench({ db });
  app.mount('/posts', Post);
  app.listen(0, { principalOf: () => principal({ type: 'user', id: 'alice' }) });
  await app.ready;
  t.after(() => { app.httpServer.close(); db.close(); });
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;

  // Create — should NOT trigger (from is only 'updated')
  const r1 = await fetch(`${origin}/posts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Post', score: 10 }),
  });
  const created = await r1.json();
  await new Promise((resolve) => setTimeout(resolve, 50));

  let row = db.prepare('SELECT hotRank FROM Post WHERE id = :id').get({ id: created.id });
  assert.equal(row.hotRank, null, 'null — from:updated excludes create');

  // Update — should trigger
  await fetch(`${origin}/posts/${created.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ score: 50 }),
  });
  await new Promise((resolve) => setTimeout(resolve, 50));

  row = db.prepare('SELECT hotRank FROM Post WHERE id = :id').get({ id: created.id });
  assert.equal(JSON.parse(row.hotRank), 150, 'computed on update');
});

test('projected.async without from recomputes on both create and update (default)', async (t) => {
  const db = new DatabaseSync(':memory:');
  setActiveDb(db);
  db.exec('CREATE TABLE Post (id TEXT, title TEXT, score REAL, hotRank TEXT)');

  const Post = entity('Post', {
    fields: {
      title: text(),
      score: number(),
      hotRank: projected.async({
        compute: async (row) => (row.score ?? 0) * 5,
      }),
    },
    grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });

  const app = workbench({ db });
  app.mount('/posts', Post);
  app.listen(0, { principalOf: () => principal({ type: 'user', id: 'alice' }) });
  await app.ready;
  t.after(() => { app.httpServer.close(); db.close(); });
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;

  const r1 = await fetch(`${origin}/posts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Post', score: 10 }),
  });
  const created = await r1.json();
  await new Promise((resolve) => setTimeout(resolve, 50));

  let row = db.prepare('SELECT hotRank FROM Post WHERE id = :id').get({ id: created.id });
  assert.equal(JSON.parse(row.hotRank), 50, 'computed on create');

  await fetch(`${origin}/posts/${created.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ score: 20 }),
  });
  await new Promise((resolve) => setTimeout(resolve, 50));

  row = db.prepare('SELECT hotRank FROM Post WHERE id = :id').get({ id: created.id });
  assert.equal(JSON.parse(row.hotRank), 100, 'computed on update');
});

// --- sequence watermarking ---

test('compute counter advances with each successful compute, survives across events', async (t) => {
  const db = new DatabaseSync(':memory:');
  setActiveDb(db);
  const { executeFrameworkDDL } = await import('../src/ddl.mjs');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Post (id TEXT, title TEXT, score REAL, hotRank TEXT)');

  let computeCount = 0;
  const Post = entity('Post', {
    fields: {
      title: text(),
      score: number(),
      hotRank: projected.async({
        compute: async (row) => {
          computeCount++;
          return (row.score ?? 0) * 2;
        },
      }),
    },
    grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });

  const app = workbench({ db });
  app.mount('/posts', Post);
  app.listen(0, { principalOf: () => principal({ type: 'user', id: 'alice' }) });
  await app.ready;
  t.after(() => { app.httpServer.close(); db.close(); });
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;

  // First create
  const r1 = await fetch(`${origin}/posts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Post1', score: 10 }),
  });
  await r1.json();
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(computeCount, 1, 'computed once');

  let cursor = db.prepare(
    "SELECT lastSeq FROM _ProjectedCursor WHERE entity = 'Post' AND field = 'hotRank'",
  ).get();
  assert.ok(cursor, 'cursor row exists');
  assert.equal(cursor.lastSeq, 1, 'cursor = 1 after first compute');

  // Second create — counter advances
  computeCount = 0;
  const r2 = await fetch(`${origin}/posts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Post2', score: 20 }),
  });
  await r2.json();
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(computeCount, 1, 'computed exactly once on second create');
  cursor = db.prepare(
    "SELECT lastSeq FROM _ProjectedCursor WHERE entity = 'Post' AND field = 'hotRank'",
  ).get();
  assert.equal(cursor.lastSeq, 2, 'cursor advanced to 2');

  // Update second post — counter advances again
  computeCount = 0;
  const rows = db.prepare('SELECT id FROM Post WHERE title = :t').all({ t: 'Post2' });
  const post2Id = rows[0].id;
  await fetch(`${origin}/posts/${post2Id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ score: 30 }),
  });
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(computeCount, 1, 'computed exactly once on update');
  cursor = db.prepare(
    "SELECT lastSeq FROM _ProjectedCursor WHERE entity = 'Post' AND field = 'hotRank'",
  ).get();
  assert.equal(cursor.lastSeq, 3, 'cursor advanced to 3');

  // Compute failure does NOT advance cursor
  computeCount = 0;
  const PostWithFailure = entity('PostWithFail', {
    fields: {
      title: text(),
      score: number(),
      hotRank: projected.async({
        compute: async () => { computeCount++; throw new Error('fail'); },
        from: 'created',
      }),
    },
    grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });
  const app2 = workbench({ db });
  app2.mount('/failposts', PostWithFailure);
  app2.listen(0, { principalOf: () => principal({ type: 'user', id: 'alice' }) });
  await app2.ready;

  db.exec('CREATE TABLE PostWithFail (id TEXT, title TEXT, score REAL, hotRank TEXT)');
  const origin2 = `http://127.0.0.1:${app2.httpServer.address().port}`;
  await fetch(`${origin2}/failposts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Fail', score: 5 }),
  });
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(computeCount, 1, 'compute attempted once');
  const failCursor = db.prepare(
    "SELECT lastSeq FROM _ProjectedCursor WHERE entity = 'PostWithFail' AND field = 'hotRank'",
  ).get();
  assert.equal(failCursor, undefined, 'no cursor row — compute failure did not advance');

  app2.httpServer.close();
});

// --- raster.crdt / polyline.crdt constructors ---

test('raster.crdt() returns a crdt-kind descriptor', () => {
  const d = raster.crdt({ mergeStrategy: 'blend' });
  assert.equal(d.kind, 'crdt');
  assert.equal(d.type, 'raster');
  assert.equal(d.mergeStrategy, 'blend');
});

test('polyline.crdt() returns a crdt-kind descriptor', () => {
  const d = polyline.crdt();
  assert.equal(d.kind, 'crdt');
  assert.equal(d.type, 'polyline');
});

test('raster.crdt and polyline.crdt validate structurally', () => {
  const ras = resolveStrategy('crdt');
  assert.equal(ras.validate(Buffer.from('pixels'), { type: 'raster' }), true);
  assert.equal(ras.validate('base64string', { type: 'raster' }), true);
  assert.equal(ras.validate(null, { type: 'raster' }), true);
  assert.equal(ras.validate(42, { type: 'raster' }), 'expected a raster value (Buffer, string, or null)');

  assert.equal(ras.validate([{ x: 1, y: 2 }], { type: 'polyline' }), true);
  assert.equal(ras.validate([], { type: 'polyline' }), true);
  assert.equal(ras.validate(null, { type: 'polyline' }), true);
  assert.equal(ras.validate('not-array', { type: 'polyline' }), 'expected a polyline value (array or null)');
});

test('raster and polyline fields compile into an entity', () => {
  const Canvas = entity('Canvas', {
    fields: {
      imageData: raster.crdt({ mergeStrategy: 'blend' }),
      stroke: polyline.crdt(),
    },
    grant: () => [scope(() => never()).can(() => grant(read))],
  });
  assert.equal(Canvas.fields.imageData.kind, 'crdt');
  assert.equal(Canvas.fields.imageData.type, 'raster');
  assert.equal(Canvas.fields.imageData.mergeStrategy, 'blend');
  assert.equal(Canvas.fields.stroke.kind, 'crdt');
  assert.equal(Canvas.fields.stroke.type, 'polyline');
});

// --- enum_() field constructor ---

test('enum_(values) returns a value/text descriptor with validate', () => {
  const d = enum_(['rect', 'ellipse', 'freedraw']);
  assert.equal(d.kind, 'value');
  assert.equal(d.type, 'text');
  assert.equal(typeof d.validate, 'function');
  assert.equal(d.validate('rect'), true);
  assert.equal(d.validate('ellipse'), true);
  assert.notEqual(d.validate('triangle'), true);
});

test('enum_() throws on empty or non-array values', () => {
  assert.throws(() => enum_(), { message: /requires a non-empty array/ });
  assert.throws(() => enum_([]), { message: /requires a non-empty array/ });
});

test('enum_() validates through the pipeline', () => {
  const Shape = entity('Shape', {
    fields: {
      type: enum_(['rect', 'ellipse', 'freedraw', 'text', 'arrow']),
    },
    grant: () => [scope(() => never()).can(() => grant(read))],
  });

  assert.doesNotThrow(() => validateMutation(Shape, { type: 'rect' }));
  assert.throws(
    () => validateMutation(Shape, { type: 'triangle' }),
    { message: /expected one of/ },
  );
});

// --- projected.async compute can query related entities ---

// Existing related-entity compute functions can still use the ambient query API;
// explicit DB-handle access is covered by the committed-db-handle test above.

test('projected.async compute can findAll related entities', async (t) => {
  const db = new DatabaseSync(':memory:');
  setActiveDb(db);

  const TComment = entity('TComment_FindAll', {
    fields: {
      post: ref('TPost_FindAll'),
      body: text(),
    },
    grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });

  const TPost = entity('TPost_FindAll', {
    fields: {
      title: text(),
      score: number({ default: 0 }),
      commentRank: projected.async({
        from: ['created', 'updated'],
        compute: async (post) => {
          const cmts = await TComment.findAll(TComment.post.is(post.id));
          return cmts.length + (post.score ?? 0);
        },
      }),
    },
    grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });

  const app = workbench({ db });
  app.mount('/tpost', TPost);
  app.mount('/tcomment', TComment);
  await app.ddl();
  app.listen(0, { principalOf: () => principal({ type: 'user', id: 'alice' }) });
  await app.ready;
  t.after(() => { app.httpServer.close(); db.close(); });
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;

  // Create post
  const r1 = await fetch(`${origin}/tpost`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'test', score: 3 }),
  });
  assert.equal(r1.status, 201);
  const { id: postId } = await r1.json();

  await new Promise((r) => setTimeout(r, 500));

  // Verify initial compute fired (0 comments + 3 score = 3)
  let row = db.prepare('SELECT commentRank FROM TPost_FindAll WHERE id = :id').get({ id: postId });
  assert.ok(row, 'post row exists');
  assert.ok(row.commentRank, 'commentRank should be set after create');
  assert.equal(JSON.parse(row.commentRank), 3, 'rank after create = score');

  // Create comments
  for (const body of ['c1', 'c2']) {
    const r = await fetch(`${origin}/tcomment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ post: postId, body }),
    });
    assert.equal(r.status, 201);
    await new Promise((r) => setTimeout(r, 200));
  }

  // Update post to trigger recompute (Comment.created doesn't trigger Post's projected.async)
  const r4 = await fetch(`${origin}/tpost/${postId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'updated' }),
  });
  assert.equal(r4.status, 200);

  await new Promise((r) => setTimeout(r, 500));

  row = db.prepare('SELECT commentRank FROM TPost_FindAll WHERE id = :id').get({ id: postId });
  assert.ok(row, 'post row exists');
  assert.ok(row.commentRank, 'commentRank should not be null');
  const rank = JSON.parse(row.commentRank);
  assert.equal(rank, 5, `commentRank expected 5, got ${rank}`);
});

// --- projected.async staleness indicators (x-workbench-projected-<field>) ---

test('read response includes projected cursor headers for staleness detection', async (t) => {
  const db = new DatabaseSync(':memory:');
  setActiveDb(db);

  const Post = entity('Post_Stale', {
    fields: {
      title: text(),
      hotRank: projected.async({
        from: ['created', 'updated'],
        compute: (row) => (row.title?.length ?? 0),
      }),
    },
    grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });

  const app = workbench({ db });
  app.mount('/posts', Post);
  await app.ddl();
  app.listen(0, { principalOf: () => principal({ type: 'user', id: 'alice' }) });
  await app.ready;
  t.after(() => { app.httpServer.close(); db.close(); });
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;

  const r1 = await fetch(`${origin}/posts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 't' }),
  });
  assert.equal(r1.status, 201);
  const { id } = await r1.json();

  // Wait for post-commit consumer to compute hotRank
  await new Promise((r) => setTimeout(r, 300));

  // Read the post — should have a projected cursor header
  const r2 = await fetch(`${origin}/posts/${id}`);
  assert.equal(r2.status, 200);
  const cursorHeader = r2.headers.get('x-workbench-projected-hotRank');
  assert.ok(cursorHeader, 'projected cursor header is present');
  assert.ok(Number(cursorHeader) >= 1, `expected cursor >= 1, got ${cursorHeader}`);

  // List responses carry the same staleness header
  const r3 = await fetch(`${origin}/posts`);
  assert.equal(r3.status, 200);
  const listHeader = r3.headers.get('x-workbench-projected-hotRank');
  assert.ok(listHeader, 'list response carries projected cursor header');
  assert.ok(Number(listHeader) >= 1, `list cursor >= 1, got ${listHeader}`);
});

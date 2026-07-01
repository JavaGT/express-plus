// projected.async — stored computed fields updated by post-commit projection
// (ADR #12, SPEC §5.3).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import expressPlus, {
  entity,
  text,
  number,
  projected,
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

  const app = expressPlus({ db });
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

  const app = expressPlus({ db });
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

  const app = expressPlus({ db });
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

  const app = expressPlus({ db });
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

  const app = expressPlus({ db });
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

  const app = expressPlus({ db });
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

  const app = expressPlus({ db });
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

// Priority 5 — W3 Slice 3 genericity proof (docs/convergence/W3-job-queue-parity.md).
// blog-platform uses the generic job-queue substrate for a NON-MEDIA kind
// (search-index), proving nothing whisper/transcode-shaped leaked into the
// substrate. The only queue surface used is kind + payload/result contract.
//
// Gate: `node --test test/blog-platform-search-jobs.test.mjs` green.
// Also: existing blog-platform tests remain green (list in final report).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { executeFrameworkDDL } from '../src/ddl.mjs';
import { createJobQueue } from '../src/job-queue.mjs';
import workbench from '../src/app.mjs';
import {
  makeBlog, makePost,
  SEARCH_INDEX_KIND,
  searchIndexMigrations,
  createPost,
  updatePost,
  searchIndexWorkerFn,
  searchPosts,
} from '../projects/blog-platform/entities.mjs';

const SECRET = 'blog-search-test-secret';
const alice = { type: 'user', id: 'alice' };

// ── Full-app acceptance: create a post → job enqueued → worker indexes it ─────

test('search-index: createPost enqueues a job; worker populates PostSearchIndex', async (t) => {
  const Blog = makeBlog();
  const Post = makePost();

  const app = workbench({
    db: ':memory:',
    jobs: { sharedSecret: SECRET, leaseMs: 60_000, heartbeatGraceMs: 60_000, reapIntervalMs: 1_000_000 },
    migrations: searchIndexMigrations,
  });
  app.mount('/blogs', Blog).mount('/posts', Post);
  app.listen(0);
  await app.ready;
  t.after(() => { app.httpServer.close(); });

  // Create a Blog row so Post.blog can be set (required ref).
  app.db.prepare(
    "INSERT INTO Blog (id, name, slug, owner) VALUES ('b1', 'Alice on Code', 'alice', 'alice')",
  ).run();

  // Create a post — the write path enqueues a search-index job.
  const postId = await createPost(app, alice, {
    title: 'Hello World',
    body: 'My first post',
    blog: 'b1',
    published: true,
  });
  assert.ok(postId, 'createPost returned a post id');

  // Assert a search-index job was enqueued.
  const jobRow = app.db.prepare(
    'SELECT id, kind, payload, status, scope FROM _Job WHERE kind = ?',
  ).get(SEARCH_INDEX_KIND);
  assert.ok(jobRow, 'a search-index job was enqueued after createPost');
  assert.equal(jobRow.status, 'queued');
  assert.equal(jobRow.kind, SEARCH_INDEX_KIND);
  assert.equal(jobRow.scope, `Post:${postId}`);

  // Genericity assertion: payload contains only { postId } — no media fields.
  const payload = JSON.parse(jobRow.payload);
  assert.deepEqual(Object.keys(payload), ['postId'], 'payload has exactly postId — no media-shaped keys');
  assert.equal(payload.postId, postId);
  assert.equal(payload.inputFileId, undefined, 'no inputFileId in payload');
  assert.equal(payload.profile, undefined, 'no profile in payload');

  // Run the in-process worker deterministically.
  const worker = app.jobs.work(SEARCH_INDEX_KIND, searchIndexWorkerFn(app), { pollIntervalMs: Infinity });
  const result = await worker.once();
  assert.ok(result, 'worker claimed and completed a job');
  assert.equal(result.job.kind, SEARCH_INDEX_KIND);
  assert.equal(result.result.accepted, true);

  // Verify the search index was populated (proves the QUEUE did the work).
  const found = searchPosts(app, 'Hello');
  assert.equal(found.length, 1);
  assert.equal(found[0].postId, postId);
  assert.equal(found[0].title, 'Hello World');
  assert.equal(found[0].body, 'My first post');

  const noMatch = searchPosts(app, 'nonexistent');
  assert.equal(noMatch.length, 0);

  // A second post — the write path enqueues another job.
  await createPost(app, alice, {
    title: 'Hello World Updated',
    body: 'Updated content',
    blog: 'b1',
    published: true,
  });

  // Run the worker again to process the second post.
  const result2 = await worker.once();
  assert.ok(result2, 'worker completed the second indexing job');
  assert.equal(result2.result.accepted, true);

  const found2 = searchPosts(app, 'Updated');
  assert.equal(found2.length, 1);
  assert.equal(found2[0].body, 'Updated content');

  worker.stop();
});

test('search-index: updatePost also enqueues a job', async (t) => {
  const Blog = makeBlog();
  const Post = makePost();

  const app = workbench({
    db: ':memory:',
    jobs: { sharedSecret: SECRET, leaseMs: 60_000, heartbeatGraceMs: 60_000, reapIntervalMs: 1_000_000 },
    migrations: searchIndexMigrations,
  });
  app.mount('/blogs', Blog).mount('/posts', Post);
  app.listen(0);
  await app.ready;
  t.after(() => { app.httpServer.close(); });

  app.db.prepare(
    "INSERT INTO Blog (id, name, slug, owner) VALUES ('b2', 'Test', 'test', 'alice')",
  ).run();

  const postId = await createPost(app, alice, {
    title: 'Original', body: 'Original content', blog: 'b2', published: true,
  });

  // consume the initial job
  const worker = app.jobs.work(SEARCH_INDEX_KIND, searchIndexWorkerFn(app), { pollIntervalMs: Infinity });
  await worker.once();

  // Clear the job and index table so we can prove the update enqueues fresh work.
  app.db.exec('DELETE FROM _Job');
  app.db.exec('DELETE FROM PostSearchIndex');

  await updatePost(app, alice, postId, { title: 'Updated Title' });

  const updateJob = app.db.prepare('SELECT kind, payload, status FROM _Job').get();
  assert.ok(updateJob, 'updatePost enqueued a job');
  assert.equal(updateJob.kind, SEARCH_INDEX_KIND);
  assert.equal(updateJob.status, 'queued');
  const upPayload = JSON.parse(updateJob.payload);
  assert.equal(upPayload.postId, postId);

  worker.stop();
});

// ── Failure path: worker throws on missing post → substrate retry → dead-letter ─

test('search-index: missing post → retried → dead-lettered (substrate policy)', async () => {
  let t = 1000;
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  // Run the migration so PostSearchIndex exists (the worker tries to INSERT).
  db.exec(
    `CREATE TABLE IF NOT EXISTS PostSearchIndex (
       postId TEXT PRIMARY KEY,
       title TEXT NOT NULL,
       body TEXT NOT NULL,
       indexedAt INTEGER NOT NULL
     )`,
  );
  // Tiny maxAttempts so we reach dead-letter quickly.
  const queue = createJobQueue({ db, sharedSecret: SECRET, now: () => t, maxAttempts: 2, backoffMs: 10 });

  queue.enqueue({ kind: SEARCH_INDEX_KIND, payload: { postId: 'fake-missing-post' } });

  const worker = queue.work(SEARCH_INDEX_KIND, searchIndexWorkerFn({ db }), { pollIntervalMs: Infinity });

  // Attempt 1: worker throws (no post with that id) → retried.
  const r1 = await worker.once();
  assert.ok(r1, 'worker claimed the job');
  assert.equal(r1.result.retried, true, 'first failure is retried (under maxAttempts)');
  assert.equal(r1.result.attempts, 1);

  // Advance past backoff so the job is claimable again.
  t = 2000;
  const r2 = await worker.once();
  assert.ok(r2, 'worker claimed the retried job');
  assert.equal(r2.result.deadLettered, true, 'second failure dead-letters (at maxAttempts)');
  assert.equal(r2.result.attempts, 2);

  const row = db.prepare('SELECT status, attempts FROM _Job WHERE kind = ?').get(SEARCH_INDEX_KIND);
  assert.equal(row.status, 'failed', 'dead-lettered job is terminal failed');
  assert.equal(row.attempts, 2, 'two attempts recorded');

  worker.stop();
  db.close();
});

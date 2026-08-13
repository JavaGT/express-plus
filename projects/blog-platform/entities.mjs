// projects/blog-platform/entities.mjs — the blog-platform domain entities.
//
// Blog → Post → Comment spine (identical shape to the constructs proven in
// test/blog-acceptance.test.mjs — ONLY built workbench constructs: entity,
// text, boolean, date, ref, scope, grant/read/write/subscribe, everyone,
// anyOf, inherit, allowAnonymous).
//
// This module additionally gives blog-platform a `search-index` job kind,
// driven through the generic job-queue substrate
// (docs/convergence/W3-job-queue-parity.md, Slice 3 — genericity proof): a
// NON-media job kind proving nothing whisper/transcode-shaped leaked into the
// substrate.
//
// Composition at the enqueue edge (src/job-queue.mjs's own header comment: "a
// post-commit consumer may call enqueue(); the queue owns the lifecycle from
// there" — OR the app's write path calls enqueue() directly). blog-platform
// has no post-commit-consumer extension slot available to it without
// touching the framework kernel (src/kernel.mjs wires only framework-owned
// seams: blob finalize, live, projected-async, durable-effects, email — no
// app-supplied slot), so this module uses the module header's other
// sanctioned path: a small write-path service function (createPost /
// updatePost) that composes the entity write with app.jobs.enqueue(), the
// same shape as the framework's own app.batch() composed-write helper
// (src/kernel.mjs: "a server-side composed mutation").
//
// The queue surface used is exactly kind + payload + scope — no media-shaped
// concept (inputFileId, profile, transcript, ...) rides on this path.

import { entity, text, boolean, date, ref, scope, grant, read, write, subscribe, everyone, anyOf, inherit, allowAnonymous } from '../../build/index.mjs';
import { tryParseScopeKey } from '../../build/internal.mjs';
import { randomUUID } from 'node:crypto';

// --- the spine: Blog / Post / Comment ---

export function makeBlog() {
  return entity('Blog', {
    name: text(),
    slug: text(),
    owner: ref('User', { role: 'owner', readonly: true }),

    grant: () => [
      scope(() => everyone()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read),
      ),
    ],
  });
}

export function makePost() {
  return entity('Post', {
    title: text(),
    body: text(),
    published: boolean({ default: false }),
    createdAt: date({ default: () => new Date() }),
    blog: ref('Blog', { required: true }),
    author: ref('User', { role: 'author', readonly: true }),

    grant: () => [
      scope(({ is, fields }) => anyOf(fields.published.is(true), is.author()))
        .can(async ({ is }) =>
          (await is.author()) ? grant(read, write, subscribe) : grant(read),
        ),
    ],
    // the public blog index lists published posts; mutations stay default-on.
    gate: { list: allowAnonymous() },
    routes: (r) => r.resource(),
  });
}

export function makeComment(Post) {
  return entity('Comment', {
    post: ref('Post', { required: true }),
    body: text({ validate: (v) => v.length <= 5000 || 'comment too long' }),
    author: ref('User', { role: 'author', readonly: true }),
    createdAt: date({ default: () => new Date() }),

    grant: inherit(Post, { via: 'post' }),
    routes: (r) => r.resource(),
  });
}

// --- search indexing, driven through the generic job queue ---

export const SEARCH_INDEX_KIND = 'search-index';

// A small derived index table, maintained ONLY by the search-index job
// worker — never by the write path directly — so the acceptance test can
// prove the QUEUE did the work (the row only appears after work().once()
// completes). Post's title/body stay plain text() fields (no FTS): a
// derived table is the simplest correct index for this slice. Declared as a
// versioned migration — the framework-owned mechanism for app-declared
// schema beyond mounted entities (src/migrations.mjs).
export const searchIndexMigrations = [
  {
    version: 1,
    up: (db) => db.exec(
      `CREATE TABLE IF NOT EXISTS PostSearchIndex (
         postId TEXT PRIMARY KEY,
         title TEXT NOT NULL,
         body TEXT NOT NULL,
         indexedAt INTEGER NOT NULL
       )`,
    ),
  },
];

function enqueueSearchIndex(app, postId) {
  return app.jobs.enqueue({
    kind: SEARCH_INDEX_KIND,
    payload: { postId },
    // the post's own scope — indexing is about THIS post, not its parent
    // Blog (a Blog has many posts; the job's unit of work is one post).
    scope: `Post:${postId}`,
  });
}

// The app's write path: a server-side composed write — one dispatch under
// the write-queue mutex, same shape as app.batch() — followed by the
// post-commit job enqueue. Returns the new Post's id.
export async function createPost(app, principal, { title, body, blog, published } = {}) {
  const { events } = await app.writeQueue.run(() => app.kernel.dispatch({
    actionId: randomUUID(),
    type: 'Post.create',
    payload: { title, body, blog, published },
    principal,
  }));
  const postId = tryParseScopeKey(events[0].scope).id;
  enqueueSearchIndex(app, postId);
  return postId;
}

export async function updatePost(app, principal, postId, patch = {}) {
  await app.writeQueue.run(() => app.kernel.dispatch({
    actionId: randomUUID(),
    type: 'Post.update',
    payload: { id: postId, ...patch },
    principal,
  }));
  enqueueSearchIndex(app, postId);
  return postId;
}

// The search-index worker: reads the post and upserts its derived index row.
// A missing post (deleted between enqueue and claim) THROWS — the
// substrate's own retry/dead-letter policy owns the failure path;
// blog-platform does not invent a second one.
export function searchIndexWorkerFn(app) {
  return async (job) => {
    const { postId } = job.payload;
    const post = app.db.prepare('SELECT id, title, body FROM Post WHERE id = ?').get(postId);
    if (!post) throw new Error(`search-index: Post ${postId} not found`);
    app.db.prepare(
      `INSERT INTO PostSearchIndex (postId, title, body, indexedAt)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(postId) DO UPDATE SET title = excluded.title, body = excluded.body, indexedAt = excluded.indexedAt`,
    ).run(post.id, post.title, post.body, Date.now());
    return { postId: post.id, indexed: true };
  };
}

// A minimal search over the derived index — the simplest correct surface for
// what blog-platform needs (no FTS5 virtual table required for this slice).
export function searchPosts(app, query) {
  const like = `%${query}%`;
  return app.db.prepare(
    'SELECT postId, title, body FROM PostSearchIndex WHERE title LIKE ? OR body LIKE ?',
  ).all(like, like);
}

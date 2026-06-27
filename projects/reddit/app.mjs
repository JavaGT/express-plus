// projects/reddit/app.mjs — thin global wiring for the Reddit clone.
//
// Communities, Posts, Comments, and Votes are mounted as entities. The auth
// boundary is the framework's baked-in session system (no separate session
// router defined here — inherits from the framework default).
//
// PAIN POINT: the front page (`/r/all/hot`) sorts by a derived `hotRank` field.
// Every page load recomputes the score→hotRank formula for every non-removed
// post. No materialized rank index, no pre-sorted cursor-pagination — full scan
// on every request (see PAIN-POINTS.md §D).

import expressPlus from 'express-plus';
import {
  Community, Post, Comment, PostVote, CommentVote,
} from './index.mjs';
import { config } from './config.mjs';

const app = expressPlus();

// ── Entities ────────────────────────────────────────────────────────────

app.mount('/r',        Community);    // /r/:communityId → community CRUD + ban routes
app.mount('/posts',    Post);         // /posts/:postId → post CRUD + /hot + /r/:name/hot + /:postId/comments
app.mount('/comments', Comment);      // auto-CRUD (comments are also accessible via /posts/:postId/comments)
app.mount('/post-votes', PostVote);   // auto-CRUD
app.mount('/comment-votes', CommentVote); // auto-CRUD

// ── Cross-cutting: front page (all communities) ────────────────────────
// PAIN POINT §D: `/feed` on multiple entities (subscribed communities) has
// no declarative construct. The framework's findAll is single-entity scoped;
// multi-community aggregation must be hand-written.

app.get('/', async (req, res) => {
  res.redirect('/r/all/hot');
});

app.get('/r/all/hot', async (req, res) => {
  const perPage = 25;
  const page    = parseInt(req.query.page) || 1;

  // PAIN POINT: sorting by derived hotRank forces a full scan of all
  // non-removed posts. No stored aggregate, no rank index.
  const posts = await Post.findAll(Post.removed.is(0))
    .sort(Post.hotRank, 'desc')
    .limit(perPage)
    .offset((page - 1) * perPage);

  res.json({ posts, page });
});

// ── Top posts within a specific community ──
// Redirects to Post's own /r/:name/hot handler (declared in index.mjs routes)
app.get('/r/:name', async (req, res) => {
  res.redirect(`/posts/r/${req.params.name}/hot`);
});

app.listen(config.port, () =>
  console.log(`reddit-clone on http://localhost:${config.port} [${config.env}]`));

// projects/reddit/index.mjs — Reddit-clone domain entities.
//
// Five entities: Community (subreddit), Post, Comment (nested tree), PostVote,
// CommentVote. Each vote stores a DIRECTION (+1/-1), so it must be a separate
// entity — the `set(ref('User'))` field type is membership-only (no per-member
// value), which is a pain point (see PAIN-POINTS.md §B).
//
// The framework's `derived` fields recompute synchronously from the entity's
// own fields. This works for `score` (derived from upvoteCount + downvoteCount)
// but NOT for the raw counts themselves — those must be manually updated when a
// Vote is created/updated/deleted, because the framework has no cross-entity
// counter or aggregate field (§C in PAIN-POINTS.md).
//
// Comments use a self-referential FK (`parent: ref('Comment')`). `ref()`
// auto-populates one level; the framework has no tree-traversal query construct
// for recursive population to arbitrary depth (§A in PAIN-POINTS.md).
//
// The front page (`/r/all/hot`) requires sorting posts by a computed hot-rank
// across all communities with pagination. `derived` recomputes per-row on read,
// which means a full scan + in-memory sort — no materialized rank index (§D).

import {
  entity, router,
  text, number, ref, date, set, log,
  grant, deny, hide,
  read, write, subscribe, admin,
} from 'express-plus';

// ── Community (subreddit) ────────────────────────────────────────────────
// Moderators and banned users are `set(ref('User'))`. The moderation log is
// an append-only `log()` field — each entry is { action, actor, target, reason,
// timestamp } recorded by a remove/ban handler.

export const Community = entity('Community', {
  fields: {
    name:          text({ max: 50, required: true }),
    description:   text({ max: 500, default: '' }),
    rules:         text({ max: 5000, default: '' }),
    creator:       ref('User', { readonly: true }),
    moderators:    set(ref('User')),
    bannedUsers:   set(ref('User')),
    moderationLog: log(),                                     // auditable trail
    subscriberCount: number({ default: 0 }),
    createdAt:     date({ default: () => new Date(), readonly: true }),
    updatedAt:     date({ touch: true, readonly: true }),
  },

  checks: {
    creator:   ({ entity, user }) => entity.creator === user.id,
    moderator: ({ entity, user }) => entity.moderators.has(user.id),
    banned:    ({ entity, user }) => entity.bannedUsers.has(user.id),
  },

  grant: async ({ is }) => {
    if (await is.banned())     return deny('banned from this community');
    if (is.creator() || is.moderator()) return grant(read, write, subscribe, admin);
    return grant(read, subscribe);                            // public-read
  },

  routes: (r, Community) => {
    r.resource();                                             // /communities CRUD
    // Ban / unban a user (moderator-only, checked via grant)
    r.post('/:communityId/ban', async (req, res) => {
      await req.community.bannedUsers.add(req.body.userId);
      // PAIN POINT: log() append has no demonstrated typed API for structured
      // entries — assuming `await req.community.moderationLog.append({...})`
      // works (the doc ceiling never shows log usage from a handler).
      res.json({ banned: req.body.userId });
    });
    r.delete('/:communityId/ban/:userId', async (req, res) => {
      await req.community.bannedUsers.remove(req.params.userId);
      res.sendStatus(204);
    });
  },
});

// ── PostVote ────────────────────────────────────────────────────────────
// PAIN POINT: `set(ref('User'))` tracks WHO but not HOW (direction). A vote is
// a (user, post, direction=±1) triple with a uniqueness constraint on (user,
// post). A separate entity is the only way to store the direction, but the
// framework has no compound-uniqueness guarantee — duplicate (user, post) votes
// are a data-integrity problem (§B).

export const PostVote = entity('PostVote', {
  fields: {
    post:      ref('Post', { required: true }),
    user:      ref('User', { readonly: true }),
    direction: number({ min: -1, max: 1, required: true }),  // +1 upvote, -1 downvote
    createdAt: date({ default: () => new Date(), readonly: true }),
  },

  checks: {
    owner: ({ entity, user }) => entity.user === user.id,
  },

  grant: async ({ is }) => {
    if (is.owner()) return grant(read, write, subscribe);
    return hide();                                            // votes are private
  },
});

export const CommentVote = entity('CommentVote', {
  fields: {
    comment:   ref('Comment', { required: true }),
    user:      ref('User', { readonly: true }),
    direction: number({ min: -1, max: 1, required: true }),
    createdAt: date({ default: () => new Date(), readonly: true }),
  },

  checks: {
    owner: ({ entity, user }) => entity.user === user.id,
  },

  grant: async ({ is }) => {
    if (is.owner()) return grant(read, write, subscribe);
    return hide();
  },
});

// ── Post ────────────────────────────────────────────────────────────────
// Score = upvoteCount - downvoteCount (derived from entity's own fields — works).
// hotRank = f(score, age) (derived from entity's own fields — works locally).
// The COUNTS themselves are manually updated by the vote handler — imperative
// glue because the framework has no cross-entity counter primitive (§C).

export const Post = entity('Post', {
  fields: {
    title:        text({ max: 300, required: true }),
    body:         text({ max: 40000, default: '' }),          // text posts
    url:          text({ max: 2000 }),                        // link posts
    community:    ref('Community', { required: true }),
    author:       ref('User', { readonly: true }),

    // PAIN POINT: these must be written by application code (vote handler).
    // No `counter(ref('PostVote'))` field type that auto-aggregates.
    upvoteCount:   number({ default: 0 }),
    downvoteCount: number({ default: 0 }),

    // Derived IS correct here: score depends only on the Post's own fields.
    // When upvoteCount or downvoteCount changes, score recomputes.
    score:        number({ derived: (p) => p.upvoteCount - p.downvoteCount, readonly: true }),

    // PAIN POINT: hotRank is derived from score + age. This is a sync
    // recompute-on-read — defensible for a single-post detail view (one row),
    // but NOT for the front page where 10k+ posts must be sorted by it.
    // Sorting by a derived field means: load every row, run the derive fn on
    // each, sort in-memory. No materialized rank index to skip the scan.
    // A stored-aggregate + async-recompute-on-vote model is needed (§C).
    hotRank:     number({
      derived: (p) => {
        const s = p.upvoteCount - p.downvoteCount;
        const order = Math.log10(Math.max(Math.abs(s), 1));
        const sign = s > 0 ? 1 : s < 0 ? -1 : 0;
        const seconds = (p.createdAt.getTime() - 1134028003 * 1000) / 45000;
        return +(sign * order + seconds).toFixed(7);
      },
      readonly: true,
    }),

    commentCount: number({ default: 0 }),

    // Removing a post: 0 = visible, 1 = moderator-removed, 2 = author-deleted.
    // Removed posts are still accessible via direct link but hidden from feeds.
    removed:      number({ default: 0 }),
    removedBy:    ref('User'),
    removalReason: text(),

    createdAt:    date({ default: () => new Date(), readonly: true }),
    updatedAt:    date({ touch: true, readonly: true }),
  },

  checks: {
    owner: ({ entity, user }) => entity.author === user.id,

    // PAIN POINT: to check read access on a Post, we must load the Community
    // and call .can() — one additional query per post. In a list of 25 posts
    // on the front page, that's 25 community loads. A bulk authorization check
    // or a denormalized auth cache would be needed at scale.
    canReadCommunity: async ({ entity, user, load }) => {
      const c = await load(entity.community);
      return c.can(read, user);
    },

    communityModerator: async ({ entity, user, load }) => {
      const c = await load(entity.community);
      return c.moderators.has(user.id);
    },
  },

  grant: async ({ is }) => {
    if (!(await is.canReadCommunity())) return hide();
    if (is.owner() || await is.communityModerator()) return grant(read, write, subscribe, admin);

    // PAIN POINT: `remove` — typed handle for "can I mark this as removed?"
    // (moderator action). Not in the doc ceiling; aspirational.
    return grant(read, write, subscribe);
  },

  routes: (r, Post) => {
    r.resource();                                             // /posts CRUD

    // ── Front-page: global hot ranking ──
    // PAIN POINT: sorting by hotRank (a derived field) on every page load
    // computes the formula for every non-removed post. No materialized-sort
    // index, no cursor-pagination on a precomputed rank — O(n) scan per query.
    r.get('/hot', async (req, res) => {
      const perPage = 25;
      const cursor   = req.query.after ? parseInt(req.query.after) : 0;
      const posts = await Post.findAll(Post.removed.is(0))
        .sort(Post.hotRank, 'desc')
        .limit(perPage)
        .offset(cursor);
      res.json({ posts, nextCursor: cursor + perPage });
    });

    // ── Community-scoped hot feed ──
    r.get('/r/:name/hot', async (req, res) => {
      // PAIN POINT: findBy name-field first, then compound filter + sort.
      // No compound-query builder shown (`.and()` not in the API surface).
      // Aspirational: nested community lookup via ref traversal.
      const community = await Community.findOne(Community.name.is(req.params.name));
      if (!community) return res.sendStatus(404);
      const page   = parseInt(req.query.page) || 1;
      const posts  = await Post.findAll({ removed: 0 })
        .where(Post.community.is(community.id))
        .sort(Post.hotRank, 'desc')
        .limit(25)
        .offset((page - 1) * 25);
      res.json({ community: community.name, posts, page });
    });

    // ── Vote on a post ──
    // PAIN POINT: imperative glue. After mutating the Vote entity, the handler
    // must manually adjust Post.upvoteCount/downvoteCount. No counter field,
    // no async-derive-on-related-mutation hook. This is the same code repeated
    // for every voteable entity (§C).
    r.post('/:postId/vote', async (req, res) => {
      const { direction } = req.body;                         // +1 or -1
      const post = req.post;

      // PAIN POINT §B: manual uniqueness enforcement. No compound FK guarantee.
      // findOne with multi-field filter has no documented API surface.
      // Aspirational: PostVote.findOne(PostVote.post.is(post.id), PostVote.user.is(req.user.id))
      // or PostVote.findOne({ where: { post: post.id, user: req.user.id } })
      const existing = await PostVote.findOne(
        PostVote.post.is(post.id)
      );  // INCOMPLETE: can't filter by user simultaneously — see §B

      if (existing && existing.user === req.user.id) {
        if (existing.direction === direction) {
          // Toggle off — remove the vote, decrement the count
          await Post.findById(post.id).update({
            upvoteCount:   direction === 1  ? post.upvoteCount - 1   : post.upvoteCount,
            downvoteCount: direction === -1 ? post.downvoteCount - 1 : post.downvoteCount,
          });
          await existing.delete();
        } else {
          // Flip direction — adjust both counts
          await Post.findById(post.id).update({
            upvoteCount:   direction === 1  ? post.upvoteCount + 1   : post.upvoteCount - 1,
            downvoteCount: direction === -1 ? post.downvoteCount + 1 : post.downvoteCount - 1,
          });
          await existing.update({ [PostVote.direction]: direction });
        }
      } else {
        // New vote
        await PostVote.create({
          [PostVote.post]:      post.id,
          [PostVote.user]:      req.user.id,
          [PostVote.direction]: direction,
        });
        await Post.findById(post.id).update({
          upvoteCount:   direction === 1  ? post.upvoteCount + 1   : post.upvoteCount,
          downvoteCount: direction === -1 ? post.downvoteCount + 1 : post.downvoteCount,
        });
      }
      res.json(await Post.findById(post.id));
    });

    // ── Moderator remove post ──
    r.post('/:postId/remove', async (req, res) => {
      const { reason } = req.body;
      await req.post.update({
        [Post.removed]:      1,
        [Post.removedBy]:    req.user.id,
        [Post.removalReason]: reason,
      });

      // PAIN POINT: moderation audit trail — should append to the community's
      // moderationLog, but cross-entity log append has no clear API path.
      // Aspirational: (await load(req.post.community)).moderationLog.append({...})
      res.json({ removed: true, post: req.post.id });
    });

    // ── Comments sub-resource ──
    r.use('/:postId/comments', postCommentRoutes(Post, Comment));
  },
});

// ── Comment (nested tree) ───────────────────────────────────────────────
// Self-referential FK (`parent: ref('Comment')`). The framework's `ref()`
// auto-populates one level. To load a comment tree, we must fetch all comments
// for a post and reconstruct the tree in application code (§A).

export const Comment = entity('Comment', {
  fields: {
    body:    text({ max: 10000, required: true }),
    post:    ref('Post', { required: true }),
    author:  ref('User', { readonly: true }),

    // PAIN POINT §A: self-referential FK. `ref()` auto-populates ONE level
    // (comment.parent = the parent Comment object). To reach a reply at depth 8,
    // you'd need `comment.parent.parent.parent...` — 8 sequential DB queries.
    // No tree traversal query construct, no recursive CTE, no `loadTree()`.
    parent:  ref('Comment'),

    upvoteCount:   number({ default: 0 }),
    downvoteCount: number({ default: 0 }),
    score:         number({ derived: (c) => c.upvoteCount - c.downvoteCount, readonly: true }),

    depth:         number({ default: 0 }),                   // root = 0, reply = parent.depth+1

    removed:       number({ default: 0 }),
    removedBy:     ref('User'),
    removalReason: text(),

    createdAt:    date({ default: () => new Date(), readonly: true }),
    updatedAt:    date({ touch: true, readonly: true }),
  },

  checks: {
    owner: ({ entity, user }) => entity.author === user.id,

    // PAIN POINT: N loads per comment thread load. To check if user can read
    // comment C, we load C's post, which loads C's post's community, to call
    // .can(). For a thread with 200 comments, that's up to 200 post loads
    // (memoized per request via `load`, but still 200 sequential).
    canReadPost: async ({ entity, user, load }) => {
      const p = await load(entity.post);
      return p.can(read, user);
    },

    communityModerator: async ({ entity, user, load }) => {
      const p = await load(entity.post);
      const c = await load(p.community);
      return c.moderators.has(user.id);
    },
  },

  grant: async ({ is }) => {
    // PAIN POINT: authorization requires post access. Every comment in a
    // thread must independently verify post-readability. With request-scoped
    // `load` memoization this is one DB hit per unique post, but the check
    // pattern is verbose — "grant if parent post is readable" has no shorthand.
    if (!(await is.canReadPost())) return hide();
    if (is.owner() || await is.communityModerator()) return grant(read, write, subscribe, admin);
    return grant(read, write, subscribe);
  },
});

// ── Comment routes (mounted under /posts/:postId/comments) ────────────────
// PAIN POINT §A: loading a comment tree.
// The thread loader fetches ALL comments for a post, then reconstructs the tree
// in application code. For a post with 3,000 comments, this fetches 3,000 rows
// and builds a tree in memory on every request. No server-side tree walker, no
// lazy-depth population, no "children" virtual field.

function postCommentRoutes(PostEntity, CommentEntity) {
  const c = router();

  // List comments for a post (flat, sorted by creation time).
  // Client is expected to reconstruct the tree from parent references.
  c.get('/', async (req, res) => {
    // req.post is auto-bound by the framework's :postId param rule
    // PAIN POINT: `findAll` accepts ONE filter (`findAll(Field.is(val))`).
    // Compound conditions (post=42 AND removed=0) have no syntax.
    // `.where()` is aspirational — not shown in the framework API.
    const comments = await CommentEntity.findAll(
      CommentEntity.post.is(req.post.id)
    ).sort(CommentEntity.createdAt, 'asc');

    // PAIN POINT: removed filtering is application code; also, tree
    // reconstruction is application code — no .loadTree(), .findChildren(),
    // .findDescendants(), .ancestors().
    const visible = comments.filter(c => c.removed === 0);
    const tree = nestComments(visible);
    res.json({ post: req.post, comments: tree });
  });

  // Create a comment (root-level or reply)
  c.post('/', async (req, res) => {
    const parentId = req.body.parentId;
    let depth = 0;
    if (parentId) {
      // PAIN POINT: loading parent to inherit depth is a manual step.
      // A `children` field (auto-set `depth = parent.depth + 1`) would absorb
      // this, but self-referential sets don't exist.
      const parent = await CommentEntity.findById(parentId);
      if (!parent || parent.post.id !== req.post.id) {
        return res.status(400).json({ error: 'invalid parent' });
      }
      depth = parent.depth + 1;
    }

    const comment = await CommentEntity.create({
      [CommentEntity.body]:   req.body.body,
      [CommentEntity.post]:   req.post.id,
      [CommentEntity.author]: req.user.id,
      [CommentEntity.parent]: parentId || null,
      [CommentEntity.depth]:  depth,
    });

    // PAIN POINT: manually bump post.commentCount — no declarative counter
    // that auto-increments when a child entity is created.
    await PostEntity.findById(req.post.id).update({
      [PostEntity.commentCount]: req.post.commentCount + 1,
    });

    res.status(201).json(comment);
  });

  // Vote on a comment (mirror of post voting — more imperative glue)
  c.post('/:commentId/vote', async (req, res) => {
    const { direction } = req.body;
    const comment = await CommentEntity.findById(req.params.commentId);
    if (!comment) return res.sendStatus(404);

    // PAIN POINT §B: same compound-query gap as PostVote
    const existing = await CommentVote.findOne(
      CommentVote.comment.is(comment.id)
    );  // INCOMPLETE: can't filter by user simultaneously

    if (existing && existing.user === req.user.id) {
      if (existing.direction === direction) {
        await CommentEntity.findById(comment.id).update({
          upvoteCount:   direction === 1  ? comment.upvoteCount - 1   : comment.upvoteCount,
          downvoteCount: direction === -1 ? comment.downvoteCount - 1 : comment.downvoteCount,
        });
        await existing.delete();
      } else {
        await CommentEntity.findById(comment.id).update({
          upvoteCount:   direction === 1  ? comment.upvoteCount + 1   : comment.upvoteCount - 1,
          downvoteCount: direction === -1 ? comment.downvoteCount + 1 : comment.downvoteCount - 1,
        });
        await existing.update({ [CommentVote.direction]: direction });
      }
    } else {
      await CommentVote.create({
        [CommentVote.comment]:   comment.id,
        [CommentVote.user]:      req.user.id,
        [CommentVote.direction]: direction,
      });
      await CommentEntity.findById(comment.id).update({
        upvoteCount:   direction === 1  ? comment.upvoteCount + 1   : comment.upvoteCount,
        downvoteCount: direction === -1 ? comment.downvoteCount + 1 : comment.downvoteCount,
      });
    }
    res.json(await CommentEntity.findById(comment.id));
  });

  // Remove comment (moderator or author)
  c.post('/:commentId/remove', async (req, res) => {
    await CommentEntity.findById(req.params.commentId).update({
      [CommentEntity.removed]:      1,
      [CommentEntity.removedBy]:    req.user.id,
      [CommentEntity.removalReason]: req.body.reason || '',
    });
    res.json({ removed: true });
  });

  return c;
}

// ── Tree reconstruction (application code, not framework) ──────────────
// PAIN POINT §A: this O(n) in-memory tree build is the only way to render a
// comment thread. No framework construct exists for recursive population.

function nestComments(flatList) {
  const map = new Map();
  const roots = [];

  for (const c of flatList) {
    map.set(c.id, { ...c, replies: [] });
  }

  for (const c of flatList) {
    const node = map.get(c.id);
    // `ref()` auto-populates: c.parent is a Comment object, not a raw ID.
    // Use c.parentId or c.parent?.id to key into the map.
    const parentId = c.parent?.id ?? c.parent;
    if (parentId && map.has(parentId)) {
      map.get(parentId).replies.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

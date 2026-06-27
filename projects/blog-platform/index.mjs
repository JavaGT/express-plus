// projects/blog-platform/index.mjs — Blog, Post, and Comment reactive entities.
//
// A blog hosting platform: many Blogs, each owned by an Author (User). A Blog
// has Posts (draft/scheduled/published, body, publishedAt). Posts have Comments.
// A SINGLE User identity spans ALL blogs — log in once, comment on any blog with
// the same account; the comment profile is unified across tenants.
//
// STRESS-TEST TARGETS:
// (a) Multi-tenancy: cross-entity auth traversals (post → blog → owner)
// (b) Publication state machine: draft/scheduled/published + timer gap
// (c) Unified comments: global User FK with cross-blog reverse lookup
// (d) Comment moderation: per-row state + audience filtering (pending/approved/spam/deleted)
// (e) Public internet: fail-closed auth default vs. public-readable posts
//
// Where a construct is missing, we WORKAROUND it and document the gap in
// PAIN-POINTS.md — but we never invent new framework exports.
import { entity, text, ref, date, set,
          grant, deny, hide,
          read, write, subscribe, admin, owner,
          open, router as Router, User } from 'express-plus';

// ─── VALID STATE SETS (hand-validated — no enum field type) ────────────
const POST_STATES = ['draft', 'scheduled', 'published'];
const COMMENT_STATES = ['pending', 'approved', 'spam', 'deleted'];

// ═══════════════════════════════════════════════════════════════════════════
// BLOG — a publication owned by a User. Readers subscribe for new-post
//        notifications. Publicly discoverable.
// ═══════════════════════════════════════════════════════════════════════════
export const Blog = entity('Blog', {
  fields: {
    name:        text({ max: 100, required: true }),
    slug:        text({ max: 100, required: true }),  // unique across all blogs
    description: text({ max: 500, default: '' }),

    // OWNERSHIP — `role: owner` auto-derives the default grant (owner ⇒ all)
    // AND `checks.owner` (so `blog.isOwner(user)` works without a `checks` block).
    owner:       ref('User', { role: owner, readonly: true }),

    // SUBSCRIBERS — reader subscription list. Adding a user auto-emits
    // Blog:<id>:subscribers:added:<userId> so their live stream picks it up.
    subscribers: set(ref('User')),

    createdAt:   date({ default: () => new Date(), readonly: true }),
    updatedAt:   date({ touch: true, readonly: true }),
  },

  // Blog is publicly discoverable: anyone can read, only the owner can write.
  grant: async ({ is }) => {
    if (is.owner()) return grant(read, write, subscribe, admin);
    return grant(read, subscribe);
  },

  routes: (r, Blog) => {
    // Public reads — `open` opts out of the fail-closed requireAuth gate.
    r.get('/',            open, blogList(Blog));
    r.get('/:blogId',     open, blogGet(Blog));

    // Owner-only mutations — route gate provides requireAuth; grant does the rest.
    r.post('/',                     createBlog(Blog));
    r.put('/:blogId',               updateBlog(Blog));
    r.delete('/:blogId',            deleteBlog(Blog));

    // Subscriptions — authenticated only (route gate requires auth).
    r.post('/:blogId/subscribe',    subscribe(Blog));
    r.delete('/:blogId/subscribe',  unsubscribe(Blog));
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// POST — a published (or draft/scheduled) article inside a Blog.
//
// Publication state machine: draft → scheduled → published.
// Scheduled posts should auto-publish at `publishedAt` — PAIN POINT: no
// framework timer/queue construct; this requires external infrastructure.
// ═══════════════════════════════════════════════════════════════════════════
export const Post = entity('Post', {
  fields: {
    title:       text({ max: 200, required: true }),
    slug:        text({ max: 200, required: true }),   // unique within the blog
    body:        text(),                                // plain text (not CRDT — blog posts aren't realtime-collab)

    // STATE MACHINE: draft | scheduled | published.
    // PAIN POINT: no enum field type. We use `text` with hand-validation in
    // route handlers — invalid states are caught at runtime, not at entity-load.
    state:       text({ default: 'draft' }),

    publishedAt: date(),                                // when to publish (scheduled) or when published

    // RELATIONSHIPS
    // `blog` FK — the owning tenant. No `role: owner` because the Blog entity
    // is the owner, not this Post. Auth must traverse: post → blog → owner.
    blog:        ref('Blog', { required: true }),
    // `author` FK — the User who wrote the post. Framework only auto-derives
    // defaults for `role: owner`; we set this manually in the create handler.
    author:      ref('User', { readonly: true }),

    createdAt:   date({ default: () => new Date(), readonly: true }),
    updatedAt:   date({ touch: true, readonly: true }),
  },

  // CHECKS — each becomes an `is.*` method in `grant` AND an instance method
  // (`post.isBlogOwner(user)`) for route-guard use. `author` is a sync check;
  // `blogOwner` is async (it loads the blog via FK traversal).
  checks: {
    author:    ({ entity, user }) => entity.author === user.id,
    // PAIN POINT: CROSS-ENTITY AUTH BOILERPLATE. Every entity in a tenant
    // hierarchy must hand-write a traversal to the owning entity's owner check.
    // There is no framework-level tenant isolation that auto-cascades.
    blogOwner: async ({ entity, user, load }) => {
      if (!user) return false;
      const blog = await load(entity.blog);
      return blog.isOwner(user);
    },
    published: ({ entity }) => entity.state === 'published',
  },

  // GRANT: published posts are public-readable; author + blog owner get full
  // access. `is.published()` is a sync check that doesn't need a user — this
  // IS the anonymous-read path, but the ROUTE GATE (requireAuth) will still
  // block unless the route uses `open`.
  grant: async ({ is }) => {
    if (is.published())                      return grant(read, subscribe);
    // PAIN POINT: `is.author()` is sync (false for anonymous since user is
    // null → entity.author !== null). `is.blogOwner()` is async and early-
    // returns false for null user. Both behave correctly, but the pattern of
    // mixing sync/async checks in a cascade is error-prone — forgot an `await`
    // and `is.blogOwner()` is a Promise (truthy), silently granting access.
    if (is.author() || await is.blogOwner()) return grant(read, write, subscribe, admin);
    return hide();
  },

  routes: (r, Post) => {
    // Public reads — `open` bypasses requireAuth so anonymous visitors can
    // read. The `grant` function above still gates access: hide() for drafts.
    r.get('/feed',         open, activityFeed(Post));   // cross-blog published feed
    r.get('/blog/:blogId', open, blogPosts(Post));      // published posts on a blog
    r.get('/:postId',      open, getPost(Post));         // single post (hide if draft)

    // Authenticated mutations — route gate requires auth; grant does per-row.
    r.post('/',                     createPost(Post));
    r.put('/:postId',               updatePost(Post));
    r.delete('/:postId',            deletePost(Post));
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// COMMENT — a reply on a Post, authored by a global User.
//
// Moderation state machine: pending → approved | spam | deleted.
// The blog author moderates comments on their own posts. Comment authors can
// edit their own pending comments. Approved comments are publicly visible when
// the parent post is published. Deleted comments are hidden but retained for
// audit.
//
// UNIFIED IDENTITY: `Comment.author` is a global User FK. A reader's profile
// shows all their comments across every blog via a simple FK query:
//   `Comment.findAll(Comment.author.is(userId))`
// This works cleanly because a `ref` FK is just a queryable column — no tenant
// isolation fights it.
// ═══════════════════════════════════════════════════════════════════════════
export const Comment = entity('Comment', {
  fields: {
    body:       text({ max: 2000, required: true }),

    // MODERATION STATE: pending | approved | spam | deleted.
    // PAIN POINT: no enum field type — same gap as Post.state.
    state:      text({ default: 'pending' }),

    // RELATIONSHIPS
    post:       ref('Post', { required: true }),
    // `author` FK — set manually in the create handler (same gap as Post.author).
    author:     ref('User', { readonly: true }),

    createdAt:  date({ default: () => new Date(), readonly: true }),
    updatedAt:  date({ touch: true, readonly: true }),
  },

  checks: {
    commentAuthor: ({ entity, user }) => entity.author === user.id,
    // PAIN POINT: DOUBLE CROSS-ENTITY TRAVERSAL. The blog owner of the post
    // this comment lives under must traverse comment → post → blog → owner.
    // Each layer of the tenant hierarchy adds a `load()` call. With 3+ levels
    // (comment → post → blog → owner), the boilerplate compounds.
    postBlogOwner: async ({ entity, user, load }) => {
      if (!user) return false;
      const post = await load(entity.post);
      const blog = await load(post.blog);
      return blog.isOwner(user);
    },
    approved:      ({ entity }) => entity.state === 'approved',
    // PAIN POINT: COMMENT REPLICATES POST VISIBILITY LOGIC. To determine if a
    // comment is publicly visible, we must check that the parent post is
    // published. This duplicates Post's `is.published()` logic inside Comment's
    // checks. There is no "delegate to parent entity's grant" mechanism.
    postPublished: async ({ entity, load }) => {
      const post = await load(entity.post);
      return post.state === 'published';
    },
  },

  grant: async ({ is }) => {
    if (await is.postBlogOwner())                             return grant(read, write, subscribe, admin);
    if (is.commentAuthor())                                   return grant(read, write, subscribe);
    if (is.approved() && await is.postPublished())            return grant(read, subscribe);
    return hide();
  },

  routes: (r, Comment) => {
    // Public: approved comments on a post (if the post is published).
    // `open` bypasses requireAuth; grant handles post-published + comment-approved.
    r.get('/post/:postId',  open, postComments(Comment));

    // Private: my comments across all blogs (unified identity).
    r.get('/mine',                  myComments(Comment));

    // Create a comment on a post (authenticated).
    r.post('/post/:postId',         createComment(Comment));

    // Edit own comment.
    r.put('/:commentId',            updateComment(Comment));

    // Moderation — blog owner only.
    r.post('/:commentId/approve',   moderateComment(Comment, 'approved'));
    r.post('/:commentId/spam',      moderateComment(Comment, 'spam'));
    r.delete('/:commentId',         softDeleteComment(Comment));
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// ROUTE HANDLER FACTORIES
//
// Each factory receives the entity class to avoid circular imports, following
// the pattern from doc/routes/handlers.mjs and doc/routes/shares.mjs.
// ═══════════════════════════════════════════════════════════════════════════

// ─── BLOG HANDLERS ────────────────────────────────────────────────────────

function blogList(Blog) {
  return async (req, res) => {
    const blogs = await Blog.findAll().sort(Blog.updatedAt, 'desc').limit(50);
    res.json({ blogs: blogs.map(b => ({ id: b.id, name: b.name, slug: b.slug, description: b.description })) });
  };
}

function blogGet(Blog) {
  return async (req, res) => {
    // `req.blog` auto-bound from `:blogId` by the framework.
    // PAIN POINT: `open` bypasses requireAuth, so `req.user` is undefined for
    // anonymous visitors. Instance methods like `blog.isOwner(undefined)` must
    // not throw — the check `entity.owner === undefined` is false, which is
    // correct, but a framework that guarantees this is safe is an assumption.
    res.json({
      id: req.blog.id, name: req.blog.name, slug: req.blog.slug,
      description: req.blog.description,
      isOwner: req.user ? req.blog.isOwner(req.user) : false,
    });
  };
}

function createBlog(Blog) {
  return async (req, res, next) => {
    // PAIN POINT: slug uniqueness is NOT enforced by the framework.
    // There is no `unique: true` field option. We hand-check it here;
    // a race condition between check and create is possible without
    // a database-level unique constraint.
    const existing = await Blog.findOne(Blog.slug.is(req.body.slug));
    if (existing) return next({ status: 409, message: 'slug taken' });

    const blog = await Blog.create({
      [Blog.name]:        req.body.name,
      [Blog.slug]:        req.body.slug,
      [Blog.description]: req.body.description || '',
      // `owner` is auto-populated from `req.user.id` by the framework because
      // of `role: owner`.
    });
    res.status(201).json({ id: blog.id, name: blog.name, slug: blog.slug });
  };
}

function updateBlog(Blog) {
  return async (req, res, next) => {
    // `req.blog` is auto-bound from `:blogId` by the framework.
    if (!req.blog.isOwner(req.user)) return res.sendStatus(403);

    if (req.body.name)  req.blog.name = req.body.name;
    if (req.body.description !== undefined) req.blog.description = req.body.description;
    // Slug changes need re-validation (same uniqueness gap).
    if (req.body.slug && req.body.slug !== req.blog.slug) {
      const clash = await Blog.findOne(Blog.slug.is(req.body.slug));
      if (clash) return next({ status: 409, message: 'slug taken' });
      req.blog.slug = req.body.slug;
    }
    await req.blog.save();
    res.json({ id: req.blog.id, name: req.blog.name, slug: req.blog.slug });
  };
}

function deleteBlog(Blog) {
  return async (req, res) => {
    if (!req.blog.isOwner(req.user)) return res.sendStatus(403);
    await Blog.delete(req.blog.id);
    res.sendStatus(204);
  };
}

// ─── SUBSCRIPTION HANDLERS ────────────────────────────────────────────────

function subscribe(Blog) {
  return async (req, res) => {
    // `req.blog` auto-bound from `:blogId`.
    await req.blog.subscribers.add(req.user.id);
    // Auto-emits Blog:<id>:subscribers:added:<userId> on the live stream.
    res.status(201).json({ subscribed: true });
  };
}

function unsubscribe(Blog) {
  return async (req, res) => {
    await req.blog.subscribers.remove(req.user.id);
    // Auto-emits Blog:<id>:subscribers:removed:<userId>.
    res.sendStatus(204);
  };
}

// ─── POST HANDLERS ────────────────────────────────────────────────────────

function activityFeed(Post) {
  return async (req, res) => {
    // Cross-blog feed of recently published posts. Public — `open` on route.
    const posts = await Post.findAll(Post.state.is('published'))
      .sort(Post.publishedAt, 'desc')
      .limit(20);
    // PAIN POINT: FK auto-population? We assume `post.blog` and `post.author`
    // are lazily loaded when accessed. If not, we'd need explicit `populate()`
    // or separate queries — the API contract for this is unclear.
    res.json({
      feed: posts.map(p => ({
        id: p.id, title: p.title, slug: p.slug,
        blog: { id: p.blog.id, name: p.blog.name, slug: p.blog.slug },
        author: { id: p.author.id, username: p.author.username },
        publishedAt: p.publishedAt,
      })),
    });
  };
}

function blogPosts(Post) {
  return async (req, res) => {
    // `req.blog` auto-bound from `:blogId`.
    const posts = await Post.findAll(
      Post.blog.is(req.blog.id).and(Post.state.is('published'))
    ).sort(Post.publishedAt, 'desc').limit(50);
    res.json({
      blog: { id: req.blog.id, name: req.blog.name, slug: req.blog.slug },
      posts: posts.map(p => ({ id: p.id, title: p.title, slug: p.slug, publishedAt: p.publishedAt })),
    });
  };
}

function getPost(Post) {
  return async (req, res) => {
    // `req.post` auto-bound from `:postId`. The framework runs `grant` on the
    // loaded entity — if the post is a draft and the viewer is not the author/
    // blog owner, grant returns `hide()` and the framework returns 404.
    // This works EVEN for anonymous users because `is.published()` and
    // `is.blogOwner()` handle the null-user case.
    res.json({
      id: req.post.id, title: req.post.title, slug: req.post.slug,
      body: req.post.body, state: req.post.state, publishedAt: req.post.publishedAt,
      blog: { id: req.post.blog.id, name: req.post.blog.name, slug: req.post.blog.slug },
      author: { id: req.post.author.id, username: req.post.author.username },
      createdAt: req.post.createdAt, updatedAt: req.post.updatedAt,
    });
  };
}

function createPost(Post) {
  return async (req, res, next) => {
    // PAIN POINT: `author` has no framework auto-default (only `role: owner`
    // FKs get it). We set it manually from `req.user`. This is correct but
    // inconsistent — some ref fields auto-populate, others need hand-setting.
    if (req.body.state && !POST_STATES.includes(req.body.state)) {
      return next({ status: 400, message: `invalid state: ${req.body.state}` });
    }

    const post = await Post.create({
      [Post.title]:       req.body.title,
      [Post.slug]:        req.body.slug,
      [Post.body]:        req.body.body || '',
      [Post.state]:       req.body.state || 'draft',
      [Post.publishedAt]: req.body.publishedAt || null,
      [Post.blog]:        req.body.blogId,
      [Post.author]:      req.user.id,  // hand-set (see PAIN POINT above)
    });
    res.status(201).json({ id: post.id, title: post.title, slug: post.slug, state: post.state });
  };
}

function updatePost(Post) {
  return async (req, res, next) => {
    // `req.post` auto-bound. Grant already verified the user is author or blogOwner.
    if (req.body.title) req.post.title = req.body.title;
    if (req.body.slug)  req.post.slug = req.body.slug;
    if (req.body.body !== undefined) req.post.body = req.body.body;

    // State transitions — validate the target state.
    if (req.body.state) {
      if (!POST_STATES.includes(req.body.state)) {
        return next({ status: 400, message: `invalid state: ${req.body.state}` });
      }
      req.post.state = req.body.state;

      // When transitioning to `published`, set publishedAt to now (unless it
      // was already scheduled). When transitioning to `scheduled`, publishedAt
      // must be set explicitly.
      if (req.body.state === 'published' && !req.post.publishedAt) {
        req.post.publishedAt = new Date();
      }
      // PAIN POINT: NO HOOK FOR SIDE EFFECTS.
      // When a post transitions to `published`, we should notify blog
      // subscribers. But the framework has no `afterSave` hook or event-
      // reaction mechanism — events are DERIVED from field mutations only.
      // Subscriber notification must be hand-implemented here (or omitted,
      // which is what we do — the workaround is external polling or a cron job).
    }

    if (req.body.publishedAt !== undefined) req.post.publishedAt = req.body.publishedAt;
    await req.post.save();
    res.json({ id: req.post.id, title: req.post.title, state: req.post.state, publishedAt: req.post.publishedAt });
  };
}

function deletePost(Post) {
  return async (req, res) => {
    // Grant already verified the user is author or blogOwner.
    await Post.delete(req.post.id);
    res.sendStatus(204);
  };
}

// ─── COMMENT HANDLERS ─────────────────────────────────────────────────────

function postComments(Comment) {
  return async (req, res) => {
    // `req.post` auto-bound from `:postId`.
    // PAIN POINT: we must manually filter to `state === 'approved'` because
    // `findAll` returns ALL rows that match the FK predicate. The grant function
    // governs per-row access for loaded entities (GET /comments/:id) but does
    // NOT filter list queries — the framework returns all rows and
    // post-filters by grant, or it doesn't filter list queries at all.
    // The API contract for list-query grant enforcement is undefined.
    const comments = await Comment.findAll(
      Comment.post.is(req.post.id).and(Comment.state.is('approved'))
    ).sort(Comment.createdAt, 'asc').limit(100);
    res.json({
      post: { id: req.post.id, title: req.post.title },
      comments: comments.map(c => ({
        id: c.id, body: c.body, state: c.state,
        author: { id: c.author.id, username: c.author.username },
        createdAt: c.createdAt,
      })),
    });
  };
}

// `GET /comments/mine` — unified comment identity across all blogs.
// A User sees all their comments regardless of which blog the post belongs to.
function myComments(Comment) {
  return async (req, res) => {
    // PAIN POINT: CROSS-BLOG COMMENT LIST. This query returns comments on
    // posts from DIFFERENT blogs. Since there is no tenant isolation at the
    // FK level (a `ref('Post')` is just a FK, not a scoped namespace), this
    // works cleanly. The tension between "tenant isolation" and "cross-tenant
    // aggregation" doesn't arise because the framework has NO tenant concept —
    // auth is entirely per-row, per-entity, hand-written in grant/checks.
    const comments = await Comment.findAll(Comment.author.is(req.user.id))
      .sort(Comment.createdAt, 'desc')
      .limit(50);
    // PAIN POINT: we must manually load the associated post for each comment
    // to display context (post title, blog name). If the FK auto-populates
    // lazily, N+1 queries result. If it doesn't, we'd need a batch load.
    const result = [];
    for (const c of comments) {
      const post = await c.post;  // assume lazy FK population
      result.push({
        id: c.id, body: c.body, state: c.state, createdAt: c.createdAt,
        post: { id: post.id, title: post.title },
      });
    }
    res.json({ comments: result });
  };
}

function createComment(Comment) {
  return async (req, res, next) => {
    // `req.post` auto-bound from `:postId`.
    // PENDING is the default; the comment must be approved by the blog owner.
    const comment = await Comment.create({
      [Comment.body]:   req.body.body,
      [Comment.post]:   req.post.id,
      [Comment.author]: req.user.id,  // hand-set (no auto-default for non-owner refs)
    });
    res.status(201).json({ id: comment.id, body: comment.body, state: comment.state });
  };
}

function updateComment(Comment) {
  return async (req, res) => {
    // `req.comment` auto-bound from `:commentId`.
    // Grant verifies the user is the comment author (or blog owner, who has admin).
    // Only the body is editable; state changes go through moderation endpoints.
    if (!req.comment.isCommentAuthor(req.user)) return res.sendStatus(403);
    req.comment.body = req.body.body;
    await req.comment.save();
    res.json({ id: req.comment.id, body: req.comment.body });
  };
}

// Moderation action factory: approve / spam.
function moderateComment(Comment, targetState) {
  return async (req, res) => {
    // `req.comment` auto-bound from `:commentId`.
    // Instance method `isPostBlogOwner` is derived from `checks.postBlogOwner`.
    // PAIN POINT: the method is async (it loads post + blog), but the naming
    // convention `isXxx` implies a sync boolean. An async `isPostBlogOwner`
    // returning a Promise is a footgun — calling it without `await` gives a
    // truthy Promise.
    if (!await req.comment.isPostBlogOwner(req.user)) return res.sendStatus(403);
    req.comment.state = targetState;
    await req.comment.save();
    res.json({ id: req.comment.id, state: req.comment.state });
  };
}

// Soft-delete: sets state to 'deleted' (hidden, retained for audit).
function softDeleteComment(Comment) {
  return async (req, res) => {
    // Both the comment author and the blog owner can delete.
    const isAuthor = req.comment.isCommentAuthor(req.user);
    const isOwner = await req.comment.isPostBlogOwner(req.user);
    if (!isAuthor && !isOwner) return res.sendStatus(403);
    req.comment.state = 'deleted';
    await req.comment.save();
    res.sendStatus(204);
  };
}

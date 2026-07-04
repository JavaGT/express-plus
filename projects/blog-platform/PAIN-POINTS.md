## Persona — The Publisher

Care about scheduled publication, public-by-default content, cross-blog identity,
and subscriber notification. Skeptical that a framework whose exemplar is a
private collaborative doc can serve public, multi-tenant, scheduled-publishing
content without ceremony on every public route.

## Attempted entity shape

```js
// blog.mjs — multi-tenant blog platform in the grilled workbench API.
// Entities: Blog, Post, Comment, Reader.
//
// Grilled constructs exercised:
//   - state + auto (scheduled publish)        — tests tick/scheduler gap
//   - scope + .can (public-by-default reads)   — tests anonymous principal + publicRead flag
//   - effects (subscriber notify)              — tests fan-out / multi-recipient gap
//   - principal types (Reader vs User)         — tests closed principal-type union
//   - inherit (Blog → Post → Comment)          — tests typed-FK grant inheritance
//   - map(set) (blog subscribers)              — tests keyed membership
//   - role: 'author' auto-populate             — tests non-owner ref defaulting
//   - unique (slug)                            — tests uniqueness constraint
//   - enum (category)                          — tests enum plugin
//
// Where a construct does not yet exist in the API surface, the code imports
// it from 'workbench' as an idealized handle and documents the gap.
import {
  entity, text, date, ref, set, map, state, enum_ as enumType,
  grant, deny, read, write, subscribe, admin, anyOf, never, scope,
  inherit, router,
  // ── aspirational imports (not yet in API surface) ──
  // principalType — declare a domain-specific principal type ('reader')
} from 'workbench';

const VIEWER    = [read, subscribe];
const AUTHOR    = [read, write, subscribe];
const OWNER     = [read, write, subscribe, admin];

// ────────────────────────────────────────────────────────────────────────────
// Blog entity — a hosted blog owned by a User.
// Blog metadata (name, slug, description) is publicly readable.
// Subscribers is a keyed set of Users (owner-managed).
// ────────────────────────────────────────────────────────────────────────────
export const Blog = entity('Blog', {
  fields: {
    name:        text({ validate: (v) => v.length <= 100 || 'name too long' }),
    slug:        text({ unique: true, validate: (v) => /^[a-z0-9-]+$/.test(v) || 'invalid slug' }),
    description: text({ max: 500 }),
    owner:       ref('User', { role: 'owner', readonly: true }),
    subscribers: set(ref('User'))
      .can(async ({ is }) =>
        (await is.owner()) ? grant(...OWNER) : grant(read)),
    createdAt:   date({ default: () => new Date() }),
  },
  checks: {
    owner: ({ Blog, principal }) => Blog.owner.is(principal?.id),
    // GAP: no `always`/`everyone` compiled constant.
    // For public blog reads (anyone can see blog metadata), we need a check
    // that is unconditionally true and compilable. `() => true` is truthy but
    // not a field-handle predicate — the compiler may reject it as non-compilable.
    // The `publicRead` entity flag (Phase 1, ~10 lines) is the planned
    // resolution, but it's not yet in the API surface.
  },
  grant: ({ principal }) => [
    // Blog metadata is public. The scope admits ALL blog rows — no filter.
    // GAP: `scope` requires named checks. No built-in `always()`/`everyone()`.
    // Workaround: scope on `is.owner()` only → public readers can't see blog
    // metadata, which breaks rendering a post (needs blog name + slug).
    //
    // With publicRead: true (aspirational), GET routes auto-open and scope
    // admits all rows; .can grants read to anonymous.
    scope(({ is }) => is.owner())
      .can(async ({ is }) => {
        if (await is.owner()) return grant(...OWNER);
        // GAP: no anonymous principal — .can can't distinguish "logged in, not
        // owner" from "no session at all."
        return grant(read, subscribe);
      }),
  ],
  routes: (r) => {
    r.resource();   // GAP: r.resource() generates auth-required routes for ALL
                    // verbs. No way to say "GET is open, POST/PUT/DELETE authed."
                    // publicRead: true would auto-open GET; without it, every
                    // public GET route needs hand-written `open` middleware.
  },
});

// ────────────────────────────────────────────────────────────────────────────
// Post entity — a blog post with draft→scheduled→published state machine.
// Published posts are public; draft/scheduled are author-only.
// ────────────────────────────────────────────────────────────────────────────
export const Post = entity('Post', {
  fields: {
    blog:     ref('Blog', { required: true }),
    title:    text({ validate: (v) => v.length <= 200 || 'title too long' }),
    body:     text({ validate: (v) => v.length <= 50000 || 'body too long' }),
    slug:     text({ unique: true }),
    author:   ref('User', { role: 'author', readonly: true }),
    category: enumType({ values: ['tech', 'life', 'politics', 'science'] }),

    // ── State machine: draft → scheduled → published → archived ────────────
    state: state({
      values: ['draft', 'scheduled', 'published', 'archived'],
      transitions: {
        draft:      ['scheduled', 'published'],
        scheduled:  ['published', 'draft'],
        published:  ['archived'],
        archived:   ['draft'],
      },
      // ── SCHEDULED PUBLISH GAP ───────────────────────────────────────────
      // GAP: `auto` only supports relative `after: duration`, not a
      // field-driven point-in-time trigger. Scheduled publish needs:
      //   "when state = 'scheduled' AND clock >= publishedAt, → published"
      //
      // `after: '0s'` transitions IMMEDIATELY on entering 'scheduled' — not
      // at the publishedAt timestamp. `after` is always relative to state entry
      // time, never a field value. There is no `at: entity.publishedAt` syntax.
      //
      // WORKAROUND: omit `auto` entirely and use entity-level `tick` (Phase 2)
      // that periodically scans for scheduled posts past publishedAt.
      auto: {
        // This is WRONG — it fires immediately, not at publishedAt:
        // when: 'scheduled', after: '0s', to: 'published',
        //
        // Aspirational form:
        // when: 'scheduled', at: Post.publishedAt, to: 'published',
      },
      // ── SUBSCRIBER-NOTIFY EFFECT GAP ────────────────────────────────────
      // GAP: effects create ONE mutation per trigger. A post publishing needs
      // to notify ALL blog subscribers — a fan-out to N recipients. The
      // `{ mutate, with }` template produces exactly one row (here: one Inbox
      // entry). There is no iteration/expansion construct for fan-out.
      //
      // `delta.member` works for single-recipient (collaborator added);
      // `blog.subscribers` is an iterable set — no way to say
      // "for each subscriber, create one Inbox row."
      //
      // ASPIRATIONAL: `{ mutate: Inbox, with: { each: blog.subscribers,
      //   template: { recipient: item, post: entity.id, kind: 'new-post' } } }`
      effects: {
        // [state.transition('scheduled', 'published')]: { mutate: Inbox, with: {
        //   recipient: ???,   // GAP: need blog.subscribers.each, not a single value
        //   post: entity.id,
        //   kind: 'new-post',
        // } },
      },
    }).can(async ({ is }) =>
      (await is.author() || await is.blogOwner()) ? grant(...OWNER) : deny('only author may change state')),

    publishedAt: date({ optional: true }),
    createdAt:   date({ default: () => new Date() }),
    updatedAt:   date({ touch: true }),
  },

  checks: {
    // `published` DOES reference the row (not principal) — compiles to
    // `state = 'published'` in SQL. Clean row-level fact.
    published: ({ entity }) => entity.state.is('published'),
    // `author` compiles — direct ref equality on Post.author column.
    author:    ({ entity, principal }) => entity.author.is(principal?.id),
    // `blogOwner` — typed-FK traversal: Post.blog.owner.is(principal.id).
    // The grilled design's typed-FK traversal (abstraction #5) makes this
    // compilable. IF the compiler follows the FK chain, it produces:
    //   JOIN blog ON post.blog_id = blog.id WHERE blog.owner_id = ?
    // Without FK-traversal compilation, this is async → non-compilable →
    // load-time error if used in scope.
    blogOwner: ({ entity, principal }) => entity.blog.owner.is(principal?.id),
  },

  grant: ({ principal }) => [
    // GAP (tentative): `is.published()` compiles to `state = 'published'` —
    // a row-only check with no principal binding. For anonymous, this admits
    // published rows into scope. Then .can returns grant(read, subscribe).
    //
    // This works IF:
    //   1. `requireAuth` doesn't reject anonymous before .can runs (needs
    //      `publicRead: true` entity flag or `open` middleware on GET routes).
    //   2. .can receives an `anonymous` principal (not null). The grilled
    //      principal type union is `user|link|system` — no `anonymous`.
    //   3. `entity.author.is(undefined)` compiles to SQL FALSE (it does —
    //      the grilled `.is(undefined) → FALSE` rule). So anonymous passes
    //      the scope filter for published rows but fails author/blogOwner
    //      sub-scopes — exactly correct.
    //
    // GAP (confirmed): `is.blogOwner()` requires typed-FK traversal in the
    // compiler. Without it, this scope is a load-time error.
    scope(({ is }) => anyOf(is.published(), is.author(), is.blogOwner()))
      .can(async ({ is, entity }) => {
        if (await is.published()) return grant(read, subscribe);
        // ^ For published posts: anyone can read. For anonymous principal:
        //   returns grant(read, subscribe) — correct. But only if anonymous
        //   principal exists.
        if (await is.author() || await is.blogOwner()) return grant(...AUTHOR);
        return deny('cannot read this post');
      }),
  ],

  routes: (r) => {
    // GAP: `r.resource()` generates ALL routes with requireAuth.
    // Public GET routes (/posts, /posts/:id) need `open` middleware.
    // r.get('/', open, listPublished);   // hand-written, open middleware
    // r.get('/:postId', open, getPost);  // same
    //
    // With publicRead: true, these routes auto-open. Without it: ceremony.
    r.resource();
  },
});

// ────────────────────────────────────────────────────────────────────────────
// Reader entity — cross-blog comment identity, separate from User.
// A Reader is created on first comment (name + email); identity persists.
// ────────────────────────────────────────────────────────────────────────────
export const Reader = entity('Reader', {
  fields: {
    name:      text({ required: true }),
    email:     text({ unique: true, validate: (v) => v.includes('@') || 'invalid email' }),
    // GAP: no way to declare "this entity's rows are readable only by the
    // Reader themselves." Reader's principal type must match Reader entity —
    // but `principalType` doesn't exist in the grilled API.
    createdAt: date({ default: () => new Date() }),
  },
  checks: {
    // GAP: `principal?.type === 'reader'` — 'reader' is not in the user|link|system union.
    // Domain-specific principal types require a framework extension point.
    self: ({ entity, principal }) =>
      principal?.type === 'reader' && entity.id === principal.id,
  },
  grant: ({ principal }) => [
    scope(({ is }) => is.self())
      .can(async ({ is }) => {
        if (await is.self()) return grant(read, write);
        // GAP: Blog owners need to read Reader profiles (to display commenter
        // names). But Reader's scope only admits self. No way to say:
        // "admit self OR any authenticated User" without a Reader-specific
        // check that loads cross-entity. This is the same publicRead gap from
        // a different angle.
        return deny('reader profile is private');
      }),
  ],
});

// ────────────────────────────────────────────────────────────────────────────
// Comment entity — on a Post, authored by a Reader, inheriting Post's grant.
// Threaded via optional self-referential parent FK.
// ────────────────────────────────────────────────────────────────────────────
const inheritPost = inherit('Post', { via: 'post' });

export const Comment = entity('Comment', {
  fields: {
    post:   ref('Post', { required: true }),
    author: ref('Reader', { role: 'author', readonly: true }),
    // GAP: `role: 'author'` derives checks.author against Reader principal.
    // But Reader is a separate principal type. The auto-derivation assumes the
    // principal type matches the ref target (User). Cross-type refs (Reader
    // authoring a Comment) don't cleanly fit the auto-derive pattern.
    body:   text({ validate: (v) => v.length <= 5000 || 'comment too long' })
      .can(async ({ is }) =>
        (await is.author()) ? grant(read, write, subscribe) : grant(read, subscribe)),
    parent: ref('Comment', { optional: true }),
    // GAP: tree loading requires `loadTree()` helper (Phase 3). Self-referential
    // FK traversal to assemble threaded comments is N+1-prone without it.
    state:  enumType({ values: ['pending', 'approved', 'spam'] })
      .can(async ({ is }) =>
        (await is.author()) ? grant(read)   // author can read, can't change state
          : (await is.blogOwner()) ? grant(read, write)  // blog owner moderates
          : grant(read)),
    createdAt: date({ default: () => new Date() }),
  },
  checks: {
    // Auto-derived from `role: 'author'` on Reader ref — but cross-type.
    // author: ({ entity, principal }) => entity.author === principal.id,
    // blogOwner needs typed-FK traversal: Comment.post.blog.owner.is(principal.id)
    blogOwner: ({ entity, principal }) => entity.post.blog.owner.is(principal?.id),
  },
  // Inherits Post's read scope through typed FK:
  // - published post's comments are publicly readable
  // - draft post's comments are only author/blog-owner readable
  // - comment author can edit their own comment (field-level .can)
  // - blog owner can moderate (field-level .can on state)
  grant: inheritPost,

  routes: (r) => {
    r.resource();                               // CRUD through inherited grant
  },
});

// ────────────────────────────────────────────────────────────────────────────
// Global wiring (aspirational)
// ────────────────────────────────────────────────────────────────────────────
// import workbench from 'workbench';
// const app = workbench();
// app.mount('/blogs', Blog);
// // Posts mount under /blogs/:blogId/posts. publicRead: true auto-opens GET.
// app.mount('/blogs/:blogId/posts', Post, { publicRead: true });
// // Comments mount under /blogs/:blogId/posts/:postId/comments.
// // Inherits Post's grant through typed FK.
// app.mount('/blogs/:blogId/posts/:postId/comments', Comment);
```

## Pain points

### BLOCKER #1: `state.auto` is duration-relative only — no point-in-time / field-driven trigger for scheduled publish

> **SETTLED (background jobs shipped):** A durable job-queue primitive has
> landed — `createJobQueue` is exported from `workbench/internal`
> (`src/job-queue.mjs`). Scheduled publish can now be driven by an in-framework
> background job (enqueue at `publishedAt`, transition on fire) instead of an
> external timer. The narrower ask — a *declarative* point-in-time `auto`
> trigger inside `state` (`at: Post.publishedAt`) — remains the open part of
> this blocker. Historical text kept below.

Tests: DECISIONLOG.md ADR #4 (scheduled mutation = timer feeding pipeline);
IMPLEMENTATION-PLAN abstraction #4 (state.auto + entity tick are same
mechanism); doc.mjs L78-82 (the only auto exemplar: relative `after: '90d'`).

Failing code:

```js
// What the blog platform needs: "at the publishedAt timestamp, auto-publish."
// What the API provides:
state: state({
  values: ['draft', 'scheduled', 'published', 'archived'],
  auto: {
    when: 'scheduled', after: '0s', to: 'published',
    // ^ This fires IMMEDIATELY on entering 'scheduled', not at publishedAt.
    // `after` is always relative to the state's entry time, never a field value.
    // There is no `at: Post.publishedAt` syntax.
  },
}),

// Workaround: omit `auto` and rely on entity-level `tick` (Phase 2 item 9)
// that periodically scans for rows matching `state = 'scheduled' AND
// publishedAt <= NOW()`. This works, but `tick` is not in the Phase 1 API
// surface (see space-invaders BLOCKER #1 for the same tick gap).
//
// ASPIRATIONAL:
// auto: {
//   when: 'scheduled', at: Post.publishedAt, to: 'published',
// },
```

The gap: `state.auto` only expresses "after N time units in this state, do X."
It cannot express "at this field's value, do X." Scheduled publish is the
canonical use case for point-in-time triggers — without it, the framework's
state machine cannot execute time-driven transitions, only duration-driven ones.

### SHOULD-FIX #1: No anonymous principal — `publicRead` bridges a gap the principal model should fill

Tests: DECISIONLOG.md ADR #1 (read is the sole visibility axis — denied read =
row absent); ADR #7 (no default grant); FEATURES.md §6 ("always functions, never
magic words"); AGENTS.md ("two default-on layers: route gate + row grant").

Failing code:

```js
// Post's grant: published posts are readable by anyone.
grant: ({ principal }) => [
  scope(({ is }) => anyOf(is.published(), is.author(), is.blogOwner()))
    .can(async ({ is, entity }) => {
      if (await is.published()) return grant(read, subscribe);
      // ^ This intends to grant read to "anyone" — but anonymous visitors have
      // no principal. principal is null/undefined. `is.published()` in scope
      // compiles to `WHERE state = 'published'` — a row-only filter that DOES
      // admit rows without a principal match. Good.
      //
      // BUT: `requireAuth` is default-on. Anonymous requests are rejected
      // BEFORE `.can` runs, at the route gate. `.can` never sees them.
      //
      // TWO problems:
      // 1. Route gate: no principal → rejected before grant evaluation.
      //    Needs `publicRead: true` entity flag OR `open` middleware on every
      //    public GET route.
      // 2. Principal model: `principal` is `{ id, type: 'user'|'link'|'system' }`.
      //    No `anonymous` type. `.can` can't cleanly distinguish "logged in
      //    but not author" from "not logged in at all."
      if (await is.author() || await is.blogOwner()) return grant(...AUTHOR);
      return deny('cannot read this post');
    }),
],
```

The `publicRead: true` flag (IMPLEMENTATION-PLAN Phase 1 item 6, "~10 lines")
solves problem 1 (route gate). But it's an entity-level escape hatch, not a
proper principal type. An anonymous principal `{ type: 'anonymous' }` would make
the grant model self-contained: `.can` can return `grant(read, subscribe)` for
anonymous without a separate flag. `publicRead` is a workaround for a missing
principal type, not a designed solution. It also doesn't compose: what if
SOME rows are public and SOME are not? The flag is entity-global, while the
grant model is per-row.

### SHOULD-FIX #2: Principal type union closed at `user|link|system` — domain-specific principal types require framework extension

Tests: IMPLEMENTATION-PLAN abstraction #2 (uniform principal model);
abstraction #5 (principal→domain-identity binding via typed FK).

Failing code:

```js
// The blog platform needs a Reader entity — a cross-blog identity for
// commenters, separate from User (who owns blogs). A Reader logs in with
// name+email (no password) and their identity + comment history carries
// across every blog on the platform.
//
// To express "a Reader can edit their own comment," the Comment entity needs:
//   author: ref('Reader', { role: 'author', readonly: true })
//
// `role: 'author'` auto-derives checks.author as:
//   ({ entity, principal }) => entity.author === principal.id
//
// This requires `principal.type === 'reader'` — the principal's ID must
// match a Reader FK. But the grilled principal union is:
//   { id, type: 'user' | 'link' | 'system' }
// There is no 'reader' type and no extension point to declare one.
//
// Workarounds, none clean:
// A) Reader IS a User (piggyback). Blurs identity: "commenter" and "blog
//    owner" are the same principal type. Breaks the distinction the domain
//    requires — a Reader may never own a blog.
// B) Comment.author = ref('User') — merge Reader into User. The cross-blog
//    identity is a User account. But then every commenter must register
//    (name+email+password+session), not just identify.
// C) Principal type is always 'user', but `readerId` field on User → bound
//    identity (User↔Reader pattern from IMPLEMENTATION-PLAN). Requires a User
//    proxy for every Reader — still merges identities.

// ASPIRATIONAL: declare a domain-specific principal type
// import { principalType } from 'workbench';
// export const ReaderPrincipal = principalType('reader', { fields: { name, email } });

// Then Comment can use:
// author: ref('Reader', { role: 'author', readonly: true })
// and the auto-derived checks.author compiles against `principal.type === 'reader'`.
```

The gap: the principal type union is hardcoded. The framework cannot express
domain-specific principals like `Reader`, `Patron` (from library stress-test),
or `Player` (from space-invaders) without framework source changes. The plan
mentions "principal→domain-identity binding" (abstraction #5) but this is
a data-link pattern (User→Patron FK), not a new principal type. A data-link
means every Reader must have an associated User — which contradicts "Reader is
separate from User."

### SHOULD-FIX #3: Effects can't fan out — one `{ mutate, with }` = one target row

Tests: DECISIONLOG.md ADR #6 (effects = bounded in-transaction effect-principal
reentrancy); doc.mjs L184-188 (the only effects exemplar: single-recipient
Inbox notification); FEATURES.md §7 ("one composed event").

Failing code:

```js
// When a post transitions from scheduled → published, notify ALL blog
// subscribers. The doc.mjs exemplar shows:
effects: {
  [native('Post', 'collaborators', 'added')]: { mutate: Inbox, with: {
    recipient: delta.member,  // ONE recipient — the single collaborator added
    doc: entity.id,
    kind: 'invite',
  } },
},

// For subscriber notify, we need N Inbox rows for N subscribers:
//   Blog.subscribers = {alice, bob, carol}
//   → 3 Inbox rows: each with recipient = one subscriber
//
// The template can't iterate: `delta.member` is a single value, and there
// is no `blog.subscribers.each` or list expansion syntax.
//
// Attempting to express it:
effects: {
  [state.transition('scheduled', 'published')]: { mutate: Inbox, with: {
    // recipient: entity.blog.subscribers.each,  ← NOT VALID; no expansion
    // post: entity.id,
    // kind: 'new-post',
  } },
},
```

The gap: the `{ mutate, with }` template produces exactly one target row.
Multi-recipient fan-out (notify all subscribers, broadcast to all channel
members) requires an iteration construct the API doesn't provide. The
single-primitive claim ("{set} and {create} collapse into one verb") is
correct for per-target decisions but silent on per-source cardinality —
one source mutation may produce N target mutations. The API needs a fan-out
primitive, or the single `{ mutate, with }` must accept an iterable expansion.

### SHOULD-FIX #4: `scope` requires named checks — no built-in `everyone()` constant for unconditional read admission

Tests: DECISIONLOG.md ADR #7 (no default grant — must name who reads);
FEATURES.md §6 ("`never()`/.is(undefined) compile to SQL FALSE").

Failing code:

```js
// Blog metadata is public. To admit all rows in scope, we need a check that
// is unconditionally true AND compilable. `never()` is the FALSE constant.
// There is no `everyone()` or `always()` TRUE constant.
//
// Workaround: define a check that's always true:
checks: {
  anyone: ({ entity }) => entity.id.is(entity.id),  // tautology, compiles
},
// Then: scope(({ is }) => is.anyone())
//
// But `entity.id.is(entity.id)` compiles to `id = id` which is MySQL's
// NULL-unsafe equality problem (NULL = NULL → NULL, not TRUE). Also: this is
// a hack — the developer is writing SQL tautology through typed handles to
// trick the compiler. The framework should provide a typed constant TRUE
// the way it provides `never()` as the typed constant FALSE.
//
// Without `everyone()`, every public-read entity must define a tautology
// check — ceremony that a first-class constant would eliminate.
```

The gap: `never()` exists as a typed SQL FALSE constant; `everyone()` (or
`always()`) as the typed SQL TRUE constant does not. Every entity that wants
to admit all authenticated users — or all visitors — to its read scope must
hack a tautology into its checks block.

### SHOULD-FIX #5: `r.resource()` generates auth-required routes for all verbs — no per-verb opt-out

Tests: DECISIONLOG.md ADR #7 (no default grant); FEATURES.md §3 (routing idiom);
AGENTS.md ("two default-on layers: route gate + row grant").

Failing code:

```js
// A blog platform's Post entity needs:
//   GET  /posts           → public (list published posts)
//   GET  /posts/:id       → public (read a published post)
//   POST /posts           → authed (create a post)
//   PUT  /posts/:id       → authed (edit own post)
//   DELETE /posts/:id     → authed (delete own post)
//
// r.resource() generates ALL FIVE routes with requireAuth. To make GET
// routes public, you must either:
//
// A) Hand-write every route:
routes: (r) => {
  r.get('/', open, listPublished);
  r.get('/:postId', open, getPost);
  r.post('/', requireAuth, createPost);
  r.put('/:postId', requireAuth, updatePost);
  r.delete('/:postId', requireAuth, deletePost);
  // ^ 5 handlers, 6 lines of middleware wiring. Repeats for Blog, Comment.
  // Multiplied by entities → ceremony proportional to public route count.
},

// B) Use publicRead: true entity flag (Phase 1, aspirational):
routes: (r) => {
  r.resource();  // GET routes auto-open; POST/PUT/DELETE stay authed
},

// Without publicRead, (A) is the only option. `r.resource()` is unusable for
// any entity with public-read routes — which is EVERY entity in a blog platform.
```

The gap: `r.resource()` is an all-or-nothing auto-CRUD that inherits the
route gate's default-on posture. There is no per-verb opt-out (`resource({ open:
['get'] })`) and no entity-level `publicRead` flag in the current API surface.
The planner calls `publicRead` "~10 lines" — but until it lands, every blog
entity's route block triples in size.

### Sharp edge #1: `is.blogOwner()` in scope requires typed-FK-traversal compilation — not yet in Phase 1 API surface

Tests: IMPLEMENTATION-PLAN abstraction #5 (typed-FK traversal in authorization
compiler); comment.mjs (inherit through typed FK — same machinery).

```js
// Post's scope needs to admit draft/scheduled posts for blog owners.
// The check:
blogOwner: ({ entity, principal }) => entity.blog.owner.is(principal.id),

// In scope:
scope(({ is }) => anyOf(is.published(), is.author(), is.blogOwner()))
//                                  compiles     compiles    requires FK traversal
//
// is.blogOwner() compiles IF the compiler can follow Post.blog → Blog.owner
// and produce: JOIN blog ON post.blog_id = blog.id WHERE blog.owner_id = ?
//
// Without FK-traversal compilation, is.blogOwner() is non-compilable → LOAD-TIME
// ERROR if used in scope. The plan says abstraction #5 is part of Phase 1
// (item 3: "queryScope derivation from grant + typed-FK traversal compilation").
// Until it lands, blogOwner cannot be in scope → draft posts are invisible to
// blog owners in list queries (data-leak or broken feature, pick one).
//
// Workaround: drop blogOwner from scope. Blog owners must use a separate
// admin list endpoint that post-filters. Second auth path.
```

### Sharp edge #2: `inherit` carries parent scope for read, but blog metadata read is owner-only — transitive public read breaks

Tests: DECISIONLOG.md ADR #7 (no default grant); comment.mjs (inherit pattern).

```js
// Comment inherits Post's grant: inherit('Post', { via: 'post' })
// Post's scope admits: published OR author OR blogOwner
// → Comment visible when: (post is published) OR (commenter is post author)
//   OR (commenter is blog owner). Correct.
//
// But what about nested comments (reply to a comment)?
// Reply inherits Comment's grant: inherit('Comment', { via: 'parent' })
// Comment's scope = Post's scope (inherited) + Comment's own scope (none declared).
// Reply → Comment → Post. Same scope chain. Works.
//
// ISSUE: If Blog becomes public-read (scope admits all), then transitively
// every Post and Comment is public-read. This is correct for a blog platform.
// But the developer must be aware that changing Blog's scope cascades to all
// descendants via inherit — a silent ripple. There is no `inherit(..., { only:
// ['read'] })` to scope the inheritance.
```

### Sharp edge #3: `role: 'author'` auto-derive assumes principal type matches ref target — cross-type refs (Reader→Comment) break

Tests: comment.mjs L23 (role: 'author'); FEATURES.md §4 (ref auto-population).

```js
// Comment's author ref:
author: ref('Reader', { role: 'author', readonly: true }),

// The grilled auto-derive for role: 'author' produces:
//   checks.author = ({ entity, principal }) => entity.author === principal.id
//
// This assumes principal is a Reader (the ref target). But the principal comes
// from the session — its type is 'user' | 'link' | 'system'. If the session
// produces a Reader principal, the type must match. Without the 'reader'
// principal type (SHOULD-FIX #2), this auto-derive silently compares a User
// principal.id against a Reader ref column — a type mismatch that may compile
// but always returns false.
//
// The framework should reject `role: 'author'` on a ref whose target entity
// does not match a principal type at load time. But principal types are
// closed — the framework can't know about Reader.
```

## Prior findings re-checked

| # | Prior finding (pre-grill) | Status | Why |
|---|---|---|---|
| 1 | No scheduled-job or timer construct → BLOCKER | RESOLVED | `state.auto` exists (doc.mjs L78-82). BUT: `auto` is duration-relative only (see BLOCKER #1 above). The scheduled-publish gap is narrower: `auto` exists but can't express field-driven point-in-time triggers. |
| 2 | List-query grant enforcement undefined → SHOULD-FIX | RESOLVED | Scope compiles to SQL WHERE; `findAll` is pre-authorized, never post-filtered. The doc.mjs feed handler (L207) explicitly states "queryScope already filtered." |
| 3 | `open` required on every public route → SHOULD-FIX | STILL-OPEN | `publicRead: true` entity flag is planned (Phase 1, "~10 lines") but not shown in any exemplar API surface. Without it, public GET routes still need hand-written `open` middleware. SHOULD-FIX #5 above covers this. |
| 4 | No tenant/isolation — cross-entity auth boilerplate → SHOULD-FIX | RESOLVED | `inherit('Parent', { via: 'fk' })` exists (comment.mjs L18) — child grant inherits parent scope + `.can` through typed FK. No hand-written traversal needed. Blog→Post→Comment chain is declarable. |
| 5 | No hooks/afterSave — no side-effect mechanism → SHOULD-FIX | RESOLVED | `effects` exist (doc.mjs L184-188): `{ mutate, with }` declarative reactions. BUT: no fan-out (SHOULD-FIX #3 above) — the subscriber-notify case (N recipients) still can't be expressed. |
| 6 | No `unique` constraint on text fields → SHOULD-FIX | RESOLVED | `unique` is Phase 1 item 6 ("~1 wk"). Declared on text fields as `text({ unique: true })` — the framework generates a DB-level unique index and surfaces a typed constraint-violation error. No hand-written race-condition-prone check-insert pattern. |
| 7 | No enum field type → NIT | RESOLVED | `state` plugin is the enum/state-machine equivalent. `enum` standalone constructor is listed as a Phase 1 item 4 built-in plugin. Post uses `state()` for lifecycles; Comment uses `enumType()` for moderation states. |
| 8 | Async `is.*` methods are a naming footgun → NIT | RESOLVED | Phase 0 auth-safety gate: "is.* thenable + unawaited-call runtime guard." The engine throws if grant returns while an `is.*` call is unawaited. No more silent auth bypass from `is.author() || is.blogOwner()`. |
| 9 | No auto-default from request context for non-owner ref → NIT | RESOLVED | `role: 'author'` on ref auto-populates from principal (comment.mjs L23). `role: 'owner'` is the privileged form; `role: 'author'` is the general case. Post.author and Comment.author both use it. |
| 10 | FK auto-population contract unspecified → NIT | STILL-OPEN | Still idealized — the grilled model says "auto-traversal and population" (CONTEXT.md L180) but N+1 semantics (eager/lazy, `.populate()`) are undefined. The blog feed handler accessing `post.blog.name` in a loop is ambiguous. |
| 11 | Comment replicates Post visibility logic → NIT | RESOLVED | `inherit('Post', { via: 'post' })` means Comment inherits Post's read scope through typed FK. No duplication. Post's definition of "published" flows to Comment automatically. |

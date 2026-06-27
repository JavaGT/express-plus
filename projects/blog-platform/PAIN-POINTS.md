// projects/blog-platform/PAIN-POINTS.md
//
// Documenting the gaps when applying the express-plus entity API to a
// multi-tenant blog hosting platform with publication state machines,
// unified comment identity, and comment moderation.
//
// Rankings: BLOCKER (cannot build the feature without framework change),
//           SHOULD-FIX (framework change substantially improves the DX),
//           NIT (awkward but workable).

# 1. No scheduled-job or timer construct — BLOCKER

**Cite**: `fields` in DOMAIN-MODULES.md L24-41 lists the complete field type
catalog: `text`, `text.crdt()`, `number`, `date`, `ref`, `set`, `presence`,
`log`, `hash`. There is no `schedule`, `queue`, `cron`, `timer`, `job`, or
`deferred` construct anywhere in the framework.

**Impact**: The publication state machine (`draft` → `scheduled` → `published`)
requires that scheduled posts auto-publish at `publishedAt`. This is a
TIME-DELAYED STATE TRANSITION — the most fundamental operation of a blog
platform after creating a post. Without a timer, the scheduled state is dead:
a post sits at `scheduled` forever unless something outside the framework
flips it.

The framework's live-event model (`Post:<id>:state:changed`) fires WHEN the
state changes, but there is nothing to CAUSE the change at the appointed time.
You must either:
(a) run an external cron job that queries `state === 'scheduled' AND
   publishedAt <= NOW()` and flips them — bypassing the entity API entirely,
(b) poll in the feed handler and side-effect the transition on read, which
    is wrong (reads should not mutate), or
(c) omit scheduled publishing and only support manual publish.

All three workarounds mean the framework does not own the publication
workflow. The state machine is a lie — the framework can represent the states
but cannot execute the transitions.

**Workaround**: External cron job polling the database directly.

**Rank**: BLOCKER

---

# 2. List-query grant enforcement is undefined — SHOULD-FIX

**Cite**: The `grant` function (DOMAIN-MODULES.md L108-114, doc/index.mjs
L108-114) governs per-row authorization when loading a single entity by ID.
The doc code shows `Document.findAll(Document.owner.is(me))` — the predicate
is hand-supplied, NOT injected by the framework from `grant`. There is NO
documented behavior for whether `findAll` post-filters results by the entity's
`grant` function.

**Impact**: If `Comment.findAll(Comment.post.is(postId))` returns ALL comments
(including pending/spam/deleted) without applying per-row `grant`, then the
public `GET /comments/post/:postId` route (which uses `open` to bypass
requireAuth) LEAKS private moderation state to anonymous visitors. An attacker
can read every pending, spam, and deleted comment by querying the endpoint.

The same applies to `Post.findAll(Post.blog.is(blogId))` — if `grant` is not
applied, draft/scheduled posts leak.

WORKAROUND (used in this code): Hand-apply the visibility filter in every
route handler by AND-ing an explicit `.and(Post.state.is('published'))` or
`.and(Comment.state.is('approved'))`. This is NOT a workaround — it is a
DUPLICATE AUTHORIZATION PATH. The handler restates what `grant` already
declares, violating the rule "authorization lives with the data" (DOMAIN-
MODULES.md L24) and "no second auth path" (DOMAIN-MODULES.md L44). If you
update `grant` to add a new role, you must ALSO update every list-query
handler — they drift apart.

**Workaround**: Explicit `.and(state.is('published'))` in every handler.

**Rank**: SHOULD-FIX (borderline BLOCKER — this is functionally a data-leak
vulnerability for any application with public-read entities).

---

# 3. `open` required on every public route — fail-closed fights public-read content — SHOULD-FIX

**Cite**: DOMAIN-MODULES.md L110-114 — "The route gate (`requireAuth`) is
default-on for every route. A single route opts out with the `open` middleware
— the one legitimate unauthenticated endpoint (it mints the session)."

**Impact**: In a blog platform, the majority of routes ARE public reads:
`GET /blogs`, `GET /blogs/:id`, `GET /posts/feed`, `GET /posts/blog/:blogId`,
`GET /posts/:postId`, `GET /comments/post/:postId`. Every one of these needs
`open` middleware. This is 6+ routes per app — it is not "the one legitimate
unauthenticated endpoint."

The `open` middleware is designed for the login route (`POST /sessions`) — a
single exception. Applying it to every public GET route is a code smell: if
PUBLIC-READ is the norm for your domain, the framework's default is fighting
you on every route.

Compounding this: `r.resource()` (auto-CRUD) cannot be used because it
generates auth-required routes for ALL verbs. You must hand-write every
route to insert `open`. An entity-level declaration like `publicRead: true`
would auto-apply `open` to GET routes only, but no such construct exists.

The framework's "two default-on layers" (route gate + row grant) are designed
for private-by-default documents (Google Docs). For public-by-default content
(blogs, CMS, forums), the route gate layer is misaligned with the domain. A
single opt-out at mount time (`app.mount('/posts', Post, { open: true })`)
would solve this, but the API has no such parameter.

**Workaround**: Hand-write every route with `open` middleware. Abandon
`r.resource()` entirely.

**Rank**: SHOULD-FIX

---

# 4. No tenant/isolation concept — cross-entity auth boilerplate — SHOULD-FIX

**Cite**: `checks` block (DOMAIN-MODULES.md L95-98, doc/index.mjs L88-94) is
the ONLY mechanism for defining auth predicates. There is no `tenant` keyword,
no `inherits` on `ref()` FKs, no auto-cascading grant from a parent entity.
The ONLY auth shortcut is `role: owner` — which works for the DIRECT owning
entity, not for child entities in a hierarchy.

**Impact**: In a multi-tenant hierarchy (Blog → Post → Comment), every child
entity must hand-write a traversal to the owning entity:

```js
// Post: post → blog → owner (one hop)
blogOwner: async ({ entity, user, load }) => {
  const blog = await load(entity.blog);
  return blog.isOwner(user);
},

// Comment: comment → post → blog → owner (two hops)
postBlogOwner: async ({ entity, user, load }) => {
  const post = await load(entity.post);
  const blog = await load(post.blog);
  return blog.isOwner(user);
},
```

At 2 hops this is acceptable boilerplate. At 3+ hops (e.g., CommentReply →
Comment → Post → Blog → Owner in a threaded comment system), the `checks`
block grows linearly with depth. Worse, EVERY entity that participates in
the tenant hierarchy must replicate the same pattern — there is no way to
say "this entity inherits auth from `ref('Post')` which inherits from
`ref('Blog')` which has an owner."

The framework HAS a concept of owner-grant auto-derivation (`role: owner` →
default grant + `checks.owner`). Extending this to FK hierarchies would be
natural: `ref('Blog', { role: owner })` on Blog → Post's `ref('Blog')` could
auto-derive `is.blogOwner()` without a hand-written traversal. But there is
no way to declare "this FK chain leads to the owner."

**Workaround**: Hand-write every cross-entity traversal in `checks`.

**Rank**: SHOULD-FIX

---

# 5. No hooks/afterSave — no side-effect mechanism — SHOULD-FIX

**Cite**: DOMAIN-MODULES.md L6-8 — "No `rooms` block, no `on(app)` block —
everything live is a field, and events are derived from field mutations."
Also: "Fields are reactive primitives that own their persistence, sync
strategy, and event emission. Events are derived from field mutations, not
hand-emitted." (AGENTS.md L60-61).

**Impact**: When a post transitions to `published`, BLOG SUBSCRIBERS should
be notified. This is a textbook side-effect: a field mutation on one entity
(Post.state) triggers an action on a different entity (push notification to
Blog.subscribers).

The framework's event model (`Post:<id>:state:changed`) fires ON the mutated
entity. It does not fire any event on Blog. There is no `on('Post.state',
'published', () => ...)` listener. There is no `afterSave` hook. The `derived`
field is synchronous and scoped to the SAME entity.

You cannot implement subscriber notification within the framework. You must
either:
(a) do it imperatively in the route handler (violates "declaration absorbs
    imperative wiring" — AGENTS.md L29-30),
(b) use an external message queue that subscribes to the DB change feed, or
(c) omit the feature.

The FEATURES.md draft mentioned `hooks: { afterSave }` — this was REMOVED in
the final design. Its absence means the framework cannot express the most
common cross-entity reaction in a blog platform: "tell subscribers something
was published."

**Workaround**: External job queue listening to DB change events. Or omit
subscriber notifications entirely.

**Rank**: SHOULD-FIX

---

# 6. No `unique` constraint on text fields — SHOULD-FIX

**Cite**: `text({ max, default })` in DOMAIN-MODULES.md L33. No `unique: true`
option is shown or documented. There is no `validate` option, no database-level
constraint declaration on fields.

**Impact**: `Blog.slug` and `Post.slug` must be unique (within all blogs and
within a blog, respectively). Without a `unique` constraint, every create and
update handler must:
(a) query for an existing row with the same slug,
(b) reject if found,
(c) accept the race condition between check and insert.

This is error-prone boilerplate on multiple routes (create + update for
both Blog and Post). A `unique: true` (or `unique: [scopeField]`) option
would push this to the framework, generate a DB-level unique index, and
surface a typed error on constraint violation — no hand-written checks.

**Workaround**: Hand-written existence checks in every handler. Race condition
accepted.

**Rank**: SHOULD-FIX

---

# 7. No enum field type — NIT

**Cite**: Field type catalog (same as point 1). No `enum` or `oneOf`
constructor that restricts a text field to a closed set of values.

**Impact**: `Post.state` (draft/scheduled/published) and `Comment.state`
(pending/approved/spam/deleted) are stored as `text` with no compile-time or
entity-load-time validation of allowed values. Invalid states are caught only
at runtime in route handlers — and inconsistently (you might validate on
create but forget on update). A typed `enum(['draft', 'scheduled',
'published'])` field constructor would:
(a) validate at entity load (reject unknown values),
(b) surface typed handles for query predicates (no magic strings),
(c) prevent invalid-state writes at the framework level.

**Workaround**: `text({ default: 'draft' })` with hand-validation in every
route handler that touches the field.

**Rank**: NIT

---

# 8. Async `is.*` methods are a naming footgun — NIT

**Cite**: `checks` in doc/index.mjs L88-95. Sync checks like `owner` return
booleans; async checks like `projectManager` return promises. The `is.*`
proxy in `grant` calls them — `is.owner()` is sync, `is.projectManager()` is
async. Both are called with the same `is.xxx()` syntax.

**Impact**: In Post's `grant`:

```js
if (is.published())                    return grant(read, subscribe);
if (is.author() || await is.blogOwner()) ...
```

`is.blogOwner()` is async (it loads a related entity). If you forget the
`await`, the expression `is.author() || is.blogOwner()` evaluates the Promise
as truthy (all Promises are truthy), silently granting access to EVERYONE —
a catastrophic auth bypass with no framework-level warning.

Contrast with `is.published()` and `is.author()` which are sync and safe to
call without `await`. The naming convention `is.*` implies a sync boolean
predicate; when some are async and some are sync, the caller must remember
which is which for every entity. An `async` suffix convention (`is.blogOwner()`
vs `await is.blogOwnerAsync()`) or a lint rule would prevent this, but the
framework provides neither.

**Workaround**: Be careful. No framework-level guard.

**Rank**: NIT (but with auth-bypass potential)

---

# 9. No auto-default from request context for non-owner ref fields — NIT

**Cite**: `role: owner` on `ref('User')` (DOMAIN-MODULES.md L72-77) auto-
populates the FK from `req.user.id` AND makes the field `readonly`. Non-owner
ref fields have NO auto-population mechanism.

**Impact**: `Post.author` and `Comment.author` both reference the creating
User. Every create handler must manually set:
```js
const post = await Post.create({ ... [Post.author]: req.user.id });
```
This is repetitive AND fragile — if a handler forgets, the FK is null/empty.
The framework already has a mechanism for `role: owner`; extending it to a
general `ref('User', { default: req.user.id })` (or `role: author`) would
eliminate a line of boilerplate from every create handler for every entity
that tracks authorship.

**Workaround**: Hand-set `[Entity.author]: req.user.id` in every create handler.

**Rank**: NIT

---

# 10. FK auto-population contract is unspecified — NIT

**Cite**: The `ref()` FK type (DOMAIN-MODULES.md L36) says "auto-populates/
traverses." The exact semantics — eager vs. lazy, N+1 risk in list queries,
whether `post.blog.name` triggers a DB query or returns a pre-loaded object —
are not defined.

**Impact**: In `activityFeed` and `postComments` handlers, we access
`post.blog.name` and `post.author.username` inside a loop. If FK population
is lazy (one query per access), a list of 20 posts causes 40 additional
queries (N+1). If it's eager (pre-loaded on `findAll`), the developer must
opt in with something like `.populate('blog', 'author')` — but no such method
exists.

The framework's `set(ref('User')).toArray()` pattern returns populated rows
(synchronous after the async call). But for plain `ref` FKs on a loaded
entity, the contract is unclear. We code to the assumption that lazy access
works; if it doesn't, every list handler must be rewritten.

**Workaround**: Assume lazy FK population works. Accept potential N+1.

**Rank**: NIT

---

# 11. Comment replicates Post visibility logic — NIT

**Cite**: `checks` is per-entity (DOMAIN-MODULES.md L95-98). There is no
`inherits` or `delegates` mechanism for auth predicates.

**Impact**: For a comment to be publicly readable, TWO conditions must hold:
(a) the comment's own state is `approved`, and (b) the parent post's state
is `published`. Comment's `checks` block implements `postPublished` — which
loads the post and checks `post.state === 'published'`. This is a DUPLICATE
of Post's `checks.published`.

If Post's definition of "published" changes (e.g., a new state `members-only`
is added), Comment's `postPublished` check must be updated independently.
The two visibility rules DRIFT APART. A `delegateTo(ref('Post'))` or FK-chain
check could express "this entity is visible when its parent is," removing the
duplication.

**Workaround**: Duplicate the parent's visibility check in the child's `checks`.

**Rank**: NIT

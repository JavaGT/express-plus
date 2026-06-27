## §C — Cross-entity aggregates: `derived` is sync, single-row only ← **BLOCKER**

**Construct:** `number({ derived: (e) => ...computed from e's fields..., readonly: true })`
**Shown at:** `domain-modules/domains/doc/index.mjs` line 36 (`wordCount`)

`derived` recomputes a value from the entity's own fields when any source field
mutates. This works for `wordCount` (derived from `body`) and for `score`
(derived from `upvoteCount - downvoteCount`). It does NOT work when the input
to computation lives in ANOTHER table.

In the Reddit clone, a Post's score is the net sum of N Vote rows. The only way
to keep it current is imperative glue in every vote handler:

```js
// In the vote handler (index.mjs line ~176):
await PostVote.create({ post: post.id, user: user.id, direction: +1 });
await Post.findById(post.id).update({ upvoteCount: post.upvoteCount + 1 });
//                                    ^^^^^^^^^^^^^^^^ manually incremented
```

This is repeated for every voteable entity (PostVote handler, CommentVote
handler) and every mutation path (create, toggle-off, flip-direction). The
framework OWNS count derivation for `wordCount` (body → wordCount, one entity)
but abdicates it for `score` (Vote rows → Post.upvoteCount, cross-entity).

**The hot-rank escalation:** `hotRank` is derived from `score` and `createdAt`.
Because `score` is derived from `upvoteCount - downvoteCount` (a Post's own
fields), the chain `Vote → upvoteCount → score → hotRank` works locally at the
entity level. But the COUNTS in step 1 are manual. And hotRank's derived value
is recomputed per-row on every read — sorting the front page by hotRank means:

1. Execute `log10(abs(score))` + age formula for every non-removed post.
2. Sort in memory.
3. Apply offset/limit.

**What's needed:**
- A **counter/aggregate field type**: `counter(ref('Vote'), { map: v => v.direction })`
  that auto-increments/decrements on related-entity mutation. Framework-owned,
  no imperative glue.
- A **stored derived vs computed derived distinction**: `score` and `hotRank`
  should be STORED (recomputed async on vote mutation, written back to the row)
  rather than COMPUTED (sync per-read). Sorting 10k posts by stored hotRank is
  an indexed column sort; sorting 10k posts by computed hotRank is a full scan.
- The `derived` marker alone is ambiguous — it doesn't say whether the value is
  cached or recalculated per access, and that decision has radical performance
  implications.

## §B — Votes need a value, not just membership: `set` can't carry direction ← **BLOCKER**

**Construct:** `set(ref('User'))`
**Shown at:** `domain-modules/domains/doc/index.mjs` line 65 (`shares: set(ref('User'))`)

A set tracks WHO (membership: in/out). A vote tracks WHO + DIRECTION (+1/-1).
The `set` field type is unordered and unvalued — it can tell you "Alice voted"
but not "Alice upvoted" vs "Alice downvoted".

This forces votes into a separate entity (`PostVote`, `CommentVote`), which then
has NO UNIQUENESS GUARANTEE on (user, target). The framework's typed FKs are
single-column (`ref('Post').is(id)`); there is no demonstrated compound-query
API (`.and()`, compound indexes, or `findOne({ post: x, user: y })`). A user
could accidentally create two votes on the same post.

**What's needed:**
- A **valued set** field type: `map(ref('User'), valueType)` that stores a
  per-member value AND enforces one-entry-per-user.
- Or a **compound FK uniqueness** declarator on Vote: `unique([Vote.post,
  Vote.user])` that the framework automatically enforces.

## §A — Nested comment tree: `ref()` populates one level, no tree traversal ← **BLOCKER**

**Construct:** `parent: ref('Comment')`
**Shown at:** not shown — self-referential FK is aspirational. The doc ceiling's
refs point to other entity types (`ref('User')`, `ref('Project')`).

`ref()` auto-populates its target lazily. `comment.parent` yields the parent
Comment object (one query, possibly memoized). But `comment.parent.parent` is
N sequential queries. For a 10-deep thread, that's 10 round-trips.

The thread-loading strategy forced by the framework:

```js
// index.mjs nestComments() — application code, O(n) in-memory:
const allComments = await Comment.findAll(Comment.post.is(post.id));
//    ^^^^^ fetches EVERY comment for the post (3000 rows for a busy thread)
const tree = nestComments(allComments);  // manual reconstruction
```

There is no:
- `.loadTree(depth)` — recursive CTE / recursive load
- `.findDescendants(id)` — materialized path walk
- `.findRoots()` + `.loadChildren()` — adjacency list helper
- A `children` virtual field on Comment (the `set` type is unordered and can't
  model a parent→children relation auto-populated by the FK's reverse)

**What's needed:**
- A **tree traversal query**: `Comment.findDescendants(rootId)` using a
  recursive CTE or materialized path.
- A **children field** that the framework auto-derives from `parent` (the
  reverse side of the FK), so `comment.children` is `{ id, body, children: [...]
  }` populated to a requested depth.
- **Depth-limiting** in the query: "load comments for post #42 to depth 3" so
  the top-level view doesn't fetch the entire thread.

## §D — Front-page ranking across communities ← **SHOULD-FIX**

**Construct:** `Entity.findAll({ filter }).sort(Entity.field, 'desc').limit(N).offset(M)`
**Shown at:** `domain-modules/domains/doc/routes/handlers.mjs` lines 18-19

`findAll` queries a single entity type. The front page /r/all needs posts from
ALL communities. This is fine — `Post.findAll()` without a community filter
covers it.

But the pagination+sorting contract is undefined at the edges:
- **Cursor pagination vs offset:** `.offset(M)` is sensitive to insertions
  between requests (duplicate/missing rows). A stable cursor (`after:
  lastSeenHotRank`) is needed for an infinite-scroll feed.
- **No stored rank index:** sorting by a derived `hotRank` field runs the derive
  function per row per query. At scale (1M+ posts), this means 1M `log10()`
  calls per top-level page load. A stored `hotRank` that updates async on vote
  mutation would be an indexed column sort.
- **Multi-entity feed:** if the framework grew a "subscribed communities"
  concept (stored as a set on Community or User), `findAll` across multiple
  communities has no compound filter: `Post.findAll(Post.community.in([...ids]))`
  is not demonstrated.

## §E — Moderation audit log ← **SHOULD-FIX**

**Construct:** `log()`
**Shown at:** `domain-modules/domains/doc/index.mjs` line 74 (`chat: log()`)

The `log()` type is append-only and emits `:appended:<id>`. It could serve as a
moderation audit trail on the Community entity. But:
- **No demonstrated API for appending to a log from a handler.** The doc
  ceiling shows `chat: log()` as a field but never calls `.append()` or
  `.write()` in a route handler.
- **Cross-entity log append:** when a moderator removes a Post, the entry
  should go in the Community's `moderationLog`, not the Post's. This requires
  loading the Community from the Post and appending — another cross-entity
  imperative step with no declarative path.
- **No retention or pruning:** an append-only log grows unboundedly. No TTL,
  no max-length guard, no archival strategy visible in the field type.

## §F — Compound queries and findOne with multiple filters ← **SHOULD-FIX**

**Construct:** `Entity.findOne(Entity.field.is(value))`
**Shown at:** `domain-modules/domains/session/routes.mjs` line 24

`findOne` accepts ONE field filter. To enforce (user, post) uniqueness on votes,
you need TWO: `PostVote.findOne({ post: x, user: y })`. No `.and()` chaining or
compound predicate constructor is demonstrated.

This isn't just a votes problem — any entity with multiple foreign keys needs
compound lookups (e.g., "find the ProjectMembership for user X on project Y").

## §G — `ref()` traversal in authorization: N loads for a list view ← **NIT**

**Construct:** `checks.canReadPost: async ({ entity, user, load }) => ...`
**Shown at:** `domain-modules/domains/doc/index.mjs` line 91 (`projectManager`)

The Post's `grant` loads the Community to check readability (`canReadCommunity`).
A front-page list of 25 posts means 25 community loads. `load()` memoizes per
unique (collection, query) per request, so if all 25 posts are in 3 communities,
it's 3 DB hits — efficient enough. But the pattern is verbose: every entity
whose grant depends on a parent must repeat the `load`+`can()` dance. A
"propagate parent's grant" shortcut (`grant: 'inherit'` or an
`parent: ref('Community', { role: grantSource })`) would make this declarative.

## §H — `remove` capability not in the typed capability set ← **NIT**

**Construct:** `grant(read, write, subscribe, admin)`
**Shown at:** `domain-modules/domains/doc/index.mjs` line 109

The four capabilities are `read`, `write`, `subscribe`, `admin`. A moderator
"removing" a post (soft-delete: set `removed=1`, hide from feeds) is a distinct
action from editing the post's title/body. Folding it into `write` or `admin` is
semantic overloading — `remove` should be its own typed handle so the grant
explicitly says `if (is.moderator()) return grant(read, remove)` without
conflating "can edit" with "can censor".

---

## Summary ranking

| § | Pain Point | Severity |
|----|-----------|----------|
| C | Cross-entity aggregates (counters, stored derived) | **BLOCKER** |
| B | Valued sets / compound FK uniqueness for votes | **BLOCKER** |
| A | Tree traversal for comment nesting (recursive refs) | **BLOCKER** |
| D | Front-page pagination + stored rank index | SHOULD-FIX |
| E | Moderation audit log (log append API, cross-entity) | SHOULD-FIX |
| F | Compound queries (multi-field findOne) | SHOULD-FIX |
| G | Inheritable parent grant (less verbose auth chains) | NIT |
| H | `remove` as a typed capability | NIT |

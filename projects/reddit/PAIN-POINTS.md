## Persona

The Social Scale Engineer — cares about tree traversal, stored aggregates, ranking, and public scale. Skeptical of a query language with only `.is()`/`.has()` and of a framework that recomputes derived fields on every read.

---

## Attempted entity shape

```js
// reddit.mjs — a Reddit clone expressed in the grilled API.
// Stress-tests: tree traversal (self-referential Comment), valued-set votes (map),
// stored-derived cross-entity aggregates (score from votes), cursor pagination
// (hotRank index), public-by-default reads (anonymous), moderation log (effects),
// compound queries (.in/.and), cursor pagination.
//
// Imports express-plus as an idealized framework (no runtime).
// Missing symbols are named where the API lacks them — that IS the point.

import {
  entity, text, number, date, boolean, ref, map, log,
  grant, deny, read, write, subscribe, admin, anyOf, never, scope,
  inherit, router, // publicRead NOT YET EXEMPLIFIED (plan: Phase 1, ~10 lines)
  User,
} from 'express-plus';

// ---------------------------------------------------------------------------
// Capability handles
// ---------------------------------------------------------------------------
const VIEWER    = [read, subscribe];
const AUTHOR    = [read, write, subscribe];
const MODERATOR = [read, write, subscribe, admin];
// NOTE: no `remove` capability handle exists. Per DECISIONLOG.md the four are
// read/write/subscribe/admin. "Remove" is folded into write or admin — semantic
// overloading. (See §H re-check below.)

// ---------------------------------------------------------------------------
// Subreddit (community)
// ---------------------------------------------------------------------------
export const Subreddit = entity('Subreddit', {
  fields: {
    name:        text({ validate: (v) => v.length <= 21 || 'name too long' }),
    description: text(),
    creator:     ref('User', { role: 'creator', readonly: true }),

    // Valued set: membership keyed by User, each member carries a role.
    // Uniqueness-by-construction — the `map` plugin replaces the join table.
    members:     map(ref('User'), {
                   role: ['subscriber', 'moderator'],
                 }),

    // Moderation audit log: append-only.
    // EFFECTS will append here when a Post is removed (see Post.effects).
    moderationLog: log({
                     action:    text(),
                     target:    ref('Post'),
                     moderator: ref('User'),
                     timestamp: date({ default: () => new Date() }),
                   }),

    createdAt:   date({ default: () => new Date() }),
  },

  checks: {
    creator:   ({ Subreddit, principal }) => Subreddit.creator.is(principal.id),
    moderator: ({ entity, principal })    => entity.members.get(principal.id)?.role === 'moderator',
    member:    ({ entity, principal })    => entity.members.has(principal.id),
    // Public read: EVERYONE can read this subreddit.
    // Compiles to SQL TRUE — a constant, touches no fields, compilable.
    // NOTE: this check doesn't use `principal` at all. For an anonymous visitor
    // (no session), what is the principal? The grilled model is {user|link|system}.
    // No 'anonymous' type exists. The framework must handle a nil principal for
    // publicRead — a gap in the uniform principal model.
    publiclyReadable: () => true,
  },

  grant: ({ principal }) => [
    // scope: PUBLIC READ — any principal (or no principal) can read.
    // The `anyOf(is.publiclyReadable(), ...)` compiles to:
    //   WHERE TRUE OR Subreddit.creator = ? OR subreddit_members.user = ?
    // which the optimizer reduces to WHERE TRUE for non-member principals.
    // This is EXPLICIT — satisfies ADR #7 (no default grant).
    scope(({ is }) => anyOf(
      is.publiclyReadable(),
      is.member(),             // compilable: has() = set-membership EXISTS
      is.creator(),            // compilable: ref equality
    ))
      .can(async ({ is }) => {
        if (await is.creator())      return grant(...MODERATOR);
        if (await is.moderator())   return grant(...MODERATOR);
        if (await is.member())      return grant(...VIEWER);
        return grant(...VIEWER);     // public: read+subscribe, no write
      }),
  ],

  // NOTE: `is.member()` in scope — is this compilable? `members.has(principal.id)`
  // compiles to a set-membership EXISTS subquery on the map table. YES — the `map`
  // plugin's `has()` is compilable (the plan confirms: "membership in an on-entity
  // set" is compilable in scope). So `is.member()` IS valid in scope.
  //
  // But `is.moderator()` references `members.get(principal.id)?.role === 'moderator'`
  // — a scalar lookup on the map value. Is this compilable? The plan says scope
  // compiles "owner-FK equality, state/enum equality, and membership in an on-entity
  // set." Scalar payload access on a map is NOT in that list. So `is.moderator()`
  // would be a LOAD-TIME ERROR in scope — it's correctly placed only in .can.
  //
  // This is correct per the grilled design: publicRead + creator covers scope;
  // moderator/member role refinement happens in .can at runtime.
  // But it means the compiler must recognize that `is.member()` (has, compilable)
  // and `is.moderator()` (get+role-check, non-compilable) are DIFFERENT checks —
  // one valid in scope, one not. The check author must understand this distinction.
  // Sharp edge: two checks on the same field with different compilability.

  routes: (r) => {
    r.resource();
  },
});

// ---------------------------------------------------------------------------
// Post
// ---------------------------------------------------------------------------
export const Post = entity('Post', {
  fields: {
    title:      text({ validate: (v) => v.length <= 300 || 'title too long' }),
    body:       text(),
    author:     ref('User', { role: 'author', readonly: true }),
    subreddit:  ref('Subreddit', { required: true }),

    // Votes as a valued set — the `map` plugin gives uniqueness-by-construction.
    // One entry per user; direction is the per-user value.
    // This replaces the separate PostVote entity (old §B).
    votes:      map(ref('User'), {
                  direction: [-1, 1],  // -1 = downvote, +1 = upvote
                }),

    // STORED aggregates — these must be updated when votes change.
    // The grilled API has `derived` (sync, per-read recompute from OWN fields)
    // and `effects` (declarative reactions). But effects templates can't do
    // arithmetic (`with: { score: score + delta.direction }`).
    //
    // BLOCKER: no `counter` field type or arithmetic in effect templates.
    // These fields exist here as aspirational — they WOULD be stored and indexed
    // if the API supported them. Currently the only path is imperative glue.
    upvoteCount:   number({ default: 0 }),
    downvoteCount: number({ default: 0 }),
    score:         number({ default: 0 }),       // upvoteCount - downvoteCount
    commentCount:  number({ default: 0 }),

    // Ranking: a stored column for cursor-paginated front-page sorts.
    // hotRank = f(score, createdAt) — e.g. log10(max(|score|,1)) + sign*age.
    // Phase 3 (stored-derived) + Phase 3 (cursor pagination). Neither exists.
    // Without stored rank, sorting 100k posts by hotRank = full table scan
    // of a computed value per request.
    hotRank:      number({ default: 0 }),

    removed:      boolean({ default: false }),
    createdAt:    date({ default: () => new Date() }),
    updatedAt:    date({ touch: true }),
  },

  checks: {
    author:    ({ Post, principal }) => Post.author.is(principal.id),
    // Cross-entity: does this principal moderate the Post's subreddit?
    // This is runtime-only (loads Subreddit, checks members.get role).
    // Correctly placed only in .can — scope can't compile cross-entity loads.
    subredditModerator: async ({ entity, principal }) => {
      const sub = await Subreddit.load(entity.subreddit);
      return sub.members.get(principal.id)?.role === 'moderator';
    },
    // NOTE: no `publiclyReadable` here — Post inherits its readability from
    // Subreddit (through `inheritsFromSubreddit`). But Post should also be
    // readable when Subreddit is public AND separately when the author's
    // profile is viewed. The grilled model says: read scope is declared
    // per-entity. If Post doesn't declare public read, a non-member visiting
    // /r/all can't see any Post row — even though the Subreddit is public.
    // You'd need to also add `publiclyReadable: () => true` to Post's checks.
    // This is correct (per-entity declaration) but verbose when the read
    // pattern is "same as parent."
    publiclyReadable: () => true,
  },

  // BLOCKER: the effects template can't do arithmetic.
  // When Post.votes changes, we need to update upvoteCount/downvoteCount/score/hotRank.
  // The grilled effect template is:
  //   { mutate: Post, with: { field: <data-interpolation> } }
  //
  // What we NEED to express:
  //   [votes.onAdded]:  { mutate: Post, with: { upvoteCount: Post.upvoteCount + delta.direction } }
  //   [votes.onChanged]: { mutate: Post, with: { score: Post.score + (newDir - oldDir) } }
  //
  // But `with` only supports data interpolation from delta + entity — no arithmetic,
  // no reference to target's current value, no atomic increment.
  //
  // FAILING CODE (would not compile — arithmetic in template is unsupported):
  //   effects: {
  //     [Post.votes.onAdded]: { mutate: Post, with: {
  //       upvoteCount: Post.upvoteCount + delta.direction  // ❌ NOT VALID
  //     } },
  //   },
  //
  // The only workaround is imperative glue in every vote-mutation handler:
  //   await post.votes.set(userId, { direction: +1 });
  //   await post.update({ upvoteCount: post.upvoteCount + 1, score: ... });
  // This is the same manual-counter problem the old §C identified — `effects`
  // doesn't dissolve it because the template grammar has no arithmetic.

  // Moderation effect (attempted — cross-entity append declaratively):
  // When `removed` transitions false→true, append to Subreddit.moderationLog.
  // BUT: how do you APPEND to a log via the `with` template?
  // `with: { moderationLog: { action: 'removed', ... } }` would be a SET —
  // overwriting the entire log. The `log` field is append-only.
  //
  // FAILING CODE (would overwrite the log, not append):
  //   effects: {
  //     [Post.removed.when(true)]: { mutate: Subreddit, with: {
  //       moderationLog: { action: 'removed', target: entity.id, moderator: delta.actor }
  //     } },
  //   },
  //
  // Gap: the `{ mutate, with }` primitive is set-only. No append/inc/array-push
  // operation in the template grammar for field types that need it (log, counter, array).
  //
  // SECOND gap: the effect principal's authorization against Subreddit's grant.
  // The effect runs as a per-effect principal whose capability is bounded to
  // (Subreddit + moderationLog). How does Subreddit.grant authorize this principal?
  // Is there an implicit grant for the declared effect? Or does the developer need
  // to add a check like `effectPrincipal: () => principal.type === 'effect' && ...`
  // to Subreddit's scope? The grilled design says the effect principal is authorized
  // against the target's grant — but the AUTHORIZATION DECLARATION (how the target
  // entity says "yes, this effect principal can write moderationLog") is unspecified.

  grant: ({ principal }) => [
    scope(({ is }) => anyOf(
      is.publiclyReadable(),
      is.author(),
    ))
      .can(async ({ is }) => {
        if (await is.author())             return grant(...AUTHOR);
        if (await is.subredditModerator()) return grant(...MODERATOR);
        return grant(...VIEWER);
      }),
  ],

  routes: (r, Post) => {
    r.resource();
    // Front page: cursor-paginated by hotRank.
    // IDEALIZED — cursor pagination is Phase 3. `.gte`/`.lte` are Phase 3.
    r.get('/front', frontPage(Post));
  },
});

// ---------------------------------------------------------------------------
// Comment (self-referential tree)
// ---------------------------------------------------------------------------

// Inherit Post's read scope: a Comment is readable by anyone who can read its
// parent Post. This is the grilled child-inheritance pattern (comment.mjs).
const inheritPost = inherit('Post', { via: 'post' });

export const Comment = entity('Comment', {
  fields: {
    body:    text({ validate: (v) => v.length <= 10000 || 'comment too long' }),
    author:  ref('User', { role: 'author', readonly: true }),
    post:    ref('Post', { required: true }),     // root anchor — grant inherits through this
    // SELF-REFERENTIAL FK: a comment can reply to another comment.
    // `optional: true` — top-level comments have no parent.
    parent:  ref('Comment', { optional: true }),  // ← SELF-REFERENTIAL
             // QUESTION: can `ref('Comment')` reference its own entity?
             // The typed-FK model requires the target entity to be declared.
             // Comment IS being declared RIGHT NOW — is it available for self-ref
             // during its own declaration? This is a framework load-order question.
             // If the compiler resolves entity references lazily (likely), this works.
             // If it requires the target to be fully declared first, it doesn't.
             // The grilled exemplars only show refs to OTHER entity types.

    votes:  map(ref('User'), { direction: [-1, 1] }),  // same valued-set as Post

    score:        number({ default: 0 }),    // same stored-derived gap
    upvoteCount:  number({ default: 0 }),
    downvoteCount: number({ default: 0 }),
    removed:      boolean({ default: false }),
    createdAt:    date({ default: () => new Date() }),
  },

  checks: {
    author: ({ Comment, principal }) => Comment.author.is(principal.id),
    // Can this principal moderate the comment's parent Post's subreddit?
    subredditModerator: async ({ entity, principal }) => {
      const p = await Post.load(entity.post);
      const sub = await Subreddit.load(p.subreddit);
      return sub.members.get(principal.id)?.role === 'moderator';
    },
  },

  // Inherits Post's read scope — anyone who can read the Post can read comments.
  // The author can edit their own (via field .can, not additional scope).
  grant: inheritPost,

  // BLOCKER: tree traversal.
  // The grilled API provides NO tree operations. To load a comment tree:
  //
  //   // Current best: load ALL comments for a post, build tree in app code
  //   const all = await Comment.findAll(Comment.post.is(postId));
  //   const tree = nestComments(all);  // O(n) manual reconstruction, n=10k
  //
  // What's NEEDED but doesn't exist:
  //   Comment.loadTree({ root: postId, depth: 3 })  // recursive CTE
  //   Comment.findDescendants(commentId)             // materialized path
  //   comment.children  // virtual field auto-derived from parent FK reverse
  //
  // Phase 3 says "tree traversal — a single loadTree() helper". Not designed yet.
  // The self-referential `parent` FK is declarable; the compiler must not
  // infinite-loop on the recursive type reference. But the QUERY surface for
  // tree operations is entirely absent from the grilled exemplars.

  routes: (r) => {
    r.resource();
  },
});

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

// Front-page handler: cursor-paginated by hotRank.
//
// IDEALIZED (cursor pagination doesn't exist — Phase 3):
//
//   async function frontPage(Post) {
//     return async (req, res) => {
//       const after = req.query.after;  // cursor token: { hotRank, id }
//       const posts = await Post.findAll(
//         Post.removed.is(false)
//       )
//         .sort(Post.hotRank, 'desc')
//         .after(after)            // ❌ cursor pagination — NOT IN API
//         .limit(25);
//       res.json({ posts, nextCursor: last(posts)?.cursor });
//     };
//   }
//
// FALLBACK (offset pagination — drifts on insertions, breaks at scale):
function frontPage(Post) {
  return async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    // `.sort().limit().offset()` works today. But offset is unstable across
    // insertions (duplicate/missing rows). And the sort is on hotRank — which
    // is either computed (full scan) or stored (not supported).
    const posts = await Post.findAll(
      Post.removed.is(false)
    )
      .sort(Post.hotRank, 'desc')
      .limit(25)
      .offset((page - 1) * 25);
    res.json({ posts, page });
  };
}
```

---

## Pain points

### BLOCKER #1 — Tree traversal for self-referential Comment tree

**Failing code:**
```js
// The self-referential FK declares fine:
parent: ref('Comment', { optional: true }),

// But there is NO tree-load operation. The only way to get a thread:
const all = await Comment.findAll(Comment.post.is(postId));
// → fetches ALL 3000 comments for a post, builds tree in app code.
// No depth limit, no recursive CTE, no children virtual field.

// What's needed but absent:
Comment.loadTree({ root: postId, depth: 3 });       // recursive CTE
Comment.findDescendants(commentId);                   // materialized path
comment.children;                                     // auto-derived reverse FK
```

**What it tests:** The typed-FK model + self-referential types. The grilled exemplars only
show FKs to *other* entity types (`ref('User')`, `ref('Doc')`). Self-referential `ref('Comment')`
tests whether the entity declaration can reference itself during its own definition. Even if
the compiler handles that, the query surface has no tree operations — `loadTree()` is a Phase 3
stub, not designed.

**ADR/design feature tested:** Typed FK traversal (#5), owned-collection-as-field, relations.
The grilled framework builds exact pagination through compiled SQL WHERE clauses, but a tree
query (recursive CTE) is a fundamentally different query shape the `scope`-only compilation
model doesn't address.

---

### BLOCKER #2 — Stored-derived cross-entity aggregates: effects can't do arithmetic

**Failing code:**
```js
// The `votes` map field gives valued-set membership. But when a vote changes,
// Post's score must update. The grilled `effects` template is:
//   { mutate: <target>, with: { field: <static interpolation from delta+entity> } }

// What we NEED (arithmetic in template — NOT SUPPORTED):
effects: {
  [Post.votes.onAdded]: { mutate: Post, with: {
    upvoteCount: Post.upvoteCount + delta.direction,   // ❌ NO ARITHMETIC
    score: Post.upvoteCount - Post.downvoteCount,       // ❌ CAN'T READ TARGET
  } },
  [Post.votes.onChanged]: { mutate: Post, with: {
    // Need: old direction vs new direction to compute correct delta
    // ❌ delta only has the NEW value, not old
    upvoteCount: ???,                                   // ❌ UNEXPRESSABLE
  } },
}
```

**What it tests:** The `effects` primitive as the home for stored-derived aggregates.
The grilled design says `state.effects` and stored-derived are "the SAME primitive —
when X mutates, mutate Y through the pipeline." But the template grammar (`with: { field:
<data-interpolation> }`) is set-overwrite only — no arithmetic, no reference to the
target's current value, no atomic increment, no access to the OLD value (for computing
deltas on value changes).

The grilled `effects` dissolve the callback/afterSave problem (they're declarative and
compiled) but do NOT dissolve the counter aggregation problem — the developer still writes
imperative arithmetic in handlers, just like the pre-grill code.

**ADR/design feature tested:** ADR #6 (bounded effects), IMPLEMENTATION-PLAN abstraction #3
(declarative reactions), Phase 3 stored-derived.

**What's needed:** Either:
- A `counter` field type: `counter(ref('Vote'), { map: v => v.direction })` — framework-owned aggregation.
- An `apply` function in effects: `{ mutate: Post, apply: (entity, delta) => ({ score: entity.score + delta.direction }) }` — breaks the declarative template model but works.
- Arithmetic operators in templates: `{ mutate: Post, with: { score: { $inc: delta.direction } } }` — a DSL inside the template.

---

### BLOCKER #3 — Cursor pagination + stored rank index for front-page feed

**Failing code:**
```js
// IDEALIZED cursor pagination:
Post.findAll(Post.removed.is(false))
  .sort(Post.hotRank, 'desc')
  .after(lastSeenCursor)   // ❌ NO CURSOR PAGINATION IN API
  .limit(25);

// FALLBACK (offset — unstable across insertions):
Post.findAll(Post.removed.is(false))
  .sort(Post.hotRank, 'desc')
  .limit(25)
  .offset((page-1)*25);    // ✓ exists, but breaks at scale
```

**What it tests:** The grilled API's claim of "exact pagination" through compiled SQL
scope. The `scope` WHERE gives exact pagination WITHOUT a post-filter, which is correct
for authorization. But the PAGINATION MECHANISM itself is offset-based, which drifts
across insertions in a high-throughput feed. Cursor pagination (`where (hotRank, id) <
(lastSeenHotRank, lastSeenId)`) requires `>`/`<` operators on compound keys — `.gte`/
`.lte` are Phase 3 (not designed yet), and compound cursors (multi-column) are not
addressed at all.

Additionally, the `hotRank` field must be STORED (not computed per-read) for an indexed
cursor sort to be fast. Stored-derived is Phase 3 and blocked by BLOCKER #2.

Chain of dependencies: effects arithmetic (BLOCKER #2) → stored hotRank → cursor
pagination. All three are Phase 3 and undemonstrateable.

**ADR/design feature tested:** Phase 1 claim of "exact pagination" through scope-based
WHERE; Phase 3 items 13 (cursor pagination) + 14 (stored-derived).

---

### SHOULD-FIX #1 — Anonymous principal for public-by-default reads

**Problem:** The grilled principal model is `{ id, type: 'user'|'link'|'system', attributes }`.
Reddit's front page is readable by ANYONE — including visitors with no session, no principal.

```js
// This scope compiles to SQL TRUE (a constant, touches no fields, fine in scope):
publiclyReadable: () => true,
scope(({ is }) => anyOf(is.publiclyReadable(), ...))

// But when the framework evaluates this grant for an UNauthenticated request,
// what principal does it pass? The model has no 'anonymous' type.
//
// Hypothetical:
//   req.principal = null      → checks receive a null principal → every
//                                `.is(principal.id)` call fails or gets undefined
//   req.principal = { type: 'anonymous' }  → not in the grilled model
```

The `publiclyReadable` check doesn't reference the principal at all, so it works
regardless. But ANY other check in the `scope` (e.g. `is.author()`) would receive a
null/undefined principal and fail. The framework must either (a) add an 'anonymous'
principal type, (b) short-circuit scope evaluation when no principal exists and the
scope includes a compilable `TRUE` check, or (c) handle null principal gracefully.

The plan mentions a `publicRead` entity flag (~10 lines, Phase 1) — but it hasn't been
exemplified. Without it, the developer must write `publiclyReadable: () => true` in
every entity that needs public read, and must ensure no other scope check depends on
the principal.

**ADR/design feature tested:** ADR #7 (no default grant) × public-by-default. The
grilled framework is fail-closed; public read requires explicit declaration.
`publiclyReadable: () => true` IS explicit — but is it sufficient without an
anonymous principal in the model?

---

### SHOULD-FIX #2 — Effect template is set-only; log.append and counter.inc are unexpressable

**Failing code:**
```js
// Moderation log: when Post.removed → true, append to Subreddit.moderationLog.
// The `with` template is a SET operation:
effects: {
  [Post.removed.when(true)]: { mutate: Subreddit, with: {
    moderationLog: { action: 'removed', target: entity.id, moderator: delta.actor }
    // ❌ OVERWRITES the entire log, not appends.
    // `log` is append-only — a set should be rejected or the template needs an
    // `append` operation:
    //   moderationLog: { $append: { action: 'removed', ... } }
  } },
}
```

The `{ mutate, with }` primitive is a SET operation. It works for scalar fields (text,
number, boolean) and for `map` (keyed set/remove via the `map` mutation operators). But
it cannot express:
- **Append** to a `log` field
- **Increment** a `number` field (needed for counters)
- **Push** to an `array` field

The grilled design says `{set}` and `{create}` collapse into one verb — the engine
decides set vs create from whether the target row exists. But there's no `{append}` /
`{inc}` / `{push}` in the primitive. These are field-type-specific mutation operations
that the template grammar doesn't distinguish.

**ADR/design feature tested:** ADR #6 (declarative effects). The design collapses
two create/set verbs into one but misses the append/increment verbs that field types
like `log` and `counter` require.

---

### SHOULD-FIX #3 — Effect principal authorization: how does the target entity grant access?

**Design gap, not code failure:**

The grilled design says: "the effect runs as a per-effect principal whose capability
is bounded to exactly the declared (target entity + template fields), authorized against
the TARGET's own grant."

But HOW does the target entity's grant authorize this effect principal? Consider:

```js
// Post declares an effect that writes to Subreddit.moderationLog:
effects: {
  [Post.removed.when(true)]: { mutate: Subreddit, with: {
    moderationLog: { ... }
  } },
}
```

The effect principal's capability is bounded to (Subreddit + moderationLog). Subreddit's
grant must authorize this principal. But what does Subreddit's grant SAY?

```js
// Option A: implicit — the effect declaration IS the authorization.
// The framework auto-grants the effect principal to the declared target+fields.
// CONCERN: this is a second auth path — bypassing Subreddit's explicit grant.

// Option B: explicit — the developer adds a check to Subreddit:
postRemovalEffect: ({ principal }) =>
  principal.type === 'effect' && principal.source === 'Post.removed' && ...
// Then uses it in scope or .can.
// CONCERN: verbose, and the effect principal identity is framework-internal.
```

The grilled design doesn't specify the authorization DECLARATION. It says the effect
runs bounded and authorized, but the mechanism for the target to say "yes" is
unspecified. Without it, either effects bypass the grant (second auth path — forbidden)
or are unauthorizable (the target can't name the effect principal).

**ADR/design feature tested:** ADR #6 (effect principal authorization), "no second
auth path" principle.

---

### SHOULD-FIX #4 — Query operators `.in` / `.and` / `.gte` / `.lte` are designed but not exemplified

**Failing code:**
```js
// The front page needs to filter by subscribed communities:
Post.findAll(
  Post.subreddit.in(favoriteSubredditIds)   // ❌ .in() — Phase 1, not exemplified
    .and(Post.removed.is(false))            // ❌ .and() — Phase 1, not exemplified
)
  .sort(Post.hotRank, 'desc')
  .limit(25);

// Without .in(), you need N queries or an OR chain.
// The grilled exemplar only shows single-predicate findAll:
Doc.findAll(Doc.owner.is(me))
```

The plan lists `.and`/`.not`/`.is`/`.in` as Phase 1, item 6. But there's no exemplar
showing them. The syntax is unclear: are predicates chained via `.and()` (fluent) or
passed as an array to `findAll()`? The doc.mjs feed handler calls `.sort()` and
`.limit()` on the result of `findAll()` — a fluent query builder. `.and()` would
naturally chain on that. But `.in()` needs a different constructor —
`Post.subreddit.in([...])` is a predicate that's NOT equality, so it's a different
kind of field-handle method.

**ADR/design feature tested:** The `is`/`has` predicate surface. The grilled exemplars
only show `.is(value)` and `.has(value)`. The plan acknowledges `.in` is needed but
hasn't demonstrated the syntax.

---

### Sharp edge #1 — `scope` compilability split: `map.has()` vs `map.get().role`

Two checks on the SAME `map` field have different compilability:

```js
checks: {
  member:    ({ entity, principal }) => entity.members.has(principal.id),
  // ✓ COMPILABLE: membership in an on-entity set → EXISTS subquery
  moderator: ({ entity, principal }) => entity.members.get(principal.id)?.role === 'moderator',
  // ✗ NON-COMPILABLE: scalar payload access → runtime only
}

// In scope:
scope(({ is }) => anyOf(is.publiclyReadable(), is.member(), is.creator()))
//                                        ^^^^^^^^^^^^ OK
// is.moderator() would be a LOAD-TIME ERROR here
```

The developer must understand that `has()` compiles but `get()` doesn't. This distinction
is derived by the compiler but the developer must author checks correctly for scope vs
.can placement. The same field (`members`) produces both compilable and non-compilable
checks — a sharp edge for API intuitiveness.

---

### Sharp edge #2 — `inherit` propagates the PARENT's `.can`, not the child's own refinement

The comment.mjs exemplar shows:
```js
grant: inheritDoc,  // inherits BOTH parent read-scope AND parent .can
```

For Reddit comments, this means a Comment inherits the Post's `.can` — which grants
AUTHOR to the Post author. But a Comment author (different person) should be able to
edit their OWN comment. The `.can` refinement on `body` handles this:

```js
body: text().can(async ({ is }) =>
  (await is.author()) ? grant(read, write, subscribe) : grant(read, subscribe))
```

But this means the inherited Post-author write capability is SUPERSEDED by the Comment's
own field-level `.can`. The grilled design says "inherit contributes BOTH parent scope
and parent .can" and "a field with no .can strong-inherits the row grant." But the row
grant is now the PARENT's .can, not the child's. The child's field .can overrides the
parent's row grant. This works but is semantically subtle: the parent's write capability
is inherited as a FLOOR that child field .can can RAISE or LOWER. The child author
gets write (field .can raises above the inherited VIEWER floor), and the parent author
gets write too (inherited). Is that correct? A Post author shouldn't be able to edit
other users' comments. The field .can only checks `is.author()` — which for a Post
author returns false. So the Post author gets the inherited .can = VIEWER, and the
field .can gives read/subscribe. Correct.

But what about a Subreddit moderator who ISN'T the Post author? The Comment inherits
Post's grant which has `is.subredditModerator() → MODERATOR`. So the moderator gets
MODERATOR (read/write/subscribe/admin) on the Comment row — and `body.can` only checks
`is.author()`, so the moderator falls through to `grant(read, subscribe)`. The field
.can overrides the row-level write with read-only. Correct (moderator can see all,
can't edit user content — they use `removed` flag instead).

This works but it's not obvious from reading the declaration that the field .can
OVERRIDES the inherited .can rather than AND-ing with it. The grilled design says
"strong-inherits" but the interaction with `inherit` is two layers of floors — the
parent's .can becomes the child's row-level floor, which the child's field .can then
overrides. Two indirections for one auth decision.

---

### Sharp edge #3 — Public read requires a check+scope per entity; pervasively verbose

ADR #7 says no default grant. Every entity with public reads needs:

```js
checks: { publiclyReadable: () => true },
grant: ({ principal }) => [
  scope(({ is }) => anyOf(is.publiclyReadable(), ...otherChecks...))
    .can(...),
],
```

This is ~3 lines per entity. For a Reddit clone with Subreddit, Post, Comment — that's
9 lines. Not terrible. But every entity repeats the same check name and scope wiring.
The plan's `publicRead` flag (~10 lines) would collapse this to a single boolean per
entity — but it hasn't been exemplified. Without it, the ceremony is acceptable (explicit
is the point of ADR #7) but the repetition across entities with identical public-read
semantics is a DRY tension.

---

### Sharp edge #4 — `score` must be separately declared; no derived-from-owned-collection

The `votes` map on Post HAS the data needed to compute `score` (sum of directions). But
there's no way to declare "score is derived from votes.sum(direction)". You must declare
`upvoteCount`, `downvoteCount`, and `score` as separate number fields and update them
imperatively (since effects can't do arithmetic).

This is a field-count explosion: one `votes` map should imply one `score` field, but the
grilled API requires 3 extra fields + imperative glue. The pre-grill code had the same
problem (old §C).

---

## Prior findings re-checked

| § | Prior finding | Status | Why |
|---|--------------|--------|-----|
| B | Valued sets / compound FK uniqueness for votes | **RESOLVED** | `map(ref('User'), { direction })` gives valued-set membership + uniqueness-by-construction. No separate Vote entity needed. The `map` plugin is in the grilled design (doc.mjs `collaborators`). |
| G | Inheritable parent grant | **RESOLVED** | `inherit('Post', { via: 'post' })` exists in comment.mjs. Comment inherits Post's read scope + .can through typed FK. |
| F | Compound queries (multi-field findOne) | **RESOLVED (plan)** | `.and()` is Phase 1, item 6. Syntax not exemplified but the plan commits to it. |
| A | Tree traversal for comment nesting | **STILL OPEN** | `ref('Comment', { optional: true })` for `parent` is declarable. But `loadTree()`, `findDescendants()`, children virtual field — none exist. Phase 3 stub. No grilled exemplar addresses self-referential FKs. |
| C | Cross-entity aggregates (counters, stored-derived) | **NEW ANGLE** | `effects` dissolve the callback/afterSave problem (declarative, compiled) but do NOT dissolve the arithmetic problem. The template `{ mutate, with }` is set-overwrite only — no increment, no sum, no reference to target's current value. The counter aggregation remains imperative. A `counter` field type or arithmetic templates are needed. |
| D | Front-page pagination + stored rank index | **STILL OPEN** | Cursor pagination and `.gte`/`.lte` are Phase 3. Stored-derived (for hotRank) is Phase 3. The grilled exemplars only show offset pagination. |
| E | Moderation audit log | **NEW ANGLE** | `effects` can DECLARE the cross-entity mutation (Post.removed → Subreddit.moderationLog), but: (1) the `with` template is set-only, can't append to a `log`; (2) effect principal authorization against the target entity is underspecified. |
| H | `remove` as a typed capability | **STILL OPEN** | The capability set is still `read/write/subscribe/admin`. No `remove` handle. Folding removal into `admin` or `write` is semantic overloading. Not grilled. |

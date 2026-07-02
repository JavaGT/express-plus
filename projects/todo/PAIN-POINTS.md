// projects/todo/PAIN-POINTS.md
//
// Stress-testing the grilled workbench API against the simplest possible
// project: a todo app. Persona: The Pragmatist — wants the simple case to stay
// simple. Central question: did killing the zero-floor (ADR #7) break the
// easy case?
//
// Rankings: BLOCKER (cannot build the feature without framework change),
//           SHOULD-FIX (framework change substantially improves DX),
//           SHARP EDGE (works but with painful ceremony or footgun),
//           GAP (API surface has no answer — not a bug, a missing primitive).

## Persona

The Pragmatist — skeptical of ADR #7, testing whether the grilled API stays
smooth for the canonical simplest project.

## Attempted entity shape — the grilled floor for a todo

### Approach A: Single-entity todo (minimalist)

```js
import {
  entity, text, boolean, date, ref,
  grant, deny, read, write, subscribe, scope,
} from 'workbench';

export const Todo = entity('Todo', {
  fields: {
    title:     text({ validate: v => v?.length > 0 || 'title required' }),
    completed: boolean({ default: false }),
    dueDate:   date({ optional: true }),
    owner:     ref('User', { role: 'owner', readonly: true }),
    parent:    ref('Todo', { optional: true }),           // self-referential subtask tree
    createdAt: date({ default: () => new Date() }),
  },

  checks: {
    owner: ({ Todo, principal }) => Todo.owner.is(principal.id),
  },

  grant: ({ principal }) => [
    scope(({ is }) => is.owner())
      .can(async ({ is }) => {
        if (await is.owner()) return grant(read, write, subscribe);
        return deny('no capability for this principal');
      }),
  ],

  routes: r => { r.resource(); },
});
```

### Approach B: List + Item (cleaner sharing, tests grant inheritance)

```js
// --- TodoList — the shared container ---
export const TodoList = entity('TodoList', {
  fields: {
    title:    text({ validate: v => v?.length > 0 || 'title required' }),
    owner:    ref('User', { role: 'owner', readonly: true }),
    collaborators: map(ref('User'), {
      role: ['viewer', 'editor'],
    }).can(async ({ is }) =>
      (await is.owner()) ? grant(read, write, subscribe) : deny('only owner manages collaborators')),
    createdAt: date({ default: () => new Date() }),
  },
  checks: {
    owner:        ({ TodoList, principal }) => TodoList.owner.is(principal.id),
    collaborator: ({ TodoList, principal }) => TodoList.collaborators.has(principal.id),
  },
  grant: ({ principal }) => [
    scope(({ is }) => anyOf(is.owner(), is.collaborator()))
      .can(async ({ is }) => {
        if (await is.owner())        return grant(read, write, subscribe);
        if (await is.collaborator()) return grant(read, write, subscribe);
        return deny('no capability for this principal');
      }),
  ],
  routes: r => { r.resource(); },
});

// --- Todo — the task item, inheriting its list's grant ---
const inheritList = inherit('TodoList', { via: 'list' });

export const Todo = entity('Todo', {
  fields: {
    title:     text({ validate: v => v?.length > 0 || 'title required' }),
    completed: boolean({ default: false }),
    dueDate:   date({ optional: true }),
    list:      ref('TodoList', { required: true }),  // typed FK → parent list
    parent:    ref('Todo', { optional: true }),       // self-referential subtask tree
    position:  number({ default: 0 }),                // sibling ordering (required; ref alone gives no order)
    createdAt: date({ default: () => new Date() }),
  },
  grant: inheritList,  // inherits TodoList's scope + .can through typed FK
  routes: r => { r.resource(); },
});
```

### Floor measurement

| Metric | Pre-grill `note.mjs` (dead floor) | Grilled Approach A (single entity) | Grilled Approach B (list + item) |
|--------|------------------------------------|------------------------------------|----------------------------------|
| Meaningful lines¹ | **5** | **20** | **48** (across two entities) |
| Entities | 1 | 1 | 2 |
| Concepts to learn | `entity`, `text`, `ref` | + `boolean`, `date`, `checks`, `grant`, `scope`, `.can`, `deny`, `grant()`, `anyOf` (if sharing) | + `map`, `inherit`, `number`, `.can` on field |
| Auth is declared | **No** (magic default) | **Yes** — explicit `checks.owner` + `scope(is.owner())` + `.can()` | **Yes** — per-entity, with inheritance |
| Sharing story | No concept | Must add `collaborators` map + new check + widen `scope` (≈8 more lines) | `collaborators` on list; items inherit automatically |

¹ Excludes imports, blank lines, closing braces.

**Honest verdict**: the 5→20 line jump for the simplest case is REAL ceremony.
The pre-grill note.mjs was 16 total lines including imports and mount; the
grilled single-entity todo is ~30 total lines. But the pre-grill lines were
LYING — they claimed "a working collaborative-doc app in three lines" while
hiding authorization behind a magic default that assumed a creator-owns-everything
model the developer never chose. The grilled 20 lines are HONEST: every line of
auth is visible, and if the developer wants a different model (team-owned,
link-shared), they edit the grant, they don't fight a hidden default. The
trade-off is security fail-closed for simplicity — and for a todo app, where
privacy IS the domain (you don't want other users reading your tasks), honest
auth is a feature, not ceremony.

That said: for the absolute simplest demo ("look, a working app in 3 lines!"),
the grilled floor is visibly heavier. A framework shortcut — `grant:
privateToOwner` as a one-liner that expands to the canonical owner check —
would recover the demo-friendly floor without reintroducing magic defaults.
This is **not** re-litigating ADR #7 (the entity MUST declare a grant); it's
providing a pre-baked grant expression for the 80% case, same as `r.resource()`
is a pre-baked route set. See SHARP EDGE #1.

---

## Pain points

### BLOCKER #1 — Self-referential tree: `parent: ref('Todo')` connects one row to its parent, but there is no way to load a tree

**ADR/design tested**: Typed FK auto-traversal (CONTEXT.md §Relations); Phase 3
`loadTree()` (IMPLEMENTATION-PLAN.md line 201-202).

**Failing code**:
```js
// Declaring the hierarchy is one line — clean:
parent: ref('Todo', { optional: true }),

// But LOADING the tree is impossible with current framework primitives.
// No API exists for any of:
const tree   = await Todo.loadTree(rootId);               // recursive CTE
const tree   = await Todo.loadTree(rootId, { depth: 3 }); // depth-limited
const roots  = await Todo.findRoots({ list: listId });     // WHERE parent IS NULL
const kids   = await todo.children();                       // reverse FK auto-population
```

**Impact**: You must either:
(a) fetch ALL todos for a list and reconstruct the tree in application memory
    (the reddit §A workaround — loads 3000 rows for a heavy list), or
(b) run N sequential queries to walk the tree manually.

**Why it's a BLOCKER**: A todo app with subtasks that can't fetch a tree is a
todo app without subtasks. The self-referential FK declares the relationship but
the query surface has no way to exploit it. The Phase 3 `loadTree()` helper is
acknowledged as needed but not yet designed — this todo app can't wait for Phase 3.

**What's needed**: `Todo.loadTree(id, { depth })` using a recursive CTE; a
`children` virtual field auto-derived from the reverse FK so `todo.children`
returns `[{ id, title, children: [...] }]` populated to the requested depth.

---

### SHARP EDGE #1 — ADR #7: even the simplest app writes the same `owner` check + `scope` + `.can` every time

**ADR/design tested**: ADR #7 — no default grant → load-time error. CONTEXT.md
§Authorization.

**Failing code** — the canonical boilerplate that every owner-only entity repeats:
```js
checks: {
  owner: ({ Todo, principal }) => Todo.owner.is(principal.id),
},

// This grant body is IDENTICAL across every owner-only entity in the app:
grant: ({ principal }) => [
  scope(({ is }) => is.owner())
    .can(async ({ is }) => {
      if (await is.owner()) return grant(read, write, subscribe);
      return deny('no capability for this principal');
    }),
],
```

**Measurement**: 10 lines of grant+check boilerplate that is character-for-
character identical for every owner-only entity in the app (Todo, TodoList, and
potentially Project, Note, ShoppingList, …).

**Why this is a SHARP EDGE, not a BLOCKER**: It works. Every line has meaning.
But it fights the AGENTS.md principle "Declaration absorbs imperative wiring" —
the developer is restating the same wiring for every entity. The framework knows
`role: 'owner'` already (it auto-derives `checks.owner` from `ref('User', { role:
'owner' })` — that derivation still works in the grilled design, per doc.mjs
line 101-103). The gap is that knowing "this entity has an owner ref" is enough
information for the framework to offer a one-liner:

```js
// What the developer SHOULD be able to write:
grant: ownerOnly,  // expands to scope(is.owner()).can(…owner has all…)

// Or, if the name `ownerOnly` feels like a magic word:
grant: simpleGrant({ owner: [read, write, subscribe] }),
```

ADR #7 says "no default grant" — and this preserves that: the developer STILL
declares a grant. It just doesn't make them type the same 10 lines every time.
`r.resource()` is the same idea — a pre-baked construct for the common case, not
a default you didn't ask for.

---

### SHARP EDGE #2 — Subtask ordering: `parent: ref('Todo')` captures hierarchy but not sibling order

**ADR/design tested**: AGENTS.md §Data — "Relations are typed foreign keys,
explicit about their target."

**Failing code**:
```js
parent: ref('Todo', { optional: true }),

// There's no way to say "subtasks are ordered" without a manual position field:
position: number({ default: 0 }),

// And even WITH a position field, the framework has no:
//   - auto-increment on insert (new subtask at end = MAX(position) + 1)
//   - reorder API (move subtask up/down → swap positions)
//   - ORDER BY injection on reverse-FK loads (children() sorted by position)
```

**Impact**: Every todo app needs draggable reordering of subtasks. Without
framework-level ordering support, the developer:
1. Adds a `position: number()` field manually.
2. Hand-writes reorder logic in route handlers (swap positions on move).
3. Sorts children in application code after every load.

**What's needed**: An `orderedCollection` field type or a `position` built-in on
self-referential refs: `ref('Todo', { optional: true, ordered: true })` that
auto-manages a `position` column, provides `.moveUp()` / `.moveDown()` / `.insertAt()`,
and auto-sorts `.children()` by position.

---

### SHARP EDGE #3 — Due-date reminders: `state.auto` uses relative durations, not absolute field values — no "fire at 3pm Tuesday"

**ADR/design tested**: Scheduled mutation (IMPLEMENTATION-PLAN.md §4); `state.auto`
(doc.mjs lines 79-81).

**Failing code**:
```js
// The grilled scheduler is:
auto: { when: 'shared', after: '90d', to: 'archived' }
//          ^state    ^fixed duration string    ^target state

// What a todo WITH a state field would need:
status: state({
  values: ['active', 'overdue', 'completed'],
  transitions: { active: ['overdue', 'completed'], overdue: ['completed'], completed: ['active'] },
  auto: { when: 'active', after: Todo.dueDate, to: 'overdue' },
  //                          ^^^^^^^^^^^^^^^ NOT a duration string — a per-row DATE FIELD.
  // The `after` parameter only accepts '90d' | '3h' | '5m', not a field reference.
}),

// Without a state field, a bare todo has NO scheduler attachment point at all:
dueDate: date({ optional: true }),
// No way to say "when dueDate arrives, set completed=false→overdue mark" or
// "when dueDate - 30min, notify user."
```

**Impact**: A todo with a due date but no reminder is a note, not a task manager.
The grilled scheduler (`state.auto`) is designed for fixed-interval transitions
(archive after 90 days, publish at scheduled time) — it takes a duration literal,
not a field reference. A per-row absolute-time trigger can't be expressed.

Two workarounds, both bad:
(a) Use `entity.tick` (recurring, e.g. every 60s) to manually query overdue
    todos and flip them — this is a polling cron in framework clothing.
(b) Omit reminders entirely — the feature disappears.

**What's needed**: Either:
- `auto: { when: 'active', at: field('dueDate'), to: 'overdue' }` — `at` takes
a typed field handle whose value is a Date, and schedules a one-shot timer; or
- A `scheduled` construct at the entity level (not tied to `state`) that accepts
  `{ at: Todo.dueDate, offset: '-30m', action: { mutate: self, with: { … } } }`
  for reminders/notifications.

---

### SHARP EDGE #4 — `completed` is a boolean, not a state — no toggle, no completion timestamp, no auto-uncomplete on edit

**ADR/design tested**: Field types as reactive primitives (FEATURES.md §4).

**Failing code**:
```js
completed: boolean({ default: false }),

// The boolean field has no:
//   - .toggle() method (must write `todo.completed = !todo.completed`)
//   - auto-timestamp (completedAt) on flip to true
//   - auto-reset (completed → false) on title edit
```

**Impact**: Minor but universal. Every todo app needs toggle semantics. Without
a `.toggle()` method, the client sends the toggled value, which is a full write
(not an idempotent toggle). A `state` field with `completed` as a value would
solve this but is overkill for a yes/no property — and state is needed for the
overdue flow too, creating a tension: is `completed` a boolean or a state?

**What's needed**: `boolean` gains `.toggle()` and an optional `touchedAt`
auto-field (records when it last flipped). Or the `state` plugin gains a
`boolean`-style two-value mode: `state({ values: ['active', 'completed'],
simple: true })` that doesn't require a full transition table but still gives
toggle + timestamp.

---

### SHARP EDGE #5 — Subtask auth: a subtask's parent may be in a DIFFERENT list with different collaborators — auth doesn't follow the self-ref

**ADR/design tested**: Typed-FK traversal in the authorization compiler
(IMPLEMENTATION-PLAN.md §5); `inherit()` (comment.mjs).

**Failing scenario**:
```js
// TodoList A is shared with Alice and Bob.
// TodoList B is shared with Alice and Carol.
// Todo #1 (in list A) has a subtask Todo #2.
// Bob tries to move Todo #2 to list B (changing its `list` FK).
//
// The grilled model: Todo inherits its grant from TodoList via `inherit('TodoList', { via: 'list' })`.
// When Bob reads Todo #1, the compiler joins Todo→TodoList(A) and applies TodoList(A)'s scope
// (which admits Bob as a collaborator) — correct.
// When Bob reads the subtask Todo #2, the compiler joins Todo#2→TodoList(A) — correct.
//
// BUT: after the move, Todo #2's `list` FK changes to B. Bob can NO LONGER READ Todo #2 because
// TodoList(B)'s scope doesn't admit Bob. This is CORRECT behavior (the subtask moved to a list Bob
// can't see). But it means subtask identity is NOT independent — a subtask's visibility is tied to
// its current list, not to its parent todo. If a subtask has no `list` FK (parent-only), there's
// no grant chain at all — the subtask's grant would need to walk `parent→parent.list` (two hops
// through a self-ref) which the typed-FK compiler doesn't support.
```

**Impact**: In Approach A (single-entity, no TodoList), a subtask's `scope` is
tied to `is.owner()` — so subtasks can only live under a todo owned by the same
user. For shared lists, this breaks: Bob can see the parent todo (shared via
collaborator) but can't see subtasks (owner check fails). In Approach B, subtasks
inherit from TodoList via `list` FK, which is correct — but a subtask without a
direct `list` FK (relying on `parent.list`) has no grant path.

**What's needed**: Typed-FK traversal that follows chains (not just one hop).
`inherit('TodoList', { via: Todo.parent.through('list') })` or a
`.through()` chain declaration. Without it, the only safe structure is flat
(no parent self-ref) or duplicated (every subtask carries a direct `list` FK).

---

### SHARP EDGE #6 — `collaborators` map duplicates owner-is-already-a-collaborator confusion

**ADR/design tested**: AGENTS.md §Architecture — "Prefer a singular system."

**Failing code in grant**:
```js
scope(({ is }) => anyOf(is.owner(), is.collaborator()))
```

The owner is implicitly a collaborator (they own the list, they can read/write).
But `collaborators` is a `map(ref('User'), …)` that does NOT include the owner
unless explicitly added. This means:

1. The `scope` must always OR `is.owner()` and `is.collaborator()`.
2. A `list.collaborators.toArray()` listing doesn't include the owner — you need
   a separate display path.
3. If the owner IS added to collaborators, there's a duplicate — and removing
   the owner from collaborators doesn't revoke their access (owner check still
   passes), creating a confusing two-source-of-truth for one person's access.

**Impact**: Minor but pervasive. Every shared entity repeats the `anyOf(is.owner(),
is.collaborator())` pattern, and every UI that lists "who has access" must
special-case the owner.

**What's needed**: Either `owner` auto-included in `collaborators` as a
non-removable member with an implicit `owner` role, or a `members` field that
ALWAYS includes the owner + invitees uniformly.

---

## Gaps — features the todo app needs that the grilled API has no answer for

### GAP #1 — No `children` virtual field from reverse FK

`parent: ref('Todo')` is half the relationship. The framework has no auto-
derived reverse side: `todo.children` doesn't exist. The developer must
hand-query `Todo.findAll(Todo.parent.is(todo.id))` for every level of the tree.
This is the query-side counterpart of BLOCKER #1.

### GAP #2 — No `toggle` mutation on boolean fields

Covered in SHARP EDGE #4.

### GAP #3 — No batch-complete ("mark all subtasks done when parent is completed")

A common todo pattern: completing a parent auto-completes all descendants. This
is a declarative effect (`{ mutate: self.children(), with: { completed: true } }`)
— but it needs a way to target "all rows matching a condition" (children WHERE
parent = self.id), not just a single known row. The grilled `effects` primitive
`{ mutate: <target>, with: <template> }` targets one entity handle, not a query.

### GAP #4 — No soft-delete / trash / archive

Todos need undo-able deletion (move to trash, restore within 30 days, permanent
purge after). The grilled model has no soft-delete concept. A `state` field with
`trash`/`deleted` values + a TTL for auto-purge would work, but entity TTL is
deferred to Phase 3.

---

## Verdict: does the grilled floor stay smooth for a trivial app?

**Yes — with a caveat.** The grilled floor is honest, and honesty is the right
default. The 5→20 line jump from the dead zero-floor is not ceremony for
ceremony's sake — it's the difference between a framework that guesses your
auth model and one that forces you to state it. For a todo app where privacy IS
the domain, explicit `scope(is.owner())` is exactly what you'd write anyway; the
framework just refuses to let you skip it.

The real pain isn't ADR #7 — it's that the 80%-case grant pattern (`owner has
all, nobody else`) must be hand-typed identically for every entity. A pre-baked
`grant: ownerOnly` (still a declared grant, still fail-closed, still no magic
default) would cut the boilerplate without weakening ADR #7. The rest of the
pain (tree loading, absolute-time scheduler, toggle, auto-children) is about
missing primitives that even the pre-grill design didn't have — the grill didn't
create these gaps, it just didn't fill them.

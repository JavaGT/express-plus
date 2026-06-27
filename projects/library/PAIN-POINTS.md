# Pain Points: Library System on express-plus

Stress-testing the idealized `express-plus` API against a real library management domain.
Rank: **BLOCKER** (cannot express the concern declaratively) > **SHOULD-FIX** (expresses it but with friction) > **NIT** (works, minor ergonomic issue).

---

## 1. BLOCKER — No first-class state machine construct

**Where:** `Copy.status: text()` in `projects/library/index.mjs`

**What failed:** There is no `state()`, `enum()`, or `transition()` field type. The API surface has `text`, `text.crdt`, `number`, `date`, `ref`, `set`, `presence`, `log`, `hash`. The state machine on Copy (`available → checked-out → returned | lost | damaged`) is modeled as `status: text()` with ad-hoc `if` guards in route handlers:

```js
if (req.copy.status !== 'available') return next({ status: 409 });
req.copy.status = 'checked-out';
```

This has several failures:
1. **No static analysis** — the framework cannot verify transition legality, list reachable states, or detect invalid transitions at entity-load time.
2. **Duplicated guards** — every route handler re-implements the same checks. A missing guard is a silent data-corruption path.
3. **No event derivation by transition** — a framework with first-class states could auto-emit `Copy:<id>:status:checked-out` on transition. Currently, only `text` `:changed` fires, losing the semantic meaning.
4. **No declarative side-effects on transition** — clearing `borrower` and `dueDate` on `checked-out → returned` is manual imperative code, not declared as part of the transition.

**What we want:**

```js
status: state({
  initial: 'available',
  transitions: {
    'available':    ['checked-out'],
    'checked-out':  ['returned', 'lost', 'damaged'],
    'lost':         ['available'],   // recovered
    'damaged':      ['available'],   // repaired
    'returned':     [],              // terminal
  },
  effects: {
    '→ returned': ({ entity }) => { entity.borrower = null; entity.dueDate = null; },
    '→ lost':     ({ entity }) => { entity.borrower = null; entity.dueDate = null; },
  },
}),
```

---

## 2. SHOULD-FIX — `grant`/`hide()` filters at row-delivery level, not query level (lost-but-recoverable items)

**Where:** `Copy.grant` in `index.mjs`

**What failed:** The task requires that a lost copy is *removed from the public catalog* but *visible to staff* — i.e., the SAME `GET /copies` endpoint returns different result sets based on who asks. The `grant: hide()` mechanism handles this correctly at the row level (lost copies → 404 for patrons, visible for staff), **but** the filtering happens AFTER the database query:

1. **Pagination breaks.** If page size is 20 but 15 copies are lost, the public sees only 5 rows on page 1, and total-count metadata is wrong.
2. **No declarative query-level filter.** The ideal would be a `scope` or `defaultQuery` on the entity that applies *before* pagination:

   ```js
   // We want something like:
   queryScope: ({ is }) => is.staff() ? {} : { status: { not: 'lost' } },
   ```

   This would push the filter into the database WHERE clause, preserving correct pagination. Currently, separate routes with hand-written `findAll` predicates are needed (`catalogRoutes()` in `index.mjs`), which is the workaround but duplicates the filtering logic outside the entity.

**Current workaround:** `catalogRoutes()` does `Copy.findAll(Copy.status.not('lost'))` as a query predicate. But this is NOT the entity's own `grant` — it's a hand-written route that bypasses the declarative auth model.

---

## 3. SHOULD-FIX — No ordered-collection field type (Hold queue)

**Where:** `Hold` entity in `index.mjs`

**What failed:** The Hold queue needs ordering (position-in-line, FIFO by `placedAt`). The available collection field type is `set(ref('User'))` — an **unordered** set with CRDT merge semantics. There is no `list()`, `queue()`, or `orderedCollection()` field type. This forces Hold to be a standalone entity where ordering is derived from a `placedAt` timestamp field, and queue position is computed by counting earlier unfulfilled holds:

```js
const position = await Hold.count(
  Hold.item.is(itemId).and(Hold.fulfilledAt.is(null)).and(Hold.placedAt.lt(myHold.placedAt))
) + 1;
```

Without a first-class ordered field, the framework cannot:
- Maintain queue position as a materialized, reactive field (must recompute on query).
- Auto-advance the queue when a hold is fulfilled (no framework-level "dequeue and notify next in line").
- Prevent the N+1 problem when listing all holds with position numbers.

**What we want:**

```js
holds: queue(ref('Patron')), // ordered, emits :enqueued / :dequeued / :advanced
```

---

## 4. SHOULD-FIX — No structured-child-entity field type (Comments)

**Where:** `Comment` entity in `index.mjs`

**What failed:** Comments are owned by a Patron ("staff Comments about patron accounts"). The AGENTS.md rule says *"A collection owned by one side is a field on that entity, not a standalone table."* But the available field types for collections are:
- `set(ref('User'))` — references, not structured sub-records
- `log()` — append-only text stream, no FKs, no structured fields

Neither can hold `{ body, author, createdAt }`. This forces `Comment` to be a standalone entity with `ref('Patron')`, violating the owned-collection rule. A `childEntities()` or `ownedCollection()` field type that stores sub-entities inline (like a nested array of structured records) would let Comments live naturally on Patron:

```js
fields: {
  comments: children('Comment', { fields: { body: text(), author: ref('Patron') } }),
}
```

Then `patron.comments` returns the staff-only nested collection, and grant/access on `comments` can be handled at the parent level.

---

## 5. NIT — `is.*` is entity-relative, but "is the requestor a staff member?" is a cross-entity question

**Where:** `checks.staff` on Copy, Item, Hold, Comment entities in `index.mjs`

**What failed:** The `checks` system is designed for entity-relative predicates — `is.owner()` means "is the requestor the owner of THIS entity?" But "is the requestor staff?" is NOT entity-relative — it's a global role query. To express it, every entity that needs role awareness must define:

```js
checks: {
  staff: async ({ user, load }) => {
    const profile = await load(Patron.findOne(Patron.account.is(user.id)));
    return profile?.role === 'staff';
  },
}
```

This is repetitive boilerplate (alleviated slightly by sharing a `requestorIsStaff` helper function). Worse, the SAME method name `is.staff()` means different things on different entities:
- On `Patron` entity: "is THIS patron record a staff member?"
- On `Copy` entity: "is the REQUESTOR a staff member?"

**What we want:** Either (a) a framework-level `is.role('staff')` based on a convention on the User entity, or (b) a way to define cross-entity "contextual checks" that aren't entity-relative.

---

## 6. NIT — No `not()` / range operators on typed field predicates

**Where:** `catalogRoutes()` in `index.mjs`, `Hold` entity

**What failed:** The typed field handle predicates shown in the exemplar are `Field.is(value)` and `Field.has(value)`. For the library domain, we need:
- `Copy.status.not('lost')` — negation (exclude lost copies from public catalog)
- `Hold.placedAt.lt(otherHold.placedAt)` — less-than (queue ordering)
- `Hold.item.is(itemId).and(Hold.fulfilledAt.is(null))` — composite AND (active holds)

The aspirational code in `index.mjs` invents `.not()`, `.lt()`, `.and()`, and `Hold.count(...)`. None of these are shown in the existing exemplar. At minimum, `.not()` and `.and()` are table-stakes for any real query.

---

## 7. NIT — No time-based scheduler primitive (overdue detection)

**Where:** The overdue transition on Copy (checked-out with `dueDate < now`)

**What failed:** Time-based state transitions ("overdue when `dueDate` passes") need a scheduler that evaluates conditions at a future time. The entity model has no `schedule()` hook, no `cron()` field, no `timer()` construct. The `date({ touch: true })` mechanism auto-bumps `updatedAt` on mutation but doesn't trigger future events. Overdue detection would need an external cron job that periodically queries `Copy.findAll(Copy.dueDate.lt(now).and(Copy.status.is('checked-out')))` and manually transitions them. This is an external orchestration concern leaking into the app because the framework has no concept of time-triggered transitions.

**What we want:**

```js
status: state({
  transitions: {
    'checked-out': ['overdue'],
  },
  auto: {
    'checked-out → overdue': {
      when: ({ entity }) => entity.dueDate < new Date(),
      poll: '1m',  // or: framework-level scheduler
    },
  },
}),
```

---

## 8. NIT — No compound uniqueness enforcement

**Where:** `Hold` entity place-hold route in `index.mjs`

**What failed:** To prevent duplicate active holds (one patron, one item, one unfulfilled hold), the route handler manually queries for existing holds before creating. There is no declarative `uniqueTogether: ['item', 'patron', { where: { fulfilledAt: null } }]` constraint on the entity fields. The framework can't enforce this at the database level, so the check is ad-hoc imperative code prone to race conditions.

---

## Summary of severity

| # | Issue | Severity |
|---|-------|----------|
| 1 | No first-class state/transition field type | **BLOCKER** |
| 2 | grant/hide is row-level, not query-level (pagination breaks) | **SHOULD-FIX** |
| 3 | No ordered-collection field type (queue) | **SHOULD-FIX** |
| 4 | No structured-child-entity field type (owned comments) | **SHOULD-FIX** |
| 5 | `is.*` is entity-relative; cross-entity role checks are boilerplate | **NIT** |
| 6 | `.not()` / `.lt()` / `.and()` / `.count()` not confirmed in API | **NIT** |
| 7 | No scheduler primitive for time-based transitions (overdue) | **NIT** |
| 8 | No compound uniqueness (duplicate-hold prevention) | **NIT** |

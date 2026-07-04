# Pain Points: Library System on workbench (POST-GRILL)

Stress-testing the GRILLED `workbench` API (doc.mjs + comment.mjs exemplars, CONTEXT.md + DECISIONLOG.md) against a real library management domain with state machines, scheduled transitions, ordered queues, compound uniqueness, and a staff/patron/public visibility asymmetry.

Rank: **BLOCKER** (cannot express the concern declaratively) > **SHOULD-FIX** (expresses it but with friction) > **Sharp edge** (works, but the API fights you in a non-obvious way).

---

## Persona

The Bureaucrat — cares about state machines, scheduled transitions, compound rules, and granular visibility. Skeptical that "two questions, read and edit" is enough for a domain with staff/patron/public tiers.

---

## Attempted entity shape

The library has five entities. The exemplar code below is IDEALIZED — it imports handles that do not yet exist in the API surface, and documents each gap inline. Code follows the doc.mjs style: one entity per conceptual cluster, `state()` for machine transitions, `grant` exactly `scope(...).can(...)`, field `.can()` for per-field access, `map` for valued sets, and `effects` for declarative reactions.

```js
// library.mjs — Library inventory system expressed in the grilled workbench API.
// Entities: Patron, Item, Checkout, Hold, StaffNote.
// Stress-targets: staff/patron read-scope asymmetry, withheld field marker,
// state-machine overdue transition, ordered holds queue, compound uniqueness,
// cross-entity FK traversal in the scope compiler.
import {
  entity, text, number, date, ref, map, state,
  grant, deny, read, write, subscribe, admin, anyOf, never, scope,
  router, User, Inbox,
  // ── aspirational imports (not yet in API surface) ──
  // queue   — ordered mutable collection, FIFO dequeue, emits :enqueued/:dequeued
  // tick    — recurring entity lifecycle hook (Phase 2 step 9)
} from 'workbench';

// ═══════════════════════════════════════════════════════════════════════════════
// Capability bundles — typed, imported, never strings
// ═══════════════════════════════════════════════════════════════════════════════
const PATRON_OWN = [read, write, subscribe];
const STAFF_FULL  = [read, write, subscribe, admin];
const STAFF_READ  = [read, subscribe, admin];

// ═══════════════════════════════════════════════════════════════════════════════
// 1. PATRON — links a User principal to a library role (patron | staff)
// ═══════════════════════════════════════════════════════════════════════════════
//
// The Patron entity is the DOMAIN IDENTITY the authorization compiler traverses
// to answer "is this principal staff?" (Abstraction #5: typed-FK traversal in
// the queryScope compiler). Every entity that needs per-role read-scope MUST
// have the compiler follow the path: principal.id → Patron.account → Patron.role.
//
// NOTE: The grilled design compiles `scope` checks to SQL WHERE. For `is.staff()`
// to compile, the compiler must traverse the typed FK `Patron.account.is(principal.id)`
// and then test `Patron.role.is('staff')`. This two-hop traversal is NOT yet shown
// in any exemplar — it is described in IMPLEMENTATION-PLAN Phase 1 step 3 but
// the API surface does not demonstrate it. The code below assumes it works; the
// gap is documented in Pain Point #1.
export const Patron = entity('Patron', {
  fields: {
    // auto-derives checks.owner (= Patron.account.is(principal.id))
    account: ref('User', { role: 'owner', readonly: true }),

    role: state({
      values: ['patron', 'staff'],
      transitions: {
        patron: ['staff'],
        staff:  ['patron'],
      },
    }).can(async ({ is }) =>
      // Only staff may promote/demote roles.
      (await is.staff()) ? grant(read, write) : grant(read)),

    // Derived: count of active checkouts for this patron
    activeCheckouts: number({ derived: async (patron) => {
      return await Checkout.count(
        Checkout.patron.is(patron.id).and(Checkout.returnedAt.is(null))
      );
    }}),

    createdAt: date({ default: () => new Date() }),
  },

  checks: {
    // NOTE: `checks.owner` is auto-derived from `account: ref('User', { role: 'owner' })`
    // The explicit form below is for clarity only.
    owner: ({ Patron, principal }) => Patron.account.is(principal.id),

    // is THIS patron record a staff member? (entity-relative — "is Patron#42 staff?")
    // On THIS entity, `is.staff()` means "does THIS row's .role === 'staff'?"
    staff: ({ Patron }) => Patron.role.is('staff'),
  },

  // Grant: a patron can read/write their own record; any staff member can
  // read any patron record (but only the patron + staff can write).
  //
  // TENSION: `is.staff()` in `scope` requires the compiler to follow:
  //   principal.id → Patron.findOne(Patron.account.is(principal.id)) → .role
  // This is typed-FK traversal (Abstraction #5). Without it, `is.staff()` in
  // scope is a LOAD-TIME ERROR (non-compilable cross-entity check in scope).
  grant: ({ principal }) => [
    scope(({ is }) => anyOf(is.owner(), is.staff()))
      .can(async ({ is }) => {
        if (await is.owner()) return grant(...PATRON_OWN);
        if (await is.staff()) return grant(...STAFF_READ);
        return deny('no access to this patron record');
      }),
  ],

  // Security-sensitive entity: staff-only fields default to withheld.
  // Without this, every new field added is readable by the row-grant default.
  fieldAccess: { default: ownerOnly },

  routes: (r) => {
    r.resource();
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. ITEM — catalogued inventory unit with state machine + holds queue
// ═══════════════════════════════════════════════════════════════════════════════
//
// This is the CENTRAL stress test for the grilled auth model. Two visibility
// asymmetries must be expressed through the single grant engine:
//
//   (a) LOST items — absent from patron result sets, present for staff.
//       → Tests `scope` per-principal: scope must admit the row for staff only.
//
//   (b) currentHolder confidentiality — patrons can see WHEN an item comes back
//       (dueDate) but NOT WHO has it (currentHolder).
//       → Tests field `.can()` returning `withheld` marker.
//
// The Bureaucrat's question: can "two questions, read and edit" express both
// asymmetries without a second auth path or a hide() axis? The answer is YES
// IF the scope compiler supports typed-FK traversal (Abstraction #5) — because
// then `is.staff()` compiles to SQL WHERE, and scope becomes per-principal.
// The field-level asymmetry (withheld) works cleanly.
//
// The holds queue is modeled as a `map(ref('Patron'), { placedAt })` — a valued
// set keyed by Patron ref. This gives compound uniqueness by construction (one
// hold per patron per item) but loses ordering: the map is inherently unordered.
// Queue position is computed at read time by sorting entries.
export const Item = entity('Item', {
  fields: {
    title: text({ validate: (v) => v.length <= 300 || 'title too long' }),

    // Physical vs digital. Currently `text` — no `enum` shown in doc.mjs.
    // doc.mjs uses `state({ values: [...] })` for the status field but not an
    // enum type for categorical fields. text works but loses static exhaustiveness.
    medium: text({ validate: (v) => ['physical','digital'].includes(v) || 'invalid medium' }),

    // ── State machine: the core domain logic ────────────────────────────────────
    // The grilled `state` field type (shown in doc.mjs) provides: declared values,
    // declared transitions (static verification at entity-load), declarative
    // effects per transition, and `auto` for scheduled transitions.
    //
    // For the library, the state machine on an Item is:
    //   available → on-hold (patron places first hold)
    //   available → checked-out (immediate checkout, no holds)
    //   on-hold → checked-out (first hold fulfilled — staff action)
    //   on-hold → available (all holds cancelled)
    //   checked-out → returned (becomes available again)
    //   checked-out → overdue (dueDate passed — scheduled)
    //   checked-out → lost (staff marks missing)
    //   overdue → returned
    //   overdue → lost
    //   lost → available (staff recovers)
    status: state({
      values: ['available', 'on-hold', 'checked-out', 'overdue', 'lost'],
      transitions: {
        available:    ['on-hold', 'checked-out'],
        'on-hold':    ['checked-out', 'available'],
        'checked-out': ['returned', 'overdue', 'lost'],
        overdue:      ['returned', 'lost'],
        lost:         ['available'],
      },
      effects: {
        // On return: clear currentHolder + dueDate.
        // EFFECT PRINCIPAL bounded to the target entity + template fields;
        // authorized against Item's OWN grant (deny rolls back the batch).
        //
        // TENSION: returning from checked-out vs overdue are TWO transitions
        // that share logic. There is no way to bind one effect to multiple
        // transitions — each must be declared separately. Duplication. (Sharp edge #3)
        [state.transition('checked-out', 'returned')]: {
          with: { currentHolder: null, dueDate: null },
        },
        [state.transition('overdue', 'returned')]: {
          with: { currentHolder: null, dueDate: null },
        },
        // On lost: clear currentHolder but preserve dueDate (for recovery audit)
        [state.transition('checked-out', 'lost')]: {
          with: { currentHolder: null },
        },
        [state.transition('overdue', 'lost')]: {
          with: { currentHolder: null },
        },
        // On transition to on-hold (first hold placed), record when hold was placed
        [state.transition('available', 'on-hold')]: {
          with: { lastHoldPlacedAt: now },
        },
        // On recovery: clear lost flag
        [state.transition('lost', 'available')]: {
          with: { isLost: false },
        },
      },

      auto: {
        // ═══ GAP: conditional-by-field-value scheduled transition ═══
        //
        // doc.mjs shows `auto: { when: 'shared', after: '90d', to: 'archived' }`
        // — a FIXED duration from state-entry. The library needs:
        //
        //   "transition checked-out → overdue WHEN dueDate < now()"
        //
        // dueDate is set at checkout time and varies per item. The grilled `auto`
        // has no way to reference a date FIELD as the deadline; it only accepts
        // a fixed string duration. Options the API could provide:
        //
        //   (a) `by: dueDate` — compile to a DB-level check or scheduler using
        //       the field's value as the trigger time (ideal, not shown)
        //   (b) `entity.tick` — a recurring evaluation loop that checks conditions
        //       (Phase 2 step 9, not shown in any exemplar)
        //   (c) `poll: '1h', when: ({ entity }) => entity.dueDate < new Date()`
        //       — a callback, breaks "declarative, not imperative"
        //
        // Without (a) or (b), overdue detection falls out of the entity declaration
        // entirely and must be an external cron job — a leak of framework concern.
        // See Pain Point #2.
        //
        // Idealized form (does not exist):
        //   when: 'checked-out', by: dueDate, to: 'overdue',
        //
        // Current compromise: no auto; overdue handled externally.
      },
    }).can(async ({ is }) => {
      // Staff can transition any status. Patrons can only read status.
      if (await is.staff()) return grant(...STAFF_FULL);
      return grant(read);
    }),

    // ── currentHolder: the confidentiality asymmetry ───────────────────────────
    //
    // Staff: sees the Patron ref (resolves to patron name/account).
    // Patrons: field returns `withheld` marker — the row is readable (title,
    //   dueDate, status are visible) but this specific field is masked.
    //
    // This is the key stress-test for field `.can()` returning a withheld marker.
    // The grilled design says: field read-denial returns the typed `withheld`
    // marker (prod) + dev diagnostic (field path + deny reason); edit-denial is
    // a hard write reject.
    //
    // RESULT: The API expresses this cleanly. The separation of row-scope (lost
    // items are absent) from field-access (currentHolder is withheld) maps
    // naturally onto `scope` + `.can`. No hide() axis needed. ✓
    currentHolder: ref('Patron', { optional: true })
      .can(async ({ is }, defaults) =>
        // Staff: inherit row grant (read/write). Patron: read → withheld, write → reject.
        (await is.staff()) ? defaults : deny('current holder is confidential to staff')),

    // dueDate is visible to anybody who can read the row — patron sees "when it
    // comes back" even though they can't see WHO has it. No `.can` override =
    // strong-inherits row grant. ✓
    dueDate: date({ optional: true }),

    // ── Holds queue: valued set (map) ──────────────────────────────────────────
    //
    // `map(ref('Patron'), { placedAt })` gives compound uniqueness by CONSTRUCTION:
    // a Patron can only appear once as a key → one active hold per item+patron.
    // No separate unique constraint needed. This is the `map` plugin dissolving
    // the separate-join-entity pattern (IMPLEMENTATION-PLAN, Phase 1 step 4).
    //
    // ⚠ GAP: `map` is KEYED-UNORDERED. Queue ordering (FIFO by placedAt) is not
    // maintained by the framework. Consumers must sort entries at read time.
    // There is no `queue` or `orderedList` field type.
    //
    // ⚠ GAP: `map` field `.can` is per-field, not per-entry. A patron cannot
    // see their OWN hold entry while other entries are withheld — it's all-or-
    // nothing on the field read. Staff sees all holds; patrons see none.
    // Per-entry field authorization would be needed for a patron to see their
    // own position in the holds queue.
    //
    // Workaround: derive `queuePosition` for the requesting patron from their
    // principal ID, but derived fields don't receive the principal context in
    // the current API (they receive the row, not the request).
    holds: map(ref('Patron'), {
      placedAt: date({ default: () => new Date() }),
    }).can(async ({ is }) =>
      // Staff: full read/write. Patrons: no read (can't see queue), write allowed
      // for placing/removing their own hold (the write is checked at the key level
      // by the map plugin — a patron can only set/remove their own key).
      //
      // TENSION: if .can returns deny for read, the patron can't even see that
      // they have a hold. A derived field `myQueuePosition` is needed, but
      // derived fields don't have access to the principal.
      (await is.staff()) ? defaults : grant(write)),

    // Derived: how many active holds are on this item? Visible to all.
    activeHolds: number({ derived: (item) => Object.keys(item.holds ?? {}).length }),

    // Derived: the requesting patron's position in the holds queue.
    // ⚠ GAP: derived fields do not receive the principal. A derived field
    // that computes `my position in line` has no way to know WHO is asking.
    // The `derived: (item, { principal }) => ...` signature is not shown.
    // queuePosition: number({ derived: (item, { principal }) => { ... } }),

    // isLost: a boolean flag set by staff. Compilable (boolean equality) —
    // so it CAN appear in `scope`. Together with `is.staff()` (which requires
    // typed-FK traversal), this lets scope filter out lost items for patrons
    // while admitting them for staff.
    isLost: boolean({ default: false })
      .can(async ({ is }, defaults) =>
        (await is.staff()) ? defaults : grant(read)),

    copiesAvailable: number({ default: 1 }),
    copiesTotal: number({ default: 1 }),

    createdAt: date({ default: () => new Date() }),
    updatedAt: date({ touch: true }),
    lastHoldPlacedAt: date({ optional: true }),
  },

  checks: {
    // Entity-relative: is THIS item lost?
    notLost: ({ Item }) => Item.isLost.is(false),

    // ⚠ CROSS-ENTITY: a staff check on Item requires loading the Patron entity.
    // The grilled design says: a check used in `scope` that cannot compile to
    // SQL is a LOAD-TIME ERROR. `is.staff()` here requires:
    //   1. Find the Patron whose account matches principal.id
    //   2. Test Patron.role === 'staff'
    //
    // Without typed-FK traversal in the compiler (Abstraction #5), this is
    // non-compilable and must live in `.can` only. But scope NEEDS it to
    // express "staff can read lost items, patrons cannot" — a read-scope
    // question, not a runtime capability question.
    //
    // The plan says Phase 1 step 3 will compile typed-FK traversal paths.
    // Until then, `is.staff()` in `scope` is a load-time error — and the
    // staff/patron read-scope asymmetry cannot be expressed declaratively.
    // See Pain Point #1.
    staff: ({ principal, load }) => {
      // IDEALIZED: after typed-FK traversal, the compiler follows this path
      // and compiles it to a SQL subquery/join.
      //
      // Explicit form (for when the compiler can't derive it):
      //   principal.id → Patron.account → Patron.role
      //
      // With the `via` directive (analogous to inherit):
      //   via: principal, to: Patron, through: 'account', check: { role: 'staff' }
      //
      // Without compiler support, this is the imperative fallback:
      const patron = await load(Patron.findOne(Patron.account.is(principal.id)));
      return patron?.role === 'staff';
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // GRANT: the core stress test
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // GOAL: staff sees all items (including lost). Patrons see only non-lost items.
  // This MUST be expressed in `scope` (compiled to SQL WHERE) because it
  // determines which rows EXIST in the result set, which affects pagination.
  //
  // If `is.staff()` compiles via typed-FK traversal:
  //   scope = staff OR notLost
  //   SQL: WHERE (EXISTS (SELECT 1 FROM patron WHERE patron.account_id = :pid
  //         AND patron.role = 'staff')) OR (item.is_lost = false)
  //   → Staff sees everything; patrons see non-lost only. ✓
  //
  // If `is.staff()` does NOT compile (no typed-FK traversal in compiler):
  //   scope can only express what's compilable from Item's OWN columns.
  //   Options:
  //     (a) scope = notLost → lost items invisible to EVERYONE including staff.
  //         Staff must use a separate query path (separate route with .not()
  //         omitted) — a second auth path, violating the singular-system rule.
  //     (b) scope = always → lost items visible to EVERYONE. Staff sees them
  //         (correct) but patrons also see them (wrong). Hide at field level
  //         doesn't help — the row ITSELF is in the result set.
  //     (c) scope can't express it → BLOCKED.
  //
  // Result: without typed-FK traversal in the compiler, the grilled API cannot
  // express per-principal read-scope when the differentiating factor (staff vs
  // patron) requires a cross-entity join. This is NOT a theoretical edge case —
  // any domain with a role system on a separate identity entity hits this.
  //
  // See Pain Point #1.
  grant: ({ principal }) => [
    scope(({ is }) => anyOf(is.notLost(), is.staff()))
      .can(async ({ is, entity }) => {
        // Staff: full access.
        if (await is.staff()) return grant(...STAFF_FULL);
        // Patron (admitted by notLost): read-only for most fields.
        // Field-level refinements (currentHolder withheld, holds read-denied)
        // are expressed on the fields themselves via `.can()`.
        return grant(read, subscribe);
      }),
  ],

  // Effects: when a checkout is created for this item, transition state.
  // ⚠ GAP: effects fire on the entity's OWN field mutations. To react to a
  // Checkout entity creation (cross-entity trigger), the Checkout entity
  // would need to declare the effect targeting Item — but Checkout doesn't
  // own Item's state machine. This is a cross-entity coordination gap.
  //
  // Workaround: the route handler that creates a Checkout must also manually
  // transition Item.status. This is imperative wiring, not declarative.
  // A two-way effect declaration (Checkout.onCreated → Item.status) requires
  // each entity to know about the other's state machine, which couples them.

  routes: (r, Item) => {
    r.resource();

    // Public catalog: non-lost items for patrons (browsing).
    // ⚠ NOTE: this route exists ONLY because `scope` can't filter per-principal
    // (if `is.staff()` doesn't compile). If scope compiled, `GET /items` would
    // return different rows per principal automatically — no separate catalog
    // route needed. This route is the SECOND AUTH PATH the grilled design was
    // supposed to eliminate.
    r.get('/catalog', async (req, res) => {
      const items = await Item.findAll(
        Item.isLost.is(false)
      ).sort(Item.updatedAt, 'desc').limit(50);
      // Each item's currentHolder field will be `withheld` for non-staff patrons
      // via field `.can()` — no manual stripping needed.
      res.json({ items });
    });

    // Place a hold on an item
    r.post('/:itemId/hold', async (req, res) => {
      const item = req.item; // auto-loaded by :itemId param
      const patron = await Patron.findOne(Patron.account.is(req.principal.id));
      await item.holds.set(patron.id, { placedAt: new Date() });
      // ⚠ GAP: the holds.set mutation should auto-transition item.status to
      // 'on-hold' if currently 'available', but cross-field effects within the
      // same entity (holds.set → status transition) are not declared.
      // The state machine owns its own transitions; external mutations to
      // other fields can't trigger state transitions without imperative code.
      if (item.status === 'available') {
        await item.status.transition('on-hold');
      }
      res.status(201).json({ queued: true });
    });

    // Staff: checkout an item to a patron
    r.post('/:itemId/checkout', async (req, res) => {
      const item = req.item;
      // ⚠ staff-check is manual: no route-level `requireRole` guard in the
      // grilled API. The route handler must imperatively check the principal's
      // role, OR rely on the field mutation failing at the grant level.
      // `item.status.transition('checked-out')` will fail if the principal
      // lacks write on `status` (deny for non-staff via field.can).
      const patron = await Patron.findById(req.body.patronId);

      // Create a checkout record (history)
      await Checkout.create({
        item: item.id,
        patron: patron.id,
        dueDate: new Date(Date.now() + 14 * 86400000), // 2 weeks
      });

      // Transition item state: the effect principal is bounded, authorized
      // against Item's grant, and runs in the SAME transaction as the
      // originating mutation. If Checkout.create and item.status.transition
      // were in a batch(), they'd share one transaction + one composed event.
      await item.status.transition(
        item.status === 'on-hold' ? 'checked-out' : 'checked-out',
        { currentHolder: patron.id, dueDate: new Date(Date.now() + 14 * 86400000) }
      );

      res.status(201).json({ checkedOut: true });
    });

    // Staff: mark item as lost
    r.post('/:itemId/lost', async (req, res) => {
      await req.item.status.transition('lost');
      await req.item.set({ isLost: true });
      res.json({ lost: true });
    });

    // Staff: recover a lost item
    r.post('/:itemId/recover', async (req, res) => {
      await req.item.status.transition('available');
      await req.item.set({ isLost: false });
      res.json({ recovered: true });
    });
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. CHECKOUT — historical record of a checkout event
// ═══════════════════════════════════════════════════════════════════════════════
export const Checkout = entity('Checkout', {
  fields: {
    item: ref('Item', { required: true }),
    patron: ref('Patron', { required: true }),
    checkedOutAt: date({ default: () => new Date() }),
    dueDate: date({ required: true }),
    returnedAt: date({ optional: true }),
  },

  checks: {
    staff: ({ principal, load }) => {
      // Same cross-entity staff check — reuse pattern from Item.
      // ⚠ Duplicated across entities. No framework-level "requestor has role X"
      // utility that the compiler understands. See Sharp edge #4.
      const patron = await load(Patron.findOne(Patron.account.is(principal.id)));
      return patron?.role === 'staff';
    },
  },

  grant: ({ principal }) => [
    // Staff sees ALL checkouts (monitoring). Patrons see their OWN checkouts.
    // ⚠ Same typed-FK-traversal dependency: `is.staff()` in scope requires
    // compiler support for principal→Patron traversal.
    scope(({ is }) => anyOf(is.patron(principal.id), is.staff()))
      .can(async ({ is }) => {
        if (await is.staff()) return grant(...STAFF_FULL);
        if (await is.patron(principal.id)) return grant(read, subscribe);
        return deny('no access to this checkout record');
      }),
  ],

  routes: (r, Checkout) => {
    r.resource();

    // Staff: all active checkouts (who has what, how long)
    r.get('/active', async (req, res) => {
      // ⚠ Cannot rely on scope alone if is.staff() doesn't compile.
      // Must manually query:
      const active = await Checkout.findAll(
        Checkout.returnedAt.is(null)
      ).sort(Checkout.dueDate, 'asc');
      res.json({ active });
    });
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. HOLD — a standalone hold entity (fallback because map is unordered)
// ═══════════════════════════════════════════════════════════════════════════════
//
// ⚠ DESIGN TENSION: The AGENTS.md rule says "A collection owned by one side is
// a field on that entity, not a standalone table." Item.holds (map) IS that field.
// But map is unordered — FIFO queue semantics are lost. Making Hold a standalone
// entity restores ordering (via placedAt sort) but:
//
//   1. Violates the owned-collection rule (duplicate pattern vs map).
//   2. Requires compound uniqueness (one hold per item+patron) — which is
//      Phase 3 (item 16), not yet in the API surface.
//   3. Queue position must be computed by counting (N+1 problem).
//
// The map-on-Item approach gives compound uniqueness for free but loses ordering.
// A `queue` field type would dissolve both concerns. See Pain Point #3.
//
// For this exemplar, Hold is standalone to demonstrate the ordering challenge.
export const Hold = entity('Hold', {
  fields: {
    item: ref('Item', { required: true }),
    patron: ref('Patron', { required: true }),
    placedAt: date({ default: () => new Date() }),
    fulfilledAt: date({ optional: true }),
    // ⚠ queuePosition is derived by counting earlier unfulfilled holds.
    // This is O(n) per hold and not materialized — the framework can't maintain
    // it as a reactive field because it depends on OTHER rows in the same entity
    // (not a field of THIS row).
  },

  checks: {
    staff: ({ principal, load }) => {
      const patron = await load(Patron.findOne(Patron.account.is(principal.id)));
      return patron?.role === 'staff';
    },
    // Compilable: is this hold for the requesting patron?
    patronHold: ({ Hold, principal }) => Hold.patron.is(principal.id),
  },

  // ⚠ COMPOUND UNIQUENESS: one active hold per item+patron.
  // The grilled API has `unique` for single fields (Phase 1 step 6).
  // Compound uniqueness (uniqueTogether) is Phase 3 (item 16).
  // Without it, the app must manually check before creating a hold:
  //   const existing = await Hold.findOne(
  //     Hold.item.is(itemId).and(Hold.patron.is(patronId)).and(Hold.fulfilledAt.is(null))
  //   );
  //   if (existing) return res.status(409).json({ error: 'already held' });
  //
  // This is a race condition without a DB-level constraint. The map-on-Item
  // approach avoids this (key uniqueness), but loses ordering.

  grant: ({ principal }) => [
    scope(({ is }) => anyOf(is.patronHold(), is.staff()))
      .can(async ({ is }) => {
        if (await is.staff()) return grant(...STAFF_FULL);
        if (await is.patronHold()) return grant(read, subscribe);
        return deny('no access');
      }),
  ],

  routes: (r) => {
    r.resource();
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. STAFFNOTE — a structured comment on a Patron's account by staff
// ═══════════════════════════════════════════════════════════════════════════════
//
// ⚠ DESIGN TENSION: The AGENTS.md rule says a collection owned by one side is a
// field on that entity. StaffNotes are owned by Patron. But the grilled API has
// no `children()` or `embeddedCollection()` field type that can hold structured
// sub-records with fields like { body, author, createdAt }.
//
// Available multi-value field types:
//   - `set(ref(...))` — references only, no payload
//   - `map(ref(...), { ... })` — valued set keyed by ref; payload IS structured
//     but the key MUST be a ref (User/Patron). StaffNotes aren't keyed by a ref.
//   - `log({ ... })` — append-only text stream; has sender/body but no
//     structured field definitions, no FKs, no per-entry access controls
//
// `map` COULD work if keyed by something synthetic, but the key type must be a
// ref — you can't key a map by an auto-incrementing ID or timestamp.
//
// The only path is a standalone entity with `ref('Patron')` — violating the
// owned-collection rule. See Pain Point #4.
export const StaffNote = entity('StaffNote', {
  fields: {
    patron: ref('Patron', { required: true }),
    author: ref('User', { role: 'author', readonly: true }),
    body: text({ validate: (v) => v.length > 0 || 'note body is required' }),
    createdAt: date({ default: () => new Date() }),
  },

  checks: {
    staff: ({ principal, load }) => {
      const patron = await load(Patron.findOne(Patron.account.is(principal.id)));
      return patron?.role === 'staff';
    },
    author: ({ entity, principal }) => entity.author === principal.id,
  },

  // Only staff may read or write StaffNotes. The patron the note is ABOUT
  // cannot see it (staff-internal).
  grant: ({ principal }) => [
    scope(({ is }) => is.staff())
      .can(async ({ is }) => {
        if (await is.staff()) return grant(...STAFF_FULL);
        return deny('staff notes are internal');
      }),
  ],

  routes: (r) => {
    r.resource();
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// WIRING — app mount
// ═══════════════════════════════════════════════════════════════════════════════
//
// The route structure for a library app:
//   GET  /items          — catalog (lost items filtered by scope)
//   GET  /items/:id      — item detail (currentHolder withheld for patrons)
//   POST /items/:id/hold — place hold
//   GET  /checkouts      — my checkouts (patron) / all active (staff)
//   GET  /patrons/:id    — patron profile (staff only, per fieldAccess:ownerOnly)
//   GET  /patrons/:id/notes — staff notes on this patron (staff only)
```

---

## Pain points

### BLOCKER #1 — Per-principal read-scope requires typed-FK traversal (staff/patron) that the compiler doesn't yet supply

**Failing code:**

```js
// Item.grant — the lost-item visibility asymmetry
grant: ({ principal }) => [
  scope(({ is }) => anyOf(is.notLost(), is.staff()))  // ← LOAD-TIME ERROR
    .can(async ({ is }) => { ... }),
],
```

**What fails:** `is.staff()` in `scope` requires the compiler to traverse the path `principal.id → Patron.account → Patron.role` and compile it to a SQL subquery/join. The grilled design says a check in `scope` that cannot compile to SQL is a **load-time error**, not a warning and not a silent JS fallback. The `checks.staff` on Item is defined as:

```js
staff: ({ principal, load }) => {
  const patron = await load(Patron.findOne(Patron.account.is(principal.id)));
  return patron?.role === 'staff';
}
```

This is non-compilable (async cross-entity `load`) without compiler support for typed-FK traversal. The doc.mjs exemplar shows no checks that require cross-entity loads in `scope` — `is.owner()`, `is.collaborator()`, and `is.linkHolder()` all compile from Doc's own columns.

**ADR/design surface tested:** ADR #2 (`scope` is compiled to SQL, non-compilable check = load-time error), ADR #5 (`scope` is the ONLY grant compiled to SQL), Abstraction #5 (typed-FK traversal in the authorization compiler).

**Consequence:** Without compiler support for typed-FK traversal, the library cannot express per-principal read-scope declaratively. The workaround is a separate `/catalog` route with a manual `Item.isLost.is(false)` query — which is a **second auth path** (the route bypasses the entity's own `grant`). This is exactly the "singular system" violation the grilled design condemns.

**Why this is BLOCKER:** The IMPLEMENTATION-PLAN explicitly calls out typed-FK traversal as non-optional ("an early decision that, left wrong, poisons a later phase"). Until it lands, any domain with a role system on a separate identity entity (library, project management, multi-tenant SaaS, healthcare) cannot express per-principal read-scope. The "two questions, read and edit" model is structurally sound — the missing piece is the compiler, not the model.

---

### BLOCKER #2 — `state.auto` lacks conditional-by-field-value deadlines (overdue)

**Failing code:**

```js
status: state({
  values: ['available', 'on-hold', 'checked-out', 'overdue', 'lost'],
  auto: {
    // The grilled form (doc.mjs):
    //   when: 'shared', after: '90d', to: 'archived'
    // This is a FIXED duration from state-entry. For overdue, dueDate is
    // DIFFERENT for every checkout — a date FIELD, not a duration.

    // NEEDED but NOT in the API:
    when: 'checked-out', by: dueDate, to: 'overdue',
    //                      ^^^^^^^^^
    //                      A REFERENCE to a date field, not a string duration.

    // ALTERNATIVE (also not in API):
    //   when: ({ entity }) => entity.status === 'checked-out' && entity.dueDate < new Date(),
    //   to: 'overdue',
    //
    // But that's a function callback, violating "declarative, not imperative."
    // An entity-level `tick` (Phase 2 step 9, not yet shown) could evaluate this
    // condition on a recurring schedule, but tick isn't in the API surface either.
  },
})
```

**What fails:** The grilled `state.auto` (from doc.mjs) only supports `{ when, after, to }` — a fixed duration from the time the state was entered. A library overdue transition depends on a per-item `dueDate` field, which varies. Neither `by: <fieldHandle>` (reference a date field) nor `entity.tick` (recurring evaluation hook) are in the API surface.

**ADR/design surface tested:** ADR #6 (declarative effects, bounded reentrancy, same pipeline). The DESIGN is correct — a scheduled overdue transition IS a mutation through the pipeline attributed to a system principal. The API surface for conditional-by-field-value deadlines is the gap.

**Consequence:** Overdue detection leaks out of the entity declaration entirely. The app must run an external cron job that queries `Item.findAll(Item.status.is('checked-out').and(Item.dueDate.lt(now)))` and manually transitions each row. This is the `on(app)` / `afterSave` reborn — imperative orchestration outside the entity, exactly what the grilled design was supposed to replace.

> **SETTLED (background jobs shipped):** The "external cron job" workaround no
> longer requires a scheduler outside the framework — `createJobQueue` is now
> exported from `workbench/internal` (`src/job-queue.mjs`), giving a durable
> in-framework job primitive for the polling/transition scan. The narrower ask
> — a *declarative* conditional-by-field-value `auto` deadline inside `state` —
> remains the open part of this blocker. Historical text kept above.

---

### SHOULD-FIX #3 — No ordered-collection field type (holds queue)

**Failing code:**

```js
// IDEAL: an ordered queue on Item
holds: queue(ref('Patron', { key: 'patronId', orderBy: 'placedAt' }))
// → emits :enqueued / :dequeued / :advanced
// → framework maintains position as a reactive property
// → dequeue() auto-advances the next hold
// → compound uniqueness by key (one hold per patron per item)

// CURRENT: map is keyed-UNORDERED
holds: map(ref('Patron'), {
  placedAt: date({ default: () => new Date() }),
})
// → compound uniqueness ✓ (keyed by Patron)
// → ordering ✗ (entries are unsorted; consumer must sort by placedAt)
// → position ✗ (no framework-maintained ordinal)
// → dequeue ✗ (no FIFO pop)
```

**What fails:** The `map` type is a keyed-unordered valued set. It gives compound uniqueness by construction (a Patron can only appear once as a key → one active hold per item+patron), which is excellent. But it cannot maintain ordering (FIFO by `placedAt`). Queue position must be computed at read time by counting earlier unfulfilled holds — an O(N) operation per hold that compounds to O(N²) for listing a queue.

**ADR/design surface tested:** AGENTS.md "A collection owned by one side is a field on that entity." `map` IS that field, and does satisfy the owned-collection rule. The gap is that not all owned collections are unordered sets — some are ordered queues.

---

### SHOULD-FIX #4 — No structured-child-entity field type (StaffNotes on Patron)

**Failing code:**

```js
// IDEAL: StaffNotes live ON Patron as an owned collection
// fields: {
//   staffNotes: children('StaffNote', {
//     fields: { body: text(), author: ref('User'), createdAt: date() },
//   }).can(async ({ is }) =>
//     (await is.staff()) ? defaults : deny('staff notes are internal')),
// }
//
// `patron.staffNotes` returns the nested collection, authorized through the
// parent's grant + the field's own .can.

// CURRENT: StaffNote is a standalone entity (violates AGENTS.md)
export const StaffNote = entity('StaffNote', {
  fields: {
    patron: ref('Patron', { required: true }),  // FK back to parent
    body: text(),
    author: ref('User'),
    createdAt: date({ default: () => new Date() }),
  },
  // Now authorization is duplicated: StaffNote.grant must re-express the
  // "staff-only" rule that Patron already knows.
});
```

**What fails:** The AGENTS.md rule states "a collection owned by one side is a field on that entity." But the field-type catalog has no type that can hold structured sub-records with their own fields, authorization, and FK population:
- `set(ref(...))` — references only, no payload fields
- `map(ref(...), { ... })` — valued set keyed by a ref; payload IS structured but the key must be a ref (StaffNotes aren't keyed by ref)
- `log({ ... })` — append-only text stream with sender/body, no structured field definitions

**ADR/design surface tested:** ADR #8 (declarative effects, bounded reentrancy) — a child-collection field type would need its own grant inheritance model (like `inherit`) and mutation pipeline integration. The `inherit('Patron', { via: 'patron' })` pattern from comment.mjs works for standalone child entities but not for embedded collections.

---

### Sharp edge #5 — `map` field `.can` is per-field, not per-entry (holds visibility)

**Failing code:**

```js
holds: map(ref('Patron'), { placedAt: date })
  .can(async ({ is }) =>
    (await is.staff()) ? defaults : deny('holds queue is staff-only'))
```

**What happens:** A patron who places a hold cannot see their OWN hold entry in the queue — `holds` read is denied entirely. Staff sees all holds. There is no middle ground: "patron can see their own hold entry but not others'." The `map` field `.can` operates at the **field** level, not the **entry** level. Per-entry authorization ("you can read entry keyed by your own patron ID") would require the `.can` function to receive the entry key, which it doesn't.

**ADR/design surface tested:** ADR #3 (field access always runtime `.can`, field read-denial = `withheld` marker). The `withheld` marker is correct for singular fields (currentHolder), but a map's read-denial is all-or-nothing — you get the whole map or nothing. A per-entry refinement ("withhold entries where entry.patronId != principal.id") is not expressible in the current `.can` API.

**Workaround:** Derive `queuePosition` as a computed field that reads the map internally and finds the principal's position. But derived fields don't receive the principal context in the API shown.

---

### Sharp edge #6 — `state.effects` cannot bind one effect to multiple transitions

**Failing code:**

```js
status: state({
  effects: {
    // checked-out → returned and overdue → returned share logic:
    // clear currentHolder + dueDate. Must declare twice.
    [state.transition('checked-out', 'returned')]: { with: { currentHolder: null, dueDate: null } },
    [state.transition('overdue', 'returned')]:   { with: { currentHolder: null, dueDate: null } },
  },
})
```

**What fails:** The `effects` map is keyed by a single typed transition handle. Two transitions that share the same effect must duplicate the declaration. The API has no `anyOf()` or wildcard for transition keys (e.g., `state.transition('*', 'returned')`). For the library, "returned" can come from "checked-out" or "overdue" — both need the same cleanup.

**ADR/design surface tested:** ADR #6 (declarative effects). Not a design flaw — effects are correctly keyed by transition, and the compiler can verify all transitions have effects declared. But ergonomically, repeated cleanup across N incoming transitions forces duplication.

---

### Sharp edge #7 — Cross-entity `staff` check duplicated on every entity that needs it

```js
// Defined on Patron, Item, Checkout, Hold, StaffNote — five times.
staff: ({ principal, load }) => {
  const patron = await load(Patron.findOne(Patron.account.is(principal.id)));
  return patron?.role === 'staff';
}
```

**What fails:** `is.staff()` means different things on different entities ("is THIS Patron row staff?" vs "is the REQUESTOR staff?"), but the implementation is identical boilerplate across every entity that needs role awareness. The grilled API has no shared-check mechanism or principal-attribute query (e.g., `principal.hasRole('staff')` derived from a convention on the User entity).

**ADR/design surface tested:** ADR #2 (checks are per-entity plain functions, never universalized across entity types). This is by design — checks are "schema-by-schema, never universalized." But role checks are a pragmatic exception: every entity that gates on role needs the same logic. A framework-level `principal.attributes` or `principal.hasRole()` that the compiler understands would eliminate the duplication without universalizing checks.

---

### Sharp edge #8 — Derived fields have no principal context (queuePosition)

```js
// IDEAL — but `derived` receives (row), not (row, principal):
queuePosition: number({
  derived: (item, { principal }) => {
    const entries = Object.entries(item.holds).sort((a, b) => a[1].placedAt - b[1].placedAt);
    return entries.findIndex(([pid]) => pid === principal.id) + 1 || null;
  }
})

// CURRENT: derived = (doc) => doc.body.trim().split(...) — row only.
```

**What fails:** The doc.mjs `derived` signature is `(doc) => ...` — it receives the row, not the request context. For library queue position, "am I #3 in line?" depends on WHO is asking. A derived field that varies per-reader is a different concept from a pure-pull computed field like `wordCount`.

---

### Confirmed WORKING — The withheld marker for field confidentiality

**Code:**

```js
currentHolder: ref('Patron', { optional: true })
  .can(async ({ is }, defaults) =>
    (await is.staff()) ? defaults : deny('current holder is confidential to staff'))
```

**Result:** Patron reads the Item row and gets: `{ title: "Moby Dick", status: "checked-out", dueDate: "2026-07-15", currentHolder: <withheld> }`. The patron knows WHEN the item comes back (dueDate) but not WHO has it (currentHolder is withheld). Staff gets the full Patron ref. No `hide()` axis needed. **The two-question model passes this test.** ✓

---

## Prior findings re-checked

Each prior (pre-grill) finding re-evaluated against the grilled API:

| # | Prior finding | Post-grill status | Why |
|---|---------------|-------------------|-----|
| 1 | No first-class state/transition field | **RESOLVED** | `state()` exists in doc.mjs with values, transitions, effects, auto. Covers the basic state machine. Remaining gap: conditional-by-field-value `auto` deadlines (Blocked #2). |
| 2 | grant/hide is row-level, not query-level (pagination breaks) | **STILL-OPEN / NEW-ANGLE** | `hide()` is dead (ADR #1). The grilled `scope` compiles to SQL WHERE — CORRECT approach for pagination. But the compiler can only express what the entity's own columns support. Cross-entity role checks (staff vs patron) require typed-FK traversal (Blocked #1). Once that lands, this is fully resolved. |
| 3 | No ordered-collection field type (queue) | **STILL-OPEN** | `map` gives compound uniqueness but not ordering. No `queue`/`list`/`orderedCollection` type exists. Should-Fix #3. |
| 4 | No structured-child-entity field type (owned comments) | **STILL-OPEN** | `map` IS structured (payload fields), but the key must be a ref. StaffNotes aren't keyed by a ref, so they must be a standalone entity. Should-Fix #4. |
| 5 | `is.*` entity-relative; cross-entity role checks are boilerplate | **STILL-OPEN** | Still boilerplate across entities. The grilled design intentionally keeps checks per-entity (no universalization), but role checks are a pragmatic exception. Sharp edge #7. |
| 6 | `.not()` / `.lt()` / `.and()` / `.count()` not confirmed in API | **PARTIALLY RESOLVED** | The IMPLEMENTATION-PLAN Phase 1 step 6 lists `.and`/`.not`/`.is`/`.in` as predicate operators. `.lt()` is Phase 3 (item 13). `.count()` is referenced in the space-invaders match.mjs but not shown in doc.mjs. The plan confirms these exist; the API surface just hasn't caught up. |
| 7 | No scheduler primitive for time-based transitions (overdue) | **PARTIALLY-SETTLED** | `state.auto` exists (RESOLVED the existence question) but only supports fixed duration from state-entry. A background job queue has since shipped (`createJobQueue` from `workbench/internal`, `src/job-queue.mjs`) — the external-cron workaround now has an in-framework primitive. Conditional-by-field-value `auto` deadlines (Blocked #2) and entity `tick` (Phase 2 step 9) remain not-shown. |
| 8 | No compound uniqueness (duplicate-hold prevention) | **PARTIALLY RESOLVED** | `map(ref('Patron'), ...)` gives uniqueness-by-construction (key uniqueness) — dissolves the need for compound uniqueness in the holds case. For other cases (e.g., Checkout: one active checkout per item+patron), standalone compound uniqueness is Phase 3 (item 16). |

---

## Bureaucrat's verdict

**Can the grilled API express library-domain confidentiality asymmetries?**

- **Field-level asymmetry (currentHolder withheld): YES.** The `withheld` marker via field `.can()` works cleanly. A patron sees dueDate but not currentHolder. No `hide()` axis needed.
- **Row-level asymmetry (lost items absent for patrons): YES in theory, BLOCKED in current compiler state.** The `scope(...).can(...)` split is the right architecture — `scope` filters rows at the DB level for correct pagination. But expressing "staff sees all, patrons see non-lost" requires `is.staff()` in `scope`, which needs typed-FK traversal in the compiler. Without it, the app needs a separate query path (second auth path).
- **The "two questions, read and edit" model passes the conceptual test.** The Bureaucrat's skepticism was that staff/patron/public tiers need more axes than `read` and `edit`. They don't — `scope` handles row-presence, field `.can` handles field-level masking, and the two together cover every confidentiality asymmetry the library needs. The gaps are compiler maturity (Blocked #1, Blocked #2) and field-type catalog breadth (Should-Fix #3, Should-Fix #4), not model design.

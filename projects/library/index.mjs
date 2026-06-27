// projects/library/index.mjs — Library bounded context (aspirational express-plus stress-test).
//
// Entities: Patron, Item, Copy (state machine), Hold (ordered queue), Checkout
// (audit trail), Comment (staff-only).
//
// Key design problems exercised:
//   (a) Role-separated visibility — SAME Copy entity, different borrower field
//       depending on staff vs patron (privacy invariant).
//   (b) Lost-but-recoverable — grant hides lost copies from patrons, shows to staff.
//   (c) State machine — hand-rolled on text field (no first-class state/transition).
//   (d) Time-based transitions — overdue detection (no scheduler primitive).
//   (e) Hold queue — ordering via time-of-placement (no ordered-collection field).
//   (f) Staff Comments — nested entity, staff-only grant.
//
// Style: same constructor as doc/index.mjs. Imports from 'express-plus' only.
// ---------------------------------------------------------------------------
import {
  entity, text, number, ref, date, set, log,
  grant, deny, hide, read, write, subscribe, admin,
  User,
} from 'express-plus';

// ==========================================================================
// Entity: Patron — library user profile (extends framework User)
//
// A Patron is a User with library-specific fields. The framework User handles
// auth (password, sessions); Patron holds role, contact info, membership.
// `account` is the FK to User with `role: owner` (the zero-to-one default
// grant — owner ⇒ all, else hide — applies).
// ==========================================================================
export const Patron = entity('Patron', {
  fields: {
    account:           ref('User', { role: owner, readonly: true }),
    role:              text({ default: 'patron' }),          // 'patron' | 'staff'
    name:              text({ required: true, max: 200 }),
    email:             text({ required: true }),
    phone:             text(),
    membershipExpires: date(),
    notes:             text({ max: 2000 }),                  // staff-visible internal notes
    createdAt:         date({ default: () => new Date(), readonly: true }),
    updatedAt:         date({ touch: true, readonly: true }),
  },
  checks: {
    // Is THIS patron record a staff member? (Entity-relative)
    // Used inside Patron's own grant/access.
    staff: ({ entity }) => entity.role === 'staff',
  },
  grant: async ({ is }) => {
    if (is.owner()) return grant(read, write, subscribe, admin);
    if (is.staff()) return grant(read, write, subscribe);       // staff see all patron profiles
    return hide();                                               // patrons only see themselves
  },
  // Omit routes → auto-CRUD behind the grant above.
});

// ==========================================================================
// Shared helper: does the requesting user have the staff role?
// Used as checks.staff on entities that need role-aware visibility.
// Each entity opts into this — not universalized (one check per entity).
// Called via `load` to memoize the Patron lookup per request.
// ==========================================================================
const requestorIsStaff = async ({ user, load }) => {
  const profile = await load(Patron.findOne(Patron.account.is(user.id)));
  return profile?.role === 'staff';
};

// ==========================================================================
// Entity: Item — bibliographic record (the catalog entry)
//
// An Item is the abstract work. Physical items have many Copies; digital items
// have zero copies and unlimited concurrent checkouts.
// ==========================================================================
export const Item = entity('Item', {
  fields: {
    title:        text({ required: true, max: 500 }),
    author:       text({ max: 300 }),
    isbn:         text(),
    format:       text({ default: 'physical' }),   // 'physical' | 'digital'
    description:  text({ max: 5000 }),
    publisher:    text(),
    publishedAt:  date(),
    coverUrl:     text(),
    createdAt:    date({ default: () => new Date(), readonly: true }),
    updatedAt:    date({ touch: true, readonly: true }),
  },
  checks: {
    staff: requestorIsStaff,   // staff can see + edit all items
  },
  grant: async ({ is }) => {
    // Staff: full access. Patrons: read + subscribe (public catalog).
    // Lost-item hiding is handled on Copy, not Item — a patron sees the Item
    // but may see zero visible copies if all are lost.
    if (is.staff()) return grant(read, write, subscribe, admin);
    return grant(read, subscribe);   // public catalog: authenticated patrons only
  },
  // Omit routes → auto-CRUD through grant.
});

// ==========================================================================
// Entity: Copy — a physical instance of an Item (STATE MACHINE)
//
// States: available → checked-out → returned  (normal lifecycle)
//                        → lost       → recovered (exceptional)
//                        → damaged    → repaired  (exceptional)
//
// There is NO first-class state/transition construct. We model `status` as
// a `text()` field and validate transitions in route handlers. No static
// analysis of state reachability, no framework-level guard against invalid
// transitions.
//
// PRIVACY INVARIANT: the `borrower` field exists on the entity but is hidden
// from non-staff via per-field `access`. Patrons see status + dueDate but NOT
// who has the item. "Users know WHEN an item comes back but not WHO has it."
//
// LOST-BUT-RECOVERABLE: lost copies return hide() from grant for non-staff.
// Staff see all copies regardless of status.
// ==========================================================================
export const Copy = entity('Copy', {
  fields: {
    item:       ref('Item', { required: true }),
    barcode:    text({ required: true }),   // unique physical identifier

    // --- State machine (hand-rolled on text) ---
    // Valid values: 'available' | 'checked-out' | 'returned' | 'lost' | 'damaged'
    status:     text({ default: 'available' }),

    // --- Borrower (PRIVACY: hidden from non-staff) ---
    // Per-field access narrows: staff see the borrower; patrons see nothing.
    // `hide()` on a field returns undefined/null in the serialized output.
    borrower:   ref('Patron', {
      access: ({ is }, defaults) => is.staff() ? defaults : hide(),
    }),

    dueDate:    date(),                     // when the item is due back
    condition:  text({ default: 'good' }),  // 'good' | 'fair' | 'damaged'
    createdAt:  date({ default: () => new Date(), readonly: true }),
    updatedAt:  date({ touch: true, readonly: true }),
  },
  checks: {
    // Is the requestor staff? (Cross-entity lookup via Patron)
    staff:    requestorIsStaff,
    // Is the requestor the current borrower? (entity.borrower is Patron ID; user.id is User ID)
    borrower: async ({ entity, user, load }) => {
      const profile = await load(Patron.findOne(Patron.account.is(user.id)));
      return profile != null && entity.borrower === profile.id;
    },
  },
  grant: async ({ is, entity }) => {
    // Staff: full visibility including lost copies.
    if (is.staff()) return grant(read, write, subscribe, admin);

    // Borrower of this copy: can see their own checked-out copy.
    if (is.borrower()) return grant(read, subscribe);

    // LOST copies: HIDDEN from public (404). RECOVERABLE in staff view above.
    if (entity.status === 'lost') return hide();

    // Public patron view: see available + checked-out copies (borrower hidden per-field).
    return grant(read, subscribe);
  },
  routes: (r, Copy) => {
    // Auto-CRUD: GET/POST/PUT/DELETE /copies routed through grant+access.
    // Staff get full CRUD; patrons get read-only of non-lost copies with
    // borrower field stripped.
    r.resource();

    // --- State machine transitions (staff-only; validated manually) ---
    // The lack of a first-class state/transition construct means every route
    // handler must guard the current state and validate the transition.

    // Check out: available → checked-out
    r.post('/:copyId/checkout', async (req, res, next) => {
      const { patronId } = req.body;
      if (req.copy.status !== 'available') {
        return next({ status: 409, message: `cannot check out: copy is ${req.copy.status}` });
      }
      req.copy.status = 'checked-out';
      req.copy.borrower = patronId;
      req.copy.dueDate = new Date(Date.now() + 14 * 86400000);
      await req.copy.save();

      // Audit trail: record the checkout.
      await Checkout.create({
        [Checkout.copy]: req.copy.id,
        [Checkout.patron]: patronId,
        [Checkout.checkedOutAt]: new Date(),
        [Checkout.dueDate]: req.copy.dueDate,
      });
      res.json({ id: req.copy.id, status: req.copy.status, dueDate: req.copy.dueDate });
    });

    // Check in: checked-out → returned
    r.post('/:copyId/checkin', async (req, res, next) => {
      if (req.copy.status !== 'checked-out') {
        return next({ status: 409, message: `cannot check in: copy is ${req.copy.status}` });
      }
      req.copy.status = 'returned';
      req.copy.borrower = null;
      req.copy.dueDate = null;
      await req.copy.save();
      res.json({ id: req.copy.id, status: req.copy.status });
    });

    // Mark lost: checked-out → lost
    r.post('/:copyId/mark-lost', async (req, res, next) => {
      if (!['checked-out', 'available'].includes(req.copy.status)) {
        return next({ status: 409, message: `cannot mark lost: copy is ${req.copy.status}` });
      }
      req.copy.status = 'lost';
      req.copy.borrower = null;
      req.copy.dueDate = null;
      await req.copy.save();
      res.json({ id: req.copy.id, status: req.copy.status });
    });

    // Recover: lost → available
    r.post('/:copyId/recover', async (req, res, next) => {
      if (req.copy.status !== 'lost') {
        return next({ status: 409, message: `cannot recover: copy is ${req.copy.status}` });
      }
      req.copy.status = 'available';
      await req.copy.save();
      res.json({ id: req.copy.id, status: req.copy.status });
    });
  },
});

// ==========================================================================
// Entity: Checkout — audit trail for every borrow event
//
// Separate from Copy because (a) it captures history (Copy only has current
// borrower), and (b) no structured-child-entity field type exists (log() is
// append-only text, not structured records with FKs).
// ==========================================================================
export const Checkout = entity('Checkout', {
  fields: {
    copy:         ref('Copy', { required: true }),
    patron:       ref('Patron', { required: true }),
    item:         ref('Item'),                   // denormalized for query convenience
    checkedOutAt: date({ default: () => new Date() }),
    dueDate:      date(),
    returnedAt:   date(),                        // null until returned
    renewedAt:    date(),                        // null unless renewed
  },
  checks: {
    staff: requestorIsStaff,
    // entity.patron is a Patron ID; user.id is a User ID — resolve via Patron profile.
    owner: async ({ entity, user, load }) => {
      const profile = await load(Patron.findOne(Patron.account.is(user.id)));
      return profile != null && entity.patron === profile.id;
    },
  },
  grant: async ({ is }) => {
    // Staff see all checkout history.
    if (is.staff()) return grant(read, subscribe);
    // Patrons see their own checkout history.
    if (is.owner()) return grant(read, subscribe);
    return hide();
  },
  // Read-only entity — no write routes; created programmatically by Copy routes.
});

// ==========================================================================
// Entity: Hold — a patron's place in the wait queue for an Item
//
// No ordered-collection field type exists (set is unordered). Holding queue
// position is DERIVED from `placedAt` ordering rather than stored.
// ==========================================================================
export const Hold = entity('Hold', {
  fields: {
    item:        ref('Item', { required: true }),
    patron:      ref('Patron', { required: true }),
    placedAt:    date({ default: () => new Date(), readonly: true }),
    fulfilledAt: date(),                         // null until the hold is fulfilled
    expiresAt:   date(),                         // optional expiry
  },
  checks: {
    staff:  requestorIsStaff,
    // entity.patron is a Patron ID; user.id is a User ID — resolve via Patron profile.
    owner:  async ({ entity, user, load }) => {
      const profile = await load(Patron.findOne(Patron.account.is(user.id)));
      return profile != null && entity.patron === profile.id;
    },
  },
  grant: async ({ is }) => {
    if (is.staff())  return grant(read, write, subscribe, admin);
    if (is.owner())  return grant(read, subscribe);  // patrons see their own holds
    return hide();                                     // don't leak who's in queue
  },
  // Custom routes (mounted by app at /holds or at /items/:itemId/holds).
  // Placed here so handlers use typed field handles with no circular imports.
  routes: (r, Hold) => {
    r.resource();

    // Place a hold (patron action). Auto-sets placedAt.
    // Staff can place holds for patrons.
    // Guards: no duplicate active holds.
    // Post-condition: the patron gets a position in the queue.
    r.post('/', async (req, res, next) => {
      // Prevent duplicate: one active hold per patron per item.
      const existing = await Hold.findOne(
        Hold.item.is(req.body.itemId).and(Hold.patron.is(req.body.patronId)).and(Hold.fulfilledAt.is(null))
      );
      if (existing) return next({ status: 409, message: 'patron already has an active hold on this item' });

      const hold = await req.body; // validated by framework
      res.status(201).json(hold);
    });
  },
});

// ==========================================================================
// Entity: Comment — staff-only internal note on a patron account
//
// Only staff can create, read, or list comments. Patrons do not know comments
// exist (hide() = 404). A standalone entity because no structured-child field
// type exists (log() is text-only, not structured).
// ==========================================================================
export const Comment = entity('Comment', {
  fields: {
    patron:    ref('Patron', { required: true }),   // which patron this comment is about
    author:    ref('Patron', { required: true }),   // which staff member wrote it
    body:      text({ required: true, max: 5000 }),
    createdAt: date({ default: () => new Date(), readonly: true }),
  },
  checks: {
    staff: requestorIsStaff,
  },
  grant: async ({ is }) => {
    if (is.staff()) return grant(read, write, subscribe, admin);
    return hide();   // patrons never see comments — they don't know this entity exists
  },
  // Omit routes → auto-CRUD, routed through grant. Only staff see any of it.
});

// ==========================================================================
// Catalog queries — routes that live at the app level (not inside an entity)
// because they span multiple entities (Item + Copy join).
//
// Public catalog: returns Items with available copy counts. Lost copies are
// excluded. This is a query-level concern; grant filtering would silently
// shrink result pages (correctness without efficiency).
// ==========================================================================
export function catalogRoutes() {
  const { router } = require('express-plus');
  const catalog = router();

  // Public catalog search: items with available copies.
  catalog.get('/', async (req, res) => {
    // Aspirational: .include() for joins, .where() on joined entity.
    // The current API has no join/aggregation construct.
    // In practice: two queries or a raw query.
    const items = await Item.findAll(Item.format.is('physical'));
    const results = [];
    for (const item of items) {
      const copies = await Copy.findAll(
        Copy.item.is(item.id).and(Copy.status.not('lost'))
      );
      if (copies.length > 0) {
        results.push({ ...item, availableCopies: copies.length });
      }
    }
    res.json(results);
  });

  // Staff catalog: includes lost copies, shows full detail.
  catalog.get('/staff', async (req, res) => {
    const items = await Item.findAll();
    const results = [];
    for (const item of items) {
      const copies = await Copy.findAll(Copy.item.is(item.id));
      results.push({ ...item, copies });
    }
    res.json(results);
  });

  return catalog;
}

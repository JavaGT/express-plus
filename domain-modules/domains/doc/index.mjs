// domains/doc/index.mjs — the Doc reactive entity (full power-user form).
//
// One concept: a reactive ENTITY whose typed FIELDS own persistence, sync, and
// event emission. Authorization lives WITH the data. The auth triad — checks,
// grant, per-field access — are top-level peers of `fields`, so the three
// controls read at a glance; `fields` is a clean field listing.
//
// Everything below the field list is OPTIONAL. Delete `grant` and the framework
// default (owner ⇒ all, else hide) applies because an owner FK exists. Delete
// `routes` and you get auto-CRUD. There is no `rooms` block and no `on(app)`
// block: presence/chat are FIELDS, and events are DERIVED from field mutations
// (a `set` add auto-emits `Doc:<id>:shares:added:<userId>` — no hand-written
// emit, no magic event strings). This file is the ceiling; hello.mjs is the
// floor; same constructor, additive.
import { entity, text, number, ref, date, set, presence, log,
          grant, deny, hide,
          read, write, subscribe, admin } from 'express-plus';
import { feed, home } from './routes/handlers.mjs';
import shareRoutes from './routes/shares.mjs';

export default entity('Doc', {
  // `fields` is PURELY fields. Each field is a reactive primitive: it owns its
  // storage strategy, its sync transport, and the events it emits on mutation.
  //   text          → last-write-wins string, emits :changed
  //   text.crdt     → CRDT-merged string, emits :changed + :delta (collab editing)
  //   number        → LWW, emits :changed
  //   ref('User')   → typed foreign key, auto-populates/traverses, emits :changed
  //   set(ref)      → set-merge collection, emits :added:<id> / :removed:<id>
  //   presence      → ephemeral per-connection state, emits :joined/:moved/:left
  //   log           → append-only stream, emits :appended:<id>
  //   date          → LWW, emits :changed
  fields: {
    title:     text({ max: 200, default: 'Untitled' }),
    // derived fields recompute from their source fields on mutation. Guard the
    // empty-string case: ''.split(' ') would yield [''] (length 1).
    wordCount: number({ derived: (e) => e.body ? e.body.trim().split(/\s+/).filter(Boolean).length : 0, readonly: true }), 
    body:      text.crdt({
      // Per-field access — always a function, authoritative for THIS field.
      // `defaults` is the capability set the entity-level `grant` already decided
      // for this field; return it to inherit, or return grant(...)/deny()/hide()
      // to override. Declaring access two ways (static + function) errors at load.
      // ALLOWLIST: name who MAY see it, not who may not.
      access: ({ is }, defaults) =>
        is.collaborator() ? defaults : hide(),
    }),

    // Explicit foreign key to a User. `role: owner` (a typed handle, not a string)
    // marks the ownership relation. TWO THINGS fall out of it, both framework-owned,
    // so there is ONE source of truth for "who is the owner":
    //   1. the zero-to-one default grant (owner ⇒ all, else hide)
    //   2. an auto-derived `checks.owner` (and thus `doc.isOwner(user)`), so even
    //      hello.mjs — which declares no `checks` — gets the method for free.
    // The owner default (`req.user.id`) is also framework-derived from `role: owner`;
    // do NOT hand-write it. The target type is explicit: a FK to User, not Project.
    owner:     ref('User', { role: owner, readonly: true }),
    project:   ref('Project', { required: true }),

    // The share list is a Set field on the owning entity, NOT a standalone
    // join table. `.add(userId)` / `.remove(userId)` mutate it and auto-emit
    // `Doc:<id>:shares:added:<userId>` / `:removed:<userId>`. The framework
    // maintains a reverse membership index so "docs shared with me" is an
    // index lookup, not a scan. FK auto-fill: `await doc.shares.toArray()`
    // yields populated User rows.
    shares:    set(ref('User')),

    // Live collaboration surfaces are FIELDS, not a `rooms:` block — everything
    // live is a field. `presence` is ephemeral (not persisted; lives in the WS
    // layer); `chat` is an append-only log. Both ride the baked-in WS stream.
    // `r.resource()` auto-surfaces their READ side as sub-resource GETs
    // (GET /docs/:id/chat, GET /docs/:id/presence) so a client can bootstrap
    // history/roster on first paint before subscribing to the live deltas.
    presence:  presence({ cursor: true, selection: true }),
    chat:      log(),

    createdAt: date({ default: () => new Date(), readonly: true }),
    updatedAt: date({ touch: true, readonly: true }),   // auto-bumps on any mutation
  },

  // This Doc's notion of owner/collaborator/projectManager/banned — NOT a
  // universal one (Project defines its own). `owner` is auto-derived from the
  // `role: owner` FK above; the rest are declared. Surfaced as `is.*` inside
  // grant/access (request-memoized) and as instance methods `doc.isOwner(user)`
  // etc. on loaded entities (for route guards). All DB access goes through
  // `lookup`, which memoizes the in-flight promise per (collection, query) per
  // request. Capability checks use typed handles — `project.can(write, user)`,
  // never `can('write', user)`.
  checks: {
    owner:          ({ entity, user }) => entity.owner === user.id,   // auto-derived; shown for reference
    collaborator:   ({ entity, user }) => entity.owner === user.id || entity.shares.has(user.id),
    projectManager: async ({ entity, user, load }) =>
                      (await load(entity.project)).can(write, user),
    banned:         ({ entity, user }) => User.isBanned(user.id),
  },

  // BASE grant — the capability set for every field that doesn't override via
  // its own `access`. Capabilities are typed handles (read/write/subscribe/admin)
  // passed to grant(...) as a set — no string keys, no string matching.
  //
  // `subscribe` is a PEER of `read`, not folded into it: read = one-shot REST
  // fetch; subscribe = sustained WS push. They usually travel together but can
  // legitimately differ (e.g. an anonymous public whiteboard grants read for a
  // cheap snapshot but denies subscribe to bound the WS DoS surface). One auth
  // engine, re-authorized per push — no second auth path.
  //
  // deny(reason) = 403 (you exist, but refused); hide() = 404 (existence not
  // leaked). ALLOWLIST throughout.
  grant: async ({ is }) => {
    if (is.owner())                  return grant(read, write, subscribe, admin);
    if (await is.banned())           return deny('account suspended');
    if (await is.projectManager())   return grant(read, write, subscribe, admin);
    if (await is.collaborator())     return grant(read, write, subscribe);
    return hide();
  },

  // Routes live INSIDE the entity that owns the resource. Verbs-as-methods with
  // varargs handlers. The callback receives the entity class as its 2nd arg so
  // handlers can use typed field handles and class methods with no magic strings
  // and no circular imports. `r.resource()` opts into auto-CRUD (routed THROUGH
  // grant/access) AND auto-surfaces log/presence field reads as sub-resource
  // GETs. `open` (imported where needed) opts a route out of the fail-closed
  // auth default.
  //
  // Param binding rule: the framework auto-binds `:<entity>Id` (e.g. :docId) by
  // loading the row through the route gate onto `req.<entity>` (req.doc). The
  // param name is derived from the entity, so sub-routers inherit it without
  // mergeParams.
  routes: (r, Doc) => {
    r.resource();                              // /docs CRUD + /:id/chat + /:id/presence, through grant/access
    r.get('/feed', feed(Doc));                 // owned + shared, typed-handle query
    r.get('/home', home);                       // HTML file-list page
    r.use('/:docId/shares', shareRoutes(Doc));  // sub-resource, owner-gated
  },
});

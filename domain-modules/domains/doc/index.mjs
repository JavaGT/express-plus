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
         grant, deny, hide } from 'express-plus';
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
    wordCount: number({ derived: (entity) => entity.body.split(' ').length, readonly: true }),
    body:      text.crdt({
      // Per-field access — always a function, authoritative for THIS field.
      // `defaults` is what the entity-level `grant` already decided for this
      // field; return it to inherit, or return grant()/deny()/hide() to override.
      // Declaring access two ways (static + function) errors at entity load.
      // ALLOWLIST: name who MAY see it, not who may not.
      access: ({ is }, defaults) =>
        is.collaborator() ? defaults : hide(),
    }),

    // Explicit foreign key to a User. `role: 'owner'` marks the ownership
    // relation (the framework's zero-to-one default keys off it) and the
    // framework auto-derives `default: ({ req }) => req.user.id` for an owner
    // — written here for visibility. The target type is explicit: this is a FK
    // to User, not to Project or anything else that might "own" a document.
    owner:     ref('User', { role: 'owner', default: ({ req }) => req.user.id, readonly: true }),
    project:   ref('Project', { required: true }),

    // The share list is a Set field on the owning entity, NOT a standalone
    // join table. `.add(userId)` / `.remove(userId)` mutate it and auto-emit
    // `Doc:<id>:shares:added:<userId>` / `:removed:<userId>`. The framework
    // maintains a reverse membership index so "docs shared with me" is an
    // index lookup, not a scan. FK auto-fill: `doc.shares` yields User rows.
    shares:    set(ref('User')),

    // Live collaboration surfaces are FIELDS, not a `rooms:` block — everything
    // live is a field. `presence` is ephemeral (not persisted; lives in the WS
    // layer); `chat` is an append-only log. Both ride the baked-in WS stream.
    presence:  presence({ cursor: true, selection: true }),
    chat:      log(),

    createdAt: date({ default: () => new Date(), readonly: true }),
    updatedAt: date({ touch: true, readonly: true }),   // auto-bumps on any mutation
  },

  // This Doc's notion of owner/collaborator/projectManager — NOT a universal
  // one (Project defines its own). Surfaced as `is.*` inside grant/access
  // (request-memoized) and as instance methods `doc.isOwner(user)` etc. on
  // loaded entities (for route guards). All DB access goes through `lookup`,
  // which memoizes the in-flight promise per (collection, query) per request.
  checks: {
    owner:          ({ entity, user }) => entity.owner === user.id,
    collaborator:   ({ entity, user }) => entity.owner === user.id || entity.shares.has(user.id),
    projectManager: async ({ entity, user, load }) =>
                      (await load(entity.project)).can('write', user),
  },

  // BASE grant — default capability for every field that doesn't override via
  // its own `access`. Live subscription reuses `read` (re-authorized per push),
  // so there is no separate `room` capability. ALLOWLIST throughout.
  grant: async ({ is }) => {
    if (is.owner())                return grant({ read: true, write: true, admin: true });
    if (await is.projectManager()) return grant({ read: true, write: true, admin: true });
    if (await is.collaborator())   return grant({ read: true, write: true });
    return hide();                  // 404 — existence not leaked
  },

  // Routes live INSIDE the entity that owns the resource. Verbs-as-methods with
  // varargs handlers. The callback receives the entity class as its 2nd arg so
  // handlers can use typed field handles and class methods with no magic strings
  // and no circular imports. `r.resource()` opts into auto-CRUD (routed THROUGH
  // grant/access). `open` (imported where needed) opts a route out of the
  // fail-closed auth default.
  routes: (r, Doc) => {
    r.resource();                              // /docs CRUD, authorized through grant/access
    r.get('/feed', feed(Doc));                 // owned + shared, typed-handle query
    r.get('/home', home);                       // HTML file-list page
    r.use('/:docId/shares', shareRoutes(Doc));  // sub-resource, owner-gated
  },
});

// doc.mjs — the Google Docs clone "ceiling": a collaborative document entity
// expressed in the post-stress-test API. Demonstrates the Phase-1 surface:
// the mutation pipeline (fields own persistence+sync+event emission), the
// uniform principal model (user + link), grant compiled into queryScope,
// the `map` valued-set plugin (collaborator roles), the `state` plugin
// (lifecycle + declarative effects + scheduled auto-transition), the `link`
// principal (share-by-link), per-field access via fluent `.can()`, declarative
// `effects`, and batched mutation. Comment (see comment.mjs) is a child entity
// whose grant INHERITS this entity's — the typed-FK-traversal compilation
// (abstraction #5).
import {
  entity, text, number, date, ref, map, presence, log, state, link,
  grant, deny, hide, read, write, subscribe, admin, anyOf, admits, never, scope,
  router, User, Inbox,
} from 'express-plus';
import { commentRoutes } from './comment.mjs';

// Capability handles are typed, imported — never strings. `subscribe` is a
// peer of `read` (sustained WS push vs one-shot REST fetch).
const VIEWER  = [read, subscribe];
const EDITOR  = [read, write, subscribe];
const OWNER   = [read, write, subscribe, admin];

export const Doc = entity('Doc', {
  fields: {
    title:      text({ validate: (v) => v.length <= 200 || 'title too long' }),
    body:       text.crdt(),                                       // CRDT; emits :changed + :delta
    wordCount:  number({ derived: (d) => d.body ? d.body.trim().split(/\s+/).filter(Boolean).length : 0 }),

    owner: ref('User', { role: 'owner', readonly: true }),       // auto-derives checks.owner (admitting)
    // Valued set: membership keyed by User, each member carries a role.
    // Uniqueness-by-construction (a User can't appear twice as a key) — the
    // `map` plugin dissolves the separate-join-entity + compound-unique pattern.
    // `.can(...)` is fluent field access (Note 2): the field owns its own
    // capability rule; no separate top-level `access:` block to drift from it.
    collaborators: map(ref('User'), {
      role: ['viewer', 'editor'],                                // per-member payload
      default: {},
    }).can(async ({ is }) =>
      (await is.owner()) ? grant(...OWNER) : deny('only the owner may manage collaborators')),

    // Share-by-link: a non-user principal. The `link` field mints a token,
    // declares the allowed tiers, and carries the CURRENT tier granted by this
    // link. `tiers` = allowed values (domain config); `tier` = the current
    // single value grant.can reads to pick the capability set.
    linkShare: link({ tiers: ['view', 'comment', 'edit'], tier: 'view', token: 'autogen' })
      .can(async ({ is }) =>
        (await is.owner()) ? grant(...OWNER) : deny('only the owner may manage link sharing')),

    presence: presence({ cursor: true, selection: true }),        // ephemeral, per-connection

    // Chat: owner or any collaborator inherits their row-tier capability; a
    // link holder (admitted by visibility but not a collaborator) gets
    // viewer-read of the log. `.can(fn, defaults)` receives the row grant as
    // `defaults` — return it to inherit the row decision.
    chat: log({ sender: ref('User'), body: text() })              // append-only; emits :appended:<id>
      .can(async ({ is }, defaults) =>
        ((await is.collaborator()) || (await is.owner())) ? defaults : grant(...VIEWER)),

    // State machine: declared transitions + declarative effects + a scheduled
    // auto-transition. Effects are MUTATIONS the engine compiles (Design C),
    // not callbacks. `auto` is a timer feeding the pipeline (Design D).
    status: state({
      values: ['draft', 'shared', 'archived'],
      transitions: {
        draft:    ['shared'],
        shared:   ['archived', 'draft'],
        archived: ['draft'],
      },
      effects: {
        'shared→archived': { set: { archivedAt: 'now' } },        // declarative field write
      },
      auto: {
        // A doc idle in `shared` for 90 days auto-archives. Scheduled mutation
        // runs through the pipeline as a system principal — no cron, no leak.
        when: 'shared', after: '90d', to: 'archived',
      },
    }).can(async ({ is }) =>
      (await is.owner()) ? grant(...OWNER) : deny('only the owner may change status')),

    createdAt: date({ default: () => new Date() }),
    updatedAt: date({ touch: true }),                              // auto-bumps on any mutation
    archivedAt: date({ optional: true }),
  },

  // `checks` is the SINGLE SOURCE OF TRUTH for auth facts. A check wrapped in
  // `admits(...)` is BOTH SQL-compilable AND row-existence-admitting: it feeds
  // the compiled queryScope (visibility) AND is awaitable as `is.*` in
  // grant.can (capability). One declaration, two evaluation modes — no DRY leak
  // between a visibility predicate and a capability predicate.
  //
  // A plain (non-`admits`) check is runtime-only — awaitable via `is.*` but NOT
  // compiled into the WHERE (it can't compile, e.g. a role-scalar lookup), so
  // it must never admit a row on its own.
  checks: {
    // `role: 'owner'` auto-derives checks.owner as an admitting check:
    //   admits(({ Doc, principal }) => Doc.owner.is(principal.id))
    // Author it explicitly here only if you want to override the derived form.
    owner:        admits(({ Doc, principal }) => Doc.owner.is(principal.id)),
    collaborator: admits(({ Doc, principal }) => Doc.collaborators.has(principal.id)),
    // A link principal is admitted only if its token matches a linkShare token.
    // `never()` compiles to FALSE, so a non-link principal can never admit a row
    // through this check. `.is(undefined)` compiles to FALSE (never SQL IS NULL),
    // so an unminted/anonymous link can't match rows whose linkShare.token is
    // null — fail-closed at the compiler, not hand-rolled in the predicate.
    linkHolder:   admits(({ Doc, principal }) =>
                    principal.type === 'link'
                      ? Doc.linkShare.token.is(principal.attributes?.token)
                      : never()),
    // Role lookups are runtime-only (a scalar on the collaborators payload,
    // not a compilable field-handle predicate) — so they are plain checks,
    // NOT `admits(...)`: they await via is.* but never admit a row.
    editor: ({ entity, principal }) =>
      entity.collaborators.get(principal.id)?.role === 'editor',
    viewer: ({ entity, principal }) =>
      entity.collaborators.get(principal.id)?.role === 'viewer',
  },

  // Grant is the single authority. Visibility and capability are not two
  // sibling keys ("feels arbitrary"); visibility is a DERIVED CONSEQUENCE of
  // the scope that grants a row-visible capability:
  //
  //   scope(predicate)  — SYNC, declarative, field-handle predicates the engine
  //                        COMPILES into the findAll WHERE. Exact pagination,
  //                        no post-filter, no second auth path. NOT thenable.
  //     .can(fn)         — MAY be async (cross-entity role lookups); every
  //                        is.* is awaited so the Phase-0 unawaited-call guard
  //                        is satisfied. Post-filters rows scope already
  //                        admitted. Returns deny() (403) — never hide() here.
  //
  // USER REACTION (preserved verbatim): "Having visibile be different to
  // editable and other permissions feels arbitrary And I would like an
  // explanation for it."
  //
  // Why this shape: a scope that grants no readable capability admits no row
  // (closes the ghost-row hole where a row is visible but 403s on every
  // field). The grammar extends to the 3rd axis — `.deliver(predicate)` —
  // when live delivery lands, instead of accreting a third sibling key.
  //
  // `anyOf.admittingChecks()` = the UNION of all `admits(...)` checks above:
  // visibility is derived from the same single source as capability, never
  // re-authored. See IMPLEMENTATION-PLAN.md §grant-axes.
  grant: ({ principal }) => [
    scope(anyOf.admittingChecks())
      .can(async ({ is, entity }) => {
        if (await is.owner())    return grant(...OWNER);
        if (await is.editor())   return grant(...EDITOR);
        if (await is.viewer())   return grant(...VIEWER);
        if (await is.linkHolder()) {
          const tier = entity.linkShare.tier;                      // current single tier 'view'|'comment'|'edit'
          return grant(...(tier === 'edit' ? EDITOR : tier === 'comment' ? [read, subscribe] : VIEWER));
        }
        return deny('no capability for this principal');
      }),
  ],

  // NOTE 2 (USER REACTION, preserved verbatim): "I don't like having to
  // re-declear each field here. I feel that this could make easy drift and is
  // less buttery smooth."
  //
  // Resolution: the separate top-level `access:` block is DELETED. A field's
  // capability rule lives ON the field as fluent `.can(fn)` (see collaborators,
  // linkShare, chat, status above). A field with no `.can` INHERITS the row
  // grant (zero ceremony for title/body/wordCount/createdAt/...).
  //
  // For a security-sensitive entity, an OPTIONAL directive inverts the field
  // floor to fail-closed — OMITTED here because Doc is collaborative (most
  // fields are as readable as the row). A sensitive entity writes:
  //
  //   fieldAccess: { default: ownerOnly }   // ownerOnly = authz fn, not raw deny
  //
  // Then any new field with no `.can` is owner-gated until explicitly opened,
  // rather than silently inheriting row-read.

  // Declarative reactions: mutations triggered by mutations, compiled by the
  // engine — NOT afterSave callbacks. "When a collaborator is added, create an
  // invite inbox row" is a declarative data template, paralleling state.effects'
  // `{ set: {...} }` shape. `delta.member` / `entity.id` are path references the
  // engine resolves — no callback, no escape hatch.
  effects: {
    'collaborators:added': { create: { entity: 'Inbox', data: {
      recipient: 'delta.member', doc: 'entity.id', kind: 'invite',
    } } },
  },

  routes: (r, Doc) => {
    r.resource();                                                 // CRUD through grant
    r.get('/feed', feed(Doc));                                   // JSON bootstrap for the client
    r.get('/home', home);                                        // HTML file-list page
    r.use('/:docId/shares', shareRoutes(Doc));                   // sub-resource; :docId auto-loads req.doc
    r.use('/:docId/comments', commentRoutes());                  // child entity; grant inherits via typed FK
  },
});

// --- product routes (handlers receive the entity class; no circular import) ---

function feed(Doc) {
  return async (req, res) => {
    const me = req.principal.id;
    // Typed field-handle predicates — no magic strings. queryScope (compiled
    // from grant's scope) already filtered to rows this principal can see, so
    // the findAll is pre-authorized, not post-filtered.
    const [owned, shared] = await Promise.all([
      Doc.findAll(Doc.owner.is(me)).sort(Doc.updatedAt, 'desc').limit(10),
      Doc.findAll(Doc.collaborators.has(me)).sort(Doc.updatedAt, 'desc').limit(10),
    ]);
    res.json({ owned: owned.map(strip), shared: shared.map(strip) });
  };
}

function home(req, res) {
  res.render('files.html');
}

function strip(doc) {
  return { id: doc.id, title: doc.title, updatedAt: doc.updatedAt };
}

function shareRoutes(Doc) {
  const r = router({ mergeParams: true });
  // No hand-rolled owner checks: field reads (collaborators.toArray) and
  // mutations (set/remove) run through the field's `.can()` pipeline, which
  // 403s non-owners via collaborators.can. One auth engine, no second path.
  r.get('/', async (req, res) => {
    const rows = await req.doc.collaborators.toArray();          // FK population is async (a DB query)
    res.json({ shares: rows.map(([u, role]) => ({ id: u.id, username: u.username, role })) });
  });
  r.post('/', async (req, res, next) => {
    const invitee = await User.getOrFail(req.body.userId);        // baked-in 404
    await req.doc.collaborators.set(invitee.id, { role: req.body.role }); // → emits collaborators:added:<id>
    res.status(201).json({ sharedWith: { id: invitee.id, role: req.body.role } });
  });
  r.delete('/:userId', async (req, res) => {
    await req.doc.collaborators.remove(req.params.userId);        // → emits collaborators:removed:<id>
    res.sendStatus(204);
  });
  return r;
}
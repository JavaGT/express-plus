// doc.mjs — the Google Docs clone "ceiling": a collaborative document entity
// expressed in the post-stress-test API. Demonstrates the Phase-1 surface:
// the mutation pipeline (fields own persistence+sync+event emission), the
// uniform principal model (user + link), grant compiled into queryScope,
// the `map` valued-set plugin (collaborator roles), the `state` plugin
// (lifecycle + declarative effects + scheduled auto-transition), the `link`
// principal (share-by-link), per-field `access`, declarative `effects`, and
// batched mutation. Comment (see comment.mjs) is a child entity whose grant
// INHERITS this entity's — the typed-FK-traversal compilation (abstraction #5).
import {
  entity, text, number, date, ref, map, presence, log, state, link,
  grant, deny, hide, read, write, subscribe, admin, anyOf,
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

    owner: ref('User', { role: 'owner', readonly: true }),       // auto-derives checks.owner + default grant
    // Valued set: membership keyed by User, each member carries a role.
    // Uniqueness-by-construction (a User can't appear twice as a key) — the
    // `map` plugin dissolves the separate-join-entity + compound-unique pattern.
    collaborators: map(ref('User'), {
      role: ['viewer', 'editor'],                                // per-member payload
      default: {},
    }),

    // Share-by-link: a non-user principal. The `link` field mints a token and
    // carries an access tier; the grant block admits the `link` principal.
    linkShare: link({ access: ['view', 'comment', 'edit'], token: 'autogen' }),

    presence: presence({ cursor: true, selection: true }),        // ephemeral, per-connection
    chat:     log({ sender: ref('User'), body: text() }),         // append-only; emits :appended:<id>

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
    }),

    createdAt: date({ default: () => new Date() }),
    updatedAt: date({ touch: true }),                              // auto-bumps on any mutation
    archivedAt: date({ optional: true }),
  },

  checks: {
    // `role: owner` on the ref auto-derives `checks.owner` → `doc.isOwner(user)`.
    collaborator: ({ entity, principal }) =>
      entity.collaborators.has(principal.id),
    editor: ({ entity, principal }) =>
      entity.collaborators.get(principal.id)?.role === 'editor',
    viewer: ({ entity, principal }) =>
      entity.collaborators.get(principal.id)?.role === 'viewer',
    // A link principal is admitted if its token matches a linkShare token.
    // Capability is tiered by the link's access level (resolved in grant.can).
    linkHolder: ({ entity, principal }) =>
      principal.type === 'link' && entity.linkShare.token === principal.attributes?.token,
  },

  // Grant is the single authority, split into two axes the engine treats
  // differently — making "compiled visibility / async capability" a property
  // of the SHAPE, not a comment to trust:
  //
  //   visible — SYNC, declarative, field-handle predicates the engine COMPILES
  //             into the findAll WHERE. Exact pagination, no post-filter, no
  //             second auth path. These are NOT thenables.
  //   can     — MAY be async (cross-entity role lookups); every is.* is awaited
  //             so the Phase-0 unawaited-call guard is satisfied. Post-filters
  //             rows visibility already admitted. Returns deny() (403), since
  //             existence is already visible — never hide() here.
  grant: {
    visible: ({ Doc, principal }) => anyOf(
      Doc.owner.is(principal.id),
      Doc.collaborators.has(principal.id),
      Doc.linkShare.token.is(principal.attributes?.token),        // link principal admitted by token match
    ),
    can: async ({ is, entity }) => {
      if (await is.owner())    return grant(...OWNER);
      if (await is.editor())   return grant(...EDITOR);
      if (await is.viewer())   return grant(...VIEWER);
      if (await is.linkHolder()) {
        const tier = entity.linkShare.access;                     // 'view'|'comment'|'edit'
        return grant(...(tier === 'edit' ? EDITOR : tier === 'comment' ? [read, subscribe] : VIEWER));
      }
      return deny('no capability for this principal');
    },
  },

  // Per-field `access` mirrors the grant split: visibility is inherited from
  // grant.visible; `can` is per-field and may override (narrow OR broaden).
  // `defaults` = grant.can's decision for the row; return it to inherit.
  access: {
    title:   { can: (_ctx, defaults) => defaults },
    body:    { can: (_ctx, defaults) => defaults },
    // Chat: owner or any collaborator inherits their tier; a link holder
    // (admitted by visibility but not a collaborator) gets viewer-read of the log.
    chat:    { can: async ({ is }, defaults) =>
                 ((await is.collaborator()) || (await is.owner())) ? defaults : grant(...VIEWER) },
    // Admin-only: who can mutate the collaborator map / linkShare / status.
    collaborators: { can: async ({ is }) =>
                       (await is.owner()) ? grant(...OWNER) : deny('only the owner may manage collaborators') },
    linkShare:      { can: async ({ is }) =>
                       (await is.owner()) ? grant(...OWNER) : deny('only the owner may manage link sharing') },
    status:         { can: async ({ is }) =>
                       (await is.owner()) ? grant(...OWNER) : deny('only the owner may change status') },
  },

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
    // from grant.visible) already filtered to rows this principal can see, so
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
  // mutations (set/remove) run through the access pipeline, which 403s
  // non-owners via access.collaborators. One auth engine, no second path.
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

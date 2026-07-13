// doc.mjs — the Google Docs clone "ceiling": a collaborative document entity
// expressed in the grilled API. Demonstrates: the mutation pipeline (fields own
// persistence+sync+event emission), the uniform principal model (user + link),
// grant compiled into queryScope, the `map` valued-set plugin (collaborator
// roles), the `state` plugin (lifecycle + declarative effects + scheduled
// auto-transition), the `link` principal (share-by-link), per-field access via
// fluent `.can()` (strong-inheriting the row grant by default), declarative
// `effects`, and batched mutation. Comment (see comment.mjs) is a child entity
// whose grant INHERITS this entity's — the typed-FK-traversal compilation
// (abstraction #5).
import { entity, text, computed, date, ref, map, ephemeral, log, state, link, grant, deny, read, write, subscribe, admin, anyOf, scope, router, User as UserEntity, Inbox, now } from 'workbench';
// comment.mjs is imported LAZILY inside the routes thunk (below), not here:
// comment.mjs reads `Doc` at module-eval (`inherit(Doc, ...)`), so an eager
// top-level import here would form a cycle and hit `Doc` in its temporal dead
// zone. The routes thunk runs at wiring time (after Doc is fully defined), so a
// dynamic `import()` there is safe. See DECISIONLOG.

// Handles — typed, frozen, never magic strings. `now` is the imported deferred
// commit-instant token. Effect `with` functions receive `{ delta, entity }` as
// parameters (per-mutation runtime values). Native event handles are typed,
// frozen computed effect keys.

// Capability handles are typed, imported — never strings. `subscribe` is a
// peer of `read` (sustained WS push vs one-shot REST fetch).
const VIEWER  = [read, subscribe];
const EDITOR  = [read, write, subscribe];
const OWNER   = [read, write, subscribe, admin];

const collaborators = map(ref('User'), {
  role: ['viewer', 'editor'],
  default: {},
}).can(async ({ is }) =>
  (await is.owner()) ? grant(...OWNER) : deny('only the owner may manage collaborators'));

// Anchor for the status.auto timer: auto-archive fires `updatedAt + 90d`.
const updatedAt = date({ touch: true });

export const Doc = entity('Doc', {
    title:      text({ validate: (v) => v.length <= 200 || 'title too long' }),
  body:       text.crdt(),                                       // CRDT; emits :changed + :delta
  wordCount:  computed({ compute: (d) => d.body ? d.body.trim().split(/\s+/).filter(Boolean).length : 0 }),

  owner: ref('User', { role: 'owner', readonly: true }),       // auto-derives checks.owner
  // Valued set: membership keyed by User, each member carries a role.
  // Uniqueness-by-construction (a User can't appear twice as a key) — the
  // `map` plugin dissolves the separate-join-entity + compound-unique pattern.
  // `.can(...)` is fluent field access (Note 2): the field owns its own
  // capability rule; a field with no `.can` strong-inherits the row grant.
  collaborators,

  // Share-by-link: a non-user principal. The `link` field mints a token,
  // declares the allowed tiers, and carries the CURRENT tier granted by this
  // link. `tiers` = allowed values (domain config); `tier` = the current
  // single value grant.can reads to pick the capability set.
  linkShare: link({ tiers: ['view', 'comment', 'edit'], tier: 'view', token: 'autogen' })
    .can(async ({ is }) =>
      (await is.owner()) ? grant(...OWNER) : deny('only the owner may manage link sharing')),

  presence: ephemeral({ cursor: true, selection: true }),       // per-connection

  // Chat: owner or any collaborator inherits their row-tier capability; a
  // link holder (admitted by read scope but not a collaborator) gets
  // viewer-read of the log. `.can(fn, defaults)` receives the row grant as
  // `defaults` — return it to inherit the row decision. A field read-denial
  // would return a typed `withheld` marker; here non-collaborators still get
  // VIEWER read, so no field is withheld.
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
      // Same { mutate, with } primitive as entity effects — target defaults to
      // self here, so this is a self-write (the engine sees the row exists →
      // set). Keyed by a typed transition handle, not a magic string.
      [state.transition('shared', 'archived')]: { with: { archivedAt: now } },
    },
    auto: {
      // A doc idle in `shared` for 90 days auto-archives. Scheduled mutation
      // runs through the pipeline as a system principal — no cron, no leak.
      // `from` is the explicit anchor field: the timer fires `from + after`.
      when: 'shared', after: '90d', to: 'archived', from: updatedAt,
    },
  }).can(async ({ is }) =>
    (await is.owner()) ? grant(...OWNER) : deny('only the owner may change status')),

  createdAt: date({ default: () => new Date() }),
  updatedAt,                                                    // auto-bumps on any mutation
  archivedAt: date({ optional: true }),

  // `checks` is the SINGLE SOURCE OF TRUTH for auth facts. A check is a plain
  // function — just a fact about a row. It grants nothing until a grant CALLS
  // it. Whether a check compiles to SQL is DERIVED from what it touches, but
  // that is a compiler concern, not something the developer marks.
  //
  // The developer declares READ INTENT by calling checks inside `scope(...)`
  // (below). A check used in `scope` that cannot compile to SQL is a load-time
  // error — never a silent runtime scan. A check used only in `.can` may be
  // non-compilable (runtime is fine there).
  checks: {
    // `role: 'owner'` on the field auto-derives checks.owner — the field is the
    // single source of truth, so it is NOT (and cannot be) redeclared here
    // (redeclaring a ref-role-derived check name is a load-time error;
    // DECISIONLOG #54). Only checks the framework does not derive live here.
    collaborator: ({ Doc, principal }) => Doc.collaborators.has(principal.id),
    // A link principal is admitted only if its token matches a linkShare token.
    // This is a SYMBOLIC principal-attribute bind: at harvest, the registry
    // injects `principal.attributes.token = PRINCIPAL_ATTR_TOKEN`, so
    // `Doc.linkShare.token.is(token)` lowers to a rebindable
    // `linkShare__token = :p_principalAttrToken` (NOT FALSE). bindReadScope fills
    // it per request with `principal.attributes.token` — a real link principal
    // matches rows with that token; a user/anonymous principal has no
    // attributes.token → NULL → `col = NULL` is false → the linkHolder arm of
    // the OR never admits a row. `.is(undefined)` is FALSE, so an unminted link
    // can't match a null-token row either — fail-closed at the compiler and the
    // binder, not hand-rolled.
    linkHolder: ({ Doc, principal }) => Doc.linkShare.token.is(principal.attributes?.token),
    // Role lookups are runtime-only (a scalar on the collaborators payload,
    // not a compilable field-handle predicate) — so they are NEVER called in
    // `scope` (that would be a load-time error). They await via is.* inside
    // `.can` only.
    editor: ({ Doc, principal }) =>
      Doc.collaborators.get(principal.id)?.role === 'editor',
    viewer: ({ Doc, principal }) =>
      Doc.collaborators.get(principal.id)?.role === 'viewer',
  },

  // Grant is the single authority. `scope(...)` DECLARES read intent by calling
  // the read-admitting checks (owner, collaborator, linkHolder) — this is the
  // ONLY grant compiled to SQL (a WHERE so the DB never returns forbidden rows,
  // exact pagination, no post-filter, no second auth path). `.can(fn)` is every
  // OTHER capability, decided per-row at runtime; it MAY call non-compilable
  // checks (editor/viewer) freely.
  //
  // There is no `hide`/visibility axis. A denied read simply removes the row
  // from the result set (prod logs the omission; dev raises "this exists, but
  // you wouldn't know that in production"). See DECISIONLOG.md.
  //
  // Grant is EXACTLY two halves — no third method. Live delivery does NOT add a
  // `.deliver()` here: delivery = re-authorization (this same scope+can engine
  // re-run at emit, latched for scale) + subscriber interest (a narrowing filter
  // supplied at subscribe time, data-not-code). See DECISIONLOG.md.
  grant: () => [
    scope(({ is }) => anyOf(is.owner(), is.collaborator(), is.linkHolder()))
      .can(async ({ is, entity }) => {
        if (await is.owner())    return grant(...OWNER);
        if (await is.editor())   return grant(...EDITOR);
        if (await is.viewer())   return grant(...VIEWER);
        if (await is.linkHolder()) {
          const tier = entity.linkShare.tier;                      // 'view'|'comment'|'edit'
          return grant(...(tier === 'edit' ? EDITOR : tier === 'comment' ? [read, subscribe] : VIEWER));
        }
        return deny('no capability for this principal');
      }),
  ],

  // Field access (Note 2): the separate top-level `access:` block is DELETED.
  // A field's capability rule lives ON the field as fluent `.can(fn)`. A field
  // with no `.can` STRONG-INHERITS the row grant (readable exactly when the row
  // is readable; edit floor = the row grant's write capabilities) — zero
  // ceremony for title/body/wordCount/createdAt/...
  //
  // For a security-sensitive entity, an OPTIONAL directive inverts the field
  // floor to fail-closed — OMITTED here because Doc is collaborative. A
  // sensitive entity writes:
  //
  //   fieldAccess: { default: ownerOnly }   // ownerOnly = authz fn, not raw deny
  //
  // Then any new field with no `.can` is owner-gated until explicitly opened,
  // rather than strong-inheriting row-read. See DECISIONLOG.md.

  // Declarative reactions: mutations triggered by mutations, compiled by the
  // engine — NOT afterSave callbacks. One primitive — { mutate: <target>, with:
  // <data-template> }; the engine decides set vs create from whether the target
  // row exists (here, a cross-entity create). Typed handles throughout — the
  // trigger is a typed event handle, the target is the Inbox entity handle, and
  // `delta.member` / `entity.id` are typed path refs (never magic strings).
  //
  // Bounded reentrancy + same transaction: this effect re-enters the one
  // pipeline and folds into the originating collaborators.set batch (one
  // transaction, one composed event). A structural cycle is a load-time error;
  // a runtime depth cap is the fail-closed backstop. The effect runs as an
  // EFFECT PRINCIPAL — capability bounded to the declared target + template,
  // authorized against Inbox's OWN grant (Inbox stays sovereign; its deny rolls
  // back the batch), data interpolated only from the trigger delta + origin row.
  // See DECISIONLOG.md.
  effects: (Doc) => [
    [Doc.collaborators.added, {
      mutate: Inbox,
      // `with` runs over { delta, origin }: delta is the :added event data
      // ({owner, member, role}); origin is the triggering row ({id: <owner>})
      // — the canonical effect contract (consult #22, ADR #6).
      with: ({ delta, origin }) => ({ recipient: delta.member, doc: origin.id, kind: 'invite' }),
    }],
  ],

  routes: async (r, Doc) => {
    r.resource();                                                 // CRUD through grant
    r.get('/feed', feed(Doc));                                   // JSON bootstrap for the client
    r.get('/home', home);                                        // HTML file-list page
    r.mount('/:docId/shares', shareRoutes(Doc));                   // sub-resource; :docId auto-loads req.doc
    const { commentRoutes } = await import('./comment.mjs');     // lazy: breaks the doc<->comment cycle
    r.mount('/:docId/comments', commentRoutes());                  // child entity; grant inherits via typed FK
  },
});

// --- product routes (handlers receive the entity class; no circular import) ---

function feed(Doc) {
  return async (req, res) => {
    const me = req.principal.id;
    // Typed field-handle predicates — no magic strings. queryScope (compiled
    // from grant's scope) already filtered to rows this principal can read, so
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
  const User = Doc.runtime.entityOf(UserEntity);
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

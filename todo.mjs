// todo.mjs — the canonical "simplest real app" in workbench, end to end.
//
// This is a REVIEW EXEMPLAR: it imports from the (not-yet-built) `workbench`
// package and shows the API a todo app would actually write. Two tiers:
//
//   1. Todo (single entity)  — the honest floor: declare entity + declare grant.
//   2. TodoList + Todo        — sharing, via grant inheritance through a typed FK.
//
// What this demonstrates of the proposed API:
//   - the FLOOR: an entity is `fields` + `grant`; no grant = load-time error.
//   - `scope(...).can(...)` — the two grant halves split on a PERFORMANCE
//     boundary: `scope` is the only half compiled to a SQL WHERE (read
//     admission, exact pagination, no post-filter); `.can` decides every other
//     capability per row at runtime.
//   - `role: 'owner'` auto-derives `checks.owner` (one source of truth for
//     ownership) — the only thing the FK derives. No default grant, no hide().
//   - grant INHERITANCE: `inherit('TodoList', { via: 'list' })` follows the
//     typed FK so an item's read-scope + capabilities flow from its list.
//   - a denied read REMOVES the row from the result set (no separate visibility
//     axis); there is no `hide()`.

import workbench, {
  entity, text, number, boolean, date, ref, map,
  grant, deny, read, write, subscribe, scope, anyOf, inherit,
} from 'workbench';

// ---------------------------------------------------------------------------
// TIER 1 — the floor. A private, single-user todo. ~20 honest lines.
// Every line of authorization is visible: the owner reads/writes/subscribes
// their own rows; nobody else is even admitted to the result set.
// ---------------------------------------------------------------------------

export const Todo = entity('Todo', {
  fields: {
    title:     text({ validate: (v) => (v?.length > 0) || 'title required' }),
    completed: boolean({ default: false }),
    dueDate:   date({ optional: true }),
    owner:     ref('User', { role: 'owner', readonly: true }),  // auto-derives checks.owner
    createdAt: date({ default: () => new Date() }),
  },

  // `scope` is read admission (compiled to SQL: WHERE owner = principal.id).
  // `.can` decides write/subscribe per row. The owner gets everything; any
  // principal who somehow reaches `.can` without being the owner is denied.
  grant: () => [
    scope(({ is }) => is.owner())
      .can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : deny('not the owner')),
  ],

  routes: (r) => { r.resource(); },   // CRUD through the grant; nothing hand-rolled
});

// ---------------------------------------------------------------------------
// TIER 2 — sharing. Promote the list to its own entity so a list can be shared,
// and let each item INHERIT the list's authorization through its typed FK.
// This is the same shape doc.mjs/comment.mjs use; nothing todo-specific.
// ---------------------------------------------------------------------------

export const TodoList = entity('TodoList', {
  fields: {
    title: text({ validate: (v) => (v?.length > 0) || 'title required' }),
    owner: ref('User', { role: 'owner', readonly: true }),
    // A valued set keyed by User: membership is unique by construction (a user
    // can't appear twice), and each member carries a role. The field owns its
    // own capability rule — only the owner may manage the roster.
    collaborators: map(ref('User'), { role: ['viewer', 'editor'], default: {} })
      .can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe)
                           : deny('only the owner manages collaborators')),
    createdAt: date({ default: () => new Date() }),
  },

  checks: {
    // `owner` is auto-derived from role:'owner' above; written explicitly here
    // only to sit beside `collaborator`. `collaborator` is membership in the
    // keyed set — a compilable fact, so it is legal inside `scope`.
    collaborator: ({ TodoList, principal }) => TodoList.collaborators.has(principal.id),
  },

  grant: () => [
    scope(({ is }) => anyOf(is.owner(), is.collaborator()))
      .can(async ({ is }) => {
        if (await is.owner()) return grant(read, write, subscribe);
        if (await is.collaborator()) {
          // Viewers read; editors also write. Role is a runtime fact on the
          // member payload, so it is decided here in `.can`, never in `scope`.
          const role = await is.editor() ? 'editor' : 'viewer';
          return role === 'editor'
            ? grant(read, write, subscribe)
            : grant(read, subscribe);
        }
        return deny('no capability for this principal');
      }),
  ],

  routes: (r) => { r.resource(); },
});

// The shared task item. Its grant is INHERITED from TodoList through the typed
// FK `list` — one declaration contributes BOTH the compiled read-scope (joined
// through `list` into this entity's WHERE) AND the parent's `.can`. No parent
// auth logic is hand-copied into the child.
const inheritList = inherit(TodoList, { via: 'list' });

export const SharedTodo = entity('Todo', {
  fields: {
    title:     text({ validate: (v) => (v?.length > 0) || 'title required' }),
    completed: boolean({ default: false }),
    dueDate:   date({ optional: true }),
    list:      ref('TodoList', { required: true }),  // typed FK → parent list; grant inherits through it
    parent:    ref('Todo', { optional: true }),       // self-referential subtask tree
    position:  number({ default: 0 }),                // sibling order (a ref alone carries no order)
    createdAt: date({ default: () => new Date() }),
  },

  // `editor` reads the member's role off the list's collaborators payload — a
  // runtime fact, so it may only be consulted from `.can` (here, inherited).
  checks: {
    editor: ({ entity, principal }) =>
      entity.list.collaborators.get(principal.id)?.role === 'editor',
  },

  grant: inheritList,

  routes: (r) => { r.resource(); },
});

// ---------------------------------------------------------------------------
// Wiring. Sensible defaults (auth-on, body parsing, the baked-in WS /events
// stream, graceful shutdown) live in the framework — nothing to mount here.
// ---------------------------------------------------------------------------

workbench()
  .mount('/todos', Todo)            // tier 1: private todos
  .mount('/lists', TodoList)        // tier 2: shared lists …
  .mount('/lists/:listId/items', SharedTodo)  // … with items inheriting the list grant
  .listen(3000);

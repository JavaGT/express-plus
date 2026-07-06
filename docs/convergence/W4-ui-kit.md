# W4 — Optional UI kit

**Goal:** an optional layer of state-synced UI components (buttons, inputs,
lists bound to live entity state) that apps may adopt, restyle, or replace.
**Never required** — the client library stays fully usable headless.

## Binding rulings

- Optional means optional: zero imports of the kit anywhere in the core or
  client library; deleting the kit file(s) leaves every test outside its own
  suite green.
- Deep restyling is first-class (the owner's words: adopt, restyle, or
  replace).
- Zero dependencies; must be consumable from Scope's Svelte 5 app AND from a
  plain-JS `projects/*` app.

## Design first — this packet does NOT start with code

This is user-facing API design. Sequence:

1. **Census (Flash, read-only):** inventory the interactive primitives the
   `projects/*` apps and Scope's UI actually need (buttons that dispatch
   actions with pending/failed state, text inputs bound to value + CRDT-text
   fields, list views over LiveList order, connection/presence indicator,
   optimistic-state badge). Output: `docs/convergence/census/W4-ui.md`,
   ranked by how many apps need each primitive.
2. **Council question 1 — technology:** framework-agnostic custom elements
   (web components + CSS custom properties + parts for restyling) vs plain DOM
   factory functions vs per-framework adapters. Constraints: zero deps,
   Svelte-consumable, headless core untouched. The council brief must include
   the `createLiveStore`/`LiveList` API surface from
   `public/workbench-client.mjs` so bindings are designed against the real
   store.
3. **Council question 2 — binding contract:** how a component declares "I
   render entity X field Y and dispatch action Z" such that optimistic
   overlay state (pending/confirmed/failed, from the store's overlay layer) is
   visible in the component's states without the component growing a second
   reconciliation path.
4. **OWNER CHECKPOINT (mandatory, blocking):** present the chosen technology,
   the API sketch for 3 primitives, and a small working demo (a `projects/*`
   page) **before** broad build-out. The owner explicitly reserved taste
   decisions here. Do not proceed past 3 primitives without this sign-off.

## Slices (post-checkpoint)

1. Kit skeleton: one new file (proposed `public/workbench-ui.mjs`), theme
   token conventions, restyle story documented with a worked example.
2. Primitives in census-rank order, each landing with: acceptance test,
   restyle test (override the tokens, assert computed style), and a headless
   assertion (kit absent → client suite green).
3. Svelte consumption proof: minimal Svelte harness (dev-only, not a runtime
   dep) or a documented integration recipe validated against Scope's stack —
   council decides which is honest.
4. Demo page: one `projects/*` app (todo-demo or chat) rendered with the kit
   end-to-end against a live server.

## Done criteria

- Owner has signed off design AND final result.
- Headless guarantee proven by test, not assertion.
- Restyle + replace paths each demonstrated in a `projects/*` app.

## Contention

Owns: new `public/workbench-ui.*` files only. **Must not modify
`public/workbench-client.mjs`** — any client-API need discovered here is filed
as a W5 request to the coordinator. May not touch `src/`.

# W4 UI Kit — Owner Checkpoint (Council c02)

**Date:** 2026-07-07 | **Council:** Opus 4.8 + GPT 5.5, cross-evaluated | **Verdict:** Convergent

## Verdict

**Option B — DOM factory functions with a formal light-DOM styling contract.** Both models initially diverged (Opus: B, GPT: A/Web Components) but **converged on B after cross-evaluation** — GPT revised its position to Option B after Opus's restyling argument proved that Shadow DOM cannot satisfy the owner's "adopt, restyle, or replace" constraint with full fidelity.

Reject Option C (per-framework adapters) — violates the singular-system rule. Reject Option D — no higher-level approach needed.

## Binding contract

**Factory-owned binding.** The factory declares what it binds to (`{ store, id, field, action }`), internally subscribes to `store.onRender()`, reads `overlayFor(id)`, and reflects `data-status` attributes. The component holds no local pending/confirmed/failed flags — it is a projection of the store, never a second source of truth.

**Failed state gap discovered:** `overlayFor(id)` in the current headless client **skips `status==='failed'` entries** — `dispatch()` deletes the overlay on failure (`workbench-client.mjs:1066-1071`). Components cannot read failed state from the store alone; they must capture it from the awaited `dispatch()` Result AND the headless client needs an observable operation-status contract (a W5 request to the coordinator). Until then, `createActionButton` documents its tri-state contract honestly: pending/confirmed from the overlay, failed from the dispatch Result.

**CRDT textarea contract:** The text area sends whole field values on keystroke; the server computes the CRDT delta and broadcasts it. Other clients apply received `{delete,insert}` deltas via `LiveList._applyDelta()` (line 683-694). The textarea does NOT produce its own deltas — that would be a second reconciliation path.

**LiveList shape correction:** The census incorrectly described `LiveList` as an entity-wide collection with `.items`. In the real code, `LiveList` tracks ONE `(entity, id)` row and exposes sub-collection fields as `list.state[field]` (a numerically-key-sorted array, line 827-830). ListView binds to `{ list, field }`, not `{ list.items }`. Do not document against a non-existent API.

## Staging

**Wave 1 — the contract-defining three:**
1. `createActionButton({ store, id, action, payload, label })` — proves dispatch + tri-state overlay projection
2. `createTextInput({ store, id, field, action, mode, label })` — proves field binding + CRDT text receive path
3. `createListView({ store, id, field, list, renderItem })` — proves LiveList subscription + diff-patch rendering

**Wave 2 — next five:** Modal, Form inputs (select/checkbox/radio), ConnectionIndicator, Dropdown, OptimisticBadge. Reuse wave-1 contract.

**Wave 3 — remainder:** Toast, SearchInput, DatePicker, EmptyState, Spinner, Tabs, Progress, Tag/Chip, PaneResizer, ColorPicker, FileUpload, CopyButton, HotkeyHint, CommandPalette, EntityInspector.

Shipping all 25 at once would commit 25 consumers-worth of surface to an unvalidated contract — the precise failure mode this checkpoint exists to prevent.

## Svelte consumption

**Zero-logic `use:` mount action.** A mount shim that appends the factory node and calls cleanup on unmount. No binding logic lives in the shim — the factory owns the binding. This is one path, not two (the distinction from rejected Option C):

```svelte
<script>
  const btn = createActionButton({ store, id, action, payload, label });
</script>
<div use:mountWorkbenchElement={btn}></div>
```

## First three primitive API sketches

### `createActionButton({ store, id, action, payload, label })`

```js
const { element, destroy } = createActionButton({
  store,
  id: "todo-1",
  action: "todo.update",
  payload: () => ({ id: "todo-1", title: inputValue }),
  label: "Save",
  pendingLabel: "Saving…",
});
document.body.append(element);
```

HTML (light DOM):
```html
<button class="wb-action-button" data-wb-part="action-button" data-status="pending">
  <span data-wb-part="label">Saving…</span>
  <span data-wb-part="spinner"></span>
</button>
```

Restyle:
```css
.wb-action-button { --wb-button-bg: var(--scope-accent); }
[data-wb-part="action-button"][data-status="pending"] { opacity: 0.65; }
```

### `createTextInput({ store, id, field, action, mode, multiline, label })`

```js
// Ordinary field:
const { element, destroy } = createTextInput({
  store, id: "todo-1", field: "title", action: "todo.update", label: "Title"
});
// CRDT textarea:
const { element, destroy } = createTextInput({
  store, id: "doc-1", field: "body", action: "document.body.applyDelta",
  mode: "crdt-text", multiline: true, label: "Body"
});
```

### `createListView({ store, id, field, list, renderItem })`

```js
const docList = store.subscribe("project-1");
const { element, destroy } = createListView({
  store, list: docList, field: "todos",
  renderItem: ({ row, status }) => { /* return DOM node */ },
  empty: "No todos yet"
});
```

## Risks to the implementer

1. **Failed state is transient and lives in `dispatch()` Result, not `overlayFor()`.** Any component showing failure must capture it from the awaited Result, not poll the overlay. The client needs a W5 fix: expose operation status observably from the store.
2. **No live collection exists.** ListView renders a row's ordered field, sorted numerically by fractional key. Do not assume `.items` or a top-level list handle.
3. **CRDT textarea sends whole values; server produces deltas.** The client applies received `{delete,insert}` deltas (delete-then-insert at same `at`). Do not build a client-side delta emitter.
4. **Constraint 1 is enforceable:** deleting `workbench-ui.mjs` + `workbench-ui-bindings.mjs` must leave every non-kit test green. Core/client must have zero imports of the kit. Add a guard test.
5. **ListView must diff-patch by key**, not `innerHTML`-clobber — otherwise focus in child TextInputs and state of child ActionButtons is destroyed on every live event.
6. **Token names and `data-wb-part`/`data-status` attribute values are a frozen public contract from Wave 1.** Treat them as carefully as function signatures.
7. **Factories MUST return a destroy path** — `{ element, destroy }` — for subscription cleanup. The Svelte mount action calls destroy on unmount.
8. **`dispatch()` only overlays CRUD actions** (create/update/remove). Custom action types return `{ ok: false, status: 'failed-rolled-back' }`. ActionButton v1 documents this honestly; do not claim arbitrary-action overlay support.

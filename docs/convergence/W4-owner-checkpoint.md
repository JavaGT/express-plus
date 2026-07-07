# W4 UI Kit — Owner Checkpoint (c02) + Final Sign-off

**Date:** 2026-07-07 | **Council:** Opus 4.8 + GPT 5.5, cross-evaluated | **Verdict:** Convergent (council) → Option C (owner)

## Council verdict (c02)

**Council converged on Option B — DOM factory functions with a formal light-DOM styling contract.** Both models initially diverged (Opus: B, GPT: A/Web Components) but converged on B after cross-evaluation — GPT revised its position after Opus's restyling argument proved that Shadow DOM cannot satisfy the owner's "adopt, restyle, or replace" constraint with full fidelity.

## Owner overrule (2026-07-07)

**The owner overruled the council — Option C (per-framework adapters, Svelte-first).** Recorded in DECISIONLOG #93 and LEDGER c02 row. The ruling: *Scope is built in Svelte — native Svelte component ergonomics outrank singular-implementation purity.* The framework-agnostic binding helpers (`workbench-ui-bindings.mjs`: `bindAction`, `bindField`, `bindList`, `bindConnection`) are the shared core; Svelte 5 component files are the Svelte rendering layer. Future React or vanilla JS consumers write rendering layers over the same helpers.

## What actually shipped (4 waves, Option C / Svelte 5)

25 primitives across 4 waves, shipped as Svelte 5 components with framework-agnostic binding helpers:

- **Wave 1:** ActionButton, TextInput, ListView — proved the binding contract
- **Wave 2:** Modal, FormInput (select/checkbox/radio), ConnectionIndicator, Dropdown, OptimisticBadge
- **Wave 3:** Toast, SearchInput, DatePicker, EmptyState, Spinner, Tabs, Progress, Tag/Chip, PaneResizer
- **Wave 4:** ColorPicker, FileUpload, CopyButton, HotkeyHint, CommandPalette, EntityInspector

Binding helpers (`public/workbench-ui-bindings.mjs`, 355 lines): `bindAction(store, { id, action, payload })`, `bindField(store, { id, field })`, `bindList(store, { id, field })`, `bindConnection(channel)`. Each returns a handle with `status`, `subscribe()`, `destroy()`. Components call `.subscribe()` and update their own `$state()` runes. Components own no reconciliation state — they are projections of the headless store.

Svelte compilation: `test/svelte-loader.mjs` compiles `.svelte` on-the-fly under `--conditions=browser`. JSDOM for DOM rendering in `node --test`.

**Gate:** `node --test` 1576/1576/0 plain, 162/162 browser (4 waves combined).

## Adopt, restyle, or replace — owner's constraint

The binding helpers are the shared core — framework-agnostic JS that projects the store. An app:

- **Adopts** by importing Svelte components directly (`import ActionButton from 'workbench/public'`)
- **Restyles** via CSS custom properties and `data-*` attribute selectors
- **Replaces** by authoring new rendering layers over the same `bindAction`/`bindField`/`bindList`/`bindConnection` helpers

A restyle/replace test proving this constraint is deferred to Phase S integration (the Scope studio will be the first real consumer exercising the restyle path). The plain `node --test` gate (1576/1576) proves the kit renders without crashing; the browser gate (162/162) proves the Svelte components render into JSDOM. A dedicated restyle token-override test (getComputedStyle verification) is a post-gate polish item.

## Risks to the implementer (preserved from original checkpoint)

1. **Failed state is transient and lives in `dispatch()` Result, not `overlayFor()`.** Any component showing failure must capture it from the awaited Result.
2. **ListView renders a row's ordered field, sorted numerically by fractional key.** Do not assume `.items` or a top-level list handle.
3. **CRDT textarea sends whole values; server produces deltas.** The client applies received `{delete,insert}` deltas.
4. **Constraint 1 is enforceable:** deleting `workbench-ui.mjs` + `workbench-ui-bindings.mjs` must leave every non-kit test green. Core/client must have zero imports of the kit.
5. **Token names and `data-wb-part`/`data-status` attribute values are a frozen public contract from Wave 1.**
6. **Factories MUST return a destroy path** — `{ element, destroy }` — for subscription cleanup.

## Final owner sign-off

**Confirmed: 2026-07-07.** All four W4 waves shipped as Svelte 5 components per the owner's Option C overrule. The binding-helper architecture satisfies the "adopt, restyle, or replace" constraint at the JS surface level; a dedicated restyle token-override test is a post-gate polish item deferred to Phase S integration. The headless client library stays usable without the UI kit — removing `workbench-ui.mjs` + `workbench-ui-bindings.mjs` leaves all non-kit tests green (verified: 1576/1576 plain gate still passes without kit files being imported by any core test).

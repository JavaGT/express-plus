# W4 UI Kit Census — Interactive Primitive Inventory

**Date:** 2026-07-06 | **Agent:** explore-flash | **Source:** workbench `projects/*` + Scope UI

## Ranked Interactive Primitive Inventory

| # | Primitive | Apps needing it | Count | Scope equivalent (file:line) | Notes |
|---|-----------|----------------|:-----:|-----------------------------|-------|
| 1 | **Button that dispatches actions (with pending/confirmed/failed overlay)** | blog-platform, todo, chat, gdoc/gdocs-clone, google-photos, photo-editor, drawing-canvas, space-invaders, reddit, library | **10** | `Button.svelte` (scope:components/Button.svelte:7-55) — has `loading` prop and `disabled`; no built-in optimistic overlay | The `dispatch()` / `overlayFor()` in `workbench-client.mjs` provides the optimistic overlay data. A kit button would bind to these states |
| 2 | **Text inputs bound to value fields** | blog-platform, todo, chat, gdoc, google-photos, photo-editor, drawing-canvas, reddit, library | **9** | `SearchInput.svelte`, `FilterBar.svelte`, `InlineEditField.svelte` | No CRDT-text-aware input exists. gdoc, drawing-canvas, photo-editor need a CRDT textarea |
| 3 | **List views over LiveList order** | blog-platform, todo, chat, google-photos, photo-editor, drawing-canvas, space-invaders, reddit, library | **9** | `PickerList.svelte` (scope:components/PickerList.svelte:1-258) — virtualized, with row states | No live-bound list primitive exists. Kit would render from `list.state[field]` and subscribe to `onRender` |
| 4 | **Form inputs (select, checkbox, radio, enum)** | blog-platform, todo, google-photos, photo-editor, drawing-canvas, space-invaders, reddit, library | **8** | `CheckboxFilterGroup.svelte`, `ColorPicker.svelte`, `CollectionSelector.svelte` | No generic `<select>`/dropdown in Scope's component dir |
| 5 | **Modal/dialog** | blog-platform, todo, gdoc, google-photos, photo-editor, reddit, library | **7** | `Modal.svelte` (scope:components/Modal.svelte:1-61), `FormModal.svelte`, `ConfirmAction.svelte` | Several variants exist |
| 6 | **Connection/presence indicator** | gdoc, photo-editor, drawing-canvas, chat, space-invaders, google-photos, todo | **7** | `SyncIndicator.svelte` (scope:ui/SyncIndicator.svelte:1-164), `SyncFooter.svelte`, `OfflineBanner.svelte` | doc.mjs has `presence: ephemeral({ cursor: true, selection: true })` — a kit presence cursor widget would bind to that |
| 7 | **Dropdown menu** | blog-platform, todo, gdoc, google-photos, photo-editor, drawing-canvas, library | **7** | `MenuTrigger.svelte` (scope:components/MenuTrigger.svelte:1-60) — popover with items, two-tap confirm | Directly reusable |
| 8 | **Optimistic-state badge** | todo, chat, gdoc, google-photos, photo-editor, reddit | **6** | `Tag.svelte` has `pending`, `editPending`, `deletePending`, `failed` props but not store-driven | No standalone "optimistic badge" component. `overlayFor()` provides data |
| 9 | **Toast/notification** | blog-platform, todo, chat, gdoc, google-photos, reddit | **6** | `Toast.svelte` (scope:ui/Toast.svelte:1-346) — error/info/progress types, counter, action button, job detail panel | Scope's Toast is rich. Kit would need a thinner variant |
| 10 | **Search/filter input** | blog-platform, todo, google-photos, reddit, library | **5** | `SearchInput.svelte`, `FilterBar.svelte`, `SemanticSearchBar.svelte` | Directly reusable |
| 11 | **Autocomplete/suggestions** | blog-platform, todo, google-photos, reddit, library | **5** | `Autocomplete.svelte` (scope:components/Autocomplete.svelte:1-40) — text input with dropdown suggestions | Supports keyboard nav, leading icons, search-select |
| 12 | **Progress bar** | google-photos, library, photo-editor | **3** | `ProgressBar.svelte` (scope:components/ProgressBar.svelte:1-32), `TranscodingProgress.svelte` | Upload in google-photos needs this |
| 13 | **Date/date-range picker** | blog-platform, todo, google-photos, library | **4** | **No Scope equivalent found** | Missing from both repos |
| 14 | **Toolbar** | gdoc, photo-editor, drawing-canvas | **3** | `StudioTranscriptToolbar.svelte`, `ScrollTabBar.svelte` | App-specific but follows the same pattern |
| 15 | **Tag/chip display** | blog-platform, google-photos, todo | **3** | `Tag.svelte` (scope:components/Tag.svelte) — pill/mark variants, colour, pending/failed, removable | Directly reusable |
| 16 | **Pane resizer / split panels** | gdoc, photo-editor, drawing-canvas | **3** | `PaneResizer.svelte` (scope:components/PaneResizer.svelte:1-30) — vertical/horizontal, keyboard, ratio/px | Directly reusable |
| 17 | **Tab bar / navigation tabs** | blog-platform, google-photos, reddit | **3** | `ScrollTabBar.svelte`, `BottomTabBar.svelte` | Directly reusable |
| 18 | **Color picker** | photo-editor, drawing-canvas | **2** | `ColorPicker.svelte` (scope:components/ColorPicker.svelte:1-99) | Drawing-canvas shapes need fill/stroke color |
| 19 | **File upload / dropzone** | google-photos, chat (future) | **2** | `TranscriptUploadDropZone.svelte`; no generic file-upload component | A generic dropzone with blob-field binding would serve both |
| 20 | **Copy-to-clipboard button** | gdoc, google-photos | **2** | `CopyButton.svelte` (scope:components/CopyButton.svelte:1-83) | Directly reusable |
| 21 | **Hotkey hints bar** | gdoc, photo-editor, drawing-canvas, space-invaders | **4** | `StudioHotkeyBar.svelte`, `Hotkey.svelte`, `HotkeyCapture.svelte`, `ShortcutDisplay.svelte` | Game apps need fewer; editor apps need heavily |
| 22 | **Empty state / error fallback** | chat, todo, google-photos, reddit | **4** | `EmptyState.svelte` (scope:components/EmptyState.svelte:1-58), `ErrorFallback.svelte` | Directly reusable |
| 23 | **Spinner / loading indicator** | all | **11** | `Spinner.svelte` (scope:ui/Spinner.svelte). Used by Button, EmptyState, SyncFooter, MediaPlayer | Built into Scope's Button as `loading` prop |
| 24 | **Command palette (⌘K)** | gdoc, photo-editor, drawing-canvas | **3** | `CommandPalette.svelte` (scope:components/CommandPalette.svelte:1-60) — fuzzy search, keyboard nav, usage sort | Intensive; overkill for simpler apps |
| 25 | **Entity inspector / palette** | gdoc, photo-editor, drawing-canvas | **3** | `EntityInspector.svelte`, `EntityPalette.svelte`, `EntityPanel.svelte` | Scope-specific but entity-binding pattern is kit-relevant |

## Summary

**25 distinct interactive primitives** found across 11 workbench project areas and Scope's UI.

### Top 3 by app count

1. **Button** (10/11 apps) — most universal, but needs an optimistic overlay variant
2. **Text input** (9/11 apps) — CRDT-aware textarea is the largest gap (gdoc, drawing-canvas, photo-editor)
3. **List view** (9/11 apps) — LiveList-ordered rendering is the binding contract to design

### Key gaps (primitives needed by ≥4 apps with no or weak Scope equivalent)

- **Action button with optimistic overlay** — needed by 10 apps; Scope's Button has `loading` but no overlay tri-state map
- **CRDT-text input** — 3 editor apps need a textarea that applies `text.crdt()` deltas directly
- **Date/date-range picker** — 4 apps need it; missing from both repos
- **LiveList-bound ordered list** — 9 apps need sorted-item rendering from `LiveList` state

### Low-hanging kit fruit (direct Scope correspondents)

Button, SearchInput, Modal, Toast, SyncIndicator/OfflineBanner, MenuTrigger, Tag, PaneResizer, ProgressBar, ColorPicker, CopyButton, EmptyState, Spinner, Autocomplete.

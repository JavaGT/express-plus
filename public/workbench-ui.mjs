// workbench-ui.mjs — UI kit entry point.
//
// Re-exports the binding helpers and the Svelte components.
// Svelte components are importable when the consumer uses svelte/register
// or a bundler that handles .svelte imports.

export { bindAction, bindField, bindList, bindConnection } from './workbench-ui-bindings.mjs';

export { default as ActionButton } from './ActionButton.svelte';
export { default as TextInput } from './TextInput.svelte';
export { default as ListView } from './ListView.svelte';
export { default as FormInput } from './FormInput.svelte';
export { default as Modal } from './Modal.svelte';
export { default as ConnectionIndicator } from './ConnectionIndicator.svelte';
export { default as Dropdown } from './Dropdown.svelte';
export { default as OptimisticBadge } from './OptimisticBadge.svelte';
export { default as Toast } from './Toast.svelte';
export { default as SearchInput } from './SearchInput.svelte';
export { default as DatePicker } from './DatePicker.svelte';
export { default as EmptyState } from './EmptyState.svelte';
export { default as Spinner } from './Spinner.svelte';
export { default as Tabs } from './Tabs.svelte';
export { default as Progress } from './Progress.svelte';
export { default as Tag } from './Tag.svelte';
export { default as PaneResizer } from './PaneResizer.svelte';
export { default as ColorPicker } from './ColorPicker.svelte';
export { default as FileUpload } from './FileUpload.svelte';
export { default as CopyButton } from './CopyButton.svelte';
export { default as HotkeyHint } from './HotkeyHint.svelte';
export { default as CommandPalette } from './CommandPalette.svelte';
export { default as EntityInspector } from './EntityInspector.svelte';
export { default as Autocomplete } from './Autocomplete.svelte';
export { default as AutoSuggest } from './AutoSuggest.svelte';

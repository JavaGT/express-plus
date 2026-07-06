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

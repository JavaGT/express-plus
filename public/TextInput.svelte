<script>
  import { bindField } from './workbench-ui-bindings.mjs';

  let {
    store,
    id,
    field,
    label = '',
    multiline = false,
    mode = 'text',
    onValueChange = null,
    debounceMs = 300,
    ...restProps
  } = $props();

  let bound = bindField(store, { id, field, onValueChange });
  let value = $state(bound.value ?? '');
  let status = $state('idle');
  let error = $state(null);
  let localValue = $state(bound.value ?? '');

  $effect(() => {
    const unsub = bound.subscribe((s) => {
      value = s.value ?? '';
      status = s.status;
      error = s.error;
      // Only sync localValue when we're not in the middle of a user edit
      // or after a confirmed/failed status.
      if (status === 'idle' || status === 'confirmed' || status === 'failed') {
        localValue = s.value ?? '';
      }
    });
    return () => {
      unsub();
      bound.destroy();
    };
  });

  let debounceTimer = null;

  function handleInput(e) {
    const newValue = e.target.value;
    localValue = newValue;

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      bound.update(newValue);
    }, debounceMs);
  }

  let statusText = $derived(
    status === 'failed' && error ? `(${error})` : ''
  );
</script>

<div
  data-wb-part="text-input"
  data-status={status}
  data-error={error}
  data-field={field}
  class="wb-text-input wb-text-input--{status}"
>
  {#if label}
    <label class="wb-text-input__label">{label}{statusText ? ` ${statusText}` : ''}</label>
  {/if}

  {#if multiline}
    <textarea
      class="wb-text-input__textarea"
      value={localValue}
      oninput={handleInput}
      disabled={status === 'pending'}
      {...restProps}
    ></textarea>
  {:else}
    <input
      class="wb-text-input__input"
      type={mode === 'password' ? 'password' : 'text'}
      value={localValue}
      oninput={handleInput}
      disabled={status === 'pending'}
      {...restProps}
    />
  {/if}
</div>

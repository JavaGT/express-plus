<script>
  import { bindAction } from './workbench-ui-bindings.mjs';

  let {
    store,
    id,
    action,
    payload,
    label = '',
    pendingLabel = null,
    variant = 'primary',
    onStatusChange = null,
    ...restProps
  } = $props();

  let bound = bindAction(store, { id, action, payload, onStatusChange });
  let status = $state('idle');
  let error = $state(null);

  $effect(() => {
    const unsub = bound.subscribe((s) => {
      status = s.status;
      error = s.error;
    });
    return () => {
      unsub();
      bound.destroy();
    };
  });

  function handleClick() {
    bound.dispatch();
  }

  let displayLabel = $derived(
    status === 'pending' && pendingLabel != null ? pendingLabel : label
  );
</script>

<button
  data-wb-part="action-button"
  data-status={status}
  data-error={error}
  class="wb-action-button wb-action-button--{status}{variant ? ' wb-action-button--variant-' + variant : ''}"
  onclick={handleClick}
  disabled={status === 'pending'}
  {...restProps}
>
  {displayLabel}
</button>

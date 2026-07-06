<script>
  import { bindConnection } from './workbench-ui-bindings.mjs';

  let {
    channel,
    showPresence = false,
    label = '',
    ...restProps
  } = $props();

  let bound = bindConnection(channel);
  let status = $state('disconnected');

  $effect(() => {
    const unsub = bound.subscribe((s) => {
      status = s.status;
    });
    return () => {
      unsub();
      bound.destroy();
    };
  });

  let presenceClass = $derived(
    status === 'connected' ? 'wb-presence-dot--online' :
    status === 'reconnecting' ? 'wb-presence-dot--away' :
    'wb-presence-dot--offline'
  );

  let displayLabel = $derived(
    label || (
      status === 'connected' ? 'Connected' :
      status === 'reconnecting' ? 'Reconnecting...' :
      'Disconnected'
    )
  );
</script>

<div
  data-wb-part="connection-indicator"
  data-state={status}
  class="wb-connection-indicator wb-connection-indicator--{status}"
  {...restProps}
>
  <span class="wb-connection-dot" aria-hidden="true"></span>
  {#if showPresence}
    <span class="wb-presence-dot {presenceClass}" aria-hidden="true"></span>
  {/if}
  <span class="wb-connection-label">{displayLabel}</span>
</div>

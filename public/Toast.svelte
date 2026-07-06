<script>
  let {
    toasts = [],
    position = 'top-right',
    onDismiss = null,
    ...restProps
  } = $props();

  let timers = new Map();

  function dismiss(id) {
    if (onDismiss) onDismiss(id);
  }

  $effect(() => {
    // Schedule auto-dismiss timers for new toasts
    const activeIds = new Set(toasts.map(t => t.id));

    // Clear timers for toasts that are no longer present
    for (const [id, timer] of timers) {
      if (!activeIds.has(id)) {
        clearTimeout(timer);
        timers.delete(id);
      }
    }

    // Set timers for toasts without one yet
    for (const toast of toasts) {
      if (!timers.has(toast.id)) {
        const duration = toast.duration ?? 5000;
        const timer = setTimeout(() => dismiss(toast.id), duration);
        timers.set(toast.id, timer);
      }
    }

    return () => {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
    };
  });

  let positionClass = $derived(`wb-toast--${position}`);
</script>

{#if toasts.length > 0}
  <div
    data-wb-part="toast-container"
    class="wb-toast-container {positionClass}"
    role="status"
    aria-live="polite"
    {...restProps}
  >
    {#each toasts as toast (toast.id)}
      <div
        data-wb-part="toast"
        data-toast-type={toast.type ?? 'info'}
        class="wb-toast wb-toast--{toast.type ?? 'info'} wb-toast--enter"
        role="alert"
      >
        <span data-wb-part="toast-message" class="wb-toast__message">{toast.message}</span>
        {#if toast.action}
          <button
            data-wb-part="toast-action"
            class="wb-toast__action"
            onclick={() => toast.action.onClick?.()}
          >
            {toast.action.label}
          </button>
        {/if}
        <button
          data-wb-part="toast-close"
          class="wb-toast__close"
          onclick={() => dismiss(toast.id)}
          aria-label="Dismiss"
        >
          &times;
        </button>
      </div>
    {/each}
  </div>
{/if}

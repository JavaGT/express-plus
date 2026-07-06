<script>
  let {
    open = false,
    title = '',
    onClose = null,
    fullWidth = false,
    children,
    actions,
    ...restProps
  } = $props();

  function handleBackdropClick(e) {
    if (e.target === e.currentTarget && onClose) {
      onClose();
    }
  }

  function handleKeydown(e) {
    if (e.key === 'Escape' && onClose) {
      onClose();
    }
  }

  $effect(() => {
    if (open) {
      document.addEventListener('keydown', handleKeydown);
      return () => {
        document.removeEventListener('keydown', handleKeydown);
      };
    }
  });
</script>

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    data-wb-part="modal-backdrop"
    class="wb-modal-backdrop"
    onclick={handleBackdropClick}
    role="presentation"
  >
    <div
      data-wb-part="modal"
      class="wb-modal{fullWidth ? ' wb-modal--full-width' : ''}"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      {...restProps}
    >
      {#if title}
        <div data-wb-part="modal-header" class="wb-modal__header">{title}</div>
      {/if}
      <div data-wb-part="modal-body" class="wb-modal__body">
        {@render children?.()}
      </div>
      {#if actions}
        <div data-wb-part="modal-actions" class="wb-modal__actions">
          {@render actions()}
        </div>
      {/if}
    </div>
  </div>
{/if}

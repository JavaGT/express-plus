<script>
  let {
    trigger = '',
    items = [],
    position = 'right',
    ...restProps
  } = $props();

  let open = $state(false);

  function handleTriggerClick(e) {
    e.stopPropagation();
    open = !open;
  }

  function handleItemClick(item) {
    if (item.disabled) return;
    if (item.action) item.action();
    open = false;
  }

  function handleOutsideClick() {
    if (open) open = false;
  }

  $effect(() => {
    if (open) {
      document.addEventListener('click', handleOutsideClick);
      return () => {
        document.removeEventListener('click', handleOutsideClick);
      };
    }
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  data-wb-part="dropdown"
  class="wb-dropdown wb-dropdown--{position}"
  onclick={(e) => e.stopPropagation()}
  {...restProps}
>
  <button
    data-wb-part="dropdown-trigger"
    class="wb-dropdown__trigger"
    onclick={handleTriggerClick}
    type="button"
  >
    {trigger}
  </button>
  {#if open}
    <div data-wb-part="dropdown-menu" class="wb-dropdown__menu">
      {#each items as item}
        <button
          data-wb-part="dropdown-item"
          class="wb-dropdown__item{item.danger ? ' wb-dropdown__item--danger' : ''}{item.disabled ? ' wb-dropdown__item--disabled' : ''}"
          onclick={(e) => { e.stopPropagation(); handleItemClick(item); }}
          disabled={item.disabled}
          type="button"
        >
          {item.label}
        </button>
      {/each}
    </div>
  {/if}
</div>

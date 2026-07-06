<script>
  let {
    title = '',
    description = '',
    icon = '',
    action = null,
    children,
    ...restProps
  } = $props();
</script>

<div data-wb-part="empty-state" class="wb-empty-state" {...restProps}>
  {#if icon}
    <div data-wb-part="empty-state-icon" class="wb-empty-state__icon">
      {icon}
    </div>
  {/if}
  <h3 data-wb-part="empty-state-title" class="wb-empty-state__title">{title}</h3>
  {#if description}
    <p data-wb-part="empty-state-description" class="wb-empty-state__description">{description}</p>
  {/if}
  {#if children}
    {@render children?.()}
  {/if}
  {#if action}
    <button
      data-wb-part="empty-state-action"
      class="wb-empty-state__action"
      onclick={() => action.onClick?.()}
    >
      {action.label}
    </button>
  {/if}
</div>

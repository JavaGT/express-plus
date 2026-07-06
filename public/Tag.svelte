<script>
  let {
    label = '',
    variant = 'pill',
    color = '',
    removable = false,
    onRemove = null,
    ...restProps
  } = $props();

  let variantClass = $derived(`wb-tag--${variant}`);
  let colorClass = $derived(color ? `wb-tag--${color}` : '');
</script>

<span
  data-wb-part="tag"
  class="wb-tag {variantClass} {colorClass}"
  data-removable={removable ? 'true' : 'false'}
  {...restProps}
>
  <span data-wb-part="tag-label" class="wb-tag__label">{label}</span>
  {#if removable}
    <button
      data-wb-part="tag-remove"
      class="wb-tag__remove"
      onclick={onRemove}
      aria-label="Remove {label}"
      type="button"
    >
      &times;
    </button>
  {/if}
</span>

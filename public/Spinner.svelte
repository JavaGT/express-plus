<script>
  let {
    size = 'md',
    label = 'Loading',
    ...restProps
  } = $props();

  let sizeClass = $derived(`wb-spinner--${size}`);
</script>

<div
  data-wb-part="spinner"
  class="wb-spinner {sizeClass}"
  role="status"
  aria-label={label}
  {...restProps}
>
  <span data-wb-part="spinner-circle" class="wb-spinner__circle" aria-hidden="true"></span>
  <span class="wb-spinner__label">{label}</span>
</div>

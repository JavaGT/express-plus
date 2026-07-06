<script>
  let { value = '#000000', label = '', onChange } = $props();

  function handleChange(e) {
    onChange?.(e.target.value);
  }
</script>

<div data-wb-part="color-picker" class="wb-color-picker">
  {#if label}
    <label data-wb-part="color-picker-label" class="wb-color-picker__label">{label}</label>
  {/if}
  <input
    data-wb-part="color-picker-input"
    class="wb-color-picker__input"
    type="color"
    value={value}
    oninput={handleChange}
  />
  <span data-wb-part="color-picker-value" class="wb-color-picker__value">{value}</span>
</div>

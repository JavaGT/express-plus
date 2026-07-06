<script>
  let {
    value = '',
    min = null,
    max = null,
    placeholder = '',
    onChange = null,
    label = '',
    ...restProps
  } = $props();

  let dateValue = $state(value);

  function handleChange(e) {
    dateValue = e.target.value;
    if (onChange) onChange(dateValue);
  }
</script>

<div data-wb-part="date-picker" class="wb-date-picker" {...restProps}>
  {#if label}
    <label data-wb-part="date-picker-label" class="wb-date-picker__label" for="dp-input">{label}</label>
  {/if}
  <input
    data-wb-part="date-picker-input"
    id="dp-input"
    type="date"
    class="wb-date-picker__input"
    value={dateValue}
    min={min}
    max={max}
    placeholder={placeholder}
    onchange={handleChange}
  />
</div>

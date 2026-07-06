<script>
  let {
    value = '',
    placeholder = '',
    debounceMs = 300,
    onSearch = null,
    onClear = null,
    ...restProps
  } = $props();

  let inputValue = $state(value);
  let timer = null;

  function handleInput(e) {
    inputValue = e.target.value;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (onSearch) onSearch(inputValue);
    }, debounceMs);
  }

  function handleClear() {
    inputValue = '';
    if (onSearch) onSearch('');
    if (onClear) onClear();
  }

  $effect(() => {
    return () => {
      if (timer) clearTimeout(timer);
    };
  });
</script>

<div data-wb-part="search-input" class="wb-search-input" {...restProps}>
  <input
    data-wb-part="search-input-field"
    type="search"
    class="wb-search-input__field"
    value={inputValue}
    placeholder={placeholder}
    oninput={handleInput}
  />
  {#if inputValue}
    <button
      data-wb-part="search-input-clear"
      class="wb-search-input__clear"
      onclick={handleClear}
      aria-label="Clear search"
    >
      &times;
    </button>
  {/if}
</div>

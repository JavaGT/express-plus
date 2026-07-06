<script>
  let { placeholder = 'Search...', minChars = 2, onSearch, onSelect, renderSuggestion } = $props();
  let value = $state('');
  let suggestions = $state([]);
  let open = $state(false);
  let highlighted = $state(-1);
  let timer;

  function handleInput(e) {
    value = e.target.value;
    clearTimeout(timer);
    if (value.length < minChars) {
      suggestions = [];
      open = false;
      return;
    }
    timer = setTimeout(async () => {
      if (onSearch) {
        const results = await onSearch(value);
        suggestions = results ?? [];
        open = suggestions.length > 0;
        highlighted = -1;
      }
    }, 200);
  }

  function doSelect(item) {
    onSelect?.(item);
    value = renderSuggestion ? renderSuggestion(item) : item.label;
    open = false;
  }

  function handleKeydown(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); highlighted = Math.min(highlighted + 1, suggestions.length - 1); }
    if (e.key === 'ArrowUp') { e.preventDefault(); highlighted = Math.max(highlighted - 1, 0); }
    if (e.key === 'Enter' && highlighted >= 0 && suggestions[highlighted]) { doSelect(suggestions[highlighted]); }
    if (e.key === 'Escape') { open = false; }
  }
</script>

<div data-wb-part="auto-suggest" class="wb-auto-suggest">
  <input
    data-wb-part="auto-suggest-input"
    class="wb-auto-suggest__input"
    type="search"
    {placeholder}
    {value}
    oninput={handleInput}
    onkeydown={handleKeydown}
    onfocus={() => { if (suggestions.length > 0) open = true; }}
    onblur={() => setTimeout(() => open = false, 150)}
    role="combobox"
    aria-expanded={open}
  />
  {#if open && suggestions.length > 0}
    <ul data-wb-part="auto-suggest-list" class="wb-auto-suggest__list" role="listbox">
      {#each suggestions as item, idx}
        <li
          data-wb-part="auto-suggest-item"
          class="wb-auto-suggest__item"
          class:wb-auto-suggest__item--highlighted={idx === highlighted}
          role="option"
          aria-selected={idx === highlighted}
          onclick={() => doSelect(item)}
        >
          {renderSuggestion ? renderSuggestion(item) : item.label}
        </li>
      {/each}
    </ul>
  {/if}
</div>

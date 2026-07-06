<script>
  let { value = '', items = [], filterFn = null, onChange, onSelect } = $props();
  let open = $state(false);
  let highlighted = $state(-1);
  let inputEl;

  let filtered = $derived(
    value.length === 0
      ? items.slice(0, 6)
      : (filterFn ? filterFn(value, items) : items.filter((i) => i.label.toLowerCase().includes(value.toLowerCase()))).slice(0, 6)
  );

  function doSelect(item) {
    onChange?.(item.label);
    onSelect?.(item);
    open = false;
  }

  function handleInput(e) {
    onChange?.(e.target.value);
    open = filtered.length > 0;
    highlighted = -1;
  }

  function handleKeydown(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); highlighted = Math.min(highlighted + 1, filtered.length - 1); }
    if (e.key === 'ArrowUp') { e.preventDefault(); highlighted = Math.max(highlighted - 1, 0); }
    if (e.key === 'Enter' && highlighted >= 0 && filtered[highlighted]) { doSelect(filtered[highlighted]); }
    if (e.key === 'Escape') { open = false; }
  }
</script>

<div data-wb-part="autocomplete" class="wb-autocomplete">
  <input
    data-wb-part="autocomplete-input"
    class="wb-autocomplete__input"
    type="text"
    {value}
    bind:this={inputEl}
    oninput={handleInput}
    onkeydown={handleKeydown}
    onfocus={() => { if (filtered.length > 0) open = true; }}
    onblur={() => setTimeout(() => open = false, 150)}
    role="combobox"
    aria-expanded={open}
    aria-autocomplete="list"
  />
  {#if open && filtered.length > 0}
    <ul data-wb-part="autocomplete-list" class="wb-autocomplete__list" role="listbox">
      {#each filtered as item, idx}
        <li
          data-wb-part="autocomplete-item"
          class="wb-autocomplete__item"
          class:wb-autocomplete__item--highlighted={idx === highlighted}
          role="option"
          aria-selected={idx === highlighted}
          onclick={() => doSelect(item)}
        >
          {item.label}
        </li>
      {/each}
    </ul>
  {/if}
</div>

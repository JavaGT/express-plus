<script>
  let { open = false, commands = [], onClose, onExecute } = $props();
  let query = $state('');
  let selectedIdx = $state(0);
  let inputEl;

  let filtered = $derived(
    query.length === 0
      ? commands
      : commands.filter((c) => c.label.toLowerCase().includes(query.toLowerCase()))
  );

  $effect(() => {
    if (open) {
      query = '';
      selectedIdx = 0;
      setTimeout(() => inputEl?.focus(), 10);
    }
  });

  function select(cmd) {
    onExecute?.(cmd.id);
    onClose?.();
  }

  function handleKeydown(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); selectedIdx = Math.min(selectedIdx + 1, filtered.length - 1); }
    if (e.key === 'ArrowUp') { e.preventDefault(); selectedIdx = Math.max(selectedIdx - 1, 0); }
    if (e.key === 'Enter' && filtered[selectedIdx]) { select(filtered[selectedIdx]); }
    if (e.key === 'Escape') { onClose?.(); }
  }
</script>

{#if open}
  <div data-wb-part="command-palette-backdrop" class="wb-command-palette__backdrop" onclick={() => onClose?.()}></div>
  <div data-wb-part="command-palette" class="wb-command-palette" role="dialog">
    <input
      data-wb-part="command-palette-input"
      class="wb-command-palette__input"
      type="text"
      placeholder="Type a command..."
      bind:value={query}
      bind:this={inputEl}
      onkeydown={handleKeydown}
    />
    {#if filtered.length === 0}
      <div data-wb-part="command-palette-empty" class="wb-command-palette__empty">No commands found</div>
    {:else}
      <ul data-wb-part="command-palette-list" class="wb-command-palette__list" role="listbox">
        {#each filtered as cmd, idx}
          <li
            data-wb-part="command-palette-item"
            class="wb-command-palette__item"
            class:wb-command-palette__item--selected={idx === selectedIdx}
            role="option"
            aria-selected={idx === selectedIdx}
            onclick={() => select(cmd)}
          >
            {#if cmd.icon}<span class="wb-command-palette__icon">{cmd.icon}</span>{/if}
            <span class="wb-command-palette__label">{cmd.label}</span>
            {#if cmd.category}<span class="wb-command-palette__category">{cmd.category}</span>{/if}
            {#if cmd.shortcut}<kbd class="wb-command-palette__shortcut">{cmd.shortcut}</kbd>{/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}

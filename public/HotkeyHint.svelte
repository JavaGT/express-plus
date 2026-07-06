<script>
  let { keys = [], label = '' } = $props();
</script>

<span data-wb-part="hotkey-hint" class="wb-hotkey-hint">
  {#if label}
    <span data-wb-part="hotkey-hint-label" class="wb-hotkey-hint__label">{label}</span>
  {/if}
  <span data-wb-part="hotkey-hint-keys" class="wb-hotkey-hint__keys">
    {#each keys as key, i}
      <kbd data-wb-part="hotkey-hint-key" class="wb-hotkey-hint__key">{key}</kbd>
      {#if i < keys.length - 1}
        <span class="wb-hotkey-hint__sep">+</span>
      {/if}
    {/each}
  </span>
</span>

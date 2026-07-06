<script>
  let { fields = [], onClose } = $props();
</script>

<div data-wb-part="entity-inspector" class="wb-entity-inspector">
  <div data-wb-part="entity-inspector-header" class="wb-entity-inspector__header">
    <span class="wb-entity-inspector__title">Properties</span>
    {#if onClose}
      <button data-wb-part="entity-inspector-close" class="wb-entity-inspector__close" onclick={onClose}>&times;</button>
    {/if}
  </div>
  <div data-wb-part="entity-inspector-body" class="wb-entity-inspector__body">
    {#if fields.length === 0}
      <span class="wb-entity-inspector__empty">No properties</span>
    {:else}
      {#each fields as field}
        <div data-wb-part="entity-inspector-row" class="wb-entity-inspector__row">
          <span data-wb-part="entity-inspector-label" class="wb-entity-inspector__label">{field.label}</span>
          <span data-wb-part="entity-inspector-value" class="wb-entity-inspector__value">{field.value ?? '—'}</span>
        </div>
      {/each}
    {/if}
  </div>
</div>

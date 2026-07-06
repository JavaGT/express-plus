<script>
  import { bindList } from './workbench-ui-bindings.mjs';

  let {
    store,
    id,
    field,
    renderItem = null,
    empty = '',
    keyFn = null,
    onItemsChange = null
  } = $props();

  let bound = bindList(store, { id, field, onItemsChange });
  let items = $state(bound.items);
  let ready = $state(false);

  $effect(() => {
    const unsub = bound.subscribe((newItems) => {
      items = newItems;
    });

    bound.ready.then(() => {
      ready = true;
    }).catch(() => {
      // Bootstrap failed — list stays empty
    });

    return () => {
      unsub();
      bound.destroy();
    };
  });

  function displayKey(item) {
    if (keyFn) return keyFn(item.row);
    return item.key;
  }

  function renderItemHtml(item) {
    if (!renderItem) return '';
    try {
      const result = renderItem(item.row);
      return typeof result === 'string' ? result : '';
    } catch {
      return '';
    }
  }
</script>

<div
  data-wb-part="list-view"
  data-ready={ready}
  data-field={field}
  class="wb-list-view"
>
  {#if items.length === 0}
    <div class="wb-list-view__empty">{empty}</div>
  {:else}
    {#each items as item (displayKey(item))}
      <div
        class="wb-list-view__item"
        data-status={item.status}
        data-key={displayKey(item)}
      >
        {@html renderItemHtml(item)}
      </div>
    {/each}
  {/if}
</div>

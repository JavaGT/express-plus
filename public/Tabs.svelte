<script>
  let {
    tabs = [],
    activeTab = null,
    onChange = null,
    children,
    ...restProps
  } = $props();

  let currentTab = $state(activeTab ?? (tabs.length > 0 ? tabs[0].id : null));

  function selectTab(id) {
    currentTab = id;
    if (onChange) onChange(id);
  }
</script>

<div data-wb-part="tabs" class="wb-tabs" {...restProps}>
  <div data-wb-part="tabs-header" class="wb-tabs__header" role="tablist">
    {#each tabs as tab}
      <button
        data-wb-part="tabs-tab"
        class="wb-tabs__tab"
        class:wb-tabs__tab--active={currentTab === tab.id}
        data-tab-id={tab.id}
        data-tab-active={currentTab === tab.id ? 'true' : 'false'}
        role="tab"
        aria-selected={currentTab === tab.id ? 'true' : 'false'}
        disabled={tab.disabled ?? false}
        onclick={() => !tab.disabled && selectTab(tab.id)}
      >
        {tab.label}
      </button>
    {/each}
  </div>
  <div data-wb-part="tabs-panel" class="wb-tabs__panel" role="tabpanel">
    {@render children?.()}
  </div>
</div>

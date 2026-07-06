<script>
  let {
    boundAction,
    ...restProps
  } = $props();

  let status = $state('idle');
  let error = $state(null);

  $effect(() => {
    if (!boundAction) return;
    const unsub = boundAction.subscribe(({ status: s, error: e }) => {
      status = s;
      error = e;
    });
    return unsub;
  });
</script>

{#if status === 'pending'}
  <span
    data-wb-part="optimistic-badge"
    data-wb-part-badge="spinner"
    data-status="pending"
    class="wb-optimistic-badge wb-optimistic-badge--pending"
    title="Saving..."
    aria-label="Saving"
    {...restProps}
  >
    <span class="wb-optimistic-badge__spinner" aria-hidden="true"></span>
  </span>
{:else if status === 'failed'}
  <span
    data-wb-part="optimistic-badge"
    data-wb-part-badge="error"
    data-status="failed"
    class="wb-optimistic-badge wb-optimistic-badge--failed"
    title={error || 'Failed'}
    aria-label={error || 'Failed'}
    {...restProps}
  >
    <span class="wb-optimistic-badge__error" aria-hidden="true">!</span>
  </span>
{/if}

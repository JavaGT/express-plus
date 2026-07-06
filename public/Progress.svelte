<script>
  let {
    value = 0,
    max = 100,
    label = '',
    variant = 'bar',
    ...restProps
  } = $props();

  let percent = $derived(Math.min(100, Math.max(0, (value / max) * 100)));
  let circumference = $derived(2 * Math.PI * 18); // r=18
  let dashOffset = $derived(circumference - (percent / 100) * circumference);
</script>

{#if variant === 'circle'}
  <div
    data-wb-part="progress"
    class="wb-progress wb-progress--circle"
    role="progressbar"
    aria-valuenow={Math.round(percent)}
    aria-valuemin={0}
    aria-valuemax={100}
    aria-label={label || 'Progress'}
    {...restProps}
  >
    <svg data-wb-part="progress-circle" class="wb-progress__circle" viewBox="0 0 40 40" aria-hidden="true">
      <circle class="wb-progress__circle-bg" cx="20" cy="20" r="18" fill="none" stroke-width="3" />
      <circle
        class="wb-progress__circle-fill"
        cx="20" cy="20" r="18"
        fill="none"
        stroke-width="3"
        stroke-dasharray={circumference}
        stroke-dashoffset={dashOffset}
        stroke-linecap="round"
        transform="rotate(-90 20 20)"
      />
    </svg>
    {#if label}
      <span data-wb-part="progress-label" class="wb-progress__label">{label}</span>
    {/if}
  </div>
{:else}
  <div
    data-wb-part="progress"
    class="wb-progress wb-progress--bar"
    role="progressbar"
    aria-valuenow={Math.round(percent)}
    aria-valuemin={0}
    aria-valuemax={100}
    aria-label={label || 'Progress'}
    {...restProps}
  >
    <div data-wb-part="progress-bar" class="wb-progress__bar">
      <div
        data-wb-part="progress-fill"
        class="wb-progress__fill"
        style="width: {percent}%"
      ></div>
    </div>
    {#if label}
      <span data-wb-part="progress-label" class="wb-progress__label">{label}</span>
    {/if}
  </div>
{/if}

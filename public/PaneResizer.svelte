<script>
  let { direction = 'horizontal', initialRatio = 50, onResize } = $props();
  let dragging = $state(false);
  let ratio = $state(initialRatio);
  let container = null;

  function onMousedown(e) {
    dragging = true;
    e.preventDefault();
    if (!container) container = e.target.parentElement;
  }

  $effect(() => {
    if (!dragging) return;
    const isH = direction === 'horizontal';

    function onMove(e) {
      const rect = container.getBoundingClientRect();
      const pos = isH ? e.clientX - rect.left : e.clientY - rect.top;
      const size = isH ? rect.width : rect.height;
      const pct = Math.max(5, Math.min(95, (pos / size) * 100));
      ratio = pct;
    }

    function onUp(e) {
      dragging = false;
      onResize?.(ratio);
    }

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp, { once: true });
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  });
</script>

<div
  data-wb-part="pane-resizer"
  data-direction={direction}
  class="wb-pane-resizer wb-pane-resizer--{direction}"
  style="--wb-pane-ratio:{ratio}"
>
  <slot {ratio} />
  <div
    data-wb-part="pane-resizer-handle"
    class="wb-pane-resizer__handle"
    role="separator"
    aria-orientation={direction === 'horizontal' ? 'vertical' : 'horizontal'}
    tabindex="0"
    onmousedown={onMousedown}
  ></div>
  <slot name="secondary" />
</div>

<script>
  let { text, label = 'Copy', copiedLabel = 'Copied!' } = $props();
  let copied = $state(false);
  let timer;

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
      clearTimeout(timer);
      timer = setTimeout(() => copied = false, 2000);
    } catch {
      // Clipboard API unavailable — silently fail
    }
  }
</script>

<button
  data-wb-part="copy-button"
  data-copied={copied || undefined}
  class="wb-copy-button"
  class:wb-copy-button--copied={copied}
  onclick={copy}
  type="button"
>
  <span data-wb-part="copy-button-label" class="wb-copy-button__label">
    {copied ? copiedLabel : label}
  </span>
</button>

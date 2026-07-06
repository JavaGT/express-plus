<script>
  let { accept = '*', disabled = false, onFiles } = $props();
  let files = $state([]);
  let dragActive = $state(false);
  let inputEl;

  function handleFiles(fileList) {
    const arr = Array.from(fileList);
    files = arr;
    onFiles?.(arr);
  }

  function onDrop(e) {
    e.preventDefault();
    dragActive = false;
    if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
  }

  function onClick() {
    if (!disabled) inputEl?.click();
  }

  $effect(() => {
    if (disabled) return;
    const prevent = (e) => e.preventDefault();
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  });
</script>

<div
  data-wb-part="file-upload"
  data-drag={dragActive || undefined}
  class="wb-file-upload"
  class:wb-file-upload--drag-active={dragActive}
  ondrop={onDrop}
  ondragover={(e) => { e.preventDefault(); dragActive = true; }}
  ondragleave={() => { dragActive = false; }}
  onclick={onClick}
  role="button"
  tabindex={disabled ? -1 : 0}
>
  <input
    data-wb-part="file-upload-input"
    class="wb-file-upload__input"
    type="file"
    {accept}
    {disabled}
    bind:this={inputEl}
    onchange={(e) => handleFiles(e.target.files)}
    hidden
  />
  {#if files.length === 0}
    <span data-wb-part="file-upload-prompt" class="wb-file-upload__prompt">
      Drop files here or click to browse
    </span>
  {:else}
    <ul data-wb-part="file-upload-list" class="wb-file-upload__list">
      {#each files as file}
        <li data-wb-part="file-upload-item" class="wb-file-upload__item">
          {file.name} ({(file.size / 1024).toFixed(1)} KB)
        </li>
      {/each}
    </ul>
  {/if}
</div>

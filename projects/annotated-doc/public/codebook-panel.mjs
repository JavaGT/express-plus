// Demo-local helpers for the annotated-doc codebook. The codebook is the
// central definition of each code (name + color); `code` annotations store only
// the Code row id, so every range tagged with a code follows a rename or
// recolor. This module renders the codebook definitions and the marker-bar code
// picker; the applied-code cards live in comment-panel.mjs alongside comments.

// Mirrors the server PALETTE (projects/annotated-doc/server.mjs). The demo
// keeps the client palette inline — it is also hard-coded for comment colors in
// index.html — so a shared server/client constant would only add a seam.
export const CODEBOOK_COLORS = Object.freeze([
  { value: '#fef08a', label: 'Yellow' },
  { value: '#fecaca', label: 'Red' },
  { value: '#bfdbfe', label: 'Blue' },
  { value: '#bbf7d0', label: 'Green' },
  { value: '#e9d5ff', label: 'Purple' },
]);

export function codebookColorLabel(value) {
  return CODEBOOK_COLORS.find((entry) => entry.value === value)?.label ?? value;
}

export function createCodebookPanel({
  codebookEl,   // #codebook — the definitions list
  emptyEl,      // #codebook-empty
  pickerEl,     // #code-picker — the marker-bar select used to apply a code
  canEdit,      // () => boolean — owner view may rename/recolor/delete
  onRename,     // (id, currentName) => void
  onRecolor,    // (id, color) => void
  onDelete,     // (id) => void
}) {
  function render(codebook) {
    const previousPick = pickerEl.value;
    codebookEl.replaceChildren();
    emptyEl.classList.toggle('hidden', codebook.length > 0);
    for (const code of codebook) {
      const entry = document.createElement('div');
      entry.className = 'codebook-entry';
      entry.dataset.codeId = code.id;
      const swatch = document.createElement('span');
      swatch.className = 'annotation-color';
      swatch.style.backgroundColor = code.color;
      const name = document.createElement('span');
      name.className = 'codebook-name';
      name.textContent = code.name;
      entry.append(swatch, name);
      if (canEdit()) {
        const recolor = document.createElement('select');
        recolor.className = 'codebook-recolor';
        recolor.setAttribute('aria-label', `Recolor ${code.name}`);
        for (const color of CODEBOOK_COLORS) {
          const option = document.createElement('option');
          option.value = color.value;
          option.textContent = color.label;
          option.selected = color.value === code.color;
          recolor.append(option);
        }
        recolor.onchange = () => onRecolor?.(code.id, recolor.value);
        const rename = document.createElement('button');
        rename.textContent = 'Rename';
        rename.setAttribute('aria-label', `Rename ${code.name}`);
        rename.onclick = () => onRename?.(code.id, code.name);
        const remove = document.createElement('button');
        remove.textContent = 'Delete';
        remove.setAttribute('aria-label', `Delete ${code.name}`);
        remove.onclick = () => onDelete?.(code.id);
        entry.append(recolor, rename, remove);
      }
      codebookEl.append(entry);
    }
    pickerEl.replaceChildren();
    for (const code of codebook) {
      const option = document.createElement('option');
      option.value = code.id;
      option.textContent = `${code.name} (${codebookColorLabel(code.color)})`;
      pickerEl.append(option);
    }
    if (codebook.some((code) => code.id === previousPick)) pickerEl.value = previousPick;
  }

  return { render };
}

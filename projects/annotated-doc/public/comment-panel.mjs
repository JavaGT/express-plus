// Demo-local helpers for the annotated-doc comment panel.
// Extracted from the inline script so index.html stays slim. Keeps the
// Playwright-stable DOM (class names, aria-labels, button text, empty message,
// quote truncation) identical to the previous inline implementation.
// Annotation highlight and select delegate to the editor binding helpers
// (setAnnotationHighlight / selectAnnotation); only color mixing stays
// demo-local here, walking the DOM for --annotation-color.

export async function awaitSettlement(result, { failMessage, unreconciledMessage } = {}) {
  if (result?.ok === false) throw (result.failure ?? new Error(failMessage ?? 'operation failed'));
  if (result?.settlement?.wait) {
    const settlement = await result.settlement.wait();
    if (settlement?.status !== 'reconciled') throw new Error(unreconciledMessage ?? failMessage ?? 'operation was not reconciled');
  }
  return result;
}

export function mixedAnnotationColor(colors) {
  const channels = colors.map((color) => [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16),
  ]);
  return `rgb(${[0, 1, 2].map((channel) => Math.round(channels.reduce((total, color) => total + color[channel], 0) / channels.length)).join(', ')})`;
}

export function annotationQuote(document, annotationId) {
  // The demo's blockless session document carries one absolute range per
  // annotation over the continuous document text.
  const ranges = (document.ranges ?? [])
    .filter((range) => range.annotationId === annotationId)
    .sort((left, right) => (left.start ?? 0) - (right.start ?? 0));
  const quote = ranges
    .map((range) => (document.text ?? '').slice(range.start ?? 0, range.end ?? 0))
    .join('');
  return quote.length > 72 ? `${quote.slice(0, 69)}...` : quote;
}

export function createCommentPanel({
  editorEl,
  annotationsEl,
  emptyEl,
  getEditorBinding, // () => binding | null
}) {
  function setActiveAnnotation(annotationId, active) {
    getEditorBinding()?.setAnnotationHighlight?.(annotationId, active);
  }

  function selectAnnotation(annotationId) {
    getEditorBinding()?.selectAnnotation?.(annotationId);
  }

  function renderAnnotationColors(snapshot) {
    const colors = new Map((snapshot?.annotations ?? [])
      .filter((annotation) => annotation.family === 'comment' && /^#[0-9a-f]{6}$/i.test(annotation.fields.color))
      .map((annotation) => [annotation.id, annotation.fields.color]));
    for (const span of editorEl.querySelectorAll('[data-annotation-ids]')) {
      const visibleColors = (span.dataset.annotationIds?.split(' ') ?? []).map((id) => colors.get(id)).filter(Boolean);
      if (visibleColors.length) span.style.setProperty('--annotation-color', mixedAnnotationColor(visibleColors));
      else span.style.removeProperty('--annotation-color');
    }
  }

  function renderAnnotations(snapshot, { onRemove } = {}) {
    const annotations = (snapshot?.annotations ?? [])
      .filter((annotation) => annotation.family === 'comment');
    annotationsEl.replaceChildren();
    emptyEl.classList.toggle('hidden', annotations.length > 0);
    for (const [index, annotation] of annotations.entries()) {
      const card = document.createElement('article');
      card.className = 'annotation-card';
      card.dataset.annotationId = annotation.id;
      card.tabIndex = 0;
      card.setAttribute('aria-label', `Locate comment ${index + 1}`);
      const title = document.createElement('strong');
      const color = document.createElement('span');
      color.className = 'annotation-color';
      color.style.backgroundColor = annotation.fields.color;
      color.setAttribute('aria-hidden', 'true');
      title.append(color, `Comment ${index + 1}`);
      const quote = document.createElement('p');
      quote.textContent = annotationQuote(snapshot, annotation.id) || 'Attached text is not visible.';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Delete';
      remove.setAttribute('aria-label', `Delete comment ${index + 1}`);
      card.addEventListener('mouseenter', () => setActiveAnnotation(annotation.id, true));
      card.addEventListener('mouseleave', () => setActiveAnnotation(annotation.id, false));
      card.addEventListener('focusin', () => setActiveAnnotation(annotation.id, true));
      card.addEventListener('focusout', () => setActiveAnnotation(annotation.id, false));
      card.addEventListener('click', (event) => {
        if (event.target.closest('button')) return;
        selectAnnotation(annotation.id);
      });
      card.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        selectAnnotation(annotation.id);
      });
      remove.onclick = () => onRemove?.(annotation.id, remove);
      card.append(title, quote, remove);
      annotationsEl.append(card);
    }
  }

  return {
    setActiveAnnotation,
    selectAnnotation,
    renderAnnotationColors,
    renderAnnotations,
  };
}

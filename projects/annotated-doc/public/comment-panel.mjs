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
  codesEl,
  codesEmptyEl,
  getEditorBinding, // () => binding | null
}) {
  function setActiveAnnotation(annotationId, active) {
    getEditorBinding()?.setAnnotationHighlight?.(annotationId, active);
  }

  function selectAnnotation(annotationId) {
    getEditorBinding()?.selectAnnotation?.(annotationId);
  }

  function renderAnnotationColors(snapshot, codebook = []) {
    // A comment colors its own range; a code annotation borrows its range
    // color from the codebook entry it references (the central source).
    const codeById = new Map((codebook ?? []).map((code) => [code.id, code]));
    const colors = new Map((snapshot?.annotations ?? [])
      .map((annotation) => {
        if (annotation.family === 'comment') {
          return /^#[0-9a-f]{6}$/i.test(annotation.fields.color)
            ? [annotation.id, annotation.fields.color]
            : null;
        }
        if (annotation.family === 'code') {
          const code = codeById.get(annotation.fields?.code);
          return code && /^#[0-9a-f]{6}$/i.test(code.color)
            ? [annotation.id, code.color]
            : null;
        }
        return null;
      })
      .filter(Boolean));
    for (const span of editorEl.querySelectorAll('[data-annotation-ids]')) {
      const visibleColors = (span.dataset.annotationIds?.split(' ') ?? []).map((id) => colors.get(id)).filter(Boolean);
      if (visibleColors.length) span.style.setProperty('--annotation-color', mixedAnnotationColor(visibleColors));
      else span.style.removeProperty('--annotation-color');
    }
  }

  function renderAnnotations(snapshot, { onRemove, onResolve, threads = [] } = {}) {
    const annotations = (snapshot?.annotations ?? [])
      .filter((annotation) => annotation.family === 'comment');
    const threadByAnnotation = new Map(threads.map((thread) => [thread.annotationId, thread]));
    annotationsEl.replaceChildren();
    emptyEl.classList.toggle('hidden', annotations.length > 0);
    for (const [index, annotation] of annotations.entries()) {
      const resolved = annotation.fields.resolved === true;
      const card = document.createElement('article');
      card.className = `annotation-card${resolved ? ' resolved' : ''}`;
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
      const thread = threadByAnnotation.get(annotation.id);
      if (thread) {
        const body = document.createElement('p');
        body.className = 'annotation-body';
        body.textContent = thread.body;
        const author = document.createElement('small');
        author.textContent = `by ${thread.author}`;
        card.append(body, author);
      }
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
      card.append(title, quote);
      const actions = document.createElement('div');
      actions.className = 'annotation-actions';
      if (onResolve) {
        const resolve = document.createElement('button');
        resolve.type = 'button';
        resolve.dataset.action = 'resolve';
        resolve.textContent = resolved ? 'Reopen' : 'Resolve';
        resolve.setAttribute('aria-label', `${resolved ? 'Reopen' : 'Resolve'} comment ${index + 1}`);
        resolve.onclick = () => onResolve(annotation.id, resolve);
        actions.append(resolve);
      }
      if (onRemove) actions.append(remove);
      if (actions.childElementCount > 0) card.append(actions);
      annotationsEl.append(card);
    }
  }

  // Applied `code` annotations: each card shows the codebook entry's name and
  // color (resolved by the central Code row id), not a per-annotation value.
  function renderCodes(snapshot, { codebook = [], onRemove } = {}) {
    const codeById = new Map((codebook ?? []).map((code) => [code.id, code]));
    const annotations = (snapshot?.annotations ?? [])
      .filter((annotation) => annotation.family === 'code');
    codesEl.replaceChildren();
    codesEmptyEl.classList.toggle('hidden', annotations.length > 0);
    for (const [index, annotation] of annotations.entries()) {
      const code = codeById.get(annotation.fields?.code);
      const card = document.createElement('article');
      card.className = 'code-card';
      card.dataset.annotationId = annotation.id;
      card.tabIndex = 0;
      card.setAttribute('aria-label', `Locate code ${index + 1}`);
      const title = document.createElement('strong');
      const color = document.createElement('span');
      color.className = 'annotation-color';
      color.style.backgroundColor = code?.color ?? '#d1d5db';
      color.setAttribute('aria-hidden', 'true');
      title.append(color, code?.name ?? 'Unknown code');
      const quote = document.createElement('p');
      quote.textContent = annotationQuote(snapshot, annotation.id) || 'Attached text is not visible.';
      card.append(title, quote);
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
      if (onRemove) {
        const actions = document.createElement('div');
        actions.className = 'annotation-actions';
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = 'Delete';
        remove.setAttribute('aria-label', `Delete code ${index + 1}`);
        remove.onclick = () => onRemove(annotation.id, remove);
        actions.append(remove);
        card.append(actions);
      }
      codesEl.append(card);
    }
  }

  return {
    setActiveAnnotation,
    selectAnnotation,
    renderAnnotationColors,
    renderAnnotations,
    renderCodes,
  };
}

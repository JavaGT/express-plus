function firstVisibleBlock(document) {
  return document?.blocks?.find((block) => block.kind === 'visible') ?? null;
}

function selectionOffsets(element) {
  const selection = element.ownerDocument.defaultView?.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return null;
  const beforeStart = range.cloneRange();
  beforeStart.selectNodeContents(element);
  beforeStart.setEnd(range.startContainer, range.startOffset);
  const beforeEnd = range.cloneRange();
  beforeEnd.selectNodeContents(element);
  beforeEnd.setEnd(range.endContainer, range.endOffset);
  const start = beforeStart.toString().length;
  const end = beforeEnd.toString().length;
  return { from: Math.min(start, end), to: Math.max(start, end) };
}

function setCaret(element, offset) {
  const selection = element.ownerDocument.defaultView?.getSelection();
  if (!selection) return;
  const range = element.ownerDocument.createRange();
  const textNode = element.firstChild;
  if (textNode?.nodeType === 3) {
    range.setStart(textNode, Math.max(0, Math.min(offset, textNode.data.length)));
  } else {
    range.setStart(element, 0);
  }
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function scalarStart(text, offset) {
  if (offset > 0 && offset < text.length) {
    const current = text.charCodeAt(offset);
    const previous = text.charCodeAt(offset - 1);
    if (current >= 0xdc00 && current <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) return offset - 1;
  }
  return offset;
}

function scalarEnd(text, offset) {
  if (offset > 0 && offset < text.length) {
    const current = text.charCodeAt(offset);
    const previous = text.charCodeAt(offset - 1);
    if (current >= 0xdc00 && current <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) return offset + 1;
  }
  return offset;
}

function changedRange(before, after) {
  let from = 0;
  while (from < before.length && from < after.length && before[from] === after[from]) from += 1;
  from = scalarStart(before, scalarStart(after, from));
  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (beforeEnd > from && afterEnd > from && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  beforeEnd = scalarEnd(before, beforeEnd);
  afterEnd = scalarEnd(after, afterEnd);
  return { from, to: beforeEnd, text: after.slice(from, afterEnd) };
}

/** Bind a plain-text contenteditable to the package-owned annotated-text session. */
export function bindAnnotatedTextEditor({ element, session, onError = () => {} }) {
  if (!element || typeof element.addEventListener !== 'function') throw new TypeError('annotated text editor requires an element');
  if (!session || typeof session.subscribe !== 'function' || typeof session.replace !== 'function') throw new TypeError('annotated text editor requires a session');
  if (typeof onError !== 'function') throw new TypeError('annotated text editor onError must be a function');

  let closed = false;
  let rendering = false;
  let composing = null;
  let queued = null;
  let queuedTimer = null;
  let submitted = null;
  let submitting = false;
  let historyInputHandled = false;

  function render(document = session.document) {
    if (closed || composing) return;
    const block = firstVisibleBlock(document);
    if (submitted && block?.id === submitted.blockId && block.text === submitted.text) {
      submitted.ingested = true;
      if (!submitting) submitted = null;
    }
    if (queued) {
      if (block?.id === queued.blockId && block.text === queued.baseText) {
        if (!submitting && (!session.status || session.status === 'live')) flushQueued();
        return;
      }
      if (block?.id === queued.blockId) {
        // This edit was composed atop the most recently submitted draft. A
        // receipt may settle before ingest publishes that draft, so the older
        // recipient snapshot is a predecessor, not an external conflict.
        if (submitted?.blockId === queued.blockId
          && queued.baseText === submitted.text
          && block.text === submitted.baseText) return;
        const intent = changedRange(queued.baseText, queued.text);
        if (intent.from === intent.to && intent.text && block.text.slice(0, intent.from) === queued.baseText.slice(0, intent.from)) {
          const delta = block.text.length - queued.baseText.length;
          const from = delta > 0 && block.text.endsWith(queued.baseText.slice(intent.from)) ? intent.from + delta : intent.from;
          queued = { ...queued, baseText: block.text, text: `${block.text.slice(0, from)}${intent.text}${block.text.slice(from)}` };
          rendering = true;
          element.textContent = queued.text;
          setCaret(element, from + intent.text.length);
          rendering = false;
          return;
        }
      }
      if (submitting || (session.status && session.status !== 'live')) return;
      clearTimeout(queuedTimer);
      queuedTimer = null;
      queued = null;
      element.setAttribute('aria-busy', 'false');
      onError(new Error('annotated text changed before buffered input was submitted'));
    }
    const text = block?.text ?? '';
    const focused = element.ownerDocument.activeElement === element;
    const selection = focused ? selectionOffsets(element) : null;
    rendering = true;
    if (element.textContent !== text) element.textContent = text;
    if (focused) setCaret(element, Math.min(selection?.to ?? text.length, text.length));
    rendering = false;
  }

  function report(work) {
    element.setAttribute('aria-busy', 'true');
    const tracked = Promise.resolve(work).then(async (result) => {
      if (result?.ok === false) onError(result.failure ?? result.deliveryError ?? result);
      if (result?.ok && result.settlement?.wait) await result.settlement.wait();
      return result;
    }, onError).finally(() => {
      if (!queued) element.setAttribute('aria-busy', 'false');
    });
    void tracked;
    return tracked;
  }

  async function replace(from, to, text) {
    const block = firstVisibleBlock(session.document);
    if (!block) return;
    submitting = true;
    try {
      const result = await report(session.replace({
      from: { blockId: block.id, offset: from, affinity: 'right' },
      to: { blockId: block.id, offset: to, affinity: 'right' },
      text,
      }));
      if (!result?.ok) {
        submitted = null;
        clearTimeout(queuedTimer);
        queuedTimer = null;
        queued = null;
        element.setAttribute('aria-busy', 'false');
        render();
        return;
      }
    } finally {
      submitting = false;
      // A settlement receipt and recipient ingest are separate fences. Only
      // translate the successor after both have confirmed this draft.
      const block = firstVisibleBlock(session.document);
      if (submitted?.ingested || (queued && block?.id === queued.blockId && block.text === queued.baseText)) {
        submitted = null;
        if (queued && (!session.status || session.status === 'live')) flushQueued();
      }
    }
  }

  function flushQueued() {
    if (!queued) return;
    if (submitting || (session.status && session.status !== 'live')) return;
    const pending = queued;
    const block = firstVisibleBlock(session.document);
    if (!block || block.id !== pending.blockId || block.text !== pending.baseText) {
      // Receipt settlement can precede the recipient's ingest publication. The
      // queued draft has an explicit authoritative base, so wait for that
      // publication rather than interpreting the previous snapshot as conflict.
      return;
    }
    queued = null;
    queuedTimer = null;
    const change = changedRange(pending.baseText, pending.text);
    if (change.from !== change.to || change.text) {
      // Keep the full visible draft while its delta waits for settlement. New
      // keystrokes must compose on it, not on the older recipient snapshot.
      submitted = { ...pending, ingested: false };
      void replace(change.from, change.to, change.text);
    }
  }

  function bufferEdit(block, from, to, text) {
    if (!queued) {
      const baseText = submitting && submitted?.blockId === block.id && element.textContent === submitted.text
        ? submitted.text
        : block.text;
      queued = { blockId: block.id, baseText, text: baseText };
    }
    if (queued.blockId !== block.id || queued.text !== element.textContent) flushQueued();
    if (!queued) {
      const baseText = submitting && submitted?.blockId === block.id && element.textContent === submitted.text
        ? submitted.text
        : block.text;
      queued = { blockId: block.id, baseText, text: baseText };
    }
    queued.text = `${queued.text.slice(0, from)}${text}${queued.text.slice(to)}`;
    element.setAttribute('aria-busy', 'true');
    rendering = true;
    element.textContent = queued.text;
    setCaret(element, from + text.length);
    rendering = false;
    clearTimeout(queuedTimer);
    // Treat continuous typing as one local intent. This prevents normal key
    // cadence from crossing a submission/reconciliation boundary mid-word.
    queuedTimer = setTimeout(flushQueued, 100);
  }

  function deleteRange(inputType, text, from, to) {
    if (from !== to) return { from: scalarStart(text, from), to: scalarEnd(text, to) };
    if (inputType === 'deleteSoftLineBackward' || inputType === 'deleteHardLineBackward') {
      const lineStart = text.lastIndexOf('\n', from - 1) + 1;
      if (lineStart === from) return null;
      return { from: lineStart, to: scalarEnd(text, from) };
    }
    if (inputType === 'deleteContentBackward') {
      if (from === 0) return null;
      return { from: scalarStart(text, from - 1), to: from };
    }
    if (inputType === 'deleteContentForward' || inputType === 'deleteContent') {
      if (to === text.length) return null;
      return { from: to, to: scalarEnd(text, to + 1) };
    }
    return null;
  }

  function beforeInput(event) {
    if (closed || rendering) return;
    if (event.isComposing || event.inputType === 'insertCompositionText') return;
    event.preventDefault();
    if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
      flushQueued();
      historyInputHandled = true;
      report(event.inputType === 'historyUndo' ? session.history.undo() : session.history.redo());
      return;
    }
    const block = firstVisibleBlock(session.document);
    const selected = selectionOffsets(element);
    if (!block || !selected) return;
    if (event.inputType === 'insertText' || event.inputType === 'insertFromPaste' || event.inputType === 'insertFromDrop') {
      const text = event.dataTransfer?.getData?.('text/plain') ?? event.data ?? '';
      if (text && selected.from !== selected.to) {
        onError(new TypeError('annotated text selection replacement is not yet supported atomically'));
        return;
      }
      if (text) bufferEdit(block, selected.from, selected.to, text);
      return;
    }
    const visibleText = queued?.blockId === block.id ? queued.text : block.text;
    const range = deleteRange(event.inputType, visibleText, selected.from, selected.to);
    if (range) bufferEdit(block, range.from, range.to, '');
  }

  function compositionStart() {
    const block = firstVisibleBlock(session.document);
    const selected = selectionOffsets(element);
    if (!block || !selected) return;
    composing = { blockId: block.id, text: block.text };
  }

  function compositionEnd() {
    if (!composing) return;
    const base = composing;
    composing = null;
    const block = firstVisibleBlock(session.document);
    const domText = element.textContent ?? '';
    if (!block || block.id !== base.blockId || block.text !== base.text) {
      render();
      return;
    }
    const change = changedRange(base.text, domText);
    render();
    if (change.from !== change.to || change.text) replace(change.from, change.to, change.text);
  }

  function keyDown(event) {
    if (event.isComposing) return;
    const modifier = event.metaKey || event.ctrlKey;
    const undo = modifier && !event.altKey && (event.key === 'z' || event.key === 'Z');
    const redo = modifier && !event.altKey && !event.shiftKey && (event.key === 'y' || event.key === 'Y');
    if (!undo && !redo) return;
    event.preventDefault();
    historyInputHandled = false;
    queueMicrotask(() => {
      if (closed || historyInputHandled) return;
      report((redo || event.shiftKey) ? session.history.redo() : session.history.undo());
    });
  }

  element.setAttribute('contenteditable', 'plaintext-only');
  element.setAttribute('aria-busy', 'false');
  element.addEventListener('beforeinput', beforeInput);
  element.addEventListener('compositionstart', compositionStart);
  element.addEventListener('compositionend', compositionEnd);
  element.addEventListener('keydown', keyDown);
  const unsubscribe = session.subscribe(render);
  render();

  return Object.freeze({
    focus() { element.focus(); },
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(queuedTimer);
      unsubscribe();
      element.removeEventListener('beforeinput', beforeInput);
      element.removeEventListener('compositionstart', compositionStart);
      element.removeEventListener('compositionend', compositionEnd);
      element.removeEventListener('keydown', keyDown);
    },
  });
}

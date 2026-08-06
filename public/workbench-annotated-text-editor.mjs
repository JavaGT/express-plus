function visibleBlocks(document) {
  return document?.blocks?.filter((block) => block.kind === 'visible') ?? [];
}

function blockSpan(element, blockId) {
  return [...element.children].find((child) => child.dataset.blockId === blockId) ?? null;
}

function scalarStart(text, offset) {
  if (offset > 0 && offset < text.length && text.charCodeAt(offset) >= 0xdc00 && text.charCodeAt(offset) <= 0xdfff
    && text.charCodeAt(offset - 1) >= 0xd800 && text.charCodeAt(offset - 1) <= 0xdbff) return offset - 1;
  return offset;
}

function scalarEnd(text, offset) {
  if (offset > 0 && offset < text.length && text.charCodeAt(offset) >= 0xdc00 && text.charCodeAt(offset) <= 0xdfff
    && text.charCodeAt(offset - 1) >= 0xd800 && text.charCodeAt(offset - 1) <= 0xdbff) return offset + 1;
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
  return { from, to: scalarEnd(before, beforeEnd), text: after.slice(from, scalarEnd(after, afterEnd)) };
}

function pointInSpan(span, node, offset) {
  if (node === span) {
    if (offset === 0) return 0;
    if (offset === span.childNodes.length) return (span.textContent ?? '').length;
    return null;
  }
  if (node.nodeType === 3 && node.parentNode === span) return offset;
  return null;
}

/** Bind a block-aware plain-text contenteditable to an annotated-text session. */
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
  let followOnEdit = null;
  let blockedComposition = false;
  let historyInputHandled = false;

  function orderedVisible(document = session.document) {
    return visibleBlocks(document);
  }

  function endpoint(node, offset, document = session.document) {
    const blocks = orderedVisible(document);
    let span = node.nodeType === 3 ? node.parentElement : node;
    while (span && span.parentElement !== element) span = span.parentElement;
    if (span?.dataset.blockId) {
      const block = blocks.find((candidate) => candidate.id === span.dataset.blockId);
      const local = pointInSpan(span, node, offset);
      if (!block || local === null || local < 0 || local > (span.textContent ?? '').length) return null;
      return { blockId: block.id, offset: local, affinity: 'right' };
    }
    if (node !== element) return null;
    const children = [...element.children];
    if (children[offset]?.dataset.restricted === 'true' || children[offset - 1]?.dataset.restricted === 'true') return null;
    const visibleIds = new Set(blocks.map((block) => block.id));
    const next = children.slice(offset).find((child) => visibleIds.has(child.dataset.blockId));
    if (next) return { blockId: next.dataset.blockId, offset: 0, affinity: 'right' };
    const previous = children.slice(0, offset).reverse().find((child) => visibleIds.has(child.dataset.blockId));
    if (previous) {
      const block = blocks.find((candidate) => candidate.id === previous.dataset.blockId);
      return { blockId: block.id, offset: (previous.textContent ?? '').length, affinity: 'right' };
    }
    return null;
  }

  function getSelection() {
    const selection = element.ownerDocument.defaultView?.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    const from = endpoint(range.startContainer, range.startOffset);
    const to = endpoint(range.endContainer, range.endOffset);
    if (!from || !to) return null;
    const children = [...element.children];
    const fromChild = children.findIndex((child) => child.dataset.blockId === from.blockId);
    const toChild = children.findIndex((child) => child.dataset.blockId === to.blockId);
    if (children.slice(Math.min(fromChild, toChild), Math.max(fromChild, toChild) + 1)
      .some((child) => child.dataset.restricted === 'true')) return null;
    const fromIndex = orderedVisible().findIndex((block) => block.id === from.blockId);
    const toIndex = orderedVisible().findIndex((block) => block.id === to.blockId);
    if (fromIndex > toIndex || (fromIndex === toIndex && from.offset > to.offset)) {
      return { from: to, to: from };
    }
    return { from, to };
  }

  function setCaret(blockId, offset) {
    const span = blockSpan(element, blockId);
    if (!span) return;
    const selection = element.ownerDocument.defaultView?.getSelection();
    if (!selection) return;
    const range = element.ownerDocument.createRange();
    const textNode = span.firstChild;
    if (textNode?.nodeType === 3) range.setStart(textNode, Math.max(0, Math.min(offset, textNode.data.length)));
    else range.setStart(span, 0);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  /**
   * Boundary typing on an annotated block is committed as text.insert-block on a
   * new (or existing unannotated) neighbor. The source block stays at baseText.
   * Return where the inserted run lives so local drafts can follow it.
   */
  function findBoundaryInsertHome(visible, sourceId, baseText, nextText) {
    if (typeof baseText !== 'string' || typeof nextText !== 'string' || nextText === baseText) return null;
    const sourceIndex = visible.findIndex((block) => block.id === sourceId);
    if (sourceIndex < 0) return null;
    const source = visible[sourceIndex];
    if (source.text !== baseText) return null;

    if (nextText.startsWith(baseText)) {
      const inserted = nextText.slice(baseText.length);
      const after = visible[sourceIndex + 1];
      if (!after || after.annotationIds?.length || !after.text) return null;
      if (inserted.startsWith(after.text) || after.text.startsWith(inserted)) {
        const matched = inserted.startsWith(after.text) ? after.text : inserted;
        return { blockId: after.id, matched, side: 'after', neighborText: after.text };
      }
      return null;
    }
    if (nextText.endsWith(baseText)) {
      const inserted = nextText.slice(0, nextText.length - baseText.length);
      const before = visible[sourceIndex - 1];
      if (!before || before.annotationIds?.length || !before.text) return null;
      if (inserted.endsWith(before.text) || before.text.endsWith(inserted)) {
        const matched = inserted.endsWith(before.text) ? before.text : inserted;
        return { blockId: before.id, matched, side: 'before', neighborText: before.text };
      }
    }
    return null;
  }

  function moveDraftToBoundaryHome(draft, home) {
    const inserted = draft.text.startsWith(draft.baseText)
      ? draft.text.slice(draft.baseText.length)
      : draft.text.endsWith(draft.baseText)
        ? draft.text.slice(0, draft.text.length - draft.baseText.length)
        : '';
    if (!inserted.startsWith(home.matched) && !home.matched.startsWith(inserted)) return null;
    const remainder = inserted.startsWith(home.matched) ? inserted.slice(home.matched.length) : '';
    if (home.side === 'after') {
      return {
        blockId: home.blockId,
        baseText: home.neighborText,
        text: `${home.neighborText}${remainder}`,
      };
    }
    return {
      blockId: home.blockId,
      baseText: home.neighborText,
      text: `${remainder}${home.neighborText}`,
    };
  }

  function render(document = session.document) {
    if (closed || composing) return;
    const blocks = document?.blocks ?? [];
    const visible = orderedVisible(document);
    const annotationFamilies = new Map((document?.annotations ?? []).map((annotation) => [annotation.id, annotation.family]));
    let caretAfterRender = null;

    if (submitted) {
      const submittedTarget = visible.find((block) => block.id === submitted.blockId);
      if (submittedTarget?.text === submitted.text) {
        submitted.ingested = true;
        if (!submitting) submitted = null;
      } else if (!submittedTarget && submitted.text === '') {
        // Empty unannotated block pruned with the delete that emptied it.
        submitted.ingested = true;
        if (!submitting) submitted = null;
      } else {
        const home = findBoundaryInsertHome(visible, submitted.blockId, submitted.baseText, submitted.text);
        if (home) {
          const movedSubmitted = moveDraftToBoundaryHome(submitted, home);
          if (queued?.blockId === submitted.blockId && queued.text.startsWith(submitted.text)) {
            const tail = queued.text.slice(submitted.text.length);
            const base = movedSubmitted ?? { blockId: home.blockId, baseText: home.neighborText, text: home.neighborText };
            queued = {
              blockId: base.blockId,
              baseText: base.baseText,
              text: home.side === 'after' ? `${base.text}${tail}` : `${tail}${base.text}`,
            };
            caretAfterRender = {
              blockId: queued.blockId,
              offset: home.side === 'after' ? queued.text.length : tail.length,
            };
          } else if (movedSubmitted && movedSubmitted.text !== movedSubmitted.baseText) {
            queued = movedSubmitted;
            caretAfterRender = {
              blockId: queued.blockId,
              offset: home.side === 'after' ? queued.text.length : Math.max(0, queued.text.length - home.neighborText.length),
            };
          } else {
            caretAfterRender = {
              blockId: home.blockId,
              offset: home.side === 'after' ? home.neighborText.length : Math.max(0, home.neighborText.length - home.matched.length),
            };
          }
          submitted.ingested = true;
          if (!submitting) submitted = null;
        }
      }
    }

    const target = queued && visible.find((block) => block.id === queued.blockId);
    if (queued && target && target.text !== queued.baseText) {
      const intent = changedRange(queued.baseText, queued.text);
      const prefix = queued.baseText.slice(0, intent.from);
      const suffix = queued.baseText.slice(intent.from);
      if (intent.from === intent.to && intent.text && target.text.startsWith(queued.baseText)) {
        const foreign = target.text.slice(queued.baseText.length);
        let overlap = 0;
        while (overlap < intent.text.length && overlap < foreign.length
          && intent.text[overlap] === foreign[overlap]) overlap += 1;
        const from = overlap ? target.text.length : intent.from;
        queued = { ...queued, baseText: target.text, text: `${target.text.slice(0, from)}${intent.text.slice(overlap)}${target.text.slice(from)}` };
      } else if (intent.from === intent.to && intent.text && target.text.startsWith(prefix) && target.text.endsWith(suffix)) {
        const foreign = target.text.slice(prefix.length, target.text.length - suffix.length);
        let overlap = 0;
        while (overlap < intent.text.length && overlap < foreign.length
          && intent.text[overlap] === foreign[overlap]) overlap += 1;
        const from = prefix.length + foreign.length;
        queued = { ...queued, baseText: target.text, text: `${target.text.slice(0, from)}${intent.text.slice(overlap)}${target.text.slice(from)}` };
      } else {
        const home = findBoundaryInsertHome(visible, queued.blockId, queued.baseText, queued.text);
        const moved = home && moveDraftToBoundaryHome(queued, home);
        if (moved) {
          queued = moved;
          caretAfterRender = {
            blockId: queued.blockId,
            offset: home.side === 'after' ? queued.text.length : Math.max(0, queued.text.length - home.neighborText.length),
          };
        } else if (!submitting && !(submitted && target.text === submitted.baseText && queued.baseText === submitted.text)
          && (!session.status || session.status === 'live')) {
          clearTimeout(queuedTimer);
          queuedTimer = null;
          queued = null;
          submitted = null;
          element.setAttribute('aria-busy', 'false');
          onError(new Error('annotated text changed before buffered input was submitted'));
        }
      }
    }
    if (queued && !visible.find((block) => block.id === queued.blockId)
      && !submitting && (!session.status || session.status === 'live')) {
      if (queued.text === '') {
        // Draft emptied a block that the server then pruned.
        clearTimeout(queuedTimer);
        queuedTimer = null;
        queued = null;
      } else {
        const home = findBoundaryInsertHome(visible, queued.blockId, queued.baseText, queued.text);
        const moved = home && moveDraftToBoundaryHome(queued, home);
        if (moved) {
          queued = moved;
          caretAfterRender = {
            blockId: queued.blockId,
            offset: home.side === 'after' ? queued.text.length : Math.max(0, queued.text.length - home.neighborText.length),
          };
        } else {
          clearTimeout(queuedTimer);
          queuedTimer = null;
          queued = null;
          submitted = null;
          element.setAttribute('aria-busy', 'false');
          onError(new Error('annotated text changed before buffered input was submitted'));
        }
      }
    }
    const displayed = new Map();
    if (submitted) {
      const submittedBlock = visible.find((block) => block.id === submitted.blockId);
      if (submittedBlock && submittedBlock.text === submitted.text) {
        displayed.set(submitted.blockId, submitted.text);
      } else if (submittedBlock && submittedBlock.text === submitted.baseText) {
        // Source still at baseText: either still in-flight on-block edit, or a
        // boundary insert-block already moved the insert to a neighbor. Only
        // paint optimistic text when the insert has not found a home yet.
        const home = findBoundaryInsertHome(visible, submitted.blockId, submitted.baseText, submitted.text);
        if (!home) displayed.set(submitted.blockId, submitted.text);
      }
    }
    if (queued) displayed.set(queued.blockId, queued.text);
    const existing = new Map([...element.children].map((child) => [child.dataset.blockId, child]));
    rendering = true;
    for (const block of blocks) {
      let span = existing.get(block.id);
      if (!span) {
        span = element.ownerDocument.createElement('span');
        span.dataset.blockId = block.id;
      }
      span.contentEditable = block.kind === 'visible' ? 'true' : 'false';
      if (block.kind === 'restricted') {
        span.textContent = block.placeholder ?? '';
        span.dataset.restricted = 'true';
        delete span.dataset.annotationFamilies;
        delete span.dataset.annotationIds;
      } else {
        delete span.dataset.restricted;
        const annotationIds = [...new Set(block.annotationIds ?? [])].sort();
        const families = [...new Set(annotationIds.map((id) => annotationFamilies.get(id)).filter(Boolean))].sort();
        if (families.length) span.dataset.annotationFamilies = families.join(' ');
        else delete span.dataset.annotationFamilies;
        if (annotationIds.length) span.dataset.annotationIds = annotationIds.join(' ');
        else delete span.dataset.annotationIds;
        const text = displayed.has(block.id) ? displayed.get(block.id) : block.text;
        if (span.textContent !== text) span.textContent = text;
      }
      const index = blocks.indexOf(block);
      if (element.children[index] !== span) element.insertBefore(span, element.children[index] ?? null);
    }
    const blockIds = new Set(blocks.map((block) => block.id));
    for (const child of [...element.children]) {
      if (!blockIds.has(child.dataset.blockId)) child.remove();
    }
    rendering = false;
    if (caretAfterRender) setCaret(caretAfterRender.blockId, caretAfterRender.offset);
    if (queued && visible.some((block) => block.id === queued.blockId)) {
      const queuedTarget = visible.find((block) => block.id === queued.blockId);
      if (queuedTarget.text === queued.baseText && !submitting && (!session.status || session.status === 'live')) flushQueued();
    }
    if (!queued && !submitted && !submitting) {
      element.setAttribute('aria-busy', 'false');
      applyFollowOnEdit();
    }
  }

  function report(work) {
    element.setAttribute('aria-busy', 'true');
    const tracked = Promise.resolve(work).then(async (result) => {
      if (result?.ok === false) onError(result.failure ?? result.deliveryError ?? result);
      if (result?.ok && result.settlement?.wait) await result.settlement.wait();
      return result;
    }, onError).finally(() => {
      if (!queued && !submitted && !submitting) element.setAttribute('aria-busy', 'false');
    });
    void tracked;
    return tracked;
  }

  function applyFollowOnEdit() {
    if (!followOnEdit || submitting || queued || submitted || composing) return;
    const next = followOnEdit;
    followOnEdit = null;
    const block = orderedVisible().find((candidate) => candidate.id === next.blockId);
    if (!block) return;
    bufferEdit(block, next.from, next.to, next.text);
  }

  async function replace(block, from, to, text) {
    submitting = true;
    try {
      const result = await report(session.replace({
        from: { blockId: block.id, offset: from, affinity: 'right' },
        to: { blockId: block.id, offset: to, affinity: 'right' },
        text,
      }));
      if (!result?.ok) {
        submitted = null;
        queued = null;
        followOnEdit = null;
        clearTimeout(queuedTimer);
        queuedTimer = null;
        element.setAttribute('aria-busy', 'false');
        render();
      }
    } finally {
      submitting = false;
      const current = orderedVisible().find((candidate) => candidate.id === block.id);
      if (submitted?.ingested || (queued && current?.text === queued.baseText)) {
        submitted = null;
        if (queued) flushQueued();
      }
      if (submitted && submitted.text === '' && submitted.ingested) submitted = null;
      render();
      applyFollowOnEdit();
    }
  }

  function flushQueued() {
    if (!queued || submitting || (session.status && session.status !== 'live')) return;
    const pending = queued;
    const block = orderedVisible().find((candidate) => candidate.id === pending.blockId);
    if (!block || block.text !== pending.baseText) return;
    queued = null;
    queuedTimer = null;
    const change = changedRange(pending.baseText, pending.text);
    if (change.from !== change.to || change.text) {
      submitted = { ...pending, ingested: false };
      void replace(block, change.from, change.to, change.text);
    } else {
      element.setAttribute('aria-busy', 'false');
    }
  }

  function bufferEdit(block, from, to, text) {
    if (!queued || queued.blockId !== block.id) {
      if (queued) flushQueued();
      if (queued) {
        onError(new Error('annotated text changed before buffered input was submitted'));
        return;
      }
      const span = blockSpan(element, block.id);
      const baseline = submitting && submitted?.blockId === block.id && span?.textContent === submitted.text
        ? submitted.text
        : block.text;
      queued = { blockId: block.id, baseText: baseline, text: baseline };
    }
    queued.text = `${queued.text.slice(0, from)}${text}${queued.text.slice(to)}`;
    element.setAttribute('aria-busy', 'true');
    rendering = true;
    const span = blockSpan(element, block.id);
    if (span) span.textContent = queued.text;
    setCaret(block.id, from + text.length);
    rendering = false;
    clearTimeout(queuedTimer);
    queuedTimer = setTimeout(flushQueued, 100);
  }

  function pendingBlockId() {
    return submitted?.blockId ?? queued?.blockId ?? composing?.blockId ?? null;
  }

  function pendingDraftText(blockId) {
    if (queued?.blockId === blockId) return queued.text;
    if (submitted?.blockId === blockId) return submitted.text;
    if (composing?.blockId === blockId) return composing.text;
    return null;
  }

  function mutationIsBlocked(blockId) {
    const target = pendingBlockId();
    if (target && target !== blockId) {
      onError(new Error('annotated text cannot edit another block while a local change is pending'));
      return true;
    }
    return false;
  }

  /** Boundary delete onto a neighbor while an empty draft is still settling. */
  function deferBoundaryEdit(edit) {
    const target = pendingBlockId();
    if (!target || target === edit.blockId) return false;
    if (composing || pendingDraftText(target) !== '') {
      onError(new Error('annotated text cannot edit another block while a local change is pending'));
      return true;
    }
    followOnEdit = edit;
    element.setAttribute('aria-busy', 'true');
    return true;
  }

  function deleteRange(inputType, text, from, to) {
    if (from !== to) return { from: scalarStart(text, from), to: scalarEnd(text, to) };
    if (inputType === 'deleteSoftLineBackward' || inputType === 'deleteHardLineBackward') {
      const lineStart = text.lastIndexOf('\n', from - 1) + 1;
      return lineStart === from ? null : { from: lineStart, to: scalarEnd(text, from) };
    }
    if (inputType === 'deleteContentBackward') return from === 0 ? null : { from: scalarStart(text, from - 1), to: from };
    if (inputType === 'deleteContentForward' || inputType === 'deleteContent') return to === text.length ? null : { from: to, to: scalarEnd(text, to + 1) };
    return null;
  }

  function adjacentDelete(block, offset, inputType) {
    if (inputType !== 'deleteContentBackward' && inputType !== 'deleteContentForward' && inputType !== 'deleteContent') return null;
    const blocks = orderedVisible();
    const index = blocks.findIndex((candidate) => candidate.id === block.id);
    const previous = inputType === 'deleteContentBackward';
    if ((previous && offset !== 0) || (!previous && offset !== block.text.length)) return null;
    const adjacent = blocks[index + (previous ? -1 : 1)];
    if (!adjacent) return null;
    const text = queued?.blockId === adjacent.id ? queued.text : adjacent.text;
    if (!text) return null;
    return previous
      ? { block: adjacent, from: scalarStart(text, text.length - 1), to: text.length }
      : { block: adjacent, from: 0, to: scalarEnd(text, 1) };
  }

  function beforeInput(event) {
    if (closed || rendering) return;
    if (event.isComposing || event.inputType === 'insertCompositionText') return;
    event.preventDefault();
    if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
      if (queued || submitted || submitting || composing) {
        onError(new Error('annotated text history is unavailable while a local change is pending'));
        return;
      }
      historyInputHandled = true;
      report(event.inputType === 'historyUndo' ? session.history.undo() : session.history.redo());
      return;
    }
    const selected = getSelection();
    if (!selected) return;
    if (selected.from.blockId !== selected.to.blockId) {
      onError(new TypeError('annotated text selection replacement is not yet supported atomically'));
      return;
    }
    const block = orderedVisible().find((candidate) => candidate.id === selected.from.blockId);
    if (!block) return;
    if (event.inputType === 'insertText' || event.inputType === 'insertFromPaste' || event.inputType === 'insertFromDrop') {
      if (mutationIsBlocked(block.id)) return;
      const text = event.dataTransfer?.getData?.('text/plain') ?? event.data ?? '';
      if (text) bufferEdit(block, selected.from.offset, selected.to.offset, text);
      return;
    }
    const text = pendingDraftText(block.id) ?? block.text;
    const range = deleteRange(event.inputType, text, selected.from.offset, selected.to.offset);
    if (range) {
      if (mutationIsBlocked(block.id)) return;
      bufferEdit(block, range.from, range.to, '');
      return;
    }
    const adjacent = selected.from.offset === selected.to.offset && adjacentDelete(block, selected.from.offset, event.inputType);
    if (!adjacent) return;
    if (pendingBlockId() && pendingBlockId() !== adjacent.block.id) {
      if (deferBoundaryEdit({ blockId: adjacent.block.id, from: adjacent.from, to: adjacent.to, text: '' })) return;
    }
    if (mutationIsBlocked(adjacent.block.id)) return;
    bufferEdit(adjacent.block, adjacent.from, adjacent.to, '');
  }

  function compositionStart(event) {
    const selected = getSelection();
    if (!selected || selected.from.blockId !== selected.to.blockId) {
      blockedComposition = true;
      event.preventDefault();
      render();
      return;
    }
    if (mutationIsBlocked(selected.from.blockId)) {
      blockedComposition = true;
      event.preventDefault();
      render();
      return;
    }
    const block = orderedVisible().find((candidate) => candidate.id === selected.from.blockId);
    if (block) {
      if (submitted?.blockId === block.id) {
        clearTimeout(queuedTimer);
        queuedTimer = null;
        queued = null;
        composing = { blockId: block.id, text: submitted.text, afterSubmitted: true };
        return;
      }
      // Keep buffered typing as the composition's predecessor. Composition
      // end will turn the whole visible result into one queued draft, so a
      // foreign update is rebased by the same path as ordinary typing.
      clearTimeout(queuedTimer);
      queuedTimer = null;
      composing = {
        blockId: block.id,
        text: queued?.blockId === block.id ? queued.text : block.text,
        queuedBaseText: queued?.blockId === block.id ? queued.baseText : block.text,
      };
    }
  }

  function compositionEnd() {
    if (blockedComposition) {
      blockedComposition = false;
      render();
      return;
    }
    if (!composing) return;
    const base = composing;
    composing = null;
    const block = orderedVisible().find((candidate) => candidate.id === base.blockId);
    const span = blockSpan(element, base.blockId);
    const domText = span?.textContent ?? '';
    if (!block) {
      render();
      return;
    }
    const queuedBaseText = base.queuedBaseText ?? base.text;
    if (domText === base.text && queuedBaseText === base.text) {
      queued = null;
      render();
      return;
    }
    queued = {
      blockId: block.id,
      baseText: queuedBaseText,
      text: domText,
    };
    element.setAttribute('aria-busy', 'true');
    render();
  }

  function historyIsBlocked() {
    if (!queued && !submitted && !submitting && !composing) return false;
    onError(new Error('annotated text history is unavailable while a local change is pending'));
    return true;
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
      if (historyIsBlocked()) return;
      report((redo || event.shiftKey) ? session.history.redo() : session.history.undo());
    });
  }

  function annotationSpans(annotationId) {
    if (closed || annotationId == null || annotationId === '') return [];
    return [...element.querySelectorAll('[data-annotation-ids]')]
      .filter((span) => (span.dataset.annotationIds?.split(' ') ?? []).includes(annotationId));
  }

  function setAnnotationHighlight(annotationId, active) {
    for (const span of annotationSpans(annotationId)) {
      if (active) span.dataset.activeAnnotation = 'true';
      else delete span.dataset.activeAnnotation;
    }
  }

  function selectAnnotation(annotationId) {
    const spans = annotationSpans(annotationId);
    const first = spans[0];
    const last = spans.at(-1);
    if (!first || !last) return;
    const doc = element.ownerDocument;
    const range = doc.createRange();
    range.setStart(first.firstChild ?? first, 0);
    if (last.firstChild?.nodeType === 3) range.setEnd(last.firstChild, last.firstChild.data.length);
    else range.setEnd(last, last.childNodes.length);
    element.focus();
    const selection = doc.defaultView?.getSelection();
    if (!selection) return;
    selection.removeAllRanges();
    selection.addRange(range);
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
    getSelection,
    setAnnotationHighlight,
    selectAnnotation,
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

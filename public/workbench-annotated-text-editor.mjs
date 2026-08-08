// Display-space walks over public recipient redaction markers. The editor must
// treat placeholder interiors as non-editable and reject selections crossing
// them; these helpers translate between display and wire coordinates.
import { classifyDisplayOffset, selectionCrossesDisplayRedaction } from './workbench-annotated-text-redaction-coords.mjs';
import { projectRangesOverEdit } from './workbench-annotated-text-snapshot.mjs';

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

// Display-space coordinate mapping over the block's DOM. In the blockless
// interval model a block holds nested marker spans (annotation runs and
// redaction placeholders) plus plain text nodes, so a selection point maps to
// the display offset by walking the block's text in document order rather than
// assuming one direct text child.

// NodeFilter.SHOW_TEXT is 4 per spec; jsdom does not expose a global
// NodeFilter, so use the numeric constant to walk text nodes in any host.
const SHOW_TEXT = 4;

function textWalker(root) {
  return root.ownerDocument.createTreeWalker(root, SHOW_TEXT);
}

function textLengthBefore(span, target) {
  let total = 0;
  const walker = textWalker(span);
  while (walker.nextNode()) {
    const current = walker.currentNode;
    if (current === target) return total;
    if (target.contains(current)) break;
    total += current.data.length;
  }
  return total;
}

function pointInSpan(span, node, offset) {
  if (node === span) {
    if (offset === 0) return 0;
    if (offset === span.childNodes.length) return (span.textContent ?? '').length;
    return null;
  }
  if (!span.contains(node)) return null;
  if (node.nodeType === 3) {
    if (offset < 0 || offset > node.data.length) return null;
    return textLengthBefore(span, node) + offset;
  }
  if (offset < 0 || offset > node.childNodes.length) return null;
  let local = textLengthBefore(span, node);
  for (let index = 0; index < offset; index += 1) local += (node.childNodes[index]?.textContent ?? '').length;
  return local;
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

  function isLocallyPruned(block) {
    if (block.kind !== 'visible') return false;
    if (queued?.blockId === block.id && queued.text === '') return true;
    if (submitted?.blockId === block.id && submitted.text === '') return true;
    return false;
  }

  function moveCaretOffPrunedBlock(blockId) {
    const blocks = orderedVisible();
    const index = blocks.findIndex((block) => block.id === blockId);
    if (index < 0) return;
    const previous = [...blocks.slice(0, index)].reverse().find((block) => !isLocallyPruned(block));
    if (previous) {
      const text = pendingDraftText(previous.id) ?? previous.text;
      setCaret(previous.id, text.length);
      return;
    }
    const next = blocks.slice(index + 1).find((block) => !isLocallyPruned(block));
    if (next) setCaret(next.id, 0);
  }

  function endpoint(node, offset, document = session.document) {
    const blocks = orderedVisible(document);
    let span = node.nodeType === 3 ? node.parentElement : node;
    while (span && span.parentElement !== element) span = span.parentElement;
    if (span?.dataset.blockId) {
      const block = blocks.find((candidate) => candidate.id === span.dataset.blockId);
      const local = pointInSpan(span, node, offset);
      if (!block || local === null || local < 0 || local > (span.textContent ?? '').length) return null;
      const classified = classifyDisplayOffset(local, block.redactions ?? []);
      if (classified.kind === 'interior') return null;
      if (classified.kind === 'left' || classified.kind === 'right') {
        return { blockId: block.id, offset: classified.offset, affinity: classified.affinity };
      }
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
    if (from.blockId === to.blockId) {
      const block = orderedVisible().find((candidate) => candidate.id === from.blockId);
      if (selectionCrossesDisplayRedaction(from.offset, to.offset, block?.redactions ?? [])) return null;
    }
    return { from, to };
  }

  function setCaret(blockId, offset) {
    const span = blockSpan(element, blockId);
    if (!span) return;
    const selection = element.ownerDocument.defaultView?.getSelection();
    if (!selection) return;
    const range = element.ownerDocument.createRange();
    let target = null;
    let nodeOffset = 0;
    let remaining = Math.max(0, Math.min(offset, (span.textContent ?? '').length));
    const walker = textWalker(span);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (remaining <= node.data.length) {
        target = node;
        nodeOffset = remaining;
        break;
      }
      remaining -= node.data.length;
    }
    if (target === null) {
      target = span;
      nodeOffset = 0;
    }
    range.setStart(target, nodeOffset);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  /**
   * Interval-rendered inline spans (issue #33 step 8). A blockless document is
   * ONE text with absolute annotation ranges and zero-width redaction markers;
   * the editor renders maximal flat runs of constant annotation-id set as
   * marker spans, plus a `data-restricted` placeholder span per redaction.
   * Display offsets count placeholder widths, matching the redaction coords
   * module; wire offsets name the text without placeholders.
   */

  function blockPaintSignature(text, ranges, redactions) {
    const rangePart = (ranges ?? []).map((range) => `${range.annotationId}:${range.start}:${range.end}`).join(',');
    const redactionPart = (redactions ?? []).map((redaction) => `${redaction.start}:${redaction.placeholder}`).join(',');
    return `${text}|${rangePart}|${redactionPart}`;
  }

  function paintBlock(span, text, ranges, annotationsById, redactions = []) {
    const doc = span.ownerDocument;
    const positiveRanges = (ranges ?? []).filter((range) => range.start < range.end);
    const points = new Set();
    for (const range of positiveRanges) {
      points.add(range.start);
      points.add(range.end);
    }
    for (const redaction of redactions) points.add(redaction.start);
    const sorted = [...points].sort((left, right) => left - right);
    const children = [];
    const emitRun = (from, to) => {
      if (to <= from) return;
      const activeIds = positiveRanges
        .filter((range) => range.start < to && range.end > from)
        .map((range) => range.annotationId);
      const segment = text.slice(from, to);
      if (activeIds.length === 0) {
        children.push(doc.createTextNode(segment));
        return;
      }
      const marker = doc.createElement('span');
      marker.dataset.annotationIds = activeIds.sort().join(' ');
      const families = [...new Set(activeIds.map((id) => annotationsById.get(id)).filter(Boolean))].sort();
      if (families.length) marker.dataset.annotationFamilies = families.join(' ');
      marker.textContent = segment;
      children.push(marker);
    };
    let cursor = 0;
    for (const point of sorted) {
      if (point > cursor) emitRun(cursor, point);
      for (const redaction of redactions) {
        if (redaction.start !== point) continue;
        const restricted = doc.createElement('span');
        restricted.dataset.restricted = 'true';
        restricted.contentEditable = 'false';
        restricted.textContent = redaction.placeholder;
        children.push(restricted);
      }
      cursor = point;
    }
    if (cursor < text.length) emitRun(cursor, text.length);
    span.textContent = '';
    for (const child of children) span.appendChild(child);
  }

  const painted = new WeakMap();

  /**
   * Paint one visible block span. Block-era documents (no `ranges` key) carry
   * annotation attrs on the block span; blockless documents render interval
   * marker spans. Returns true when the DOM changed. `draftEdit` projects the
   * ranges through a pending local draft so optimistic text paints markers at
   * their shifted positions.
   */
  function paintDisplay(span, document, block, text, draftEdit) {
    if (!Array.isArray(document?.ranges)) {
      if (span.textContent === text) return false;
      span.textContent = text;
      return true;
    }
    const ranges = draftEdit
      ? projectRangesOverEdit(document.ranges, draftEdit.from, draftEdit.to, draftEdit.text)
      : document.ranges;
    const signature = blockPaintSignature(text, ranges, block.redactions);
    if (painted.get(span) === signature) return false;
    paintBlock(span, text, ranges, new Map((document.annotations ?? []).map((annotation) => [annotation.id, annotation.family])), block.redactions);
    painted.set(span, signature);
    return true;
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
    const blocks = (document?.blocks ?? []).filter((block) => !(block.kind === 'visible' && isLocallyPruned(block)));
    const visible = orderedVisible(document).filter((block) => !isLocallyPruned(block));
    const annotationFamilies = new Map((document?.annotations ?? []).map((annotation) => [annotation.id, annotation.family]));
    let caretAfterRender = null;
    // A render that merely confirms the already-displayed optimistic state must
    // not move the caret. Browsers collapse a selection to the start of a
    // contentEditable node the moment its text node is replaced, so capture the
    // caret before touching the DOM and restore it when the render did not
    // intentionally relocate it (a draft move sets caretAfterRender instead).
    const caretBeforeRender = closed ? null : getSelection();

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
    const draftEdit = queued ? changedRange(queued.baseText, queued.text) : null;
    const existing = new Map([...element.children].map((child) => [child.dataset.blockId, child]));
    rendering = true;
    let domMutated = false;
    for (const block of blocks) {
      let span = existing.get(block.id);
      if (!span) {
        span = element.ownerDocument.createElement('span');
        span.dataset.blockId = block.id;
        domMutated = true;
      }
      const editable = block.kind === 'visible' ? 'true' : 'false';
      if (span.contentEditable !== editable) {
        span.contentEditable = editable;
        domMutated = true;
      }
      if (block.kind === 'restricted') {
        if (span.textContent !== (block.placeholder ?? '')) {
          span.textContent = block.placeholder ?? '';
          domMutated = true;
        }
        span.dataset.restricted = 'true';
        delete span.dataset.annotationFamilies;
        delete span.dataset.annotationIds;
      } else if (Array.isArray(document?.ranges)) {
        delete span.dataset.restricted;
        delete span.dataset.annotationFamilies;
        delete span.dataset.annotationIds;
        const text = displayed.has(block.id) ? displayed.get(block.id) : block.text;
        if (paintDisplay(span, document, block, text, queued?.blockId === block.id ? draftEdit : null)) domMutated = true;
      } else {
        delete span.dataset.restricted;
        const annotationIds = [...new Set(block.annotationIds ?? [])].sort();
        const families = [...new Set(annotationIds.map((id) => annotationFamilies.get(id)).filter(Boolean))].sort();
        if (families.length) span.dataset.annotationFamilies = families.join(' ');
        else delete span.dataset.annotationFamilies;
        if (annotationIds.length) span.dataset.annotationIds = annotationIds.join(' ');
        else delete span.dataset.annotationIds;
        const text = displayed.has(block.id) ? displayed.get(block.id) : block.text;
        if (span.textContent !== text) {
          span.textContent = text;
          domMutated = true;
        }
      }
      const index = blocks.indexOf(block);
      if (element.children[index] !== span) {
        element.insertBefore(span, element.children[index] ?? null);
        domMutated = true;
      }
    }
    const blockIds = new Set(blocks.map((block) => block.id));
    for (const child of [...element.children]) {
      if (!blockIds.has(child.dataset.blockId)) {
        child.remove();
        domMutated = true;
      }
    }
    rendering = false;
    if (caretAfterRender) setCaret(caretAfterRender.blockId, caretAfterRender.offset);
    else if (domMutated && caretBeforeRender?.from && caretBeforeRender.to
      && caretBeforeRender.from.blockId === caretBeforeRender.to.blockId
      && caretBeforeRender.from.offset === caretBeforeRender.to.offset) {
      const caretBlock = visible.find((candidate) => candidate.id === caretBeforeRender.from.blockId);
      if (caretBlock) {
        const span = blockSpan(element, caretBlock.id);
        const length = span ? (span.textContent ?? '').length : caretBlock.text.length;
        setCaret(caretBeforeRender.from.blockId, Math.max(0, Math.min(caretBeforeRender.from.offset, length)));
      }
    }
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
    if (queued.text === '') {
      // Optimistic prune: drop the hollow span immediately; server confirms via v12.
      if (span) span.remove();
      moveCaretOffPrunedBlock(block.id);
    } else {
      if (span) paintDisplay(span, session.document, block, queued.text,
        queued.blockId === block.id ? changedRange(queued.baseText, queued.text) : null);
      setCaret(block.id, from + text.length);
    }
    rendering = false;
    clearTimeout(queuedTimer);
    queuedTimer = setTimeout(flushQueued, 100);
  }

  function pendingBlockId() {
    if (composing) return composing.blockId;
    // Empty drafts are already pruned locally and must not lock neighbors.
    if (queued && queued.text !== '') return queued.blockId;
    if (submitted && submitted.text !== '') return submitted.blockId;
    return null;
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

  /** Boundary delete onto a neighbor while a locking draft is still settling. */
  function deferBoundaryEdit(edit) {
    const target = pendingBlockId();
    if (!target || target === edit.blockId) return false;
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
    const localText = pendingDraftText(block.id) ?? block.text;
    if ((previous && offset !== 0) || (!previous && offset !== localText.length)) return null;
    let step = previous ? -1 : 1;
    let cursor = index + step;
    while (cursor >= 0 && cursor < blocks.length) {
      const adjacent = blocks[cursor];
      if (isLocallyPruned(adjacent)) {
        cursor += step;
        continue;
      }
      const text = pendingDraftText(adjacent.id) ?? adjacent.text;
      if (!text) {
        cursor += step;
        continue;
      }
      return previous
        ? { block: adjacent, from: scalarStart(text, text.length - 1), to: text.length }
        : { block: adjacent, from: 0, to: scalarEnd(text, 1) };
    }
    return null;
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
    // A redacted recipient reads a display text with placeholders whose display
    // offsets do not map onto the wire offsets the session authors. Fail closed
    // instead of submitting mis-translated offsets (matching the redaction
    // coords invariant and the no-fold-for-redacted-recipients stance).
    if ((block.redactions?.length ?? 0) > 0) {
      onError(new Error('annotated text is redacted in this view and cannot be edited'));
      return;
    }
    if (event.inputType === 'insertText' || event.inputType === 'insertFromPaste' || event.inputType === 'insertFromDrop') {
      if (mutationIsBlocked(block.id)) return;
      const text = event.dataTransfer?.getData?.('text/plain') ?? event.data ?? '';
      if (text) bufferEdit(block, selected.from.offset, selected.to.offset, text);
      return;
    }
    const text = pendingDraftText(block.id) ?? block.text;
    // Caret left on a hollow pruned block: hop immediately.
    const onPrunedEmpty = text === '' && selected.from.offset === selected.to.offset;
    const range = onPrunedEmpty ? null : deleteRange(event.inputType, text, selected.from.offset, selected.to.offset);
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
    if ((block?.redactions?.length ?? 0) > 0) {
      blockedComposition = true;
      event.preventDefault();
      render();
      onError(new Error('annotated text is redacted in this view and cannot be edited'));
      return;
    }
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

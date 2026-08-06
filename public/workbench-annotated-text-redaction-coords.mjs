// Pure display-space walks over public recipient redaction markers
// `{ start, end: start, placeholder }`. Zero-width at `start` in stripped text;
// rendered placeholder occupies `placeholder.length` in the editor DOM.

function displayInterval(redaction, displayed) {
  const start = redaction.start + displayed;
  return { start, end: start + redaction.placeholder.length, nextDisplayed: displayed + redaction.placeholder.length };
}

/** Map a display caret/selection offset onto wire (stripped-text) coordinates. */
export function displayToWirePosition(value, redactions = []) {
  let displayed = 0;
  for (const redaction of redactions) {
    const { start, end, nextDisplayed } = displayInterval(redaction, displayed);
    if (value.offset < start) break;
    if (value.offset === start) return { ...value, offset: redaction.start, affinity: 'left' };
    if (value.offset < end) {
      const error = new TypeError('annotated text placeholder is not editable');
      error.code = 'position-redacted';
      throw error;
    }
    if (value.offset === end) return { ...value, offset: redaction.start, affinity: 'right' };
    displayed = nextDisplayed;
  }
  return { ...value, offset: value.offset - displayed };
}

/**
 * Classify a display offset against placeholders.
 * Returns `{ kind: 'left'|'interior'|'right'|'plain', offset, affinity? }`.
 * Interior is not a legal caret; callers return null.
 */
export function classifyDisplayOffset(offset, redactions = []) {
  let displayed = 0;
  for (const redaction of redactions) {
    const { start, end, nextDisplayed } = displayInterval(redaction, displayed);
    if (offset === start) return { kind: 'left', offset, affinity: 'left' };
    if (offset > start && offset < end) return { kind: 'interior', offset };
    if (offset === end) return { kind: 'right', offset, affinity: 'right' };
    displayed = nextDisplayed;
  }
  return { kind: 'plain', offset };
}

/** True when [fromOffset, toOffset] overlaps any placeholder interior/edge span. */
export function selectionCrossesDisplayRedaction(fromOffset, toOffset, redactions = []) {
  let displayed = 0;
  for (const redaction of redactions) {
    const { start, end, nextDisplayed } = displayInterval(redaction, displayed);
    if (fromOffset < end && toOffset > start) return true;
    displayed = nextDisplayed;
  }
  return false;
}

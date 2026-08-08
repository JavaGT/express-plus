// Document-wide display↔wire coordinate mapping for recipient redaction
// markers (issue #33 step 8). Coordinate spaces:
//
//   canonical  — the server text before recipient projection (not addressed
//                here: the recipient receives the projected document only);
//   wire       — the recipient's document.text, with redacted intervals
//                removed;
//   display    — the wire text as the editor renders it: each redaction
//                placeholder occupies placeholder.length display columns at
//                the display image of its wire start.
//
// A marker { start, end, placeholder } is zero-width in wire space
// (start === end); its placeholder renders as `placeholder` text at the
// display image of `start`. Markers must be sorted by `start`. Every function
// is pure and redaction lists are never mutated.

function displayInterval(redaction, displayed) {
  const start = redaction.start + displayed;
  return { start, end: start + redaction.placeholder.length, nextDisplayed: displayed + redaction.placeholder.length };
}

/** Wire → display. `value` is { offset, affinity? }. A wire offset that lands
 * exactly on a placeholder start maps to its left edge ('left' affinity) or
 * right edge ('right' affinity); a missing affinity chooses the left edge. */
export function wireToDisplayPosition(value, redactions = []) {
  let displayed = 0;
  for (const redaction of redactions) {
    if (value.offset < redaction.start) break;
    if (value.offset === redaction.start) {
      return {
        ...value,
        offset: displayed + redaction.start + (value.affinity === 'right' ? redaction.placeholder.length : 0),
        affinity: value.affinity === 'right' ? 'right' : 'left',
      };
    }
    displayed += redaction.placeholder.length;
  }
  return { ...value, offset: value.offset + displayed };
}

/** Display → wire. Throws TypeError when the offset is inside a placeholder
 * (an interior is not a legal caret). */
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

/** True when [fromOffset, toOffset] (display) overlaps any placeholder interior/edge span. */
export function selectionCrossesDisplayRedaction(fromOffset, toOffset, redactions = []) {
  let displayed = 0;
  for (const redaction of redactions) {
    const { start, end, nextDisplayed } = displayInterval(redaction, displayed);
    if (fromOffset < end && toOffset > start) return true;
    displayed = nextDisplayed;
  }
  return false;
}

/** Total display width contributed by the placeholders, to back the display
 * length of a rendered wire text out to its wire length. */
export function placeholderDisplayWidth(redactions = []) {
  let total = 0;
  for (const redaction of redactions) total += redaction.placeholder.length;
  return total;
}

import { projectAnnotatedTextForRecipient } from './annotated-text-recipient-projection.mjs';

function fail(message) { throw new Error(`annotated-text caret projection: ${message}`); }

function exact(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    fail(`${label} has invalid shape`);
  }
}

function splitsSurrogate(text, offset) {
  if (offset <= 0 || offset >= text.length) return false;
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

// Converts an internal caret location to its only recipient-visible form. The
// caret is ONE absolute UTF-16 offset into the canonical text; there are no
// blocks. The snapshot projector is deliberately reused so protection decisions
// cannot drift. When any redaction is present, the visible text cannot safely
// locate the caret, so only a deterministic edge (start/end) with the opaque
// presence token is disclosed — never the offset or any protected text.
export function projectAnnotatedTextCaretForRecipient(canonical, descriptor, decisions, caret, presence) {
  exact(caret, ['offset'], 'caret');
  if (!Number.isSafeInteger(caret.offset) || caret.offset < 0) {
    fail('caret location is invalid');
  }
  if (typeof presence !== 'string' || presence.length === 0 || presence.length > 256) {
    fail('presence token is invalid');
  }
  if (typeof canonical?.text !== 'string' || caret.offset > canonical.text.length || splitsSurrogate(canonical.text, caret.offset)) {
    fail('caret location is outside the canonical text');
  }

  const projected = projectAnnotatedTextForRecipient(canonical, descriptor, decisions);
  if (projected.restricted || projected.redactions?.length) {
    // The caret exists but cannot be safely located in the visible text. The
    // edge MUST be recipient-independent: a half-split decision would leak a
    // midpoint oracle against the hidden canonical length. Always pin 'start'
    // (fail closed); the recipient only learns that a presence exists.
    return Object.freeze({ kind: 'edge', presence, edge: 'start' });
  }
  return Object.freeze({ kind: 'caret', presence, offset: caret.offset });
}

import { projectAnnotatedTextForRecipient } from './annotated-text-recipient-projection.ts';

type CaretProjection =
  | { readonly kind: 'edge'; readonly presence: string; readonly edge: 'start' }
  | { readonly kind: 'caret'; readonly presence: string; readonly offset: number }
  | { readonly kind: 'selection'; readonly presence: string; readonly from: number; readonly to: number };

interface CanonicalAnnotation {
  id: string;
  family: string;
  fields: Record<string, any>;
  owner?: string;
  protectedTargetIds?: string[];
}

interface CanonicalRange {
  annotationId: string;
  start: number;
  end: number;
}

interface CanonicalMeasurement {
  id: string;
  family: string;
  formatVersion: number;
  payload: any;
}

interface CanonicalOrphan {
  id: string;
  family: string;
  fields: Record<string, any>;
  savedQuote: string;
  savedRange: [number, number];
  owner?: string;
}

interface CanonicalAnnotatedText {
  kind: string;
  version: number;
  text: string;
  annotations: CanonicalAnnotation[];
  ranges: CanonicalRange[];
  measurements: CanonicalMeasurement[];
  capabilityHints: string[];
  orphans?: CanonicalOrphan[];
}

interface ProtectorDecisions {
  version: number;
  protectors: Array<{ protectorId: string; outcome: string }>;
  capabilityHints: string[];
}

function fail(message: string): never { throw new Error(`annotated-text caret projection: ${message}`); }

function exact(value: unknown, keys: readonly string[], label: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    fail(`${label} has invalid shape`);
  }
}

function splitsSurrogate(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false;
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

// Converts an internal caret location to its only recipient-visible form. The
// caret is ONE absolute UTF-16 offset into the canonical text; there are no
// blocks. A session may instead carry a selection (`{ from, to }`), which the
// same projection turns into a recipient-visible `{ kind: 'selection' }` range.
// The snapshot projector is deliberately reused so protection decisions
// cannot drift. When any redaction is present, the visible text cannot safely
// locate the caret or selection, so only a deterministic edge (start/end) with
// the opaque presence token is disclosed — never the offsets or any protected
// text.
export function projectAnnotatedTextCaretForRecipient(canonical: CanonicalAnnotatedText, descriptor: any, decisions: ProtectorDecisions, caret: { offset: number; selection?: { from: number; to: number } }, presence: string): CaretProjection {
  if (!caret || typeof caret !== 'object' || Array.isArray(caret)
    || (Object.keys(caret).length !== 1 && (Object.keys(caret).length !== 2 || !Object.hasOwn(caret, 'selection')))
    || !Object.hasOwn(caret, 'offset')) {
    fail('caret location is invalid');
  }
  if (!Number.isSafeInteger(caret.offset) || caret.offset < 0) {
    fail('caret location is invalid');
  }
  if (typeof presence !== 'string' || presence.length === 0 || presence.length > 256) {
    fail('presence token is invalid');
  }
  if (typeof canonical?.text !== 'string' || caret.offset > canonical.text.length || splitsSurrogate(canonical.text, caret.offset)) {
    fail('caret location is outside the canonical text');
  }
  let selection: { from: number; to: number } | null = null;
  if (caret.selection !== undefined) {
    exact(caret.selection, ['from', 'to'], 'caret selection');
    if (!Number.isSafeInteger(caret.selection.from) || !Number.isSafeInteger(caret.selection.to)
      || caret.selection.from < 0 || caret.selection.to > canonical.text.length
      || caret.selection.from > caret.selection.to
      || splitsSurrogate(canonical.text, caret.selection.from) || splitsSurrogate(canonical.text, caret.selection.to)) {
      fail('caret selection is outside the canonical text');
    }
    selection = caret.selection;
  }

  const projected = projectAnnotatedTextForRecipient(canonical, descriptor, decisions);
  if (projected.restricted || projected.redactions?.length) {
    // The caret exists but cannot be safely located in the visible text. The
    // edge MUST be recipient-independent: a half-split decision would leak a
    // midpoint oracle against the hidden canonical length. Always pin 'start'
    // (fail closed); the recipient only learns that a presence exists.
    return Object.freeze({ kind: 'edge', presence, edge: 'start' });
  }
  if (selection) {
    return Object.freeze({ kind: 'selection', presence, from: selection.from, to: selection.to });
  }
  return Object.freeze({ kind: 'caret', presence, offset: caret.offset });
}

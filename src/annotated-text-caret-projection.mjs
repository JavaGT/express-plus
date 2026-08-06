import { projectAnnotatedTextForRecipient } from './annotated-text-recipient-projection.mjs';
import { getAnnotatedTextCompiledMetadata } from './annotated-text-field.mjs';

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
// snapshot projector is deliberately reused so protection decisions cannot drift.
export function projectAnnotatedTextCaretForRecipient(canonical, descriptor, decisions, caret, presence) {
  const meta = getAnnotatedTextCompiledMetadata(descriptor);
  if (!meta?.caret) fail('descriptor has no compiled caret declaration');
  exact(caret, ['blockId', 'offset'], 'caret');
  if (typeof caret.blockId !== 'string' || !Number.isSafeInteger(caret.offset) || caret.offset < 0) {
    fail('caret location is invalid');
  }
  if (typeof presence !== 'string' || presence.length === 0 || presence.length > 256) {
    fail('presence token is invalid');
  }
  const block = canonical?.blocks?.find((candidate) => candidate?.id === caret.blockId);
  if (!block || typeof block.text !== 'string' || caret.offset > block.text.length || splitsSurrogate(block.text, caret.offset)) {
    fail('caret location is outside the canonical block');
  }

  const projected = projectAnnotatedTextForRecipient(canonical, descriptor, decisions);
  const recipientBlock = projected.blocks.find((candidate) => candidate.id === caret.blockId);
  if (!recipientBlock) fail('recipient block is missing');
  if (recipientBlock.kind === 'visible') {
    // The recipient shape deliberately omits hidden width. Until presence has a
    // redaction-aware coordinate map, no canonical caret in such a block can be
    // safely located, even when it appears to precede a marker.
    if (recipientBlock.redactions?.length) return Object.freeze({ kind: 'edge', presence, blockId: caret.blockId, edge: 'start' });
    return Object.freeze({ kind: 'caret', presence, blockId: caret.blockId, offset: caret.offset });
  }
  if (recipientBlock.kind === 'restricted') {
    const edge = caret.offset <= block.text.length - caret.offset ? 'start' : 'end';
    return Object.freeze({ kind: 'edge', presence, blockId: caret.blockId, edge });
  }
  fail('recipient block is invalid');
}

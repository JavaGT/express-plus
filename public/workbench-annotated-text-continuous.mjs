// Blockless continuous annotated-text family (issue #33).
//
// The RGA checkpoint already holds the whole document text; blocks were a
// redundant partition imposed by elementKeys ownership. This module drops the
// block layer entirely: one continuous text stream per document, absolute
// UTF-16 offsets, and annotations as character ranges resolved to structural
// endpoints.
//
// Endpoint semantics (the load-bearing correction): stored endpoints keep their
// historical `basisFrontier` and are positioned against the CURRENT checkpoint
// as long as the current frontier DOMINATES the basis and the anchor element
// still exists (including as a tombstone). They are never rebased to the latest
// frontier — that would silently move boundary semantics after ordinary edits.

import {
  applyTextOp,
  createTextState,
  materializeText as materializeCheckpointText,
  restoreTextCheckpoint,
  textCheckpoint,
} from './workbench-annotated-text.mjs';

const trustedFamilies = new WeakSet();

function fail(message) {
  throw new Error(`annotated-text continuous: ${message}`);
}

function trustFamily(family) {
  const trusted = deepFreeze(family);
  trustedFamilies.add(trusted);
  return trusted;
}

function assertTrustedFamily(family) {
  if (!family || typeof family !== 'object' || !trustedFamilies.has(family)) {
    fail('family must be created or restored by this module');
  }
  return family;
}

/** A continuous family is the document id + the RGA checkpoint. No blocks. */
export function restoreTextFamily(familyCheckpoint) {
  if (!familyCheckpoint || typeof familyCheckpoint !== 'object' || Array.isArray(familyCheckpoint)) {
    fail('family checkpoint must be a non-array object');
  }
  const allowedKeys = new Set(['id', 'checkpoint']);
  for (const key of Object.keys(familyCheckpoint)) {
    if (!allowedKeys.has(key)) fail(`unknown family checkpoint key: ${key}`);
  }
  if (typeof familyCheckpoint.id !== 'string' || familyCheckpoint.id.length === 0) {
    fail('family checkpoint id must be a non-empty string');
  }
  const checkpoint = restoreTextCheckpoint(familyCheckpoint.checkpoint);
  return trustFamily({ id: familyCheckpoint.id, checkpoint });
}

export function createTextFamily(id, checkpoint) {
  if (typeof id !== 'string' || id.length === 0) fail('document id must be a non-empty string');
  const restored = restoreTextCheckpoint(checkpoint);
  return trustFamily({ id, checkpoint: restored });
}

/**
 * Seed a continuous family from plain text (one root element; blocks are gone).
 * A single multi-scalar element is the canonical import shape — mid-element
 * offset edits resolve correctly (verified) — so import is O(1), not O(chars).
 */
export function importTextToFamily(documentId, actor, text) {
  if (typeof documentId !== 'string' || documentId.length === 0) fail('document id must be a non-empty string');
  if (typeof actor !== 'string' || !/^[0-9a-f]{32}$/.test(actor)) fail('import actor must be a 32-hex id');
  if (typeof text !== 'string') fail('import text must be a string');
  let state = createTextState();
  if (text.length > 0) {
    state = applyTextOp(state, ['workbench.text', 1, [actor, 1], 1, [], ['insert', ['root'], text]]);
  }
  return createTextFamily(documentId, textCheckpoint(state));
}

export function textFamilyCheckpoint(family) {
  assertTrustedFamily(family);
  return trustFamily({ id: family.id, checkpoint: family.checkpoint });
}

export function materializeText(family) {
  return materializeCheckpointText(assertTrustedFamily(family).checkpoint);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object') return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/** Apply a whole-document text operation, returning the next family. */
export function applyTextOperation(family, operation) {
  assertTrustedFamily(family);
  const nextState = applyTextOp(family.checkpoint, operation);
  return trustFamily({ id: family.id, checkpoint: nextState });
}

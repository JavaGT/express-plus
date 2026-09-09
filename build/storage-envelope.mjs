// storage-envelope.ts — the gzip storage envelope for heavy committed-log
// payload text (`_Log.eventData` and `_ActionReceipt.resultData`).
//
// Transcript-style payloads compress 20-27x (measured 2026-09-09 on the Scope
// dev database: 137.6 MB of receipt resultData → 7.7 MB stored, 66.4 MB of
// operated eventData → 3.2 MB stored, gzip -9 + base64). This module is the
// ONE definition of the stored envelope bytes; a second copy of the prefix or
// the codec is exactly the seam where stored formats drift.
//
// Stored format (version carried by the prefix, mirroring the
// `__workbenchCompactedResult` versioning style): the envelope is the ASCII
// prefix `wb.gz1:` followed by base64(gzip(utf8(plain))). The value stays
// TEXT in a TEXT column — no schema migration, `LENGTH()`/`json_valid()`
// keep their meaning, and a plain JSON payload can never collide with the
// prefix (JSON text always starts with `{`, `[`, `"`, a digit, or a literal).
// Reads of an envelope unwrap to the exact original text; reads of anything
// else pass through unchanged, so old plain rows and new envelope rows
// coexist (mixed histories). An envelope that carries the prefix but fails
// to decode is CORRUPTION: decode throws a fixed opaque error and never
// falls back to treating the bytes as plain JSON — fail closed, so a
// tampered row can never masquerade as a replayable ack.
//
// The knob is opt-in per database handle: `workbench({
// payloadCompressionMinBytes })` attaches a policy to the app's handle and
// only writes above the threshold are enveloped. With no policy attached
// every byte of the write and read paths is exactly as before.

import { gzipSync, gunzipSync } from 'node:zlib';



/** Version-1 envelope prefix; the `1` is the format version. */
export const STORAGE_ENVELOPE_PREFIX = 'wb.gz1:';






// Per-handle policy, mirroring the WeakMap pattern of driver.prepareCached and
// application-action-http's dispatchers: the policy travels with the database
// handle, so every committed-log write/read reached through that handle sees
// the same storage decision and no module-level global state exists.
const storageEnvelopePolicies = new WeakMap                               ();

// attachStorageEnvelopePolicy — opt a database handle into envelope writes
// (or pass null to detach, restoring the exact legacy behavior). Attaching is
// idempotent: the last policy wins and read paths are unaffected (they handle
// mixed histories either way).
export function attachStorageEnvelopePolicy(db          , policy                              )       {
  if (policy === null) {
    storageEnvelopePolicies.delete(db          );
    return;
  }
  storageEnvelopePolicies.set(db          , policy);
}

// storageEnvelopePolicyFor — the handle's write policy, or undefined when the
// handle never opted in (the default; byte-parity with the legacy format).
export function storageEnvelopePolicyFor(db          )                                    {
  return storageEnvelopePolicies.get(db          );
}

// isStorageEnvelope — the O(1) mixed-history probe. Only a string carrying
// the exact prefix counts; any other value (plain JSON text, null, a foreign
// BLOB) is not an envelope.
export function isStorageEnvelope(value         )                  {
  return typeof value === 'string' && value.startsWith(STORAGE_ENVELOPE_PREFIX);
}

// encodeStorageEnvelope — the ONE envelope constructor. Deterministic for a
// given input (fixed level, no embedded timestamp), so the same payload always
// produces the same stored bytes.
export function encodeStorageEnvelope(plain        )         {
  const compressed = gzipSync(Buffer.from(plain, 'utf8'), { level: 9 });
  return STORAGE_ENVELOPE_PREFIX + compressed.toString('base64');
}

// decodeStorageEnvelope — unwrap an envelope to its exact original text.
// Malformed envelopes (bad base64, non-gzip bytes, truncated stream) throw
// the fixed opaque signature: callers must never see a silently-degraded
// payload, because a receipt resultData carries the commit acknowledgement and
// a _Log eventData row is replay authority.
export function decodeStorageEnvelope(envelope        )         {
  if (!isStorageEnvelope(envelope)) {
    throw new Error('malformed gzip storage envelope: missing wb.gz1: prefix');
  }
  const base64 = envelope.slice(STORAGE_ENVELOPE_PREFIX.length);
  let plainBytes        ;
  try {
    plainBytes = gunzipSync(Buffer.from(base64, 'base64'));
  } catch {
    throw new Error('malformed gzip storage envelope: payload does not decompress');
  }
  return plainBytes.toString('utf8');
}

// unwrapStoredPayloadText — the read-path entry: envelope rows unwrap to the
// exact original text, everything else is returned unchanged so legacy plain
// rows keep their exact legacy decode path.
export function unwrapStoredPayloadText(value         )         {
  return isStorageEnvelope(value) ? decodeStorageEnvelope(value) : value          ;
}

// maybeEnvelopeStoredPayload — the write-path entry: apply the handle's policy
// (if any) to one serialized payload text. No policy or below the threshold →
// the text is returned unchanged (byte-identical legacy bytes).
export function maybeEnvelopeStoredPayload(db          , text        )         {
  const policy = storageEnvelopePolicyFor(db);
  if (!policy || Buffer.byteLength(text, 'utf8') < policy.minBytes) return text;
  return encodeStorageEnvelope(text);
}

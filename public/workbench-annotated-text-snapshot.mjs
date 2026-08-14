import { createAnnotatedTextSnapshotSessionBinding, getAnnotatedTextSnapshotSessionBinding } from './workbench-annotated-text-snapshot-internal.mjs';
import { projectEndpointToOffset } from './workbench-annotated-text-continuous.mjs';

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) { for (const child of value) deepFreeze(child); return Object.freeze(value); }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function isStructuralEndpoint(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.hasOwn(value, 'point') && Object.hasOwn(value, 'basisFrontier');
}

function materializeRecipientRanges(snapshot, family) {
  if (snapshot.version === 1) {
    return snapshot.ranges.map((range) => {
      if (!range || typeof range !== 'object' || Array.isArray(range)
        || typeof range.annotationId !== 'string'
        || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)) {
        throw new Error('annotatedText snapshot: v1 ranges must be offset pairs');
      }
      if (isStructuralEndpoint(range.start) || isStructuralEndpoint(range.end)) {
        throw new Error('annotatedText snapshot: v1 envelope must not carry endpoints');
      }
      return { annotationId: range.annotationId, start: range.start, end: range.end };
    });
  }
  if (snapshot.version !== 2) {
    throw new Error('annotatedText snapshot: snapshot must be a complete blockless recipient envelope');
  }
  if (!family) {
    throw new Error('annotatedText snapshot: v2 endpoints require a family replica');
  }
  return snapshot.ranges.map((range) => {
    if (!range || typeof range !== 'object' || Array.isArray(range)
      || typeof range.annotationId !== 'string'
      || !isStructuralEndpoint(range.start) || !isStructuralEndpoint(range.end)) {
      throw new Error('annotatedText snapshot: v2 ranges must be structural endpoints');
    }
    return { annotationId: range.annotationId, start: range.start, end: range.end };
  });
}

export function isOffsetRange(range) {
  return !!range && typeof range === 'object' && !Array.isArray(range)
    && Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end);
}

/** Resolve one document range to UTF-16 offsets. Offset-form (redacted) passes through. */
export function resolveRangeOffsets(range, family) {
  if (isOffsetRange(range)) return { annotationId: range.annotationId, start: range.start, end: range.end };
  if (!family) throw new Error('annotated text range resolution requires a family replica');
  return {
    annotationId: range.annotationId,
    start: projectEndpointToOffset(family, range.start),
    end: projectEndpointToOffset(family, range.end),
  };
}

export function resolveRangesOffsets(ranges, family) {
  if (!Array.isArray(ranges)) return ranges;
  return ranges.map((range) => resolveRangeOffsets(range, family));
}

/** Resolve ranges or return null so render can fail closed to snapshot recovery. */
export function tryResolveRangesOffsets(ranges, family) {
  if (!Array.isArray(ranges)) return ranges;
  const resolved = [];
  for (const range of ranges) {
    try {
      resolved.push(resolveRangeOffsets(range, family));
    } catch {
      return null;
    }
  }
  return resolved;
}

/**
 * Shift redacted/offset ranges through one absolute-offset edit. Anchored
 * ranges are returned unchanged — callers resolve them against a family.
 */
export function shiftOffsetRangesOverEdit(ranges, from, to, text) {
  if (!Array.isArray(ranges) || ranges.length === 0) return ranges;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) return ranges;
  const insertion = from === to;
  const delta = text.length - (to - from);
  if (insertion && text.length === 0) return ranges;
  return ranges.map((range) => {
    if (!isOffsetRange(range)) return range;
    let start;
    let end;
    if (insertion) {
      if (range.end <= from) {
        start = range.start;
        end = range.end;
      } else if (range.start <= from) {
        start = range.start;
        end = range.end + text.length;
      } else {
        start = range.start + text.length;
        end = range.end + text.length;
      }
    } else {
      start = range.start < from ? range.start : range.start >= to ? range.start + delta : from + text.length;
      end = range.end <= from ? range.end : range.end > to ? range.end + delta : from + text.length;
    }
    return Object.freeze({ ...range, start, end });
  });
}

export function shiftOffsetRangesOverText(ranges, beforeText, afterText) {
  if (!Array.isArray(ranges) || ranges.length === 0 || beforeText === afterText) return ranges;
  let from = 0;
  while (from < beforeText.length && from < afterText.length && beforeText[from] === afterText[from]) from += 1;
  let beforeEnd = beforeText.length;
  let afterEnd = afterText.length;
  while (beforeEnd > from && afterEnd > from && beforeText[beforeEnd - 1] === afterText[afterEnd - 1]) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  from = scalarStart(beforeText, scalarStart(afterText, from));
  beforeEnd = scalarEnd(beforeText, beforeEnd);
  return shiftOffsetRangesOverEdit(ranges, from, beforeEnd, afterText.slice(from, scalarEnd(afterText, afterEnd)));
}

export function materializeAnnotatedTextSnapshot(snapshot, handle, options = {}) {
  const binding = getAnnotatedTextSnapshotSessionBinding(options?.binding ?? options) ?? createAnnotatedTextSnapshotSessionBinding();
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) ||
      snapshot.kind !== 'workbench.annotatedText.recipient' ||
      (snapshot.version !== 1 && snapshot.version !== 2) ||
      typeof snapshot.text !== 'string' || !Array.isArray(snapshot.ranges) ||
      !Array.isArray(snapshot.annotations) || !Array.isArray(snapshot.measurements)) {
    throw new Error('annotatedText snapshot: snapshot must be a complete blockless recipient envelope');
  }
  if (snapshot.orphans !== undefined && !Array.isArray(snapshot.orphans)) throw new Error('annotatedText snapshot: orphans must be an array');
  if (snapshot.redactions !== undefined && !Array.isArray(snapshot.redactions)) throw new Error('annotatedText snapshot: redactions must be an array');
  for (const marker of snapshot.redactions ?? []) {
    if (!marker || typeof marker !== 'object' || Array.isArray(marker)
      || !Number.isSafeInteger(marker.start) || !Number.isSafeInteger(marker.end)
      || marker.start < 0 || marker.end < marker.start || marker.end > snapshot.text.length
      || typeof marker.placeholder !== 'string') {
      throw new Error('annotatedText snapshot: redaction markers must be in-bounds { start, end, placeholder } intervals');
    }
  }
  // Fail closed on an undeclared annotation family: the handle names the
  // declared families, and a hostile/malformed stream must not smuggle an
  // annotation the application never declared.
  const declaredFamilies = handle?.annotations ? new Set(Object.keys(handle.annotations)) : null;
  if (declaredFamilies !== null) {
    for (const annotation of snapshot.annotations) {
      if (!declaredFamilies.has(annotation.family)) {
        throw new Error(`annotatedText snapshot: annotation family '${annotation.family}' is not declared`);
      }
    }
  }
  // Capability hints are recipient-specific, snapshot-fenced guidance derived
  // from current authorization. A compiled handle validates the hint vocabulary;
  // callers without a handle retain the plain projected names.
  const declaredCapabilities = handle?.capabilities ? new Set(Object.keys(handle.capabilities)) : null;
  let capabilities = snapshot.capabilityHints ? [...snapshot.capabilityHints] : [];
  if (declaredCapabilities !== null) {
    if (!Array.isArray(snapshot.capabilityHints)) {
      throw new Error('annotatedText snapshot: capabilityHints must be an array when capabilities are declared');
    }
    const seen = new Set();
    const names = [];
    for (const hint of snapshot.capabilityHints) {
      if (typeof hint !== 'string' || !declaredCapabilities.has(hint) || seen.has(hint)) {
        throw new Error(`annotatedText snapshot: capability hint '${String(hint)}' is not a unique declared capability`);
      }
      seen.add(hint);
      names.push(hint);
    }
    capabilities = names;
  }
  const document = deepFreeze({
    kind: 'workbench.annotatedText.recipient', version: snapshot.version,
    text: snapshot.text,
    ranges: materializeRecipientRanges(snapshot, options.family),
    annotations: snapshot.annotations.map((a) => ({ id: a.id, family: a.family, fields: { ...a.fields }, ...(a.owner ? { owner: a.owner } : {}) })),
    orphans: (snapshot.orphans ?? []).map((o) => ({ id: o.id, family: o.family, fields: { ...o.fields }, savedQuote: o.savedQuote, ...(o.owner ? { owner: o.owner } : {}) })),
    measurements: (snapshot.measurements ?? []).map((m) => ({ ...m })),
    // Authoring capability signal: the wire envelope carries `capabilityHints`
    // (granted capability names); project them into the public `capabilities`
    // array the host uses to expose authoring affordances. A restricted
    // recipient is review-only and exposes `capabilities: null`.
    capabilities: snapshot.restricted ? null : capabilities,
    ...(snapshot.restricted ? { restricted: true } : {}),
    ...(snapshot.redactions?.length ? { redactions: snapshot.redactions.map((r) => ({ start: r.start, end: r.end, placeholder: r.placeholder })) } : {}),
  });
  binding.document = document;
  binding.generation = (binding.generation ?? 0) + 1;
  return document;
}

// Optimistic document-bound projections (issue #33 blockless). Text edits are
// DISPOSITION-NEUTRAL: a range the edit collapses to zero width stays collapsed
// and its annotation stays attached, so the visible placeholder never infers
// the server's delete-vs-orphan policy. Explicit annotation removal is already
// a precise delete of a stable annotation id, so its pending projection can
// remove that id immediately; the authoritative delivery snapshot still owns
// reconciliation and restores the preimage if the action is rejected.
export function projectPendingAnnotatedTextDocument(document, action, _ignored) {
  const edit = action?.payload?.version === 9 ? action.payload.edit : null;
  if (!edit) return document;
  if (edit.kind === 'annotation.remove') {
    const annotationId = edit.annotationId;
    if (typeof annotationId !== 'string' || annotationId.length === 0 || !Array.isArray(document?.annotations)) return document;
    const annotations = document.annotations.filter((annotation) => annotation?.id !== annotationId);
    const ranges = Array.isArray(document.ranges)
      ? document.ranges.filter((range) => range?.annotationId !== annotationId)
      : document.ranges;
    const orphans = Array.isArray(document.orphans)
      ? document.orphans.filter((orphan) => orphan?.id !== annotationId)
      : document.orphans;
    if (annotations.length === document.annotations.length
      && ranges?.length === document.ranges?.length
      && orphans?.length === document.orphans?.length) return document;
    return Object.freeze({
      ...document,
      annotations: Object.freeze(annotations),
      ...(Array.isArray(document.ranges) ? { ranges: Object.freeze(ranges) } : {}),
      ...(Array.isArray(document.orphans) ? { orphans: Object.freeze(orphans) } : {}),
    });
  }
  if (edit.kind !== 'text.insert' && edit.kind !== 'text.delete' && edit.kind !== 'text.replace') return document;
  const text = document?.text ?? '';
  const start = edit.kind === 'text.insert' ? edit.at.offset : edit.from.offset;
  const end = edit.kind === 'text.insert' ? start : edit.to.offset;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > text.length) return document;
  if (splitsSurrogate(text, start) || splitsSurrogate(text, end)) return document;
  const inserted = edit.kind === 'text.insert' || edit.kind === 'text.replace' ? edit.text : '';
  const spliced = `${text.slice(0, start)}${inserted}${text.slice(end)}`;
  const ranges = Array.isArray(document.ranges) && document.ranges.some((range) => isOffsetRange(range))
    ? Object.freeze(shiftOffsetRangesOverEdit(document.ranges, start, end, inserted))
    : document.ranges;
  return Object.freeze({
    ...document,
    text: spliced,
    ...(Array.isArray(document.ranges) ? { ranges } : {}),
  });
}

function splitsSurrogate(text, offset) {
  return offset > 0 && offset < text.length
    && text.charCodeAt(offset - 1) >= 0xd800 && text.charCodeAt(offset - 1) <= 0xdbff
    && text.charCodeAt(offset) >= 0xdc00 && text.charCodeAt(offset) <= 0xdfff;
}

// Bounds may land between a surrogate pair when the transition crosses an
// astral character; back off to the scalar boundary so offsets stay on
// character edges (mirrors the editor's changedRange scalar handling).
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

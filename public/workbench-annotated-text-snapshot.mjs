import { createAnnotatedTextSnapshotSessionBinding, getAnnotatedTextSnapshotSessionBinding } from './workbench-annotated-text-snapshot-internal.mjs';
import { projectEndpointToOffset, resolveOffsetToEndpoint } from './workbench-annotated-text-continuous.mjs';

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
//
// annotation.apply / reapply projects a pending annotation at document-absolute
// authoring offsets. The projection resolves those offsets to recipient-v2
// anchored endpoints against the family (holding the historical basis, per
// Decision 0025) so the placeholder range stays positional across a concurrent
// foreign text edit instead of bolting an offset range onto the anchored
// document. Reapply by stable annotation id is an upsert — the annotation and
// its one range replace any same-id rows, never duplicate. An apply that cannot
// be anchored (no family, unresolvable offsets) is left UNPROJECTED (returns
// the document unchanged) rather than guessing a mutation; the session surfaces
// the inapplicable apply as a conflict/failure to the caller.
export function projectPendingAnnotatedTextDocument(document, action, options) {
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
  if (edit.kind === 'annotation.apply') {
    return projectAnnotationApply(document, edit, options);
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

// Whether `document` carries recipient-v2 anchored endpoints (the authoring
// surface) rather than redacted/legacy offset ranges.
function isAnchoredDocument(document) {
  return document?.version === 2;
}

// A document with no ranges array yet is treated as offset-form only when it
// is not a v2 recipient. This keeps the v1/redacted splice path unchanged.
function projectAnnotationApply(document, edit, options) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return document;
  const annotation = edit.annotation;
  if (!annotation || typeof annotation !== 'object' || Array.isArray(annotation)
    || typeof annotation.id !== 'string' || annotation.id.length === 0
    || typeof annotation.family !== 'string' || annotation.family.length === 0
    || !annotation.fields || typeof annotation.fields !== 'object' || Array.isArray(annotation.fields)
    || !edit.from || typeof edit.from !== 'object' || Array.isArray(edit.from)
    || !edit.to || typeof edit.to !== 'object' || Array.isArray(edit.to)
    || typeof edit.from.offset !== 'number' || typeof edit.to.offset !== 'number') {
    return document;
  }
  const fromOffset = edit.from.offset;
  const toOffset = edit.to.offset;
  const fromAffinity = edit.from.affinity === 'left' ? 'left' : 'right';
  const toAffinity = edit.to.affinity === 'left' ? 'left' : 'right';
  const text = document.text ?? '';
  // The mirror of the server plan: an apply must be a forward, non-empty,
  // in-bounds selection or it is inapplicable (never guess).
  if (!Number.isSafeInteger(fromOffset) || !Number.isSafeInteger(toOffset)
    || fromOffset < 0 || toOffset < fromOffset || toOffset > text.length
    || fromOffset === toOffset) {
    return document;
  }

  let range;
  const preResolved = options?.range;
  const family = options?.family;
  if (preResolved && isStructuralEndpoint(preResolved.start) && isStructuralEndpoint(preResolved.end)) {
    // The session captured the authoring-basis anchored endpoints once; place
    // them verbatim so a foreign fold that re-projects this pending apply does
    // not re-anchor against a shifted basis.
    range = Object.freeze({ annotationId: annotation.id, start: preResolved.start, end: preResolved.end });
  } else if (family && isAnchoredDocument(document)) {
    // Anchor the authoring offsets against the given family (the session's
    // authoring basis). Resolution failures are inapplicable — leave unprojected.
    try {
      range = Object.freeze({
        annotationId: annotation.id,
        start: resolveOffsetToEndpoint(family, fromOffset, family.checkpoint.frontier, fromAffinity),
        end: resolveOffsetToEndpoint(family, toOffset, family.checkpoint.frontier, toAffinity),
      });
    } catch {
      return document;
    }
  } else if (!isAnchoredDocument(document)) {
    // v1 / redacted offset surface: apply as a plain offset range.
    range = Object.freeze({ annotationId: annotation.id, start: fromOffset, end: toOffset });
  } else {
    // Anchored document without a family or pre-resolved range: cannot anchor.
    return document;
  }

  // Upsert the annotation entity by stable id (replace fields, never append a
  // duplicate row for the same annotation).
  const annotations = Array.isArray(document.annotations) ? [...document.annotations] : [];
  const existingIndex = annotations.findIndex((candidate) => candidate?.id === annotation.id);
  const projectedAnnotation = Object.freeze({
    id: annotation.id,
    family: annotation.family,
    fields: Object.freeze({ ...annotation.fields }),
    ...(annotation.owner ? { owner: annotation.owner } : {}),
  });
  const nextAnnotations = existingIndex >= 0
    ? annotations.map((candidate, index) => (index === existingIndex ? projectedAnnotation : candidate))
    : [...annotations, projectedAnnotation];

  // Upsert the range by stable id: same-id replace keeps exactly ONE range at
  // the latest selection (mirrors planTextRangeApply), never a duplicate.
  const ranges = Array.isArray(document.ranges) ? document.ranges : [];
  const nextRanges = Object.freeze([
    ...ranges.filter((candidate) => candidate?.annotationId !== annotation.id),
    range,
  ]);

  return Object.freeze({
    ...document,
    annotations: Object.freeze(nextAnnotations),
    ...(Array.isArray(document.ranges) ? { ranges: nextRanges } : {}),
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

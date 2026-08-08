import { createAnnotatedTextSnapshotSessionBinding, getAnnotatedTextSnapshotSessionBinding } from './workbench-annotated-text-snapshot-internal.mjs';

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) { for (const child of value) deepFreeze(child); return Object.freeze(value); }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function materializeAnnotatedTextSnapshot(snapshot, handle, options = {}) {
  const binding = getAnnotatedTextSnapshotSessionBinding({ binding: options?.binding }) ?? createAnnotatedTextSnapshotSessionBinding();
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) ||
      snapshot.kind !== 'workbench.annotatedText.recipient' || snapshot.version !== 1 ||
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
  const document = deepFreeze({
    kind: 'workbench.annotatedText.recipient', version: 1,
    text: snapshot.text,
    ranges: snapshot.ranges.map((r) => ({ annotationId: r.annotationId, start: r.start, end: r.end })),
    annotations: snapshot.annotations.map((a) => ({ id: a.id, family: a.family, fields: { ...a.fields }, ...(a.owner ? { owner: a.owner } : {}) })),
    orphans: (snapshot.orphans ?? []).map((o) => ({ id: o.id, family: o.family, fields: { ...o.fields }, savedQuote: o.savedQuote, ...(o.owner ? { owner: o.owner } : {}) })),
    measurements: (snapshot.measurements ?? []).map((m) => ({ ...m })),
    ...(snapshot.restricted ? { restricted: true } : {}),
    ...(snapshot.redactions?.length ? { redactions: snapshot.redactions.map((r) => ({ start: r.start, end: r.end, placeholder: r.placeholder })) } : {}),
  });
  binding.document = document;
  binding.generation = (binding.generation ?? 0) + 1;
  return document;
}

// Optimistic absolute-offset text splice (issue #33 blockless).
export function projectPendingAnnotatedTextDocument(document, action, _ignored) {
  const edit = action?.payload?.version === 9 ? action.payload.edit : null;
  if (!edit || (edit.kind !== 'text.insert' && edit.kind !== 'text.delete' && edit.kind !== 'text.replace')) return document;
  const text = document?.text ?? '';
  const start = edit.kind === 'text.insert' ? edit.at.offset : edit.from.offset;
  const end = edit.kind === 'text.insert' ? start : edit.to.offset;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > text.length) return document;
  const spliced = edit.kind === 'text.insert'
    ? `${text.slice(0, start)}${edit.text}${text.slice(start)}`
    : `${text.slice(0, start)}${edit.kind === 'text.replace' ? edit.text : ''}${text.slice(end)}`;
  const projected = projectRangesOverEdit(document.ranges, start, end, edit.kind === 'text.insert' || edit.kind === 'text.replace' ? edit.text : '');
  const next = Object.freeze({
    ...document,
    text: spliced,
    ...(Array.isArray(document.ranges) ? { ranges: projected } : {}),
  });
  return pruneEmptiedRanges(next);
}

/**
 * Project annotation ranges through one absolute-offset edit that replaces
 * [from, to) with `text` (an insertion has from === to). Ranges are absolute
 * in the document text. Boundary affinity matches the family semantics:
 * an insertion AT a range's start joins the range (its end grows), an
 * insertion at its end stays outside, and a covering replace collapses the
 * range to zero width. The authoritative server projection corrects any
 * approximation on the next fold or snapshot.
 */
export function projectRangesOverEdit(ranges, from, to, text) {
  if (!Array.isArray(ranges) || ranges.length === 0) return ranges;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) return ranges;
  const insertion = from === to;
  const delta = text.length - (to - from);
  if (insertion && text.length === 0) return ranges;
  return ranges.map((range) => {
    if (!range || typeof range !== 'object' || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)) return range;
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

/** Drop ranges a text edit collapsed to zero width and their annotations. */
export function pruneEmptiedRanges(document) {
  if (!Array.isArray(document.ranges) || document.ranges.length === 0) return document;
  const live = document.ranges.some((range) => range.start >= range.end);
  if (!live) return document;
  const retained = document.ranges.filter((range) => range.start < range.end);
  const retainedIds = new Set(retained.map((range) => range.annotationId));
  return Object.freeze({
    ...document,
    ranges: retained,
    annotations: (document.annotations ?? []).filter((annotation) => retainedIds.has(annotation.id)),
  });
}

/** Project ranges through the text transition from one materialized text to the next. */
export function projectRangesOverText(ranges, beforeText, afterText) {
  if (!Array.isArray(ranges) || ranges.length === 0 || beforeText === afterText) return ranges;
  let from = 0;
  while (from < beforeText.length && from < afterText.length && beforeText[from] === afterText[from]) from += 1;
  let beforeEnd = beforeText.length;
  let afterEnd = afterText.length;
  while (beforeEnd > from && afterEnd > from && beforeText[beforeEnd - 1] === afterText[afterEnd - 1]) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  return projectRangesOverEdit(ranges, from, beforeEnd, afterText.slice(from, afterEnd));
}

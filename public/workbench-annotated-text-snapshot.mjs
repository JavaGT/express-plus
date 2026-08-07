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
  return Object.freeze({ ...document, text: spliced });
}

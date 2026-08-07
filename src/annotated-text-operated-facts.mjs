// Shared packing of the v13 operated-event facts bag (issue #33 blockless).
// Plan and admit mint the same exact key set so the envelope cannot drift
// between the two producers. Blocks are gone: annotations carry one document
// range, and text edits are document-wide (no block identities).

export function packOperatedFacts(data) {
  const arrays = (value) => Object.freeze(value ?? []);
  return Object.freeze({
    family: data.family ?? null,
    annotation: data.annotation ?? null,
    ranges: arrays(data.ranges),
    measurements: arrays(data.measurements),
    lifecycle: data.lifecycle ?? null,
    result: data.result ?? null,
    emptiedAnnotations: arrays(data.emptiedAnnotations),
    actorId: data.actorId ?? null,
    selectedRange: data.selectedRange ?? null,
    removedAnnotationIds: arrays(data.removedAnnotationIds),
  });
}

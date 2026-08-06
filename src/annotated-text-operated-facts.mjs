// Shared packing of the v13 operated-event facts bag. Plan and admit mint the
// same exact key set so the envelope cannot drift between the two producers.

export function packOperatedFacts(data) {
  const arrays = (value) => Object.freeze(value ?? []);
  return Object.freeze({
    family: data.family ?? null,
    block: data.block ?? null,
    blocks: arrays(data.blocks),
    annotation: data.annotation ?? null,
    memberships: arrays(data.memberships),
    measurements: arrays(data.measurements),
    lifecycle: data.lifecycle ?? null,
    result: data.result ?? null,
    prunedBlockIds: arrays(data.prunedBlockIds),
    emptiedAnnotations: arrays(data.emptiedAnnotations),
    actorId: data.actorId ?? null,
    selectedBlockId: data.selectedBlockId ?? null,
    selectedBlockIds: arrays(data.selectedBlockIds),
    splitBlockIds: arrays(data.splitBlockIds),
    splitOps: arrays(data.splitOps),
    groupMembership: data.groupMembership ?? null,
    preimage: arrays(data.preimage),
    postimage: arrays(data.postimage),
    removedAnnotationIds: arrays(data.removedAnnotationIds),
  });
}

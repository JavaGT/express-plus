import { getAnnotatedTextCompiledMetadata } from './annotated-text-field.mjs';

function fail(message) { throw new Error(`annotated-text recipient projection: ${message}`); }

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function exact(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) fail(`${label} has invalid shape`);
}

// This is an internal-only canonical input. T4 protection targets never cross
// this seam into the recipient document.
export function projectAnnotatedTextForRecipient(canonical, descriptor, decisions) {
  const meta = getAnnotatedTextCompiledMetadata(descriptor);
  if (!meta) fail('descriptor must be compiled');
  const canonicalKeys = ['kind', 'version', 'blocks', 'annotations', 'memberships', 'measurements', 'capabilities', 'groupMemberships'];
  exact(canonical, canonicalKeys, 'canonical');
  exact(decisions, ['version', 'protectors', 'capabilityHints'], 'decisions');
  if (canonical.kind !== 'workbench.annotatedText.canonical' || canonical.version !== 1 || decisions.version !== 1 ||
      !Array.isArray(canonical.blocks) || !Array.isArray(canonical.annotations) || !Array.isArray(canonical.memberships) ||
      !Array.isArray(canonical.measurements) || !Array.isArray(canonical.groupMemberships) || !Array.isArray(decisions.protectors) || !Array.isArray(decisions.capabilityHints)) fail('invalid version or collection');

  const annotations = new Map();
  for (const annotation of canonical.annotations) {
    const keys = annotation?.protectedTargetIds === undefined ? ['id', 'family', 'fields'] : ['id', 'family', 'fields', 'protectedTargetIds'];
    exact(annotation, keys, 'annotation');
    if (typeof annotation.id !== 'string' || annotations.has(annotation.id) || !Object.hasOwn(meta.annotationHandles, annotation.family)) fail('annotation is invalid');
    if (annotation.protectedTargetIds !== undefined && (!Object.hasOwn(meta.protectingFamilies, annotation.family) || !Array.isArray(annotation.protectedTargetIds) || annotation.protectedTargetIds.some((id, i, all) => typeof id !== 'string' || (i > 0 && all[i - 1] >= id)))) fail('protector targets are invalid');
    annotations.set(annotation.id, annotation);
  }
  const blockIds = new Set();
  const canonicalGroupIds = new Set();
  for (const block of canonical.blocks) {
    exact(block, ['id', 'groupId', 'text', 'fields', 'annotationIds'], 'block');
    if (typeof block.id !== 'string' || blockIds.has(block.id) || typeof block.groupId !== 'string' || block.groupId.length === 0 || typeof block.text !== 'string' || !Array.isArray(block.annotationIds)) fail('block is invalid');
    blockIds.add(block.id);
    canonicalGroupIds.add(block.groupId);
  }
  const blockFamilies = new Set(Object.entries(meta.annotationHandles).filter(([, handle]) => handle.appliesTo === 'block').map(([family]) => family));
  const groupFamilies = new Set(Object.entries(meta.annotationHandles).filter(([, handle]) => handle.appliesTo === 'block-group').map(([family]) => family));
  for (const membership of canonical.memberships) {
    exact(membership, ['annotationId', 'blockId', 'ordinal'], 'membership');
    const annotation = annotations.get(membership.annotationId);
    if (!annotation || !blockFamilies.has(annotation.family) || !blockIds.has(membership.blockId) || !Number.isSafeInteger(membership.ordinal) || membership.ordinal < 0) fail('membership is invalid');
  }
  const groupMemberships = canonical.groupMemberships;
  for (const membership of groupMemberships) {
    exact(membership, ['annotationId', 'groupId', 'ordinal'], 'group membership');
    const annotation = annotations.get(membership.annotationId);
    if (!annotation || !groupFamilies.has(annotation.family) || !canonicalGroupIds.has(membership.groupId) || !Number.isSafeInteger(membership.ordinal) || membership.ordinal < 0) fail('group membership is invalid');
  }
  for (const annotationId of annotations.keys()) {
    if (!canonical.memberships.some((membership) => membership.annotationId === annotationId) && !groupMemberships.some((membership) => membership.annotationId === annotationId)) fail('canonical annotation has no membership');
  }
  const canonicalMemberships = new Map();
  for (const membership of canonical.memberships) {
    const key = `${membership.annotationId}\u0000${membership.blockId}`;
    if (canonicalMemberships.has(key)) fail('canonical memberships must be unique per annotation and block');
    canonicalMemberships.set(key, membership);
  }
  const groupMembershipKeys = new Set();
  for (const membership of groupMemberships) {
    const key = `${membership.annotationId}\u0000${membership.groupId}`;
    if (groupMembershipKeys.has(key)) fail('canonical group memberships must be unique per annotation and group');
    groupMembershipKeys.add(key);
  }
  for (const groupId of new Set(groupMemberships.map((membership) => membership.groupId))) {
    const families = new Set();
    for (const membership of groupMemberships.filter((entry) => entry.groupId === groupId)) {
      const family = annotations.get(membership.annotationId).family;
      if (meta.annotationHandles[family].cardinality === 'one') {
        if (families.has(family)) fail('cardinality-one group annotation is duplicated');
        families.add(family);
      }
    }
  }
  for (const block of canonical.blocks) {
    const expected = canonical.memberships.filter((m) => m.blockId === block.id).map((m) => m.annotationId).sort();
    const actual = [...block.annotationIds].sort();
    if (new Set(actual).size !== actual.length || actual.some((id) => !annotations.has(id) || !blockFamilies.has(annotations.get(id).family)) || JSON.stringify(actual) !== JSON.stringify(expected)) fail('canonical block memberships disagree');
  }
  const measurementIds = new Set();
  for (const measurement of canonical.measurements) {
    exact(measurement, ['id', 'blockId', 'family', 'formatVersion', 'payload'], 'measurement');
    if (typeof measurement.id !== 'string' || measurementIds.has(measurement.id) || !blockIds.has(measurement.blockId) ||
        !Object.hasOwn(meta.measurementHandles, measurement.family) || !Number.isSafeInteger(measurement.formatVersion) || measurement.formatVersion < 1) fail('measurement is invalid');
    measurementIds.add(measurement.id);
  }
  const active = new Map();
  for (const annotation of annotations.values()) {
    if (!Object.hasOwn(meta.protectingFamilies, annotation.family) || !annotation.protectedTargetIds?.length) continue;
    const own = new Set(canonical.memberships.filter((m) => m.annotationId === annotation.id).map((m) => m.blockId));
    const target = new Set(canonical.memberships.filter((m) => annotation.protectedTargetIds.includes(m.annotationId)).map((m) => m.blockId));
    const overlap = new Set([...own].filter((id) => target.has(id)));
    if (overlap.size) active.set(annotation.id, overlap);
  }
  const outcomes = new Map();
  for (const decision of decisions.protectors) {
    exact(decision, ['protectorId', 'outcome'], 'protector decision');
    if (!active.has(decision.protectorId) || outcomes.has(decision.protectorId) || !['allow', 'deny'].includes(decision.outcome)) fail('protector decisions must exactly match active protectors');
    outcomes.set(decision.protectorId, decision.outcome);
  }
  if (outcomes.size !== active.size) fail('protector decisions must exactly match active protectors');
  const capabilityHints = new Set();
  for (const hint of decisions.capabilityHints) {
    if (typeof hint !== 'string' || !Object.hasOwn(meta.capabilityHandles ?? {}, hint) || capabilityHints.has(hint)) fail('capability hints must be unique declared capabilities');
    capabilityHints.add(hint);
  }
  const restricted = new Set();
  for (const [id, blocks] of active) if (outcomes.get(id) === 'deny') for (const blockId of blocks) restricted.add(blockId);
  const memberships = canonical.memberships.filter((m) => !restricted.has(m.blockId) && !Object.hasOwn(meta.protectingFamilies, annotations.get(m.annotationId).family));
  const groups = [];
  const groupsByCanonicalId = new Map();
  for (const block of canonical.blocks) {
    if (restricted.has(block.id)) {
      groups.push(null);
       groupsByCanonicalId.set(block.groupId, null);
      continue;
    }
    const id = block.groupId;
    let group = groups.at(-1);
    if (!group || group.canonicalId !== id) { group = { id: `group-${groups.filter(Boolean).length}`, canonicalId: id, blockIds: [], annotationIds: [] }; groups.push(group); }
    if (groupsByCanonicalId.has(id)) {
      const prior = groupsByCanonicalId.get(id);
      groupsByCanonicalId.set(id, prior === group ? group : null);
    } else {
      groupsByCanonicalId.set(id, group);
    }
    group.blockIds.push(block.id);
  }
  for (const membership of groupMemberships) {
    const group = groupsByCanonicalId.get(membership.groupId);
    if (group && !Object.hasOwn(meta.protectingFamilies, annotations.get(membership.annotationId).family)) group.annotationIds.push(membership.annotationId);
  }
  for (const group of groups.filter(Boolean)) { delete group.canonicalId; group.annotationIds = [...new Set(group.annotationIds)]; }
  const retainedIds = new Set([...memberships.map((m) => m.annotationId), ...groups.filter(Boolean).flatMap((group) => group.annotationIds)]);
  return freeze({
    kind: 'workbench.annotatedText.recipient', version: 1,
    blockGroups: groups.filter(Boolean),
    blocks: canonical.blocks.map((block) => restricted.has(block.id)
      ? { kind: 'restricted', id: block.id, placeholder: meta.restrictedPlaceholder }
      : { kind: 'visible', id: block.id, text: block.text, fields: { ...block.fields }, annotationIds: memberships.filter((m) => m.blockId === block.id).map((m) => m.annotationId) }),
    annotations: [...annotations.values()].filter((a) => retainedIds.has(a.id)).map(({ id, family, fields }) => ({ id, family, fields: { ...fields } })),
    memberships: memberships.map((m) => ({ ...m })),
    measurements: canonical.measurements.filter((m) => !restricted.has(m.blockId)).map((m) => ({ ...m })),
    capabilityHints: [...capabilityHints].filter((hint) => !restricted.size || hint !== 'body.read'),
  });
}

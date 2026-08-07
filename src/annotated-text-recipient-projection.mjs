import { getAnnotatedTextCompiledMetadata } from './annotated-text-field.mjs';

// The public projection deliberately exposes only zero-width visible markers.
// Snapshot minting needs the corresponding canonical intervals to bind an
// authoring token, but those intervals must never serialize with the recipient.
const recipientRedactionIntervals = new WeakMap();

export function authoringRedactionsForRecipient(recipient, blockId) {
  return recipientRedactionIntervals.get(recipient)?.get(blockId) ?? [];
}

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
  // Canonical annotated-text inputs are internal, but caret tests and older
  // internal callers predate orphan state. Treat their absence as no orphans;
  // snapshots always supply the field.
  const canonicalKeys = ['kind', 'version', 'blocks', 'annotations', 'memberships', 'measurements', 'capabilities', 'groupMemberships'];
  if (Object.hasOwn(canonical ?? {}, 'orphans')) canonicalKeys.push('orphans');
  exact(canonical, canonicalKeys, 'canonical');
  exact(decisions, ['version', 'protectors', 'capabilityHints'], 'decisions');
  if (canonical.kind !== 'workbench.annotatedText.canonical' || canonical.version !== 1 || decisions.version !== 1 ||
      !Array.isArray(canonical.blocks) || !Array.isArray(canonical.annotations) || !Array.isArray(canonical.memberships) ||
      !Array.isArray(canonical.measurements) || !Array.isArray(canonical.groupMemberships) || (canonical.orphans !== undefined && !Array.isArray(canonical.orphans)) || !Array.isArray(decisions.protectors) || !Array.isArray(decisions.capabilityHints)) fail('invalid version or collection');

  const annotations = new Map();
  for (const annotation of canonical.annotations) {
    const keys = annotation?.protectedTargetIds === undefined
      ? (annotation?.owner === undefined ? ['id', 'family', 'fields'] : ['id', 'family', 'fields', 'owner'])
      : (annotation?.owner === undefined ? ['id', 'family', 'fields', 'protectedTargetIds'] : ['id', 'family', 'fields', 'owner', 'protectedTargetIds']);
    exact(annotation, keys, 'annotation');
    if (typeof annotation.id !== 'string' || annotations.has(annotation.id) || !Object.hasOwn(meta.annotationHandles, annotation.family)) fail('annotation is invalid');
    if (annotation.owner !== undefined && (typeof annotation.owner !== 'string' || annotation.owner.length === 0)) fail('annotation owner is invalid');
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
  const rangeFamilies = new Set(Object.entries(meta.annotationHandles).filter(([, handle]) => handle.appliesTo === 'text-range').map(([family]) => family));
  const blockCarriedFamilies = new Set([...blockFamilies, ...rangeFamilies]);
  const groupFamilies = new Set(Object.entries(meta.annotationHandles).filter(([, handle]) => handle.appliesTo === 'block-group').map(([family]) => family));
  for (const membership of canonical.memberships) {
    const rangeKeys = membership?.start === undefined && membership?.end === undefined
      ? ['annotationId', 'blockId', 'ordinal']
      : ['annotationId', 'blockId', 'ordinal', 'start', 'end'];
    exact(membership, rangeKeys, 'membership');
    const annotation = annotations.get(membership.annotationId);
    const block = canonical.blocks.find((candidate) => candidate.id === membership.blockId);
    if (!annotation || !blockCarriedFamilies.has(annotation.family) || !block || !Number.isSafeInteger(membership.ordinal) || membership.ordinal < 0 ||
        (membership.start !== undefined && (!Number.isSafeInteger(membership.start) || !Number.isSafeInteger(membership.end) || membership.start < 0 || membership.end <= membership.start || membership.end > block.text.length))) fail('membership is invalid');
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
  const orphanIds = new Set();
  const disclosableOrphans = [];
  for (const orphan of canonical.orphans ?? []) {
    exact(orphan, orphan?.owner === undefined ? ['id', 'family', 'fields', 'savedQuote', 'membershipBlockIds'] : ['id', 'family', 'fields', 'owner', 'savedQuote', 'membershipBlockIds'], 'orphan');
    if (orphan.owner !== undefined && (typeof orphan.owner !== 'string' || orphan.owner.length === 0)) fail('orphan owner is invalid');
    if (typeof orphan.id !== 'string' || orphanIds.has(orphan.id) || !Object.hasOwn(meta.annotationHandles, orphan.family) || meta.annotationHandles[orphan.family].appliesTo !== 'block' || typeof orphan.savedQuote !== 'string' ||
        !Array.isArray(orphan.membershipBlockIds) || orphan.membershipBlockIds.length === 0 || orphan.membershipBlockIds.some((id) => typeof id !== 'string' || id.length === 0) || new Set(orphan.membershipBlockIds).size !== orphan.membershipBlockIds.length) fail('orphan is invalid');
    if (annotations.has(orphan.id)) fail('orphan id conflicts with active annotation');
    orphanIds.add(orphan.id);
    // last_memberships may still name blocks later pruned by another removal.
    // Missing anchors are non-disclosable history, not a document-wide failure.
    if (orphan.membershipBlockIds.every((id) => blockIds.has(id))) disclosableOrphans.push(orphan);
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
    if (new Set(actual).size !== actual.length || actual.some((id) => !annotations.has(id) || !blockCarriedFamilies.has(annotations.get(id).family)) || JSON.stringify(actual) !== JSON.stringify(expected)) fail('canonical block memberships disagree');
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
    // A protector is active on a block only where it actually protects a target
    // — the protector's range must intersect a protected target's range on the
    // same block. Same-block co-membership alone is insufficient: a protector
    // and a target on the same block with disjoint ranges protect nothing there.
    // Range-less (whole-block) memberships are treated as covering the block.
    const ownMemberships = canonical.memberships.filter((m) => m.annotationId === annotation.id);
    const targetMemberships = canonical.memberships.filter((m) => annotation.protectedTargetIds.includes(m.annotationId));
    const overlappingBlocks = new Set();
    for (const own of ownMemberships) {
      for (const target of targetMemberships) {
        if (own.blockId !== target.blockId) continue;
        const ownWhole = own.start === undefined || own.end === undefined;
        const targetWhole = target.start === undefined || target.end === undefined;
        const intersects = ownWhole || targetWhole
          || (own.start < target.end && target.start < own.end);
        if (intersects) {
          overlappingBlocks.add(own.blockId);
          break;
        }
      }
    }
    if (overlappingBlocks.size) active.set(annotation.id, overlappingBlocks);
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
  const deniedIntervals = new Map();
  for (const [id, blocks] of active) {
    if (outcomes.get(id) !== 'deny') continue;
    for (const blockId of blocks) {
      const membership = canonicalMemberships.get(`${id}\u0000${blockId}`);
      // Range-less memberships are legacy whole-block spans. Cross-block spans
      // also stay on the existing whole-block path until their projection is
      // designed; only a same-block explicit range is inline-redactable.
      const protectorMemberships = canonical.memberships.filter((entry) => entry.annotationId === id);
      const block = canonical.blocks.find((candidate) => candidate.id === blockId);
      if (membership.start === undefined || protectorMemberships.length !== 1 ||
          (membership.start === 0 && membership.end === block.text.length)) {
        restricted.add(blockId);
        continue;
      }
      const intervals = deniedIntervals.get(blockId) ?? [];
      intervals.push({ start: membership.start, end: membership.end, placeholder: meta.protectingFamilies[annotations.get(id).family].placeholder });
      deniedIntervals.set(blockId, intervals);
    }
  }
  for (const blockId of restricted) deniedIntervals.delete(blockId);
  const redactionsByBlock = new Map();
  for (const [blockId, intervals] of deniedIntervals) {
    const merged = [];
    for (const interval of [...intervals].sort((left, right) => left.start - right.start || right.end - left.end)) {
      const prior = merged.at(-1);
      if (prior && interval.start <= prior.end) {
        prior.end = Math.max(prior.end, interval.end);
      } else {
        merged.push({ ...interval });
      }
    }
    redactionsByBlock.set(blockId, merged);
  }
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
  const visibleBlockIds = new Set(canonical.blocks.filter((block) => !restricted.has(block.id)).map((block) => block.id));
  const authoringRedactions = new Map();
  const visibleLengthByBlock = new Map();
  const visibleBlocks = canonical.blocks.map((block) => {
    if (restricted.has(block.id)) return { kind: 'restricted', id: block.id, placeholder: meta.restrictedPlaceholder };
    const intervals = redactionsByBlock.get(block.id) ?? [];
    let offset = 0;
    let text = '';
    const authoring = [];
    const redactions = intervals.map((interval) => {
      text += block.text.slice(offset, interval.start);
      const start = text.length;
      offset = interval.end;
      authoring.push(Object.freeze({ visibleStart: start, start: interval.start, end: interval.end }));
      return { start, end: start, placeholder: interval.placeholder };
    });
    text += block.text.slice(offset);
    visibleLengthByBlock.set(block.id, text.length);
    if (authoring.length) authoringRedactions.set(block.id, Object.freeze(authoring));
    return { kind: 'visible', id: block.id, text, fields: { ...block.fields }, annotationIds: memberships.filter((m) => m.blockId === block.id).map((m) => m.annotationId), ...(redactions.length ? { redactions } : {}) };
  });

  /** Canonical → recipient-visible offset map for one block, derived from the
   *  inline-redaction compression already applied to its visible text. */
  const visibleOffsetFor = (blockId) => {
    const authoring = authoringRedactions.get(blockId) ?? [];
    return (canonicalOffset) => {
      let hidden = 0;
      for (const interval of authoring) {
        if (canonicalOffset > interval.start) {
          hidden += interval.end - interval.start;
          continue;
        }
        if (canonicalOffset === interval.start) return interval.visibleStart;
        break;
      }
      return canonicalOffset - hidden;
    };
  };

  const rangeMemberships = [];
  for (const membership of memberships) {
    const family = annotations.get(membership.annotationId).family;
    if (!rangeFamilies.has(family)) continue;
    const visibleLength = visibleLengthByBlock.get(membership.blockId);
    if (visibleLength === undefined) continue;
    const toVisible = visibleOffsetFor(membership.blockId);
    if (membership.start === undefined || membership.end === undefined) {
      rangeMemberships.push({ annotationId: membership.annotationId, blockId: membership.blockId, ordinal: membership.ordinal, start: 0, end: visibleLength });
      continue;
    }
    const start = toVisible(membership.start);
    const end = toVisible(membership.end);
    // Fully inside a redaction → no positive visible span. T2 deliberately
    // omits these memberships (ADR 0008 show-through for fully-redacted text
    // ranges is deferred); the annotation drops out of delivery.
    if (end <= start) continue;
    rangeMemberships.push({ annotationId: membership.annotationId, blockId: membership.blockId, ordinal: membership.ordinal, start, end });
  }

  const result = {
    kind: 'workbench.annotatedText.recipient', version: 1,
    blockGroups: groups.filter(Boolean),
    blocks: visibleBlocks,
    annotations: [...annotations.values()].filter((a) => retainedIds.has(a.id)).map(({ id, family, fields, owner }) => ({ id, family, fields: { ...fields }, ...(owner ? { owner } : {}) })),
    // Text-range memberships expose recipient-visible sub-block offsets; all
    // other memberships stay whole-block (coordinates stripped). Canonical
    // ranges and redaction widths never cross this seam.
    memberships: [...memberships.filter((m) => !rangeFamilies.has(annotations.get(m.annotationId).family)).map(({ annotationId, blockId, ordinal }) => ({ annotationId, blockId, ordinal })), ...rangeMemberships],
    measurements: canonical.measurements.filter((m) => !restricted.has(m.blockId) && !redactionsByBlock.has(m.blockId)).map((m) => ({ ...m })),
    capabilityHints: [...capabilityHints].filter((hint) => (!restricted.size && !redactionsByBlock.size) || hint !== 'body.read'),
    // An orphan has no active membership. It is therefore disclosed only when
    // every block that formed its saved quote is currently recipient-visible.
    // Missing/deleted or restricted source blocks fail closed.
    orphans: (canonical.orphans ?? [])
      .filter((orphan) => !Object.hasOwn(meta.protectingFamilies, orphan.family))
       .filter((orphan) => orphan.membershipBlockIds.every((id) => visibleBlockIds.has(id) && !redactionsByBlock.has(id)))
      .map(({ id, family, fields, savedQuote, owner }) => ({ id, family, fields: { ...fields }, savedQuote, ...(owner ? { owner } : {}) })),
  };
  recipientRedactionIntervals.set(result, authoringRedactions);
  return freeze(result);
}

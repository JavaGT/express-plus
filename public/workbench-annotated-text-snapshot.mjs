// Browser materialization accepts only the recipient projection produced by
// Workbench delivery. Canonical protection facts never cross this seam.
// Validates a v1 recipient envelope against a compiled static field handle
// and returns a frozen logical document with public semantic shapes only.
// No physical names, internal encoding, tables, or WeakMap internals leak.
//
// The handle MUST be a compiled static annotatedText field handle (from
// Entity.field) with shape { annotations: object-not-array, measurements:
// object-not-array, capabilities: object|null }. Raw descriptors passed
// to annotatedText() — which have annotations as an array — are rejected.
//
// Public shapes:
//   Block: visible {kind, id, text, fields, annotationIds}
//          | restricted {kind, id, placeholder}
//   Annotation: {id, family, fields}
//   Membership: {annotationId, blockId, ordinal}
//   Measurement: {id, blockId, family, formatVersion, payload}
//   Document: {version, blocks, blockGroups, annotations, memberships, measurements, capabilities}

import { createAnnotatedTextSnapshotSessionBinding, getAnnotatedTextSnapshotSessionBinding } from './workbench-annotated-text-snapshot-internal.mjs';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const OPAQUE_TOKEN = /^[A-Za-z0-9_-]{43}$/;

function exactKeys(value, keys) {
  return Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function opaqueToken(value) {
  return typeof value === 'string' && OPAQUE_TOKEN.test(value);
}

function fail(path, message) {
  throw new Error(`annotatedText snapshot: ${path}: ${message}`);
}

/**
 * Apply the visible, text-only placeholder for one pending v9 authoring action.
 * Authoritative recipient snapshots remain the only reconciliation authority.
 */
export function projectPendingAnnotatedTextDocument(document, action, positionBlocks) {
  const edit = action?.payload?.version === 9 ? action.payload.edit : null;
  if (!edit || (edit.kind !== 'text.insert' && edit.kind !== 'text.delete' && edit.kind !== 'text.replace')) return document;
  const blockId = positionBlocks.get(edit.kind === 'text.insert' ? edit.at.positionToken : edit.from.positionToken);
  if (!blockId || (edit.kind !== 'text.insert' && blockId !== positionBlocks.get(edit.to.positionToken))) return document;
  const index = document.blocks.findIndex((block) => block.kind === 'visible' && block.id === blockId);
  if (index === -1) return document;
  const block = document.blocks[index];
  const start = edit.kind === 'text.insert' ? edit.at.offset : edit.from.offset;
  const end = edit.kind === 'text.insert' ? start : edit.to.offset;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > block.text.length) return document;
  const text = edit.kind === 'text.insert'
    ? `${block.text.slice(0, start)}${edit.text}${block.text.slice(start)}`
    : edit.kind === 'text.replace' ? `${block.text.slice(0, start)}${edit.text}${block.text.slice(end)}` : `${block.text.slice(0, start)}${block.text.slice(end)}`;
  const blocks = [...document.blocks];
  blocks[index] = Object.freeze({ ...block, text });
  return Object.freeze({ ...document, blocks: Object.freeze(blocks) });
}

export function materializeAnnotatedTextSnapshot(snapshot, handle, options) {
  const binding = getAnnotatedTextSnapshotSessionBinding(options) ?? createAnnotatedTextSnapshotSessionBinding();
  if (!snapshot || typeof snapshot !== 'object') {
    fail('', 'snapshot must be a non-null object');
  }
  if (snapshot.kind !== 'workbench.annotatedText.recipient' || snapshot.version !== 1) {
    fail('kind', 'must be a version 1 recipient projection');
  }
  if (typeof handle !== 'object' || handle === null) {
    fail('', 'handle must be a non-null object');
  }

  // Accept only the compiled static field handle: annotations/measurements
  // must be objects (not arrays). Raw annotatedText descriptors have
  // annotations as an array and are rejected.
  if (typeof handle.annotations !== 'object' || handle.annotations === null || Array.isArray(handle.annotations)) {
    fail('handle', 'must be a compiled annotated-text static field handle (rejecting raw descriptor)');
  }
  if (typeof handle.measurements !== 'object' || handle.measurements === null || Array.isArray(handle.measurements)) {
    fail('handle', 'must be a compiled annotated-text static field handle (rejecting raw descriptor)');
  }

  if (!snapshot.blockGroups || !Array.isArray(snapshot.blockGroups)) {
    fail('blockGroups', 'must be a recipient block-group array');
  }

  const declaredAnnotationNames = new Set(Object.keys(handle.annotations));
  const declaredMeasurementNames = new Set(Object.keys(handle.measurements));
  const declaredCapabilityNames = handle.capabilities
    ? new Set(Object.keys(handle.capabilities))
    : new Set();

  // Validate blocks
  if (!Array.isArray(snapshot.blocks)) {
    fail('blocks', 'must be a non-empty array');
  }
  if (snapshot.blocks.length === 0) {
    fail('blocks', 'must contain at least one block');
  }
  const seenBlockIds = new Set();
  const blocks = [];
  for (let i = 0; i < snapshot.blocks.length; i++) {
    const b = snapshot.blocks[i];
    if (!b || typeof b !== 'object' || Array.isArray(b)) {
      fail(`blocks[${i}]`, 'must be a non-null object');
    }
    if (typeof b.id !== 'string' || b.id.length === 0) {
      fail(`blocks[${i}].id`, 'must be a non-empty string');
    }
    if (seenBlockIds.has(b.id)) {
      fail(`blocks[${i}].id`, `duplicate block id '${b.id}'`);
    }
    seenBlockIds.add(b.id);
    if (b.kind === 'restricted') {
      if (Object.keys(b).length !== 3 || typeof b.placeholder !== 'string' || b.placeholder.length === 0) {
        fail(`blocks[${i}]`, 'restricted block must contain only kind, id, and placeholder');
      }
      blocks.push(Object.freeze({ kind: 'restricted', id: b.id, placeholder: b.placeholder }));
      continue;
    }
    if (b.kind !== 'visible' || Object.keys(b).length !== 5 || typeof b.text !== 'string') {
      fail(`blocks[${i}]`, 'visible block must contain only kind, id, text, fields, and annotationIds');
    }
    const fields = b.fields && typeof b.fields === 'object' && !Array.isArray(b.fields)
      ? Object.freeze({ ...b.fields })
      : Object.freeze({});
    const annotationIds = Array.isArray(b.annotationIds)
      ? Object.freeze([...b.annotationIds])
      : Object.freeze([]);
    for (const aid of annotationIds) {
      if (typeof aid !== 'string' || aid.length === 0) {
        fail(`blocks[${i}].annotationIds`, 'each annotationId must be a non-empty string');
      }
    }
    blocks.push(Object.freeze({
      kind: 'visible',
      id: b.id,
      text: b.text,
      fields,
      annotationIds,
    }));
  }

  // Validate annotations
  if (!Array.isArray(snapshot.annotations)) {
    fail('annotations', 'must be an array');
  }
  const seenAnnotationIds = new Set();
  const annotations = [];
  for (let i = 0; i < snapshot.annotations.length; i++) {
    const a = snapshot.annotations[i];
    if (!a || typeof a !== 'object' || Array.isArray(a)) {
      fail(`annotations[${i}]`, 'must be a non-null object');
    }
    if (typeof a.id !== 'string' || a.id.length === 0) {
      fail(`annotations[${i}].id`, 'must be a non-empty string');
    }
    if (seenAnnotationIds.has(a.id)) {
      fail(`annotations[${i}].id`, `duplicate annotation id '${a.id}'`);
    }
    seenAnnotationIds.add(a.id);
    if (typeof a.family !== 'string' || !IDENTIFIER.test(a.family)) {
      fail(`annotations[${i}].family`, 'must be a valid identifier');
    }
    if (!declaredAnnotationNames.has(a.family)) {
      fail(`annotations[${i}].family`, `'${a.family}' is not a declared annotation family`);
    }
    const fields = a.fields && typeof a.fields === 'object' && !Array.isArray(a.fields)
      ? Object.freeze({ ...a.fields })
      : Object.freeze({});
    if (a.owner !== undefined && (typeof a.owner !== 'string' || a.owner.length === 0)) {
      fail(`annotations[${i}].owner`, 'must be a non-empty string when present');
    }
    annotations.push(Object.freeze({
      id: a.id,
      family: a.family,
      fields,
      ...(typeof a.owner === 'string' ? { owner: a.owner } : {}),
    }));
  }

  // Validate memberships — public shape is whole-block {blockId, ordinal}
  if (!Array.isArray(snapshot.memberships)) {
    fail('memberships', 'must be an array');
  }
  const memberships = [];
  for (let i = 0; i < snapshot.memberships.length; i++) {
    const m = snapshot.memberships[i];
    if (!m || typeof m !== 'object' || Array.isArray(m)) {
      fail(`memberships[${i}]`, 'must be a non-null object');
    }
    if (typeof m.annotationId !== 'string' || !seenAnnotationIds.has(m.annotationId)) {
      fail(`memberships[${i}].annotationId`, `must reference a declared annotation`);
    }
    const annotation = annotations.find((candidate) => candidate.id === m.annotationId);
    if (handle.annotations[annotation.family]?.appliesTo !== 'block') {
      fail(`memberships[${i}].annotationId`, `must reference a block annotation`);
    }
    if (typeof m.blockId !== 'string' || !seenBlockIds.has(m.blockId)) {
      fail(`memberships[${i}].blockId`, `must reference a declared block`);
    }
    if (typeof m.ordinal !== 'number' || !Number.isSafeInteger(m.ordinal) || m.ordinal < 0) {
      fail(`memberships[${i}].ordinal`, 'must be a non-negative safe integer');
    }
    memberships.push(Object.freeze({
      annotationId: m.annotationId,
      blockId: m.blockId,
      ordinal: m.ordinal,
    }));
  }

  // Validate that blocks' annotationIds reference real annotations and that
  // every annotation with memberships is listed in the block's annotationIds.
  for (const block of blocks) {
    if (block.kind === 'restricted') continue;
    for (const aid of block.annotationIds) {
      if (!seenAnnotationIds.has(aid)) {
        fail('blocks', `block '${block.id}' annotationIds references unknown annotation '${aid}'`);
      }
      const annotation = annotations.find((candidate) => candidate.id === aid);
      if (handle.annotations[annotation.family]?.appliesTo !== 'block') {
        fail('blocks', `block '${block.id}' annotationIds references a non-block annotation '${aid}'`);
      }
    }
  }
  for (const membership of memberships) {
    const block = blocks.find(b => b.id === membership.blockId);
    if (!block || block.kind === 'restricted') {
      fail('memberships', `restricted block '${membership.blockId}' cannot have memberships`);
    }
    if (!block.annotationIds.includes(membership.annotationId)) {
      fail('memberships', `membership annotation '${membership.annotationId}' not in block '${membership.blockId}' annotationIds`);
    }
  }

  // Recipient groups are the only public carrier of group annotation
  // membership. Restricted blocks and block-level annotations cannot cross
  // this boundary through a group.
  const seenGroupIds = new Set();
  const groupedVisibleBlocks = new Set();
  const blockGroups = [];
  for (let i = 0; i < snapshot.blockGroups.length; i++) {
    const group = snapshot.blockGroups[i];
    if (!group || typeof group !== 'object' || Array.isArray(group)
      || Reflect.ownKeys(group).length !== 3
      || !Object.hasOwn(group, 'id') || !Object.hasOwn(group, 'blockIds') || !Object.hasOwn(group, 'annotationIds')
      || typeof group.id !== 'string' || group.id.length === 0
      || !Array.isArray(group.blockIds) || !Array.isArray(group.annotationIds)) {
      fail(`blockGroups[${i}]`, 'must contain exactly id, blockIds, and annotationIds');
    }
    if (seenGroupIds.has(group.id)) fail(`blockGroups[${i}].id`, `duplicate group id '${group.id}'`);
    seenGroupIds.add(group.id);
    if (group.blockIds.length === 0) fail(`blockGroups[${i}].blockIds`, 'must not be empty');
    const blockIds = [];
    const groupBlockIds = new Set();
    for (const blockId of group.blockIds) {
      if (typeof blockId !== 'string' || !seenBlockIds.has(blockId)) {
        fail(`blockGroups[${i}].blockIds`, 'must reference declared blocks');
      }
      if (groupBlockIds.has(blockId)) fail(`blockGroups[${i}].blockIds`, `duplicate block '${blockId}'`);
      groupBlockIds.add(blockId);
      const block = blocks.find((candidate) => candidate.id === blockId);
      if (block.kind === 'restricted') fail(`blockGroups[${i}].blockIds`, 'restricted blocks cannot belong to groups');
      if (groupedVisibleBlocks.has(blockId)) fail(`blockGroups[${i}].blockIds`, `block '${blockId}' belongs to multiple groups`);
      groupedVisibleBlocks.add(blockId);
      blockIds.push(blockId);
    }
    const annotationIds = [];
    const groupAnnotationIds = new Set();
    for (const annotationId of group.annotationIds) {
      if (typeof annotationId !== 'string' || !seenAnnotationIds.has(annotationId)) {
        fail(`blockGroups[${i}].annotationIds`, 'must reference declared annotations');
      }
      if (groupAnnotationIds.has(annotationId)) fail(`blockGroups[${i}].annotationIds`, `duplicate annotation '${annotationId}'`);
      groupAnnotationIds.add(annotationId);
      annotationIds.push(annotationId);
    }
    blockGroups.push({ group, blockIds, annotationIds });
  }
  for (let i = 0; i < blockGroups.length; i++) {
    for (const annotationId of blockGroups[i].annotationIds) {
      const annotation = annotations.find((candidate) => candidate.id === annotationId);
      if (handle.annotations[annotation.family]?.appliesTo !== 'block-group') {
        fail(`blockGroups[${i}].annotationIds`, `group annotation '${annotationId}' is not declared as a block-group annotation`);
      }
      if (blocks.some((block) => block.kind === 'visible' && block.annotationIds.includes(annotationId))) {
        fail(`blockGroups[${i}].annotationIds`, `group annotation '${annotationId}' cannot be a block annotation`);
      }
    }
  }
  for (const block of blocks) {
    if (block.kind === 'visible' && !groupedVisibleBlocks.has(block.id)) {
      fail('blockGroups', `visible block '${block.id}' must belong to exactly one group`);
    }
  }

  // Validate measurements
  if (!Array.isArray(snapshot.measurements)) {
    fail('measurements', 'must be an array');
  }
  const measurements = [];
  for (let i = 0; i < snapshot.measurements.length; i++) {
    const m = snapshot.measurements[i];
    if (!m || typeof m !== 'object' || Array.isArray(m)) {
      fail(`measurements[${i}]`, 'must be a non-null object');
    }
    if (typeof m.id !== 'string' || m.id.length === 0) {
      fail(`measurements[${i}].id`, 'must be a non-empty string');
    }
    if (typeof m.blockId !== 'string' || !seenBlockIds.has(m.blockId)) {
      fail(`measurements[${i}].blockId`, `must reference a declared block`);
    }
    if (blocks.find(b => b.id === m.blockId)?.kind === 'restricted') {
      fail(`measurements[${i}].blockId`, 'restricted blocks cannot have measurements');
    }
    if (typeof m.family !== 'string' || !IDENTIFIER.test(m.family)) {
      fail(`measurements[${i}].family`, 'must be a valid identifier');
    }
    if (!declaredMeasurementNames.has(m.family)) {
      fail(`measurements[${i}].family`, `'${m.family}' is not a declared measurement family`);
    }
    if (typeof m.formatVersion !== 'number' || !Number.isSafeInteger(m.formatVersion) || m.formatVersion <= 0) {
      fail(`measurements[${i}].formatVersion`, 'must be a positive integer');
    }
    measurements.push(Object.freeze({
      id: m.id,
      blockId: m.blockId,
      family: m.family,
      formatVersion: m.formatVersion,
      payload: m.payload !== undefined ? m.payload : null,
    }));
  }

  // Validate recipient capability hints. They are guidance, not authority.
  let capabilities = null;
  if (declaredCapabilityNames.size > 0) {
    if (!Array.isArray(snapshot.capabilityHints)) {
      fail('capabilityHints', 'must be present when capabilities are declared');
    }
    const capList = [];
    for (const capKey of snapshot.capabilityHints) {
      if (!declaredCapabilityNames.has(capKey)) {
        fail(`capabilityHints.${capKey}`, `'${capKey}' is not a declared capability`);
      }
      if (capList.includes(capKey)) fail('capabilityHints', 'must not contain duplicates');
      capList.push(capKey);
    }
    capabilities = Object.freeze([...capList]);
  }

  const authoring = snapshot.authoring;
  if (authoring !== undefined && (!authoring || typeof authoring !== 'object' || Array.isArray(authoring)
    || !exactKeys(authoring, ['version', 'stream', 'lease', 'snapshot', 'acknowledgementFence', 'positionFrames', 'groupFrames', 'splitResolutions'])
    || authoring.version !== 1 || !opaqueToken(authoring.stream) || !opaqueToken(authoring.lease)
    || !opaqueToken(authoring.snapshot) || new Set([authoring.stream, authoring.lease, authoring.snapshot]).size !== 3
    || !Number.isSafeInteger(authoring.acknowledgementFence) || authoring.acknowledgementFence < 0
    || !Array.isArray(authoring.positionFrames) || !Array.isArray(authoring.groupFrames) || !Array.isArray(authoring.splitResolutions))) fail('authoring', 'must be a complete version 1 envelope');
  const visibleIds = new Set(blocks.filter((block) => block.kind === 'visible').map((block) => block.id));
  const positionTokens = new Map();
  const opaqueTokens = new Set(authoring ? [authoring.stream, authoring.lease, authoring.snapshot] : []);
  for (const frame of authoring?.positionFrames ?? []) {
    if (!frame || typeof frame !== 'object' || Array.isArray(frame) || !exactKeys(frame, ['blockId', 'positionToken'])
      || typeof frame.blockId !== 'string' || !opaqueToken(frame.positionToken) || !visibleIds.has(frame.blockId)
      || positionTokens.has(frame.blockId) || opaqueTokens.has(frame.positionToken)) fail('authoring.positionFrames', 'must exactly name visible blocks with unique opaque tokens');
    positionTokens.set(frame.blockId, frame.positionToken);
    opaqueTokens.add(frame.positionToken);
  }
  if (authoring && positionTokens.size !== visibleIds.size) fail('authoring.positionFrames', 'must exactly match visible blocks');
  const groupTokens = new Map();
  for (let index = 0; index < (authoring?.groupFrames ?? []).length; index += 1) {
    const frame = authoring.groupFrames[index];
    if (!frame || typeof frame !== 'object' || Array.isArray(frame) || !exactKeys(frame, ['groupToken'])
      || !opaqueToken(frame.groupToken) || opaqueTokens.has(frame.groupToken)) fail('authoring.groupFrames', 'must contain unique opaque tokens');
    groupTokens.set(frame.groupToken, blockGroups[index]?.group);
    opaqueTokens.add(frame.groupToken);
  }
  if (authoring && groupTokens.size !== blockGroups.length) fail('authoring.groupFrames', 'must exactly match block groups');
  const splitTokens = new Set();
  for (const entry of authoring?.splitResolutions ?? []) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !exactKeys(entry, ['temporaryBlock', 'blockId'])
      || !opaqueToken(entry.temporaryBlock)
      || typeof entry.blockId !== 'string' || !visibleIds.has(entry.blockId)
      || splitTokens.has(entry.temporaryBlock) || opaqueTokens.has(entry.temporaryBlock)) fail('authoring.splitResolutions', 'must name visible blocks with unique temporary blocks');
    splitTokens.add(entry.temporaryBlock);
    opaqueTokens.add(entry.temporaryBlock);
  }
  const materializedGroupEntries = blockGroups.map(({ group, blockIds, annotationIds }, index) => {
    const materialized = Object.freeze({
      kind: 'workbench.annotatedText.block-group',
      blockIds: Object.freeze(blockIds),
      annotationIds: Object.freeze(annotationIds),
    });
    return { materialized, serverId: authoring ? authoring.groupFrames[index].groupToken : group.id };
  });
  const materializedGroups = Object.freeze(materializedGroupEntries.map(({ materialized }) => materialized));
  binding.generation += 1;
  const document = Object.freeze({
    kind: 'workbench.annotatedText.recipient',
    version: 1,
    blocks: Object.freeze(blocks),
    blockGroups: materializedGroups,
    annotations: Object.freeze(annotations),
    memberships: Object.freeze(memberships),
    measurements: Object.freeze(measurements),
    capabilities,
  });
  binding.document = document;
  if (typeof binding.onBlockGroup === 'function') {
    for (const { materialized, serverId } of materializedGroupEntries) {
      binding.onBlockGroup(materialized, serverId, binding.generation);
    }
  }
  // The public document never carries authoring tokens. The returned binding is
  // session-private and is read only by createAnnotatedTextHttpSession.
  if (authoring) binding.authoring = Object.freeze({ stream: authoring.stream, lease: authoring.lease, snapshot: authoring.snapshot, acknowledgementFence: authoring.acknowledgementFence, positionTokens, groupTokens, splitResolutions: Object.freeze(authoring.splitResolutions.map((entry) => Object.freeze({ ...entry }))) });
  return document;
}

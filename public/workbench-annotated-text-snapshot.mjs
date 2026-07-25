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
//   Block: {id, text, fields, annotationIds}
//   Annotation: {id, family, fields}
//   Membership: {annotationId, blockId, ordinal}
//   Measurement: {id, blockId, family, formatVersion, payload}
//   Document: {version, blocks, annotations, memberships, measurements, capabilities}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function fail(path, message) {
  throw new Error(`annotatedText snapshot: ${path}: ${message}`);
}

export function materializeAnnotatedTextSnapshot(snapshot, handle) {
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
    annotations.push(Object.freeze({
      id: a.id,
      family: a.family,
      fields,
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

  return Object.freeze({
    kind: 'workbench.annotatedText.recipient',
    version: 1,
    blocks: Object.freeze(blocks),
    annotations: Object.freeze(annotations),
    memberships: Object.freeze(memberships),
    measurements: Object.freeze(measurements),
    capabilities,
  });
}

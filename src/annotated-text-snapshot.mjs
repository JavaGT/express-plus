import { deserializeField } from './field-strategy.mjs';
import { materializeBlock, restoreTextFamilyCheckpoint, textFamilyCheckpoint } from './annotated-text-family.mjs';
import { getAnnotatedTextCompiledMetadata, resolveAnnotatedTextOwningScope } from './annotated-text-field.mjs';
import { projectAnnotatedTextForRecipient } from './annotated-text-recipient-projection.mjs';
import { projectAnnotatedTextCaretForRecipient } from './annotated-text-caret-projection.mjs';
import { mayRow, protectingAnnotationCapabilities } from './row-grant.mjs';
import { read } from './grant.mjs';
import { randomUUID } from 'node:crypto';

function fail(message) { throw new Error(`annotated-text snapshot: ${message}`); }
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function requireBlockGroupIds(blocks, groupRows, fieldName) {
  if (groupRows.length !== blocks.length) fail(`field '${fieldName}' blocks do not have exactly one group row`);
  const blockIds = new Set(blocks.map((block) => block.id));
  const groupIds = new Map();
  for (const group of groupRows) {
    if (!blockIds.has(group.block_id) || groupIds.has(group.block_id) || typeof group.group_id !== 'string' || group.group_id.length === 0) {
      fail(`field '${fieldName}' has invalid block group state`);
    }
    groupIds.set(group.block_id, group.group_id);
  }
  if (groupIds.size !== blocks.length) fail(`field '${fieldName}' blocks do not have exactly one group row`);
  return groupIds;
}

function requireGroupMembershipIntegrity(groupMemberships, annotations, groupIds, descriptor, fieldName) {
  const meta = getAnnotatedTextCompiledMetadata(descriptor);
  const groupFamilies = new Set(Object.entries(meta.annotationHandles)
    .filter(([, handle]) => handle.appliesTo === 'block-group').map(([family]) => family));
  const annotationFamilies = new Map(annotations.map((annotation) => [annotation.id, annotation.family]));
  const seen = new Set();
  for (const membership of groupMemberships) {
    const family = annotationFamilies.get(membership.annotation_id);
    if (!family || !groupFamilies.has(family) || !groupIds.has(membership.group_id) ||
        !Number.isSafeInteger(membership.ordinal) || membership.ordinal < 0) {
      fail(`field '${fieldName}' has invalid group membership state`);
    }
    const key = `${membership.annotation_id}\u0000${membership.group_id}`;
    if (seen.has(key)) fail(`field '${fieldName}' has duplicate group membership state`);
    seen.add(key);
    const handle = meta.annotationHandles[family];
    if (handle.cardinality === 'one' && groupMemberships.some((other) => other.group_id === membership.group_id && other.annotation_id !== membership.annotation_id && annotationFamilies.get(other.annotation_id) === family)) {
      fail(`field '${fieldName}' has duplicated cardinality-one group annotation`);
    }
  }
}

// Reads only Workbench-owned annotated-text relations and projects them before
// an HTTP snapshot is serialized. Any malformed state or access failure throws;
// callers deny the entire snapshot rather than falling back to canonical facts.
async function projectAnnotatedText({ db, entity, row, principal, fieldName, descriptor, caret = null, presence = null, mintBasis = true }) {
  const meta = getAnnotatedTextCompiledMetadata(descriptor);
  if (!meta) fail(`field '${fieldName}' is not compiled`);
  const prefix = `${entity.name}_${fieldName}`;
  if (db.prepare(`SELECT 1 FROM ${prefix}_retired WHERE document_id = ?`).get(row.id)) fail(`field '${fieldName}' document is retired`);
  const state = db.prepare(`SELECT family_checkpoint FROM ${prefix}_state WHERE document_id = ?`).get(row.id);
  if (!state) fail(`field '${fieldName}' state is missing`);
  const family = restoreTextFamilyCheckpoint(JSON.parse(state.family_checkpoint));
  const blockRows = db.prepare(`SELECT * FROM ${prefix}_block WHERE document_id = ? ORDER BY position`).all(row.id);
  const groupRows = db.prepare(`SELECT block_id, group_id FROM ${prefix}_block_group WHERE block_id IN (SELECT id FROM ${prefix}_block WHERE document_id = ?)` ).all(row.id);
  const groupIds = requireBlockGroupIds(blockRows, groupRows, fieldName);
  if (blockRows.length !== family.blocks.length) fail(`field '${fieldName}' blocks disagree with checkpoint`);
  const annotations = db.prepare(
    `SELECT annotation.id, annotation.family FROM ${prefix}_annotation AS annotation WHERE annotation.document_id = ? AND (EXISTS (SELECT 1 FROM ${prefix}_membership AS membership WHERE membership.annotation_id = annotation.id) OR EXISTS (SELECT 1 FROM ${prefix}_group_membership AS membership WHERE membership.annotation_id = annotation.id)) ORDER BY annotation.id`,
  ).all(row.id);
  const memberships = db.prepare(
    `SELECT membership.annotation_id, membership.block_id, membership.ordinal FROM ${prefix}_membership AS membership JOIN ${prefix}_annotation AS annotation ON annotation.id = membership.annotation_id WHERE annotation.document_id = ? ORDER BY membership.annotation_id, membership.ordinal`,
  ).all(row.id);
  const groupMemberships = db.prepare(
    `SELECT membership.annotation_id, membership.group_id, membership.ordinal FROM ${prefix}_group_membership AS membership JOIN ${prefix}_annotation AS annotation ON annotation.id = membership.annotation_id WHERE annotation.document_id = ? ORDER BY membership.annotation_id, membership.ordinal`,
  ).all(row.id);
  const targetRows = db.prepare(
    `SELECT edge.annotation_id, edge.target_annotation_id FROM ${prefix}_annotation_protected_target AS edge JOIN ${prefix}_annotation AS annotation ON annotation.id = edge.annotation_id WHERE annotation.document_id = ? ORDER BY edge.annotation_id, edge.target_annotation_id`,
  ).all(row.id);
  const targets = new Map();
  for (const edge of targetRows) targets.set(edge.annotation_id, [...(targets.get(edge.annotation_id) ?? []), edge.target_annotation_id]);
  const canonicalMemberships = memberships.map((membership) => ({ annotationId: membership.annotation_id, blockId: membership.block_id, ordinal: membership.ordinal }));
  const canonicalAnnotations = annotations.map((annotation) => {
    const declared = descriptor.annotations.find((entry) => entry.annotationName === annotation.family);
    if (!declared) fail(`annotation '${annotation.id}' has unknown family`);
    const fields = {};
    const stored = db.prepare(`SELECT * FROM ${prefix}_annotation_${annotation.family} WHERE annotation_id = ?`).get(annotation.id);
    if (!stored && Object.keys(declared.fields).length !== 0) fail(`annotation '${annotation.id}' fields are missing`);
    for (const [name, field] of Object.entries(declared.fields)) fields[name] = deserializeField(field, stored[name]);
    const targetIds = targets.get(annotation.id);
    return targetIds ? { id: annotation.id, family: annotation.family, fields, protectedTargetIds: targetIds } : { id: annotation.id, family: annotation.family, fields };
  });
  const blockIds = new Set(blockRows.map((block) => block.id));
  if (blockIds.size !== blockRows.length || family.blocks.some((block) => !blockIds.has(block.id))) fail(`field '${fieldName}' block IDs disagree with checkpoint`);
  const canonical = {
    kind: 'workbench.annotatedText.canonical', version: 1,
    blocks: blockRows.map((block) => ({
      id: block.id,
      groupId: groupIds.get(block.id) ?? block.id,
      text: materializeBlock(family, block.id),
      fields: Object.fromEntries(Object.entries(descriptor.block ?? {}).map(([name, field]) => [name, deserializeField(field, block[name])])),
      annotationIds: canonicalMemberships.filter((membership) => membership.blockId === block.id).map((membership) => membership.annotationId),
    })),
    annotations: canonicalAnnotations,
    memberships: canonicalMemberships,
    measurements: db.prepare(`SELECT id, block_id, family, format_version, payload FROM ${prefix}_measurement WHERE block_id IN (SELECT id FROM ${prefix}_block WHERE document_id = ?) ORDER BY id`).all(row.id)
      .map((measurement) => ({ id: measurement.id, blockId: measurement.block_id, family: measurement.family, formatVersion: measurement.format_version, payload: JSON.parse(measurement.payload) })),
    capabilities: [],
    groupMemberships: [],
  };
  canonical.groupMemberships = groupMemberships.map((membership) => ({ annotationId: membership.annotation_id, groupId: membership.group_id, ordinal: membership.ordinal }));
  const active = canonicalAnnotations.filter((annotation) => Object.hasOwn(meta.protectingFamilies, annotation.family) && annotation.protectedTargetIds?.length)
    .filter((annotation) => {
      const own = new Set(canonicalMemberships.filter((membership) => membership.annotationId === annotation.id).map((membership) => membership.blockId));
      return canonicalMemberships.some((membership) => annotation.protectedTargetIds.includes(membership.annotationId) && own.has(membership.blockId));
    });
  const protectors = [];
  for (const annotation of active) {
    const access = meta.protectingFamilies[annotation.family].access;
    const decision = await protectingAnnotationCapabilities(entity, row, annotation, access, principal);
    protectors.push({ protectorId: annotation.id, outcome: decision.capabilities.includes(read) ? 'allow' : 'deny' });
  }
  const decisions = { version: 1, protectors, capabilityHints: [] };
  const recipient = caret === null
    ? projectAnnotatedTextForRecipient(canonical, descriptor, decisions)
    : projectAnnotatedTextCaretForRecipient(canonical, descriptor, decisions, caret, presence);
  if (caret !== null || !mintBasis) return recipient;
  const token = randomUUID();
  const visibleBlocks = recipient.blocks.filter((block) => block.kind === 'visible').map((block) => block.id);
  // A recipient has one current basis per document. A fresh snapshot supersedes
  // the prior coordinate frame while keeping storage bounded by recipients.
  const canonicalByBlock = new Map(canonical.blocks.map((block) => [block.id, block.groupId]));
  const durableBlocks = new Map();
  for (const block of canonical.blocks) durableBlocks.set(block.groupId, [...(durableBlocks.get(block.groupId) ?? []), block.id]);
  const durableExposures = new Map();
  for (const group of recipient.blockGroups) {
    const durable = [...new Set(group.blockIds.map((id) => canonicalByBlock.get(id)))];
    const complete = durable.length === 1 && JSON.stringify([...group.blockIds].sort()) === JSON.stringify([...(durableBlocks.get(durable[0]) ?? [])].sort());
    if (complete) durableExposures.set(durable[0], [...(durableExposures.get(durable[0]) ?? []), group]);
  }
  const exposedGroups = [];
  for (const [groupId, groups] of durableExposures) if (groups.length === 1) exposedGroups.push({ id: groups[0].id, groupId, blockIds: [...groups[0].blockIds] });
  db.prepare(`INSERT INTO ${prefix}_basis (token, document_id, principal_id, structural_revision, family_checkpoint, visible_blocks, exposed_groups) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(document_id, principal_id) DO UPDATE SET token = excluded.token, structural_revision = excluded.structural_revision, family_checkpoint = excluded.family_checkpoint, visible_blocks = excluded.visible_blocks, exposed_groups = excluded.exposed_groups`)
    .run(token, row.id, principal?.id ?? '', db.prepare(`SELECT structure_version FROM ${prefix}_state WHERE document_id = ?`).get(row.id).structure_version, JSON.stringify(textFamilyCheckpoint(family)), JSON.stringify(visibleBlocks), JSON.stringify(exposedGroups));
  return Object.freeze({ ...recipient, basis: token });
}

/** Owning-scope-admin-authorized package canonical export. Never projects through a recipient view. */
export async function exportAnnotatedText({ app, entity, field, documentId, expectedOwningScope, principal }) {
  const db = app?.db;
  if (!db || !app?.entities || !entity || !field || typeof documentId !== 'string' || !documentId) {
    fail('export requires app, entity, field, and documentId');
  }
  if (!expectedOwningScope || typeof expectedOwningScope !== 'object' ||
      typeof expectedOwningScope.entity?.name !== 'string' ||
      typeof expectedOwningScope.id !== 'string' || !expectedOwningScope.id) {
    fail('export requires an expectedOwningScope with a declared entity and non-empty id');
  }
  const registeredEntity = app.entities.get(entity.name);
  if (!registeredEntity) fail('export entity is not registered with the application');
  entity = registeredEntity;
  const fieldName = field.fieldName;
  const descriptor = entity.fields?.[fieldName];
  if (!descriptor || descriptor.kind !== 'annotatedText') fail('export field is not annotatedText');
  const row = db.prepare(`SELECT * FROM ${entity.name} WHERE id = ?`).get(documentId);
  if (!row) fail('document is missing');
  const owningScope = resolveAnnotatedTextOwningScope(descriptor, entity.fields, row);
  if (owningScope.entity !== expectedOwningScope.entity.name || owningScope.id !== expectedOwningScope.id) {
    fail('expected owning scope does not match document');
  }
  const scopeEntity = app.entities.get(owningScope.entity);
  if (!scopeEntity) fail('declared owning scope entity is not registered with the application');
  const scopeRow = db.prepare(`SELECT * FROM ${scopeEntity.name} WHERE id = ?`).get(owningScope.id);
  if (!scopeRow || !await mayRow(scopeEntity, 'admin', scopeRow, principal)) {
    fail('owning scope admin authorization failed');
  }
  const prefix = `${entity.name}_${fieldName}`;
  if (db.prepare(`SELECT 1 FROM ${prefix}_retired WHERE document_id = ?`).get(documentId)) fail('document is retired');
  const state = db.prepare(`SELECT family_checkpoint FROM ${prefix}_state WHERE document_id = ?`).get(documentId);
  if (!state) fail('document state is missing');
  const family = restoreTextFamilyCheckpoint(JSON.parse(state.family_checkpoint));
  const blocks = db.prepare(`SELECT * FROM ${prefix}_block WHERE document_id = ? ORDER BY position`).all(documentId);
  const groupRows = db.prepare(`SELECT block_id, group_id FROM ${prefix}_block_group WHERE block_id IN (SELECT id FROM ${prefix}_block WHERE document_id = ?)` ).all(documentId);
  const groupIds = requireBlockGroupIds(blocks, groupRows, fieldName);
  const annotations = db.prepare(`SELECT * FROM ${prefix}_annotation WHERE document_id = ? ORDER BY id`).all(documentId);
  const memberships = db.prepare(`SELECT membership.* FROM ${prefix}_membership AS membership JOIN ${prefix}_annotation AS annotation ON annotation.id = membership.annotation_id WHERE annotation.document_id = ? ORDER BY membership.annotation_id, membership.ordinal`).all(documentId);
  const groupMemberships = db.prepare(`SELECT membership.* FROM ${prefix}_group_membership AS membership JOIN ${prefix}_annotation AS annotation ON annotation.id = membership.annotation_id WHERE annotation.document_id = ? ORDER BY membership.annotation_id, membership.ordinal`).all(documentId);
  requireGroupMembershipIntegrity(groupMemberships, annotations, new Set(groupIds.values()), descriptor, fieldName);
  const targets = db.prepare(`SELECT edge.* FROM ${prefix}_annotation_protected_target AS edge JOIN ${prefix}_annotation AS annotation ON annotation.id = edge.annotation_id WHERE annotation.document_id = ? ORDER BY edge.annotation_id, edge.target_annotation_id`).all(documentId);
  const targetMap = new Map();
  for (const target of targets) targetMap.set(target.annotation_id, [...(targetMap.get(target.annotation_id) ?? []), target.target_annotation_id]);
  const result = {
    kind: 'workbench.annotatedText.canonical', version: 1,
    blocks: blocks.map((block) => ({
      id: block.id,
      groupId: groupIds.get(block.id) ?? block.id,
      text: materializeBlock(family, block.id),
      fields: Object.fromEntries(Object.entries(descriptor.block ?? {}).map(([name, desc]) => [name, deserializeField(desc, block[name])])),
      annotationIds: memberships.filter((membership) => membership.block_id === block.id).map((membership) => membership.annotation_id),
    })),
    annotations: annotations.map((annotation) => {
      const declared = descriptor.annotations.find((entry) => entry.annotationName === annotation.family);
      if (!declared) fail(`annotation '${annotation.id}' has unknown family`);
      const stored = db.prepare(`SELECT * FROM ${prefix}_annotation_${annotation.family} WHERE annotation_id = ?`).get(annotation.id) ?? {};
      return { id: annotation.id, family: annotation.family, fields: Object.fromEntries(Object.entries(declared.fields).map(([name, desc]) => [name, deserializeField(desc, stored[name])])), ...(targetMap.has(annotation.id) ? { protectedTargetIds: targetMap.get(annotation.id) } : {}) };
    }),
    memberships: memberships.map((membership) => ({ annotationId: membership.annotation_id, blockId: membership.block_id, ordinal: membership.ordinal })),
    measurements: db.prepare(`SELECT measurement.* FROM ${prefix}_measurement AS measurement JOIN ${prefix}_block AS block ON block.id = measurement.block_id WHERE block.document_id = ? ORDER BY measurement.id`).all(documentId).map((measurement) => ({ id: measurement.id, blockId: measurement.block_id, family: measurement.family, formatVersion: measurement.format_version, payload: JSON.parse(measurement.payload) })),
    capabilities: [],
    groupMemberships: groupMemberships.map((membership) => ({ annotationId: membership.annotation_id, groupId: membership.group_id, ordinal: membership.ordinal })),
  };
  return deepFreeze(result);
}

export async function projectAnnotatedTextSnapshot(input) {
  return projectAnnotatedText(input);
}

export async function projectAnnotatedTextCaretSnapshot(input) {
  return projectAnnotatedText(input);
}

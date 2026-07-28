import { deserializeField } from './field-strategy.mjs';
import { materializeBlock, restoreTextFamilyCheckpoint, textFamilyCheckpoint } from './annotated-text-family.mjs';
import { getAnnotatedTextCompiledMetadata } from './annotated-text-field.mjs';
import { projectAnnotatedTextForRecipient } from './annotated-text-recipient-projection.mjs';
import { projectAnnotatedTextCaretForRecipient } from './annotated-text-caret-projection.mjs';
import { protectingAnnotationCapabilities } from './row-grant.mjs';
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
  if (blockRows.length !== family.blocks.length) fail(`field '${fieldName}' blocks disagree with checkpoint`);
  const annotations = db.prepare(
    `SELECT annotation.id, annotation.family FROM ${prefix}_annotation AS annotation WHERE annotation.document_id = ? AND EXISTS (SELECT 1 FROM ${prefix}_membership AS membership WHERE membership.annotation_id = annotation.id) ORDER BY annotation.id`,
  ).all(row.id);
  const memberships = db.prepare(
    `SELECT membership.annotation_id, membership.block_id, membership.ordinal FROM ${prefix}_membership AS membership JOIN ${prefix}_annotation AS annotation ON annotation.id = membership.annotation_id WHERE annotation.document_id = ? ORDER BY membership.annotation_id, membership.ordinal`,
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
      text: materializeBlock(family, block.id),
      fields: Object.fromEntries(Object.entries(descriptor.block ?? {}).map(([name, field]) => [name, deserializeField(field, block[name])])),
      annotationIds: canonicalMemberships.filter((membership) => membership.blockId === block.id).map((membership) => membership.annotationId),
    })),
    annotations: canonicalAnnotations,
    memberships: canonicalMemberships,
    measurements: db.prepare(`SELECT id, block_id, family, format_version, payload FROM ${prefix}_measurement WHERE block_id IN (SELECT id FROM ${prefix}_block WHERE document_id = ?) ORDER BY id`).all(row.id)
      .map((measurement) => ({ id: measurement.id, blockId: measurement.block_id, family: measurement.family, formatVersion: measurement.format_version, payload: JSON.parse(measurement.payload) })),
    capabilities: [],
  };
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
  db.prepare(`INSERT INTO ${prefix}_basis (token, document_id, principal_id, structural_revision, family_checkpoint, visible_blocks) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(document_id, principal_id) DO UPDATE SET token = excluded.token, structural_revision = excluded.structural_revision, family_checkpoint = excluded.family_checkpoint, visible_blocks = excluded.visible_blocks`)
    .run(token, row.id, principal?.id ?? '', db.prepare(`SELECT structure_version FROM ${prefix}_state WHERE document_id = ?`).get(row.id).structure_version, JSON.stringify(textFamilyCheckpoint(family)), JSON.stringify(visibleBlocks));
  return Object.freeze({ ...recipient, basis: token });
}

/** Owner-authorized, package-assembled canonical export. Never projects through a recipient view. */
export async function exportAnnotatedText({ db, entity, field, documentId, principal }) {
  if (!db || !entity || !field || typeof documentId !== 'string' || !documentId) fail('export requires db, entity, field, and documentId');
  const fieldName = field.fieldName;
  const descriptor = entity.fields?.[fieldName];
  if (!descriptor || descriptor.kind !== 'annotatedText') fail('export field is not annotatedText');
  const row = db.prepare(`SELECT * FROM ${entity.name} WHERE id = ?`).get(documentId);
  if (!row || principal?.id == null || String(row[descriptor.owner]) !== String(principal.id)) fail('owner authorization failed');
  const prefix = `${entity.name}_${fieldName}`;
  if (db.prepare(`SELECT 1 FROM ${prefix}_retired WHERE document_id = ?`).get(documentId)) fail('document is retired');
  const state = db.prepare(`SELECT family_checkpoint FROM ${prefix}_state WHERE document_id = ?`).get(documentId);
  if (!state) fail('document state is missing');
  const family = restoreTextFamilyCheckpoint(JSON.parse(state.family_checkpoint));
  const blocks = db.prepare(`SELECT * FROM ${prefix}_block WHERE document_id = ? ORDER BY position`).all(documentId);
  const annotations = db.prepare(`SELECT * FROM ${prefix}_annotation WHERE document_id = ? ORDER BY id`).all(documentId);
  const memberships = db.prepare(`SELECT membership.* FROM ${prefix}_membership AS membership JOIN ${prefix}_annotation AS annotation ON annotation.id = membership.annotation_id WHERE annotation.document_id = ? ORDER BY membership.annotation_id, membership.ordinal`).all(documentId);
  const targets = db.prepare(`SELECT edge.* FROM ${prefix}_annotation_protected_target AS edge JOIN ${prefix}_annotation AS annotation ON annotation.id = edge.annotation_id WHERE annotation.document_id = ? ORDER BY edge.annotation_id, edge.target_annotation_id`).all(documentId);
  const targetMap = new Map();
  for (const target of targets) targetMap.set(target.annotation_id, [...(targetMap.get(target.annotation_id) ?? []), target.target_annotation_id]);
  const result = {
    kind: 'workbench.annotatedText.canonical', version: 1,
    blocks: blocks.map((block) => ({
      id: block.id,
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
  };
  return deepFreeze(result);
}

export async function projectAnnotatedTextSnapshot(input) {
  return projectAnnotatedText(input);
}

export async function projectAnnotatedTextCaretSnapshot(input) {
  return projectAnnotatedText(input);
}

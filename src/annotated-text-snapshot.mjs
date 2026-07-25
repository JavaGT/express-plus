import { deserializeField } from './field-strategy.mjs';
import { materializeBlock, restoreTextFamilyCheckpoint } from './annotated-text-family.mjs';
import { getAnnotatedTextCompiledMetadata } from './annotated-text-field.mjs';
import { projectAnnotatedTextForRecipient } from './annotated-text-recipient-projection.mjs';
import { protectingAnnotationCapabilities } from './row-grant.mjs';
import { read } from './grant.mjs';

function fail(message) { throw new Error(`annotated-text snapshot: ${message}`); }

// Reads only Workbench-owned annotated-text relations and projects them before
// an HTTP snapshot is serialized. Any malformed state or access failure throws;
// callers deny the entire snapshot rather than falling back to canonical facts.
export async function projectAnnotatedTextSnapshot({ db, entity, row, principal, fieldName, descriptor }) {
  const meta = getAnnotatedTextCompiledMetadata(descriptor);
  if (!meta) fail(`field '${fieldName}' is not compiled`);
  const prefix = `${entity.name}_${fieldName}`;
  const state = db.prepare(`SELECT family_checkpoint FROM ${prefix}_state WHERE document_id = ?`).get(row.id);
  if (!state) fail(`field '${fieldName}' state is missing`);
  const family = restoreTextFamilyCheckpoint(JSON.parse(state.family_checkpoint));
  const blockRows = db.prepare(`SELECT * FROM ${prefix}_block WHERE document_id = ? ORDER BY position`).all(row.id);
  if (blockRows.length !== family.blocks.length) fail(`field '${fieldName}' blocks disagree with checkpoint`);
  const annotations = db.prepare(`SELECT id, family FROM ${prefix}_annotation WHERE document_id = ? ORDER BY id`).all(row.id);
  const memberships = db.prepare(
    `SELECT membership.annotation_id, membership.block_id, membership.ordinal FROM ${prefix}_membership AS membership JOIN ${prefix}_annotation AS annotation ON annotation.id = membership.annotation_id WHERE annotation.document_id = ? ORDER BY membership.annotation_id, membership.ordinal`,
  ).all(row.id);
  const targetRows = db.prepare(
    `SELECT edge.annotation_id, edge.target_annotation_id FROM ${prefix}_annotation_protected_target AS edge JOIN ${prefix}_annotation AS annotation ON annotation.id = edge.annotation_id WHERE annotation.document_id = ? ORDER BY edge.annotation_id, edge.target_annotation_id`,
  ).all(row.id);
  const targets = new Map();
  for (const edge of targetRows) targets.set(edge.annotation_id, [...(targets.get(edge.annotation_id) ?? []), edge.target_annotation_id]);
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
  const canonicalMemberships = memberships.map((membership) => ({ annotationId: membership.annotation_id, blockId: membership.block_id, ordinal: membership.ordinal }));
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
  return projectAnnotatedTextForRecipient(canonical, descriptor, { version: 1, protectors, capabilityHints: [] });
}

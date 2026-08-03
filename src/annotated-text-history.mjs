// Package-private durable history support.  The image format is deliberately
// boring: its table list is compiled, and its rows are canonical and owned by
// one document.  It is never an event or an application-visible receipt.
// These capabilities are package-internal: neither is re-exported by the app
// surface.  The projection capability is intentionally identity based, not a
// public opt-in property on an arbitrary consumer.
import { clearAuthoringState } from './annotated-text-authoring-stream.mjs';

export const ANNOTATED_HISTORY_COMPLETION = Symbol('workbench.annotated-history-completion');
const annotatedEntityProjections = new WeakSet();
export function markAnnotatedEntityProjection(projection) { annotatedEntityProjections.add(projection); return projection; }
export function isAnnotatedEntityProjection(projection) { return annotatedEntityProjections.has(projection); }

const tableNames = (prefix, metadata) => Object.freeze([
  `${prefix}_state`, `${prefix}_block`, `${prefix}_block_group`,
  `${prefix}_annotation`, `${prefix}_annotation_protected_target`,
  `${prefix}_annotation_orphan_state`, `${prefix}_membership`, `${prefix}_group_membership`,
  `${prefix}_measurement`, ...metadata.families.map((family) => `${prefix}_annotation_${family}`),
]);

const rowKey = (row) => JSON.stringify(row);
const order = (rows) => rows.slice().sort((a, b) => rowKey(a).localeCompare(rowKey(b)));
const own = (db, table, column, id) => order(db.prepare(`SELECT * FROM ${table} WHERE ${column} = ?`).all(id));
const many = (db, table, column, ids) => ids.length ? order(db.prepare(`SELECT * FROM ${table} WHERE ${column} IN (${ids.map(() => '?').join(',')})`).all(...ids)) : [];
const columnsOf = (db, table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));

function assertImage(image, prefix, metadata, where = 'history image') {
  if (!image || image.version !== 1 || typeof image.documentId !== 'string' || !Array.isArray(image.tables)) throw new TypeError(`${where} is malformed`);
  const expected = tableNames(prefix, metadata);
  if (image.tables.length !== expected.length || image.tables.some((t, i) => t.name !== expected[i] || !Array.isArray(t.rows))) throw new TypeError(`${where} tables are malformed`);
  const schemas = new Map(expected.map((name) => [name, null]));
  // The caller validates against the live schema below; this first pass still
  // rejects every structural ambiguity before any restore write.
  const all = image.tables.flatMap((t) => t.rows);
  for (const table of image.tables) {
    const sorted = order(table.rows);
    if (sorted.length !== table.rows.length || sorted.some((row, index) => rowKey(row) !== rowKey(table.rows[index]))) throw new TypeError(`${where} rows are not canonical`);
    const ids = new Set();
    for (const row of table.rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new TypeError(`${where} row is malformed`);
      if ('id' in row && (typeof row.id !== 'string' || !row.id || ids.has(row.id))) throw new TypeError(`${where} ids are invalid`);
      if ('id' in row) ids.add(row.id);
    }
  }
  if (image.tables[0].rows.length !== 1) throw new TypeError(`${where} state cardinality is invalid`);
  void schemas; void all;
  return image;
}

function validateImageAgainstSchema({ db, image, prefix, documentId, metadata, expectedOwnership, where = 'history image' }) {
  assertImage(image, prefix, metadata, where);
  if (!expectedOwnership || expectedOwnership.documentId !== documentId
    || expectedOwnership.projectId == null || expectedOwnership.ownerId == null) {
    throw new TypeError(`${where} ownership metadata is missing`);
  }
  const names = tableNames(prefix, metadata);
  const schema = new Map(names.map((name) => [name, new Set(db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name))]));
  const byName = new Map(image.tables.map((table) => [table.name, table]));
  const blockIds = new Set(byName.get(`${prefix}_block`).rows.map((row) => row.id));
  const annotationIds = new Set(byName.get(`${prefix}_annotation`).rows.map((row) => row.id));
  const annotations = byName.get(`${prefix}_annotation`).rows;
  const annotationById = new Map(annotations.map((row) => [row.id, row]));
  const declaredFamilies = new Set(metadata.families);
  if (annotations.some((annotation) => typeof annotation.family !== 'string'
    || annotation.family.length === 0 || !declaredFamilies.has(annotation.family))) {
    throw new TypeError(`${where} annotation family is undeclared`);
  }
  const groupIds = new Set(byName.get(`${prefix}_block_group`).rows.map((row) => row.group_id));
  if (byName.get(`${prefix}_state`).rows.length !== 1) throw new TypeError(`${where} state cardinality is invalid`);
  for (const table of image.tables) {
    const columns = schema.get(table.name);
    if (!columns) throw new TypeError(`${where} table is invalid`);
    const uniqueIndexes = db.prepare(`PRAGMA index_list(${table.name})`).all();
    const seenKeys = new Set();
    for (const row of table.rows) {
      const keys = Object.keys(row).sort();
      if (keys.length !== columns.size || keys.some((key, index) => key !== [...columns].sort()[index])) throw new TypeError(`${where} columns are invalid`);
      if (row.document_id !== undefined && row.document_id !== documentId) throw new TypeError(`${where} has foreign document`);
      if ((table.name === `${prefix}_block` || table.name === `${prefix}_annotation`)
        && (row.project_id !== expectedOwnership.projectId || row.owner_id !== expectedOwnership.ownerId)) {
        throw new TypeError(`${where} has inconsistent ownership`);
      }
      if (row.block_id !== undefined && !blockIds.has(row.block_id)) throw new TypeError(`${where} has foreign block`);
      if (row.annotation_id !== undefined && !annotationIds.has(row.annotation_id)) throw new TypeError(`${where} has foreign annotation`);
      if (row.target_annotation_id !== undefined && !annotationIds.has(row.target_annotation_id)) throw new TypeError(`${where} has foreign target`);
      if (table.name === `${prefix}_group_membership` && !groupIds.has(row.group_id)) throw new TypeError(`${where} has foreign group`);
      for (const index of uniqueIndexes) {
        const indexed = db.prepare(`PRAGMA index_info(${index.name})`).all().map((column) => column.name);
        if (indexed.length && indexed.every((column) => row[column] !== null && row[column] !== undefined)) {
          const key = `${index.name}:${indexed.map((column) => JSON.stringify(row[column])).join('|')}`;
          if (seenKeys.has(key)) throw new TypeError(`${where} has duplicate unique keys`);
          seenKeys.add(key);
        }
      }
    }
  }
  for (const family of metadata.families) {
    const extension = byName.get(`${prefix}_annotation_${family}`).rows;
    const expected = annotations.filter((annotation) => annotation.family === family).map((annotation) => annotation.id);
    const hasFields = Object.keys(metadata.annotationFields?.[family]?.fields ?? {}).length > 0;
    if (((hasFields && (extension.length !== expected.length || new Set(extension.map((row) => row.annotation_id)).size !== extension.length
      || !expected.every((id) => extension.some((row) => row.annotation_id === id))))
      || (!hasFields && extension.length !== 0)) || extension.some((row) => {
      const parent = annotationById.get(row.annotation_id);
      return !parent || parent.family !== family;
    })) {
      throw new TypeError(`${where} annotation family coverage is invalid`);
    }
  }
  return { names, schema, byName, blockIds, annotationIds };
}

export function isCanonicalAnnotatedTextHistoryImage(image, prefix, documentId, metadata) {
  try {
    // Canonicality is checked at restore time against the compiled schema. The
    // fact validator has no database handle, so it still enforces identity,
    // table order, row order, and basic cardinality here.
    assertImage(image, prefix, metadata, 'history image');
    return image.prefix === prefix && image.documentId === documentId;
  } catch { return false; }
}

export function annotatedTextHistoryImage({ db, prefix, documentId, metadata }) {
  if (!metadata || !Array.isArray(metadata.families)) throw new TypeError('annotated history metadata is missing');
  const names = tableNames(prefix, metadata);
  const blockTable = `${prefix}_block`, annotationTable = `${prefix}_annotation`;
  const blocks = own(db, blockTable, 'document_id', documentId), annotations = own(db, annotationTable, 'document_id', documentId);
  const blockIds = blocks.map((r) => r.id), annotationIds = annotations.map((r) => r.id);
  const rows = names.map((name) => {
    const columns = columnsOf(db, name);
    const column = columns.has('document_id') ? 'document_id' : columns.has('block_id') ? 'block_id' : 'annotation_id';
    return { name, rows: column === 'document_id' ? own(db, name, column, documentId) : column === 'block_id' ? many(db, name, column, blockIds) : many(db, name, column, annotationIds) };
  });
  // Child rows selected by a document must be checked through their parent
  // identities; never allow a cross-document row into a private fact.
  const blockIdSet = new Set(blockIds), annotationIdSet = new Set(annotationIds);
  for (const table of rows) for (const row of table.rows) {
    if ('block_id' in row && !blockIdSet.has(row.block_id)) throw new TypeError('annotated history image has foreign block');
    if ('annotation_id' in row && !annotationIdSet.has(row.annotation_id)) throw new TypeError('annotated history image has foreign annotation');
    if ('target_annotation_id' in row && !annotationIdSet.has(row.target_annotation_id)) throw new TypeError('annotated history image has foreign target');
  }
  return Object.freeze({ version: 1, prefix, documentId, tables: Object.freeze(rows.map((t) => Object.freeze({ name: t.name, rows: Object.freeze(t.rows) }))) });
}

export function restoreAnnotatedTextHistoryImage({ db, prefix, documentId, image, metadata, expectedOwnership }) {
  const validated = validateImageAgainstSchema({ db, image, prefix, documentId, metadata, expectedOwnership });
  if (image.prefix !== prefix || image.documentId !== documentId) throw new TypeError('annotated history image ownership mismatch');
  // Validate all identities and columns before the first write.
  const { names, schema } = validated;
  const currentBlocks = db.prepare(`SELECT id FROM ${prefix}_block WHERE document_id = ?`).all(documentId).map((r) => r.id);
  const currentAnnotations = db.prepare(`SELECT id FROM ${prefix}_annotation WHERE document_id = ?`).all(documentId).map((r) => r.id);
  // Authoring stream state is recipient-specific and must never be revived by a
  // historical restore. It is intentionally not part of the image.
  clearAuthoringState(db, prefix, documentId);
  for (const table of names.slice().reverse()) {
    const columns = schema.get(table);
    const column = columns.has('document_id') ? 'document_id' : columns.has('block_id') ? 'block_id' : 'annotation_id';
    const ids = column === 'document_id' ? [documentId] : column === 'block_id' ? currentBlocks : currentAnnotations;
    if (ids.length) db.prepare(`DELETE FROM ${table} WHERE ${column} IN (${ids.map(() => '?').join(',')})`).run(...ids);
  }
  for (const table of image.tables) for (const row of table.rows) {
    const columns = [...schema.get(table.name)].sort();
    db.prepare(`INSERT INTO ${table.name} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...columns.map((c) => row[c]));
  }
}

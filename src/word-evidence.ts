import { txn, type DbHandle, type DbStatement } from './driver.ts';
import { operationalConsumer } from './operational-consumer.ts';
import {
  importTextToFamily,
  materializeText,
  projectEndpointToOffset,
  resolveOffsetToEndpoint,
  restoreTextFamilySerialized,
} from './annotated-text-continuous.ts';
import type { ContinuousTextFamily } from './annotated-text-continuous.ts';
import type { StructuralEndpoint } from './annotated-text-family.ts';
import { frozenJsonSnapshot } from './annotated-text-r2.ts';

// Word evidence is the general, framework-native form of the old timing-only
// `words` create payload (Sol D2 → word-evidence generalization). A source
// block carries one envelope of shared word identity plus per-family payload
// arrays; a field-derived committed-log consumer materializes one relational
// row per (word, family) anchored to immutable RGA endpoints; the framework
// read resolves those anchors against current text on demand. Never part of
// the CRDT checkpoint.
//
// Issue #33 (blockless): evidence is DOCUMENT-scoped — one row per (word,
// family) over the continuous document text. There is no block or
// source_block dimension anymore; words carry absolute document.startUtf16 /
// endUtf16 and are resolved to whole-document structural endpoints.

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;

export interface WordEvidenceFamilyDeclaration {
  readonly familyName: string;
  readonly formatVersion: number;
  readonly parse: (value: unknown) => unknown;
}

export interface CanonicalWordEvidenceEnvelope {
  readonly version: 1;
  readonly ids: readonly string[];
  readonly startsUtf16: readonly number[];
  readonly endsUtf16: readonly number[];
  readonly originalTokens: readonly string[];
  readonly families: Readonly<Record<string, Readonly<{ formatVersion: number; values: readonly unknown[] }>>>;
}

export function assertWordEvidenceFamilyName(name: string): void {
  if (typeof name !== 'string' || !IDENTIFIER.test(name)) {
    throw new Error(`word evidence family name '${String(name)}' is not a valid identifier`);
  }
}

function assertBlockText(blockText: string): void {
  if (typeof blockText !== 'string') throw new Error('blockText is required');
}

function assertWordIds(ids: readonly unknown[]): void {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error('word evidence requires a non-empty ids array');
  }
  if (ids.some((id) => typeof id !== 'string' || id.length === 0)) {
    throw new Error('word evidence ids must be non-empty strings');
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error('word evidence ids must be unique');
  }
}

function assertSafeUtf16Offsets(startsUtf16: readonly number[], endsUtf16: readonly number[], blockText: string): void {
  const length = startsUtf16.length;
  if (endsUtf16.length !== length) throw new Error('word evidence startsUtf16 and endsUtf16 must be aligned');
  for (let i = 0; i < length; i++) {
    const start = startsUtf16[i];
    const end = endsUtf16[i];
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(end) || end < start || end > blockText.length) {
      throw new Error(`word evidence span ${i} must satisfy 0 <= start <= end <= block text length`);
    }
  }
}

function assertOriginalTokens(originalTokens: unknown, startsUtf16: readonly number[], endsUtf16: readonly number[], blockText: string): string[] {
  if (originalTokens === undefined) {
    // Derive original tokens from the source text when not supplied.
    return startsUtf16.map((start, index) => blockText.slice(start, endsUtf16[index]));
  }
  if (!Array.isArray(originalTokens) || originalTokens.length !== startsUtf16.length || originalTokens.some((token) => typeof token !== 'string')) {
    throw new Error('word evidence originalTokens must be strings aligned to ids');
  }
  return [...originalTokens] as string[];
}

/**
 * Validate + canonicalize a source block's word-evidence envelope against the
 * field's declared families. Returns the canonical frozen envelope with parsed
 * per-word payloads; throws on any structural or family violation.
 *
 * @param {object} value the block's `wordEvidence` input
 * @param {{ families: readonly unknown[], blockText: string }} context
 * @returns frozen canonical envelope
 */
export function assertWordEvidencePayload(
  value: unknown,
  { families = [], blockText }: { families?: readonly WordEvidenceFamilyDeclaration[]; blockText: string },
): CanonicalWordEvidenceEnvelope {
  assertBlockText(blockText);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('word evidence must be a non-array object');
  }
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) throw new Error('word evidence requires version 1');
  const ids = raw.ids;
  const startsUtf16 = raw.startsUtf16;
  const endsUtf16 = raw.endsUtf16;
  assertWordIds(ids as readonly unknown[]);
  const idList = ids as readonly unknown[];
  if (!Array.isArray(startsUtf16) || !Array.isArray(endsUtf16) || startsUtf16.length !== idList.length) {
    throw new Error('word evidence startsUtf16 must be aligned to ids');
  }
  assertSafeUtf16Offsets(startsUtf16, endsUtf16, blockText);
  const originalTokens = assertOriginalTokens(raw.originalTokens, startsUtf16, endsUtf16, blockText);

  const declared = new Map(families.map((family) => [family.familyName, family]));
  const rawFamilies = raw.families;
  if (!rawFamilies || typeof rawFamilies !== 'object' || Array.isArray(rawFamilies)) {
    throw new Error('word evidence families must be a non-array object');
  }
  const familyNames = Object.keys(rawFamilies);
  if (familyNames.length === 0) throw new Error('word evidence families must not be empty');
  const canonicalFamilies: Record<string, Readonly<{ formatVersion: number; values: readonly unknown[] }>> = {};
  for (const familyName of familyNames) {
    const declaration = declared.get(familyName);
    if (!declaration) throw new Error(`word evidence family '${familyName}' is not declared on this field`);
    const familyInput = (rawFamilies as Record<string, unknown>)[familyName];
    if (!familyInput || typeof familyInput !== 'object' || Array.isArray(familyInput)) {
      throw new Error(`word evidence family '${familyName}' must be a non-array object`);
    }
    const familyObject = familyInput as { formatVersion?: unknown; values?: unknown };
    if (familyObject.formatVersion !== declaration.formatVersion) {
      throw new Error(`word evidence family '${familyName}' formatVersion must be ${declaration.formatVersion}`);
    }
    if (!Array.isArray(familyObject.values) || familyObject.values.length !== idList.length) {
      throw new Error(`word evidence family '${familyName}' values must be aligned to ids`);
    }
    const values = familyObject.values.map((entry, index) => {
      let parsed: unknown;
      try {
        parsed = declaration.parse(entry);
      } catch (error) {
        throw new Error(`word evidence family '${familyName}' value ${index} failed validation: ${error instanceof Error ? error.message : String(error)}`);
      }
      let frozen: unknown;
      try {
        frozen = frozenJsonSnapshot(parsed);
      } catch {
        throw new Error(`word evidence family '${familyName}' value ${index} is not JSON`);
      }
      return frozen;
    });
    canonicalFamilies[familyName] = Object.freeze({ formatVersion: declaration.formatVersion, values: Object.freeze(values) });
  }

  return Object.freeze({
    version: 1,
    ids: Object.freeze([...idList]) as readonly string[],
    startsUtf16: Object.freeze([...startsUtf16]),
    endsUtf16: Object.freeze([...endsUtf16]),
    originalTokens: Object.freeze(originalTokens),
    families: Object.freeze(canonicalFamilies),
  });
}

/** Canonical word-evidence table name for a generated annotated-text field. */
export function wordEvidenceTableName(entityName: string, fieldName: string): string {
  return `${entityName}_${fieldName}_word_evidence`;
}

function upsertStatement(db: DbHandle, tableName: string): DbStatement {
  const columns = [
    'scope', 'document_id', 'word_id', 'family',
    'start_anchor', 'end_anchor', 'source_start_utf16', 'source_end_utf16', 'original_token',
    'payload', 'origin_seq', 'format_version',
  ];
  const placeholders = columns.map(() => '?').join(', ');
  const update = columns.filter((column) => column !== 'scope' && column !== 'document_id' && column !== 'word_id' && column !== 'family')
    .map((column) => `${column} = excluded.${column}`).join(', ');
  return db.prepare(`INSERT INTO ${tableName} (${columns.join(', ')})
    VALUES (${placeholders})
    ON CONFLICT(scope, document_id, word_id, family) DO UPDATE SET ${update}`);
}

/**
 * A committed-log consumer for one engaged annotated-text field. Whole-event
 * idempotency: one `${scope}:${committedEventId}` key, one DB transaction
 * covering every block, word and family in the event.
 */
export function createWordEvidenceConsumer({ db, entityName, fieldName, tableName, families }: {
  db: DbHandle;
  entityName: string;
  fieldName: string;
  tableName: string;
  families: readonly WordEvidenceFamilyDeclaration[];
}) {
  const declared = new Map(families.map((family) => [family.familyName, family]));
  const consumerName = `${entityName}.${fieldName}.word-evidence`;
  return operationalConsumer({
    name: consumerName,
    declarationVersion: '1',
    projectionId: consumerName,
    effectId: consumerName,
    event: {
      eventType: `${entityName}.created`,
      fields: ['id', '__workbench'],
      project(fields: any) {
        return { id: String(fields.id ?? ''), __workbench: fields.__workbench };
      },
    },
    idempotencyKey(delivery: any) {
      return `${delivery.metadata.scopeId}:${delivery.metadata.committedEventId}`;
    },
    async handle(delivery: any) {
      try {
        const payload = delivery.payload;
        const annotated = payload.__workbench?.annotatedText?.[fieldName];
        if (!annotated?.blocks || annotated.blocks.length === 0) return { kind: 'ack' };
        // Blockless (issue #33): the whole document is one continuous text.
        // Join the source blocks in order, import them as one family, and
        // resolve each word's ABSOLUTE document offset to a structural endpoint.
        const blockTexts = annotated.blocks.map((entry: any) => String(entry.text ?? ''));
        const fullText = blockTexts.join('');
        const family = importTextToFamily(payload.id, annotated.actor, fullText);
        const frontier = family.checkpoint.frontier;
        const originSeq = parseInt(String(delivery.metadata.committedEventId).split(':').at(-1) ?? '0', 10);
        const insert = upsertStatement(db, tableName);
        let utf16Cursor = 0;
        await txn(db, () => {
          for (const block of annotated.blocks) {
            const evidence = block.wordEvidence;
            if (evidence) {
              for (let i = 0; i < evidence.ids.length; i++) {
                const start = evidence.startsUtf16[i] + utf16Cursor;
                const end = evidence.endsUtf16[i] + utf16Cursor;
                // resolveOffsetToEndpoint binary-searches the derived index,
                // so bulk imports stay ~O(log E) per offset.
                const startAnchor = resolveOffsetToEndpoint(family, start, frontier, 'right');
                const endAnchor = resolveOffsetToEndpoint(family, end, frontier, 'right');
                for (const familyName of Object.keys(evidence.families)) {
                  const familyDeclaration = declared.get(familyName);
                  if (!familyDeclaration) throw new Error(`word evidence family '${familyName}' is not declared on ${entityName}.${fieldName}`);
                  const familyInput = evidence.families[familyName];
                  insert.run(
                    delivery.metadata.scopeId,
                    payload.id,
                    evidence.ids[i],
                    familyName,
                    JSON.stringify(startAnchor),
                    JSON.stringify(endAnchor),
                    start,
                    end,
                    evidence.originalTokens[i],
                    JSON.stringify(familyInput.values[i]),
                    originSeq,
                    familyDeclaration.formatVersion,
                  );
                }
              }
            }
            utf16Cursor += String(block.text ?? '').length;
          }
        });
        return { kind: 'ack' };
      } catch (error) {
        return { kind: 'terminal', code: 'word-evidence-projection-failed', detail: String(error) };
      }
    },
  });
}

interface WordEvidenceEntityLike {
  name: string;
  fields?: Record<string, { kind?: unknown; wordEvidence?: readonly WordEvidenceFamilyDeclaration[] }>;
}

/** Build the engaged word-evidence consumers for every declared field. */
export function createWordEvidenceConsumers({ db, entities }: {
  db: DbHandle;
  entities: ReadonlyMap<string, WordEvidenceEntityLike>;
}): unknown[] {
  const consumers: unknown[] = [];
  for (const entity of entities.values()) {
    for (const [fieldName, descriptor] of Object.entries(entity.fields ?? {})) {
      if (descriptor?.kind !== 'annotatedText') continue;
      const families = descriptor.wordEvidence;
      if (!families || families.length === 0) continue;
      consumers.push(createWordEvidenceConsumer({
        db,
        entityName: entity.name,
        fieldName,
        tableName: wordEvidenceTableName(entity.name, fieldName),
        families,
      }));
    }
  }
  return consumers;
}

/** A frozen handle to a field's declared word-evidence families. */
export function wordEvidenceFieldHandle(entityName: string, fieldName: string, descriptor: { wordEvidence?: readonly WordEvidenceFamilyDeclaration[] }): {
  entityName: string;
  fieldName: string;
  tableName: string;
  families: readonly Readonly<{ familyName: string; formatVersion: number }>[];
} {
  const families = Object.freeze(
    (descriptor.wordEvidence ?? []).map((family) => Object.freeze({ familyName: family.familyName, formatVersion: family.formatVersion })),
  );
  return Object.freeze({
    entityName,
    fieldName,
    tableName: wordEvidenceTableName(entityName, fieldName),
    families,
  });
}

interface EvidenceEntry {
  shared: {
    startAnchor: unknown;
    endAnchor: unknown;
    sourceStartUtf16: number;
    sourceEndUtf16: number;
    originalToken: string;
  };
  evidence: Record<string, unknown>;
}

/**
 * Resolve a document's immutable word-evidence anchors against the current
 * continuous text (framework-native read). Reads the evidence rows and the
 * annotated-text family checkpoint from one consistent snapshot; a word whose
 * anchor no longer projects to its original token is marked `edited`. The
 * caller compares the returned `structureVersion` with its live document.
 */
export function readWordEvidence({ database, entityName, fieldName, tableName, scope, documentId, families }: {
  database: DbHandle;
  entityName: string;
  fieldName: string;
  tableName: string;
  scope: string;
  documentId: string;
  families?: readonly string[];
}): { structureVersion: unknown; words: readonly unknown[] } | null {
  const state = database.prepare(`SELECT structure_version, family_checkpoint FROM ${entityName}_${fieldName}_state WHERE document_id = ?`).get(documentId);
  if (!state) return null;
  const family = restoreTextFamilySerialized(state.family_checkpoint as string);
  const familyFilter = families && families.length > 0 ? families : null;
  const rows = familyFilter
    ? database.prepare(`SELECT * FROM ${tableName} WHERE scope = ? AND document_id = ? AND family IN (${familyFilter.map(() => '?').join(', ')}) ORDER BY source_start_utf16`)
        .all(scope, documentId, ...familyFilter)
    : database.prepare(`SELECT * FROM ${tableName} WHERE scope = ? AND document_id = ? ORDER BY source_start_utf16`).all(scope, documentId);
  return pivotEvidenceRows(family, state.structure_version, rows);
}

function pivotEvidenceRows(family: ContinuousTextFamily, structureVersion: unknown, rows: readonly Record<string, unknown>[]): {
  structureVersion: unknown;
  words: readonly Readonly<{
    wordId: string;
    start: number;
    end: number;
    text: string;
    edited: boolean;
    evidence: Readonly<Record<string, unknown>>;
  }>[];
} {
  const byWord = new Map<string, EvidenceEntry>();
  for (const row of rows) {
    const shared = {
      startAnchor: row.start_anchor,
      endAnchor: row.end_anchor,
      sourceStartUtf16: row.source_start_utf16 as number,
      sourceEndUtf16: row.source_end_utf16 as number,
      originalToken: String(row.original_token),
    };
    const wordId = String(row.word_id);
    const existing = byWord.get(wordId);
    if (existing) {
      const existingShared = existing.shared as Record<string, unknown>;
      for (const key of Object.keys(shared)) {
        if (existingShared[key] !== (shared as Record<string, unknown>)[key]) {
          throw new Error(`word-evidence corruption: word '${wordId}' has disagreeing ${key} across family rows`);
        }
      }
      existing.evidence[String(row.family)] = JSON.parse(row.payload as string);
    } else {
      byWord.set(wordId, { shared, evidence: { [String(row.family)]: JSON.parse(row.payload as string) } });
    }
  }
  const words: Array<{
    wordId: string;
    start: number;
    end: number;
    text: string;
    edited: boolean;
    evidence: Readonly<Record<string, unknown>>;
  }> = [];
  for (const [wordId, entry] of byWord) {
    const { startAnchor, endAnchor, sourceStartUtf16, sourceEndUtf16, originalToken } = entry.shared;
    let start: number;
    let end: number;
    let edited = false;
    try {
      start = projectEndpointToOffset(family, JSON.parse(startAnchor as string) as StructuralEndpoint);
      end = projectEndpointToOffset(family, JSON.parse(endAnchor as string) as StructuralEndpoint);
    } catch {
      start = sourceStartUtf16;
      end = sourceEndUtf16;
      edited = true;
    }
    let text = originalToken;
    if (!(start < end)) {
      // Zero-width or unprojectable range: fall back to the original token and
      // flag it as no longer matching the current document.
      text = originalToken;
      edited = true;
    } else {
      const docText = materializeText(family);
      if (end > docText.length) {
        text = originalToken;
        edited = true;
      } else {
        text = docText.slice(start, end);
        if (text !== originalToken) edited = true;
      }
    }
    words.push({
      wordId,
      start,
      end,
      text,
      edited,
      evidence: Object.freeze({ ...entry.evidence }),
    });
  }
  words.sort((a, b) => a.start - b.start || a.wordId.localeCompare(b.wordId));
  return {
    structureVersion,
    words: Object.freeze(words.map((word) => Object.freeze(word))),
  };
}

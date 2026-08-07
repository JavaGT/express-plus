import { txn } from './driver.mjs';
import { operationalConsumer } from './operational-consumer.mjs';
import {
  importTextFamilyFromBlocks,
  materializeBlock,
  projectEndpointToBlockOffset,
  resolvePositionToEndpoint,
  restoreTextFamilyCheckpoint,
} from './annotated-text-family.mjs';
import { frozenJsonSnapshot } from './annotated-text-r2.mjs';

// Word evidence is the general, framework-native form of the old timing-only
// `words` create payload (Sol D2 → word-evidence generalization). A source
// block carries one envelope of shared word identity plus per-family payload
// arrays; a field-derived committed-log consumer materializes one relational
// row per (word, family) anchored to immutable RGA endpoints; the framework
// read resolves those anchors against current text on demand. Never part of
// the CRDT checkpoint.

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;

export function assertWordEvidenceFamilyName(name) {
  if (typeof name !== 'string' || !IDENTIFIER.test(name)) {
    throw new Error(`word evidence family name '${String(name)}' is not a valid identifier`);
  }
}

function assertBlockText(blockText) {
  if (typeof blockText !== 'string') throw new Error('blockText is required');
}

function assertWordIds(ids) {
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

function assertSafeUtf16Offsets(startsUtf16, endsUtf16, blockText) {
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

function assertOriginalTokens(originalTokens, startsUtf16, endsUtf16, blockText) {
  if (originalTokens === undefined) {
    // Derive original tokens from the source text when not supplied.
    return startsUtf16.map((start, index) => blockText.slice(start, endsUtf16[index]));
  }
  if (!Array.isArray(originalTokens) || originalTokens.length !== startsUtf16.length || originalTokens.some((token) => typeof token !== 'string')) {
    throw new Error('word evidence originalTokens must be strings aligned to ids');
  }
  return [...originalTokens];
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
export function assertWordEvidencePayload(value, { families = [], blockText }) {
  assertBlockText(blockText);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('word evidence must be a non-array object');
  }
  if (value.version !== 1) throw new Error('word evidence requires version 1');
  const { ids, startsUtf16, endsUtf16 } = value;
  assertWordIds(ids);
  if (!Array.isArray(startsUtf16) || !Array.isArray(endsUtf16) || startsUtf16.length !== ids.length) {
    throw new Error('word evidence startsUtf16 must be aligned to ids');
  }
  assertSafeUtf16Offsets(startsUtf16, endsUtf16, blockText);
  const originalTokens = assertOriginalTokens(value.originalTokens, startsUtf16, endsUtf16, blockText);

  const declared = new Map(families.map((family) => [family.familyName, family]));
  const rawFamilies = value.families;
  if (!rawFamilies || typeof rawFamilies !== 'object' || Array.isArray(rawFamilies)) {
    throw new Error('word evidence families must be a non-array object');
  }
  const familyNames = Object.keys(rawFamilies);
  if (familyNames.length === 0) throw new Error('word evidence families must not be empty');
  const canonicalFamilies = {};
  for (const familyName of familyNames) {
    const declaration = declared.get(familyName);
    if (!declaration) throw new Error(`word evidence family '${familyName}' is not declared on this field`);
    const familyInput = rawFamilies[familyName];
    if (!familyInput || typeof familyInput !== 'object' || Array.isArray(familyInput)) {
      throw new Error(`word evidence family '${familyName}' must be a non-array object`);
    }
    if (familyInput.formatVersion !== declaration.formatVersion) {
      throw new Error(`word evidence family '${familyName}' formatVersion must be ${declaration.formatVersion}`);
    }
    if (!Array.isArray(familyInput.values) || familyInput.values.length !== ids.length) {
      throw new Error(`word evidence family '${familyName}' values must be aligned to ids`);
    }
    const values = familyInput.values.map((entry, index) => {
      let parsed;
      try {
        parsed = declaration.parse(entry);
      } catch (error) {
        throw new Error(`word evidence family '${familyName}' value ${index} failed validation: ${error.message}`);
      }
      let frozen;
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
    ids: Object.freeze([...ids]),
    startsUtf16: Object.freeze([...startsUtf16]),
    endsUtf16: Object.freeze([...endsUtf16]),
    originalTokens: Object.freeze(originalTokens),
    families: Object.freeze(canonicalFamilies),
  });
}

/** Canonical word-evidence table name for a generated annotated-text field. */
export function wordEvidenceTableName(entityName, fieldName) {
  return `${entityName}_${fieldName}_word_evidence`;
}

function upsertStatement(db, tableName) {
  const columns = [
    'scope', 'document_id', 'word_id', 'family', 'source_block_id', 'source_ordinal',
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
export function createWordEvidenceConsumer({ db, entityName, fieldName, tableName, families }) {
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
      project(fields) {
        return { id: String(fields.id ?? ''), __workbench: fields.__workbench };
      },
    },
    idempotencyKey(delivery) {
      return `${delivery.metadata.scopeId}:${delivery.metadata.committedEventId}`;
    },
    async handle(delivery) {
      try {
        const payload = delivery.payload;
        const annotated = payload.__workbench?.annotatedText?.[fieldName];
        if (!annotated?.blocks || annotated.blocks.length === 0) return { kind: 'ack' };
        const family = importTextFamilyFromBlocks(payload.id, annotated.actor, annotated.blocks);
        const frontier = family.checkpoint.frontier;
        const originSeq = parseInt(String(delivery.metadata.committedEventId).split(':').at(-1) ?? '0', 10);
        const insert = upsertStatement(db, tableName);
        let ordinal = 0;
        await txn(db, () => {
          for (const block of annotated.blocks) {
            const evidence = block.wordEvidence;
            if (!evidence) continue;
            for (let i = 0; i < evidence.ids.length; i++) {
              const startAnchor = resolvePositionToEndpoint(family, block.id, evidence.startsUtf16[i], frontier, 'right');
              const endAnchor = resolvePositionToEndpoint(family, block.id, evidence.endsUtf16[i], frontier, 'right');
              for (const familyName of Object.keys(evidence.families)) {
                const familyDeclaration = declared.get(familyName);
                if (!familyDeclaration) throw new Error(`word evidence family '${familyName}' is not declared on ${entityName}.${fieldName}`);
                const familyInput = evidence.families[familyName];
                insert.run(
                  delivery.metadata.scopeId,
                  payload.id,
                  evidence.ids[i],
                  familyName,
                  block.id,
                  ordinal,
                  JSON.stringify(startAnchor),
                  JSON.stringify(endAnchor),
                  evidence.startsUtf16[i],
                  evidence.endsUtf16[i],
                  evidence.originalTokens[i],
                  JSON.stringify(familyInput.values[i]),
                  originSeq,
                  familyDeclaration.formatVersion,
                );
              }
              ordinal++;
            }
          }
        });
        return { kind: 'ack' };
      } catch (error) {
        return { kind: 'terminal', code: 'word-evidence-projection-failed', detail: String(error) };
      }
    },
  });
}

/** Build the engaged word-evidence consumers for every declared field. */
export function createWordEvidenceConsumers({ db, entities }) {
  const consumers = [];
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
export function wordEvidenceFieldHandle(entityName, fieldName, descriptor) {
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

/**
 * Resolve a field's immutable word-evidence anchors against the document's
 * current text (framework-native read). Reads the evidence rows and the
 * annotated-text family checkpoint from one consistent snapshot; a word whose
 * anchor no longer projects to its original token is marked `edited`. The
 * caller compares the returned `structureVersion` with its live document.
 */
export function readWordEvidence({ database, entityName, fieldName, tableName, scope, documentId, families }) {
  const state = database.prepare(`SELECT structure_version, family_checkpoint FROM ${entityName}_${fieldName}_state WHERE document_id = ?`).get(documentId);
  if (!state) return null;
  const family = restoreTextFamilyCheckpoint(JSON.parse(state.family_checkpoint));
  const familyFilter = families && families.length > 0 ? families : null;
  const rows = familyFilter
    ? database.prepare(`SELECT * FROM ${tableName} WHERE scope = ? AND document_id = ? AND family IN (${familyFilter.map(() => '?').join(', ')}) ORDER BY source_ordinal`)
        .all(scope, documentId, ...familyFilter)
    : database.prepare(`SELECT * FROM ${tableName} WHERE scope = ? AND document_id = ? ORDER BY source_ordinal`).all(scope, documentId);
  return pivotEvidenceRows(family, state.structure_version, rows);
}

function pivotEvidenceRows(family, structureVersion, rows) {
  const byWord = new Map();
  for (const row of rows) {
    const shared = {
      sourceBlockId: row.source_block_id,
      sourceOrdinal: row.source_ordinal,
      startAnchor: row.start_anchor,
      endAnchor: row.end_anchor,
      sourceStartUtf16: row.source_start_utf16,
      sourceEndUtf16: row.source_end_utf16,
      originalToken: row.original_token,
    };
    const existing = byWord.get(row.word_id);
    if (existing) {
      for (const key of Object.keys(shared)) {
        if (existing.shared[key] !== shared[key]) {
          throw new Error(`word-evidence corruption: word '${row.word_id}' has disagreeing ${key} across family rows`);
        }
      }
      existing.evidence[row.family] = JSON.parse(row.payload);
    } else {
      byWord.set(row.word_id, { shared, evidence: { [row.family]: JSON.parse(row.payload) } });
    }
  }
  const words = [];
  for (const [wordId, entry] of byWord) {
    const { sourceBlockId, sourceOrdinal, startAnchor, endAnchor, sourceStartUtf16, sourceEndUtf16, originalToken } = entry.shared;
    let start;
    let end;
    let blockId = null;
    let edited = false;
    try {
      start = projectEndpointToBlockOffset(family, sourceBlockId, JSON.parse(startAnchor));
      end = projectEndpointToBlockOffset(family, sourceBlockId, JSON.parse(endAnchor));
      blockId = sourceBlockId;
    } catch {
      start = sourceStartUtf16;
      end = sourceEndUtf16;
      edited = true;
    }
    let text = originalToken;
    if (blockId) {
      try {
        text = materializeBlock(family, blockId).slice(start, end);
      } catch {
        text = originalToken;
      }
    }
    if (text !== originalToken) edited = true;
    words.push({
      wordId,
      blockId,
      start,
      end,
      text,
      edited,
      sourceOrdinal,
      evidence: Object.freeze({ ...entry.evidence }),
    });
  }
  words.sort((a, b) => a.sourceOrdinal - b.sourceOrdinal || a.wordId.localeCompare(b.wordId));
  return {
    structureVersion,
    words: Object.freeze(words.map((word) => Object.freeze(word))),
  };
}

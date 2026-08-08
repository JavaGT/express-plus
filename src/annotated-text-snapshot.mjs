import { deserializeField } from './field-strategy.mjs';
import { restoreTextFamily, materializeText, projectEndpointToOffset, textFamilyCheckpoint } from './annotated-text-continuous.mjs';
import { getAnnotatedTextCompiledMetadata, resolveAnnotatedTextOwningScope } from './annotated-text-field.mjs';
import { projectAnnotatedTextForRecipient, authoringRedactionsForRecipient } from './annotated-text-recipient-projection.mjs';
import { projectAnnotatedTextCaretForRecipient } from './annotated-text-caret-projection.mjs';
import { mayRow, protectingAnnotationCapabilities } from './row-grant.mjs';
import { read } from './grant.mjs';
import { resolveStream, resolveLease, issueAuthoringSnapshot, buildAuthoringEnvelope } from './annotated-text-authoring-stream.mjs';
import { readSeq } from './cursor.mjs';
import { rawRow } from './entity/query.mjs';
import { scopeOf } from './scope-handle.mjs';
                                                                           

function fail(message        )        {
  throw new Error(`annotated-text snapshot: ${message}`);
}

function deepFreeze   (value   )    {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value                           )) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const RECIPIENT_READ_ATTEMPTS = 2;
const recipientUnavailable = deepFreeze({ kind: 'unavailable' });
const recipientRetry = deepFreeze({ kind: 'retry' });

function requireRecipientReadInput(input     ) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      !input.app?.db || !input.app?.entities || typeof input.entity?.name !== 'string' ||
      !input.field || typeof input.field.fieldName !== 'string' ||
      typeof input.documentId !== 'string' || input.documentId.length === 0 ||
      !input.expectedOwningScope || typeof input.expectedOwningScope !== 'object' ||
      typeof input.expectedOwningScope.entity?.name !== 'string' ||
      typeof input.expectedOwningScope.id !== 'string' || input.expectedOwningScope.id.length === 0 ||
      !input.principal || typeof input.principal !== 'object' ||
      typeof input.principal.type !== 'string' || !Object.hasOwn(input.principal, 'id') ||
      !Object.hasOwn(input.principal, 'attributes')) {
    throw new TypeError('readAnnotatedTextForRecipient requires a complete public recipient read input');
  }
}

function sanitizedRecipientReadFailure()        {
  return new Error('annotated-text recipient read failed');
}

function unchangedCursor(db     , scopeKey        , before        )          {
  return readSeq(db, scopeKey) === before;
}

/**
 * Project a stored membership range (historical-basis endpoint JSON) to
 * absolute offsets against the current continuous family. Returns null when the
 * range is unprojectable (stale basis / lost anchor).
 */
function projectRangeToOffsets(family                      , startPoint        , endPoint        )                                        {
  let start;
  let end;
  try {
    start = projectEndpointToOffset(family, JSON.parse(startPoint));
    end = projectEndpointToOffset(family, JSON.parse(endPoint));
  } catch {
    return null;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > materializeText(family).length) return null;
  return { start, end };
}

function loadAnnotations({ db, prefix, descriptor, documentId }                                                                  )        {
  const rows = db.prepare(`SELECT id, family, owner_id FROM ${prefix}_annotation WHERE document_id = ? ORDER BY id`).all(documentId);
  const targets = db.prepare(
    `SELECT edge.annotation_id, edge.target_annotation_id FROM ${prefix}_annotation_protected_target AS edge
      JOIN ${prefix}_annotation AS annotation ON annotation.id = edge.annotation_id
     WHERE annotation.document_id = ? ORDER BY edge.annotation_id, edge.target_annotation_id`,
  ).all(documentId);
  const targetsByAnnotation = new Map                  ();
  for (const edge of targets) targetsByAnnotation.set(edge.annotation_id, [...(targetsByAnnotation.get(edge.annotation_id) ?? []), edge.target_annotation_id]);
  const annotations        = [];
  for (const row of rows) {
    const declared = descriptor.annotations.find((entry     ) => entry.annotationName === row.family);
    if (!declared) fail(`annotation '${row.id}' has unknown family`);
    const fields                      = {};
    const stored = db.prepare(`SELECT * FROM ${prefix}_annotation_${row.family} WHERE annotation_id = ?`).get(row.id);
    if (!stored && Object.keys(declared.fields).length !== 0) fail(`annotation '${row.id}' fields are missing`);
    for (const [name, field] of Object.entries(declared.fields)) fields[name] = deserializeField(field       , stored[name]);
    const targetIds = targetsByAnnotation.get(row.id);
    annotations.push(targetIds
      ? { id: row.id, family: row.family, fields, owner: row.owner_id, protectedTargetIds: targetIds }
      : { id: row.id, family: row.family, fields, owner: row.owner_id });
  }
  return annotations;
}

// Reads only Workbench-owned annotated-text relations and projects them before
// an HTTP snapshot is serialized. Any malformed state or access failure throws;
// callers deny the entire snapshot rather than falling back to canonical facts.
async function projectAnnotatedText({ db, entity, row, principal, fieldName, descriptor, caret = null, presence = null, mintBasis = true, authoring = null }   
          
              
           
                 
                    
                  
              
                 
                      
                  
 )               {
  const meta = getAnnotatedTextCompiledMetadata(descriptor);
  if (!meta) fail(`field '${fieldName}' is not compiled`);
  const prefix = `${entity.name}_${fieldName}`;
  if (db.prepare(`SELECT 1 FROM ${prefix}_retired WHERE document_id = ?`).get(row.id)) fail(`field '${fieldName}' document is retired`);
  const state = db.prepare(`SELECT family_checkpoint FROM ${prefix}_state WHERE document_id = ?`).get(row.id);
  if (!state) fail(`field '${fieldName}' state is missing`);
  const family = restoreTextFamily(JSON.parse(state.family_checkpoint));
  const text = materializeText(family);

  const annotations = loadAnnotations({ db, prefix, descriptor, documentId: row.id });

  // Document-scoped ranges: project stored historical-basis endpoints to
  // absolute offsets. An unprojectable PROTECTOR fails the whole document
  // (fail closed); an unprojectable non-protector is dropped.
  const rangeRows = db.prepare(`SELECT annotation_id, start_point, end_point FROM ${prefix}_membership WHERE annotation_id IN (SELECT id FROM ${prefix}_annotation WHERE document_id = ?)`).all(row.id);
  const ranges        = [];
  const droppedAnnotationIds = new Set        ();
  for (const rangeRow of rangeRows) {
    const projected = projectRangeToOffsets(family, rangeRow.start_point, rangeRow.end_point);
    const annotation = annotations.find((candidate) => candidate.id === rangeRow.annotation_id);
    if (!annotation) continue;
    if (!projected) {
      if (Object.hasOwn(meta.protectingFamilies, annotation.family)) {
        fail(`field '${fieldName}' protector '${annotation.id}' has an unprojectable range`);
      }
      droppedAnnotationIds.add(annotation.id);
      continue;
    }
    ranges.push({ annotationId: rangeRow.annotation_id, start: projected.start, end: projected.end });
  }

  const orphanRows = db.prepare(
    `SELECT a.id, a.family, a.owner_id, o.saved_quote, o.last_range
       FROM ${prefix}_annotation AS a
       JOIN ${prefix}_annotation_orphan_state AS o ON o.annotation_id = a.id
      WHERE a.document_id = ?
      ORDER BY a.id`,
  ).all(row.id);
  const orphans = orphanRows.map((o     ) => {
    const declared = descriptor.annotations.find((entry     ) => entry.annotationName === o.family);
    if (!declared) fail(`orphan '${o.id}' has unknown family`);
    let savedRange;
    try {
      savedRange = JSON.parse(o.last_range ?? 'null');
    } catch {
      fail(`orphan '${o.id}' has malformed last range`);
    }
    if (savedRange === null) savedRange = [0, 0];
    if (!Array.isArray(savedRange) || savedRange.length !== 2 || !Number.isSafeInteger(savedRange[0]) || !Number.isSafeInteger(savedRange[1]) || savedRange[0] < 0 || savedRange[1] < savedRange[0]) {
      fail(`orphan '${o.id}' has malformed last range`);
    }
    const fields                      = {};
    const stored = db.prepare(`SELECT * FROM ${prefix}_annotation_${o.family} WHERE annotation_id = ?`).get(o.id);
    if (!stored && Object.keys(declared.fields).length !== 0) fail(`orphan '${o.id}' fields are missing`);
    for (const [name, field] of Object.entries(declared.fields)) fields[name] = deserializeField(field       , stored[name]);
    return { id: o.id, family: o.family, fields, owner: o.owner_id, savedQuote: o.saved_quote, savedRange };
  });

  const orphanIds = new Set(orphans.map((orphan     ) => orphan.id));
  const canonical = {
    kind: 'workbench.annotatedText.canonical', version: 1,
    text,
    annotations: annotations.filter((annotation) => !droppedAnnotationIds.has(annotation.id) && !orphanIds.has(annotation.id)),
    ranges,
    orphans,
    measurements: db.prepare(`SELECT id, family, format_version, payload FROM ${prefix}_measurement WHERE document_id = ? ORDER BY id`).all(row.id)
      .map((measurement     ) => ({ id: measurement.id, family: measurement.family, formatVersion: measurement.format_version, payload: JSON.parse(measurement.payload) })),
    capabilityHints: [],
  };

  const active = canonical.annotations.filter((annotation) => Object.hasOwn(meta.protectingFamilies, annotation.family) && annotation.protectedTargetIds?.length);
  const protectors        = [];
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

  const cursor = authoring?.fence ?? db.prepare(`SELECT lastSeq FROM _ProjectedCursor WHERE entity = ? AND field = ?`).get(entity.name, fieldName)?.lastSeq ?? 0;
  if (!authoring) return recipient;

  const { streamToken, leaseToken } = authoring;
  const stream = resolveStream({ db, prefix, streamToken, documentId: row.id, principalType: principal?.type ?? 'principal', principalId: principal?.id ?? '' });
  if (!stream) fail('authoring stream is unavailable');
  const lease = resolveLease({ db, prefix, leaseToken, streamId: stream.id });
  if (!lease) fail('authoring lease is unavailable');

  // One DOCUMENT-scoped position frame binds the whole family checkpoint basis.
  const issued = issueAuthoringSnapshot({
    db, prefix, leaseId: lease.id, fence: cursor,
    positions: [{
      familyCheckpoint: textFamilyCheckpoint(family),
      visibleAtIssue: true,
      redactions: authoringRedactionsForRecipient(recipient),
    }],
  });
  if (!issued) fail('authoring stream capacity exceeded');
  const envelope = buildAuthoringEnvelope({
    streamToken: stream.id,
    leaseToken: lease.id,
    snapshotToken: issued.snapshot.id,
    fence: cursor,
    positionFrames: issued.positionFrames,
  });
  // The recipient seeds its fold reducer from this family checkpoint. The
  // checkpoint is the full canonical text (including tombstones), so it is only
  // safe when the recipient sees the ENTIRE document unredacted. Restricted or
  // inline-redacted recipients get no family: they stay on snapshot recovery.
  const fullyVisible = !recipient.restricted && !recipient.redactions?.length && authoringRedactionsForRecipient(recipient).length === 0;
  if (fullyVisible) (envelope       ).family = textFamilyCheckpoint(family);
  return Object.freeze({ ...recipient, authoring: Object.freeze(envelope) });
}

/** Owning-scope-admin-authorized package canonical export. Never projects through a recipient view. */
export async function exportAnnotatedText({ app, entity, field, documentId, expectedOwningScope, principal }     )               {
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
  for (let attempt = 0; attempt < RECIPIENT_READ_ATTEMPTS; attempt += 1) {
    const row = rawRow(db, entity.name, documentId);
    if (!row) fail('document is missing');
    const owningScope = resolveAnnotatedTextOwningScope(descriptor, entity.fields, row);
    if (owningScope.entity !== expectedOwningScope.entity.name || owningScope.id !== expectedOwningScope.id) {
      fail('expected owning scope does not match document');
    }
    // Authorization and the canonical read must be ONE consistent view. Capture
    // the owning-scope cursor before authorizing and verify it is unchanged
    // after the read; a commit landing in between retries the whole attempt.
    const owningScopeCursorBefore = readSeq(db, owningScope.key);
    let attemptResult;
    try {
      const scopeEntity = app.entities.get(owningScope.entity);
      if (!scopeEntity) fail('declared owning scope entity is not registered with the application');
      const scopeRow = rawRow(db, scopeEntity.name, owningScope.id);
      if (!scopeRow || !await mayRow(scopeEntity, 'admin', scopeRow, principal)) {
        fail('owning scope admin authorization failed');
      }
      attemptResult = projectCanonicalExport({ db, entity, fieldName, descriptor, documentId });
    } catch (error) {
      if (unchangedCursor(db, owningScope.key, owningScopeCursorBefore)) throw error;
      continue;
    }
    if (unchangedCursor(db, owningScope.key, owningScopeCursorBefore)) return attemptResult;
  }
  fail('export could not obtain a consistent document view');
}

function projectCanonicalExport({ db, entity, fieldName, descriptor, documentId }                                                                                  )      {
  const prefix = `${entity.name}_${fieldName}`;
  if (db.prepare(`SELECT 1 FROM ${prefix}_retired WHERE document_id = ?`).get(documentId)) fail('document is retired');
  const state = db.prepare(`SELECT family_checkpoint FROM ${prefix}_state WHERE document_id = ?`).get(documentId);
  if (!state) fail('document state is missing');
  const family = restoreTextFamily(JSON.parse(state.family_checkpoint));
  const text = materializeText(family);
  const annotations = loadAnnotations({ db, prefix, descriptor, documentId });
  const rangeRows = db.prepare(`SELECT annotation_id, start_point, end_point FROM ${prefix}_membership WHERE annotation_id IN (SELECT id FROM ${prefix}_annotation WHERE document_id = ?)`).all(documentId);
  const ranges        = [];
  for (const rangeRow of rangeRows) {
    const projected = projectRangeToOffsets(family, rangeRow.start_point, rangeRow.end_point);
    if (!projected) continue;
    ranges.push({ annotationId: rangeRow.annotation_id, start: projected.start, end: projected.end });
  }
  const orphanRows = db.prepare(
    `SELECT a.id, a.family, a.owner_id, o.saved_quote, o.last_range
       FROM ${prefix}_annotation AS a
       JOIN ${prefix}_annotation_orphan_state AS o ON o.annotation_id = a.id
      WHERE a.document_id = ? ORDER BY a.id`,
  ).all(documentId);
  const orphans = orphanRows.map((o     ) => {
    const declared = descriptor.annotations.find((entry     ) => entry.annotationName === o.family);
    if (!declared) fail(`orphan '${o.id}' has unknown family`);
    let savedRange;
    try { savedRange = JSON.parse(o.last_range ?? 'null'); } catch { fail(`orphan '${o.id}' has malformed last range`); }
    if (savedRange === null) savedRange = [0, 0];
    if (!Array.isArray(savedRange) || savedRange.length !== 2 || !Number.isSafeInteger(savedRange[0]) || !Number.isSafeInteger(savedRange[1]) || savedRange[0] < 0 || savedRange[1] < savedRange[0]) fail(`orphan '${o.id}' has malformed last range`);
    const stored = db.prepare(`SELECT * FROM ${prefix}_annotation_${o.family} WHERE annotation_id = ?`).get(o.id) ?? {};
    return { id: o.id, family: o.family, fields: Object.fromEntries(Object.entries(declared.fields).map(([name, desc]) => [name, deserializeField(desc       , stored[name])])), owner: o.owner_id, savedQuote: o.saved_quote, savedRange };
  });
  const result = {
    kind: 'workbench.annotatedText.canonical', version: 1,
    text,
    annotations,
    ranges,
    orphans,
    measurements: db.prepare(`SELECT id, family, format_version, payload FROM ${prefix}_measurement WHERE document_id = ? ORDER BY id`).all(documentId)
      .map((measurement     ) => ({ id: measurement.id, family: measurement.family, formatVersion: measurement.format_version, payload: JSON.parse(measurement.payload) })),
    capabilityHints: [],
  };
  return deepFreeze(result);
}

/**
 * Public recipient snapshot read. The expected scope binds the caller's intent,
 * while current row grants on both the document and its resolved owner decide
 * authority. Deliberately returns one opaque result for every ordinary denial.
 */
export async function readAnnotatedTextForRecipient(input     )               {
  requireRecipientReadInput(input);
  const { app, field, documentId, expectedOwningScope, principal } = input;
  const db = app.db;
  const entity = app.entities.get(input.entity.name);
  if (!entity || input.entity !== entity.declaration) {
    throw new TypeError('readAnnotatedTextForRecipient entity must be the application-registered declaration');
  }
  const descriptor = entity.fields?.[field.fieldName];
  const metadata = getAnnotatedTextCompiledMetadata(descriptor);
  if (!descriptor || descriptor.kind !== 'annotatedText' ||
      field.annotations !== metadata?.annotationHandles ||
      field.measurements !== metadata?.measurementHandles ||
      field.capabilities !== metadata?.capabilityHandles) {
    throw new TypeError('readAnnotatedTextForRecipient field must be the registered annotatedText handle');
  }
  const expectedScopeEntity = app.entities.get(expectedOwningScope.entity.name);
  if (!expectedScopeEntity || expectedOwningScope.entity !== expectedScopeEntity.declaration) {
    throw new TypeError('readAnnotatedTextForRecipient expectedOwningScope entity must be the application-registered declaration');
  }

  for (let attempt = 0; attempt < RECIPIENT_READ_ATTEMPTS; attempt += 1) {
    let capturedOwningScopeKey                = null;
    let capturedOwningScopeCursor                = null;
    try {
      const row = rawRow(db, entity.name, documentId);
      if (!row) {
        const before = readSeq(db, scopeOf(expectedOwningScope.entity.name, expectedOwningScope.id).key);
        if (unchangedCursor(db, scopeOf(expectedOwningScope.entity.name, expectedOwningScope.id).key, before)) return recipientUnavailable;
        continue;
      }
      let owningScope;
      try {
        owningScope = resolveAnnotatedTextOwningScope(descriptor, entity.fields, row);
      } catch {
        const before = readSeq(db, scopeOf(expectedOwningScope.entity.name, expectedOwningScope.id).key);
        if (unchangedCursor(db, scopeOf(expectedOwningScope.entity.name, expectedOwningScope.id).key, before)) return recipientUnavailable;
        continue;
      }
      if (owningScope.entity !== expectedOwningScope.entity.name || owningScope.id !== expectedOwningScope.id) {
        const before = readSeq(db, owningScope.key);
        if (unchangedCursor(db, owningScope.key, before)) return recipientUnavailable;
        continue;
      }
      const scopeEntity = app.entities.get(owningScope.entity);
      if (!scopeEntity) {
        const before = readSeq(db, owningScope.key);
        if (unchangedCursor(db, owningScope.key, before)) return recipientUnavailable;
        continue;
      }
      const scopeRow = rawRow(db, scopeEntity.name, owningScope.id);
      if (!scopeRow) {
        const before = readSeq(db, owningScope.key);
        if (unchangedCursor(db, owningScope.key, before)) return recipientUnavailable;
        continue;
      }

      const owningScopeCursorBefore = readSeq(db, owningScope.key);
      capturedOwningScopeKey = owningScope.key;
      capturedOwningScopeCursor = owningScopeCursorBefore;
      const mayReadScope = await mayRow(scopeEntity, 'read', scopeRow, principal);
      const mayReadDocument = await mayRow(entity, 'read', row, principal);
      if (!mayReadScope || !mayReadDocument) {
        if (unchangedCursor(db, owningScope.key, owningScopeCursorBefore)) return recipientUnavailable;
        continue;
      }
      let document;
      try {
        document = await projectAnnotatedText({
          db, entity, row, principal, fieldName: field.fieldName, descriptor, mintBasis: false,
        });
      } catch (error) {
        if (!unchangedCursor(db, owningScope.key, owningScopeCursorBefore)) continue;
        if (db.prepare(`SELECT 1 FROM ${entity.name}_${field.fieldName}_retired WHERE document_id = ?`).get(documentId)) return recipientUnavailable;
        throw error;
      }
      const owningScopeCursorAfter = readSeq(db, owningScope.key);
      if (owningScopeCursorBefore !== owningScopeCursorAfter) continue;
      return deepFreeze({ kind: 'snapshot', document, owningScopeCursor: owningScopeCursorAfter });
    } catch {
      if (capturedOwningScopeKey !== null && capturedOwningScopeCursor !== null &&
          !unchangedCursor(db, capturedOwningScopeKey, capturedOwningScopeCursor)) continue;
      throw sanitizedRecipientReadFailure();
    }
  }
  return recipientRetry;
}

export async function projectAnnotatedTextSnapshot(input     )               {
  return projectAnnotatedText(input);
}

export async function projectAnnotatedTextCaretSnapshot(input     )               {
  return projectAnnotatedText(input);
}

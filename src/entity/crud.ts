// Entity CRUD handler generation — the mutation handlers for create, update,
// and remove, extracted from the entity compiler so the compiler stays focused
// on validation and assembly, not handler bodies.
//
// createCrudHandlers builds the { `${name}.create`, `${name}.update`,
// `${name}.remove` } handlers that turn an authorized action payload into
// emitted lifecycle events. Side-table mutation handlers (map.add, log.append,
// etc.) are delegated to the side-table strategy, keeping the CRUD generator
// focused on the entity-row lifecycle.

import { createHash, randomUUID } from 'node:crypto';
import { validateMaterializedField, validateMutation, ValidationError, deserializeField, serializeField, flattenStruct, resolveStrategy } from '../field-strategy.ts';
import { scopeOf } from '../scope-handle.ts';
import * as eventHandles from '../event-handle.ts';
import { assertFrontier, assertUtf16Offset, assertWellFormedText, canonicalTextOp, frontierDominates, scalarCount } from '../annotated-text.ts';
import { applyTextOperationToBlock, restoreTextFamilyCheckpoint, splitBlock, mergeBlocks, materializeBlock, textFamilyCheckpoint, resolvePositionToEndpoint } from '../annotated-text-family.ts';
import { splitBlockMemberships, mergeBlocksMemberships, addMembership, removeMembership } from '../annotated-text-membership.ts';
import { getAnnotatedTextCompiledMetadata, resolveAnnotatedTextOwningScope, resolveDeclarationMeasurementExtension } from '../annotated-text-field.ts';
import { assertR2BlockSplitPayload, frozenJsonSnapshot } from '../annotated-text-r2.ts';
import { assertR3BlockMergePayload, canonicalJsonEqual } from '../annotated-text-r3.ts';
import { assertR4AnnotationApplyPayload } from '../annotated-text-r4.ts';
import { assertR5AnnotationDetachPayload } from '../annotated-text-r5.ts';
import { assertWordEvidencePayload } from '../word-evidence.ts';
import { erasureDirectivePreparation } from '../erasure-directive.ts';
import { CASCADE_DESCENDANT, CASCADE_PREAUTHORIZED } from './removal-cascade.ts';
import { admitRow } from '../row-grant.ts';
import { admitsInvitationRemoval } from '../auth/invitation-acceptance-authority.ts';
import { clearAuthoringState, issueAuthoringSnapshot, buildAuthoringEnvelope } from '../annotated-text-authoring-stream.ts';
import { admitV9AnnotatedTextEdit, assertV9AuthoringBinding as assertV9AuthoringBindingFromAdmit } from '../annotated-text-admit.ts';
import { packOperatedFacts } from '../annotated-text-operated-facts.ts';
import { applyTextOperation, compactTextFamilyCheckpoint, restoreTextFamilySerialized, textFamilyBasis } from '../annotated-text-continuous.ts';
import { rawRow } from './query.ts';

export const CRUD_CURSOR_POLICY = Symbol('workbench.crud-cursor-policy');
export const ANNOTATED_TEXT_COMPENSATION = Symbol('workbench.annotated-text-compensation');

/** Prefer the dispatch scope when it is the inherited parent shell for this row. */
export function resolveGeneratedEventScope(record: any, { id, row, payload, scope }: any) {
  const inherit = record.inherit;
  if (inherit && typeof scope === 'string' && scope.length > 0) {
    const ownerId = row?.[inherit.via] ?? payload?.[inherit.via];
    if (typeof ownerId === 'string' && ownerId.length > 0 && scope === scopeOf(inherit.parent, ownerId).key) {
      return scope;
    }
  }
  if (Object.values(record.fields).some((descriptor: any) => descriptor.kind === 'annotatedText')) {
    const annotated = Object.entries(record.fields).find(([, descriptor]: [string, any]) => descriptor.kind === 'annotatedText');
    return resolveAnnotatedTextOwningScope(annotated![1], record.fields, row ?? payload ?? {}).key;
  }
  return scopeOf(record.name, id).key;
}

export function assertAnnotatedTextOperationPayload(name: string, fieldName: string, payload: any): any {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      Object.keys(payload).length !== 4 ||
      !Object.hasOwn(payload, 'version') || !Object.hasOwn(payload, 'id') ||
      !Object.hasOwn(payload, 'expected') || !Object.hasOwn(payload, 'operation')) {
    throw new ValidationError(`${name}.${fieldName}.operation requires exactly { version, id, expected, operation }`);
  }
  if (payload.version !== 1 || typeof payload.id !== 'string' || payload.id.length === 0) {
    throw new ValidationError(`${name}.${fieldName}.operation requires version 1 and a non-empty id`);
  }
  const expected = payload.expected;
  if (!expected || typeof expected !== 'object' || Array.isArray(expected) ||
      Object.keys(expected).length !== 2 || !Object.hasOwn(expected, 'structuralRevision') || !Object.hasOwn(expected, 'frontier') ||
      !Number.isSafeInteger(expected.structuralRevision) || expected.structuralRevision < 1 || !Array.isArray(expected.frontier)) {
    throw new ValidationError(`${name}.${fieldName}.operation expected requires structuralRevision and frontier`);
  }
  const operation = payload.operation;
  if (!operation || typeof operation !== 'object' || Array.isArray(operation) ||
      Object.keys(operation).length !== 3 || operation.kind !== 'text.apply' ||
      typeof operation.blockId !== 'string' || operation.blockId.length === 0 || !Object.hasOwn(operation, 'operation')) {
    throw new ValidationError(`${name}.${fieldName}.operation supports exactly a text.apply block operation`);
  }
  return Object.freeze({
    version: 1,
    id: payload.id,
    expected: Object.freeze({ structuralRevision: expected.structuralRevision, frontier: expected.frontier }),
    operation: Object.freeze({ kind: 'text.apply', blockId: operation.blockId, operation: canonicalTextOp(operation.operation) }),
  });
}

export function assertV9AnnotatedTextOffsetEditPayload(name: string, fieldName: string, payload: any): any {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length !== 4 ||
      payload.version !== 9 || typeof payload.id !== 'string' || payload.id.length === 0 ||
      !payload.authoring || typeof payload.authoring !== 'object' || Array.isArray(payload.authoring) ||
      Object.keys(payload.authoring).length !== 4 ||
      payload.authoring.version !== 1 || typeof payload.authoring.stream !== 'string' || payload.authoring.stream.length === 0 ||
      typeof payload.authoring.lease !== 'string' || payload.authoring.lease.length === 0 ||
      typeof payload.authoring.mutationId !== 'string' || payload.authoring.mutationId.length === 0 ||
      !payload.edit || typeof payload.edit !== 'object' || Array.isArray(payload.edit)) {
    throw new ValidationError(`${name}.${fieldName}.operation requires version 9 { id, authoring: { version, stream, lease, mutationId }, edit }`);
  }
  const pToken = (value: any, label: string) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3 ||
        typeof value.positionToken !== 'string' || value.positionToken.length === 0 ||
        !Number.isSafeInteger(value.offset) || value.offset < 0 ||
        (value.affinity !== 'left' && value.affinity !== 'right')) {
      throw new ValidationError(`${name}.${fieldName}.operation ${label} requires { positionToken, offset, affinity }`);
    }
    return Object.freeze({ positionToken: value.positionToken, offset: value.offset, affinity: value.affinity });
  };
  let edit;
  const e = payload.edit;
  if (e.kind === 'text.insert' && Object.keys(e).length === 3 && typeof e.text === 'string' && e.text.length > 0) {
    try { assertWellFormedText(e.text); } catch (error: any) { throw new ValidationError(`${name}.${fieldName}.operation inserted text ${error.message}`); }
    edit = Object.freeze({ kind: 'text.insert', at: pToken(e.at, 'insert position'), text: e.text });
  } else if (e.kind === 'text.delete' && Object.keys(e).length === 3) {
    edit = Object.freeze({ kind: 'text.delete', from: pToken(e.from, 'delete start'), to: pToken(e.to, 'delete end') });
  } else if (e.kind === 'text.replace' && Object.keys(e).length === 4 && typeof e.text === 'string' && e.text.length > 0) {
    try { assertWellFormedText(e.text); } catch (error: any) { throw new ValidationError(`${name}.${fieldName}.operation replacement text ${error.message}`); }
    edit = Object.freeze({ kind: 'text.replace', from: pToken(e.from, 'replace start'), to: pToken(e.to, 'replace end'), text: e.text });
  } else if (e.kind === 'block.split' && Object.keys(e).length === 3 && typeof e.temporaryBlock === 'string' && e.temporaryBlock.length > 0) {
    edit = Object.freeze({ kind: 'block.split', at: pToken(e.at, 'split position'), temporaryBlock: e.temporaryBlock });
  } else if (e.kind === 'block.merge' && Object.keys(e).length === 3 && typeof e.leftPositionToken === 'string' && e.leftPositionToken && typeof e.rightPositionToken === 'string' && e.rightPositionToken) {
    edit = Object.freeze({ kind: 'block.merge', leftPositionToken: e.leftPositionToken, rightPositionToken: e.rightPositionToken });
  } else if (e.kind === 'annotation.apply' && Object.keys(e).length === 4 && e.annotation && typeof e.annotation === 'object') {
    edit = Object.freeze({ kind: 'annotation.apply', annotation: frozenJsonSnapshot(e.annotation), from: pToken(e.from, 'annotation start'), to: pToken(e.to, 'annotation end') });
  } else if (e.kind === 'annotation.detach' && Object.keys(e).length === 3 && typeof e.annotationId === 'string' && e.annotationId && typeof e.positionToken === 'string' && e.positionToken) {
    edit = Object.freeze({ kind: 'annotation.detach', annotationId: e.annotationId, positionToken: e.positionToken });
  } else if (e.kind === 'annotation.remove' && Object.keys(e).length === 2 && typeof e.annotationId === 'string' && e.annotationId) {
    edit = Object.freeze({ kind: 'annotation.remove', annotationId: e.annotationId });
  } else if (e.kind === 'block.continue' && Object.keys(e).length === 3 && typeof e.temporaryBlock === 'string' && e.temporaryBlock.length > 0) {
    edit = Object.freeze({ kind: 'block.continue', at: pToken(e.at, 'continue position'), temporaryBlock: e.temporaryBlock });
  } else if (e.kind === 'block.split-and-assign' && Object.keys(e).length === 4 && typeof e.temporaryBlock === 'string' && e.temporaryBlock.length > 0) {
    edit = Object.freeze({ kind: 'block.split-and-assign', at: pToken(e.at, 'split position'), temporaryBlock: e.temporaryBlock, annotation: frozenJsonSnapshot(e.annotation) });
  } else if (e.kind === 'block-group.assignment.set' && Object.keys(e).length === 3) {
    edit = Object.freeze({ kind: 'block-group.assignment.set', selection: assertV9GroupSelection(name, fieldName, e.selection), annotation: frozenJsonSnapshot(e.annotation) });
  } else if (e.kind === 'block-group.assignment.clear' && Object.keys(e).length === 3) {
    if (typeof e.family !== 'string' || e.family.length === 0) throw new ValidationError(`${name}.${fieldName}.operation invalid clear assignment`);
    edit = Object.freeze({ kind: 'block-group.assignment.clear', selection: assertV9GroupSelection(name, fieldName, e.selection), family: e.family });
  } else {
    throw new ValidationError(`${name}.${fieldName}.operation v9 edit is not supported`);
  }
  return Object.freeze({ version: 9, id: payload.id, authoring: Object.freeze({ version: 1, stream: payload.authoring.stream, lease: payload.authoring.lease, mutationId: payload.authoring.mutationId }), edit });
}

function assertV9GroupSelection(name: string, fieldName: string, value: any): any {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError(`${name}.${fieldName}.operation selection is invalid`);
  if (value.kind === 'one' && Object.keys(value).length === 2 && typeof value.groupToken === 'string' && value.groupToken) return Object.freeze({ kind: 'one', groupToken: value.groupToken });
  if ((value.kind === 'consecutive' || value.kind === 'listed') && Object.keys(value).length === 2 && Array.isArray(value.groupTokens) && value.groupTokens.length && value.groupTokens.every((token: any) => typeof token === 'string' && token) && new Set(value.groupTokens).size === value.groupTokens.length) return Object.freeze({ kind: value.kind, groupTokens: Object.freeze([...value.groupTokens]) });
  throw new ValidationError(`${name}.${fieldName}.operation selection is invalid`);
}

function ownerFieldOf(entity: any) {
  for (const [fieldName, descriptor] of Object.entries(entity.fields) as Array<[string, any]>) {
    if (descriptor.type === 'ref' && descriptor.role && descriptor.readonly) {
      return fieldName;
    }
  }
  return null;
}

function materializeDefault(defaultValue: any) {
  const value = typeof defaultValue === 'function' ? defaultValue() : defaultValue;
  return value !== null && typeof value === 'object' ? structuredClone(value) : value;
}

function assertAnnotatedTextImportPayload(name: string, fieldName: string, descriptor: any, value: any) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${name}.${fieldName} annotated-text import must be a non-array object`);
  }
  const allowed = new Set(['version', 'blocks', 'ranges']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new ValidationError(`${name}.${fieldName} annotated-text import has unknown key '${key}'`);
  }
  if (value.version !== 1) throw new ValidationError(`${name}.${fieldName} annotated-text import requires version 1`);
  const { blocks } = value;
  if (!Array.isArray(blocks) || blocks.length === 0) throw new ValidationError(`${name}.${fieldName} annotated-text import must have a non-empty blocks array`);
  for (const key of Object.keys(blocks)) {
    if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= blocks.length) {
      throw new ValidationError(`${name}.${fieldName} annotated-text import blocks has an extra property`);
    }
  }
  const blockFieldNames = descriptor.block ? Object.keys(descriptor.block) : [];
  const canonicalBlocks = [];
  // Blockless (issue #33): measurements are DOCUMENT-scoped, one per family
  // across the whole document — a family carried by more than one source block
  // is a client error, caught at admission.
  const importedMeasurementFamilies = new Set();
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      throw new ValidationError(`${name}.${fieldName} annotated-text import blocks[${i}] must be a non-array object`);
    }
    const allowedBlock = new Set(['text', 'fields', 'measurements', 'wordEvidence']);
    for (const key of Object.keys(block)) {
      if (!allowedBlock.has(key)) throw new ValidationError(`${name}.${fieldName} annotated-text import blocks[${i}] has unknown key '${key}'`);
    }
    try { assertWellFormedText(block.text); } catch (error: any) {
      throw new ValidationError(`${name}.${fieldName} annotated-text import blocks[${i}].text ${error.message}`);
    }
    if (block.text.length === 0) {
      throw new ValidationError(`${name}.${fieldName} annotated-text import has an empty text block`);
    }
    if (block.fields !== undefined) {
      if (!block.fields || typeof block.fields !== 'object' || Array.isArray(block.fields)) {
        throw new ValidationError(`${name}.${fieldName} annotated-text import blocks[${i}].fields must be a non-array object or omitted`);
      }
      for (const fieldName of Object.keys(block.fields)) {
        if (!blockFieldNames.includes(fieldName)) {
          throw new ValidationError(`${name}.${fieldName} annotated-text import blocks[${i}].fields has unknown field '${fieldName}'`);
        }
      }
    }
    const fields: Record<string, any> = {};
    for (const declaredName of blockFieldNames) {
      const fieldDescriptor = descriptor.block[declaredName];
      let fieldValue;
      if (Object.hasOwn(block.fields ?? {}, declaredName)) {
        fieldValue = block.fields[declaredName];
      } else if (fieldDescriptor.default !== undefined) {
        fieldValue = materializeDefault(fieldDescriptor.default);
      } else if (fieldDescriptor.nullable || fieldDescriptor.optional) {
        fieldValue = null;
      } else {
        throw new ValidationError(`${name}.${fieldName} annotated-text import blocks[${i}].fields is missing required field '${declaredName}'`);
      }
      const strategy = resolveStrategy(fieldDescriptor.kind);
      const validation = strategy.validate(fieldValue, fieldDescriptor);
      if (validation !== true) {
        throw new ValidationError(`${name}.${fieldName} annotated-text import blocks[${i}].fields.${declaredName}: ${validation}`);
      }
      if (typeof fieldDescriptor.validate === 'function' && fieldDescriptor.validate(fieldValue) !== true) {
        throw new ValidationError(`${name}.${fieldName} annotated-text import blocks[${i}].fields.${declaredName} failed declared validation`);
      }
      fields[declaredName] = fieldValue;
    }
    const measurements = [];
    if (block.measurements !== undefined) {
      if (!Array.isArray(block.measurements)) throw new ValidationError(`${name}.${fieldName} annotated-text import blocks[${i}].measurements must be an array`);
      const families = new Set();
      for (let j = 0; j < block.measurements.length; j++) {
        const measurement = block.measurements[j];
        if (!measurement || typeof measurement !== 'object' || Array.isArray(measurement) || Object.keys(measurement).length !== 2 || typeof measurement.family !== 'string' || !Object.hasOwn(measurement, 'payload')) {
          throw new ValidationError(`${name}.${fieldName} annotated-text import blocks[${i}].measurements[${j}] has invalid shape`);
        }
        if (families.has(measurement.family)) throw new ValidationError(`${name}.${fieldName} annotated-text import blocks[${i}] has duplicate measurement family '${measurement.family}'`);
        families.add(measurement.family);
        if (importedMeasurementFamilies.has(measurement.family)) throw new ValidationError(`${name}.${fieldName} annotated-text import has duplicate measurement family '${measurement.family}' across source blocks`);
        importedMeasurementFamilies.add(measurement.family);
        const config = descriptor.measurements.find((entry: any) => entry.measurementName === measurement.family);
        if (!config) throw new ValidationError(`${name}.${fieldName} annotated-text import has unknown measurement family '${measurement.family}'`);
        let payload;
        try { payload = frozenJsonSnapshot(measurement.payload); } catch { throw new ValidationError(`${name}.${fieldName} annotated-text import measurement payload is not JSON`); }
        const extension = resolveDeclarationMeasurementExtension(config);
        if (!extension) throw new ValidationError(`${name}.${fieldName} annotated-text import has no structural adapter for measurement '${measurement.family}'`);
        try {
          const result = extension.validate(Object.freeze({ version: 1, formatVersion: config.formatVersion, blockText: block.text, payload }));
          if (result !== undefined) throw new Error('validate returned a value');
        } catch { throw new ValidationError(`${name}.${fieldName} annotated-text import measurement '${measurement.family}' failed validation`); }
        measurements.push(Object.freeze({ id: randomUUID(), family: measurement.family, formatVersion: config.formatVersion, payload }));
      }
    }
    let wordEvidence;
    if (block.wordEvidence !== undefined) {
      try {
        wordEvidence = assertWordEvidencePayload(block.wordEvidence, { families: descriptor.wordEvidence, blockText: block.text });
      } catch (error: any) {
        throw new ValidationError(`${name}.${fieldName} annotated-text import blocks[${i}].wordEvidence ${error.message}`);
      }
    }
    canonicalBlocks.push(Object.freeze({
      id: randomUUID(),
      text: block.text,
      fields: Object.freeze(fields),
      measurements: Object.freeze(measurements),
      ...(wordEvidence === undefined ? {} : { wordEvidence }),
    }));
  }
  // Document-absolute annotation ranges over the concatenated block texts
  // (issue #216): one annotation row, its family field row, and one membership
  // per range, seeded by the create projection in the same transaction.
  const fullText = blocks.map((block: any) => block.text).join('');
  const canonicalRanges = [];
  const annotationIds = new Set();
  if (value.ranges !== undefined) {
    if (!Array.isArray(value.ranges)) throw new ValidationError(`${name}.${fieldName} annotated-text import ranges must be an array`);
    for (let i = 0; i < value.ranges.length; i++) {
      const range = value.ranges[i];
      if (!range || typeof range !== 'object' || Array.isArray(range)) {
        throw new ValidationError(`${name}.${fieldName} annotated-text import ranges[${i}] must be a non-array object`);
      }
      const allowedRange = new Set(['annotationId', 'family', 'start', 'end', 'fields']);
      for (const key of Object.keys(range)) {
        if (!allowedRange.has(key)) throw new ValidationError(`${name}.${fieldName} annotated-text import ranges[${i}] has unknown key '${key}'`);
      }
      const { annotationId, family, start, end } = range;
      if (typeof annotationId !== 'string' || annotationId.length === 0) {
        throw new ValidationError(`${name}.${fieldName} annotated-text import ranges[${i}].annotationId must be a non-empty string`);
      }
      if (annotationIds.has(annotationId)) throw new ValidationError(`${name}.${fieldName} annotated-text import ranges[${i}] has duplicate annotationId '${annotationId}'`);
      annotationIds.add(annotationId);
      const declaredAnnotation = descriptor.annotations?.find((entry: any) => entry.annotationName === family);
      if (typeof family !== 'string' || !declaredAnnotation) {
        throw new ValidationError(`${name}.${fieldName} annotated-text import ranges[${i}].family '${String(family)}' is not declared`);
      }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > fullText.length) {
        throw new ValidationError(`${name}.${fieldName} annotated-text import ranges[${i}] offsets must be safe integers with 0 <= start < end <= ${fullText.length}`);
      }
      try { assertUtf16Offset(fullText, start); assertUtf16Offset(fullText, end); } catch (error: any) {
        throw new ValidationError(`${name}.${fieldName} annotated-text import ranges[${i}] offsets ${error.message}`);
      }
      const declaredFields: Record<string, any> = declaredAnnotation.fields ?? {};
      if (range.fields !== undefined) {
        if (!range.fields || typeof range.fields !== 'object' || Array.isArray(range.fields)) {
          throw new ValidationError(`${name}.${fieldName} annotated-text import ranges[${i}].fields must be a non-array object or omitted`);
        }
        for (const fieldName of Object.keys(range.fields)) {
          if (!Object.hasOwn(declaredFields, fieldName)) {
            throw new ValidationError(`${name}.${fieldName} annotated-text import ranges[${i}].fields has unknown field '${fieldName}'`);
          }
        }
      }
      const rangeFields: Record<string, any> = {};
      for (const [fieldName, fieldDescriptor] of Object.entries(declaredFields)) {
        let fieldValue;
        if (Object.hasOwn(range.fields ?? {}, fieldName)) {
          fieldValue = range.fields[fieldName];
        } else if (fieldDescriptor.default !== undefined) {
          fieldValue = materializeDefault(fieldDescriptor.default);
        } else if (fieldDescriptor.nullable || fieldDescriptor.optional) {
          fieldValue = null;
        } else {
          throw new ValidationError(`${name}.${fieldName} annotated-text import ranges[${i}].fields is missing required field '${fieldName}'`);
        }
        if (fieldValue === null && fieldDescriptor.nullable === true) {
          rangeFields[fieldName] = null;
          continue;
        }
        const strategy = resolveStrategy(fieldDescriptor.kind);
        const validation = strategy.validate(fieldValue, fieldDescriptor);
        if (validation !== true) {
          throw new ValidationError(`${name}.${fieldName} annotated-text import ranges[${i}].fields.${fieldName}: ${validation}`);
        }
        if (typeof fieldDescriptor.validate === 'function' && fieldDescriptor.validate(fieldValue) !== true) {
          throw new ValidationError(`${name}.${fieldName} annotated-text import ranges[${i}].fields.${fieldName} failed declared validation`);
        }
        rangeFields[fieldName] = fieldValue;
      }
      canonicalRanges.push(Object.freeze({ annotationId, family, start, end, fields: Object.freeze(rangeFields) }));
    }
  }
  const imported = { version: 1, actor: randomUUID().replaceAll('-', ''), blocks: Object.freeze(canonicalBlocks) };
  if (value.ranges !== undefined) (imported as Record<string, unknown>).ranges = Object.freeze(canonicalRanges);
  return Object.freeze(imported);
}

export function materializeCreateDefaults(record: any, payload: any) {
  const data = { ...payload };
  for (const [fieldName, descriptor] of Object.entries(record.fields) as Array<[string, any]>) {
    if (!(fieldName in data) && descriptor.default !== undefined) {
      data[fieldName] = materializeDefault(descriptor.default);
      data[fieldName] = validateMaterializedField(record, fieldName, data[fieldName]);
    }
  }
  return data;
}

export function createCrudHandlers({ record, sideTableStrategyEntries, conditionalHistory = false, conditionalCreateHistory = false }: {
  record: any;
  sideTableStrategyEntries: any[];
  conditionalHistory?: boolean;
  conditionalCreateHistory?: boolean;
}) {
  const { name, fields, verbs } = record;
  const ownerField = ownerFieldOf({ name, fields });

  const handlers: Record<string, any> = {
    [`${name}.create`]: ({ payload, principal, db, history, scope }: any) => {
      if (Object.hasOwn(payload, '__workbench')) {
        throw new ValidationError(`${name}.__workbench is reserved for framework event metadata`);
      }
      const { id: requestedId, ...fieldsPayload } = payload;
      const annotatedImports: Record<string, any> = {};
      for (const [fieldName, descriptor] of Object.entries(fields) as Array<[string, any]>) {
        if (descriptor.kind === 'annotatedText' && Object.hasOwn(fieldsPayload, fieldName)) {
          annotatedImports[fieldName] = assertAnnotatedTextImportPayload(name, fieldName, descriptor, fieldsPayload[fieldName]);
          delete fieldsPayload[fieldName];
        }
        if (descriptor.kind === 'crdt' && descriptor.type === 'text' && fieldName in fieldsPayload) {
          throw new ValidationError(`${name}.${fieldName} accepts native operations only; create the row then dispatch ${name}.${fieldName}.apply`);
        }
      }
      const validatedFields = validateMutation(record, fieldsPayload);
      if (requestedId !== undefined && (typeof requestedId !== 'string' || requestedId.length === 0)) {
        throw new ValidationError(`${name}.id: expected a non-empty text id`);
      }
      const id = requestedId ?? randomUUID();
      if (history) {
        if (!conditionalCreateHistory || history.operation !== 'redo' || !history.input || Object.keys(history.input).length !== 2) throw new ValidationError(`${name}.create history input is invalid`);
        const replacement = history.input.replacement;
        if (history.input.expected !== null || !replacement || replacement.id !== id) throw new ValidationError(`${name}.create history input rows are invalid`);
        const columns = db.prepare(`PRAGMA table_info(${name})`).all().map((column: any) => column.name);
        if (Object.keys(replacement).length !== columns.length || columns.some((column: any) => !Object.hasOwn(replacement, column)) || db.prepare(`SELECT 1 FROM ${name} WHERE id = ?`).get(id)) {
          throw Object.assign(new Error(`${name}.create history expected row conflicts`), { status: 409 });
        }
        const restored: Record<string, any> = { id };
        for (const [fieldName, descriptor] of Object.entries(fields) as Array<[string, any]>) restored[fieldName] = deserializeField(descriptor, replacement[fieldName]);
        return { events: [{ handle: verbs.created.handle, type: verbs.created.type, scope: resolveGeneratedEventScope(record, { id, payload: replacement, scope }), data: restored }], privateFact: { before: null, after: replacement } };
      }
      const data = materializeCreateDefaults(record, { ...validatedFields, id });
      if (ownerField) data[ownerField] = principal?.id;
      const annotatedText = Object.fromEntries(
        Object.entries(fields)
          .filter(([, descriptor]: [string, any]) => descriptor.kind === 'annotatedText')
          .map(([fieldName]) => {
            const value = annotatedImports[fieldName] ?? Object.freeze({
            version: 1,
            actor: randomUUID().replaceAll('-', ''),
            blocks: Object.freeze([Object.freeze({ id: randomUUID(), text: '', fields: null })]),
            });
            return [fieldName, Object.freeze({ ...value, initialBlockId: value.blocks[0].id })];
          }),
      );
      if (Object.keys(annotatedText).length > 0) {
        data.__workbench = Object.freeze({ annotatedText: Object.freeze(annotatedText) });
      }
      const events = [{
        handle: verbs.created.handle,
        type: verbs.created.type,
        scope: resolveGeneratedEventScope(record, { id, payload: data, scope }),
        data,
      }];
      if (!conditionalCreateHistory) return events;
      // The durable fact must be complete before it is stored; projections cannot
      // repair an already-persisted private fact after the fact.
      const columns = db.prepare(`PRAGMA table_info(${name})`).all().map((column: any) => column.name);
      const after = Object.fromEntries(columns.map((column: any) => {
        if (column === 'id') return [column, id];
        const descriptor = fields[column];
        return [column, descriptor && Object.hasOwn(data, column) ? serializeField(descriptor, data[column]) : null];
      }));
      return { events, privateFact: { before: null, after } };
    },
    [`${name}.update`]: ({ payload, principal: _p, db, history, scope }: any) => {
      const { id, ...rest } = payload;
      if (!id) throw Object.assign(new Error('update requires an id'), { status: 400 });
      if (Object.keys(rest).length === 0) {
        if (!history) throw new ValidationError(`${name}.update requires at least one field to change`);
      }
      const currentStored = conditionalHistory ? rawRow(db, name, id) as any : null;
      if (conditionalHistory && !currentStored) throw Object.assign(new Error(`${name} ${id} not found`), { status: 404 });
      if (history) {
        if (!conditionalHistory || !history || (history.operation !== 'undo' && history.operation !== 'redo') || !history.input || Object.keys(history.input).length !== 2) throw new ValidationError(`${name}.update history input is invalid`);
        const { expected, replacement } = history.input;
        const columns = db.prepare(`PRAGMA table_info(${name})`).all().map((column: any) => column.name);
        const validRow = (row: any) => row && typeof row === 'object' && !Array.isArray(row) && Object.keys(row).length === columns.length && columns.every((column: any) => Object.hasOwn(row, column));
        if (!validRow(expected) || !validRow(replacement) || expected.id !== id || replacement.id !== id) throw new ValidationError(`${name}.update history input rows are invalid`);
        if (!columns.every((column: any) => Object.is(currentStored[column], expected[column]))) throw Object.assign(new Error(`${name}.update history expected row conflicts`), { status: 409 });
        const data: Record<string, any> = {};
        for (const [fieldName, descriptor] of Object.entries(fields) as Array<[string, any]>) {
          if (descriptor.kind === 'struct') {
            const cells = Object.keys(descriptor.cells).map((cell) => `${fieldName}__${cell}`);
            if (cells.some((cell) => !Object.is(currentStored[cell], replacement[cell]))) {
              data[fieldName] = Object.fromEntries(cells.map((column) => {
                const cell = column.slice(fieldName.length + 2);
                return [cell, deserializeField(descriptor.cells[cell], replacement[column])];
              }));
            }
          } else if (Object.hasOwn(replacement, fieldName) && !Object.is(currentStored[fieldName], replacement[fieldName])) {
            data[fieldName] = deserializeField(descriptor, replacement[fieldName]);
          }
        }
        return { events: [{ handle: verbs.updated.handle, type: verbs.updated.type, scope: resolveGeneratedEventScope(record, { id, row: currentStored, payload: replacement, scope }), data: { ...data, id } }], privateFact: { before: expected, after: replacement } };
      }
      for (const fieldName of Object.keys(rest)) {
        if (fields[fieldName]?.kind === 'annotatedText') {
          throw new ValidationError(`${name}.${fieldName} is an annotated-text field and cannot be set through update payloads`);
        }
        if (fields[fieldName]?.immutable === true) {
          throw new ValidationError(`${name}.${fieldName} is immutable: a client may set it on create but may not change it.`);
        }
      }
      const validatedFields = validateMutation(record, rest);
      const stateTransitions = [];
      // Transition guard: for every state field in the payload, pre-read the
      // current row and verify the move is in the declared transition graph.
      // Runs after structural validation so invalid targets report as domain
      // errors before transition errors (clearer diagnostic order).
      for (const [fieldName, descriptor] of Object.entries(fields) as Array<[string, any]>) {
        if (descriptor.kind !== 'state') continue;
        if (!(fieldName in validatedFields)) continue;
        let current;
        try {
          // findById is installed by installEntityQueries on the record before
          // createCrudHandlers is called, so it is available at handler runtime.
          current = record.findById(id);
        } catch (e) {
          throw Object.assign(
            new ValidationError(
              'Illegal transition check requires a durable database ' +
                `(in-memory kernel cannot verify state transitions for ${name}.${fieldName})`,
            ),
            { status: 400 },
          );
        }
        if (!current || current[fieldName] == null) {
          throw Object.assign(
            new ValidationError(
              `${name}.${fieldName}: illegal transition (no current state) -> ${validatedFields[fieldName]}`,
            ),
            { status: 400 },
          );
        }
        const currentValue = current[fieldName];
        if (currentValue === validatedFields[fieldName]) continue; // no-op, skip check
        const legalTargets = descriptor.transitions[currentValue];
        if (!legalTargets || !legalTargets.includes(validatedFields[fieldName])) {
          throw Object.assign(
            new ValidationError(
              `${name}.${fieldName}: illegal transition ${currentValue} -> ${validatedFields[fieldName]}`,
            ),
            { status: 400 },
          );
        }
        stateTransitions.push({ fieldName, from: currentValue, to: validatedFields[fieldName] });
      }
      const data: Record<string, any> = { ...validatedFields, id };
      for (const [fieldName, descriptor] of Object.entries(fields) as Array<[string, any]>) {
        if (descriptor.touch) data[fieldName] = new Date();
      }
      const updateRow = rawRow(db, name, id) ?? null;
      const result = [{
        handle: verbs.updated.handle,
        type: verbs.updated.type,
        scope: resolveGeneratedEventScope(record, { id, row: updateRow, payload, scope }),
        data,
        ...(stateTransitions.length > 0 ? { _stateTransitions: stateTransitions } : {}),
      }];
      if (conditionalHistory) {
        const after = { ...currentStored };
        for (const [fieldName, value] of Object.entries(data)) {
          const descriptor = fields[fieldName];
          if (!descriptor || descriptor.kind === 'store') continue;
          if (descriptor.kind === 'struct') Object.assign(after, Object.fromEntries(Object.entries(flattenStruct(fieldName, descriptor, value))));
          else after[fieldName] = serializeField(descriptor, value);
        }
        for (const [fieldName, descriptor] of Object.entries(fields) as Array<[string, any]>) if (descriptor.touch) after[fieldName] = serializeField(descriptor, data[fieldName]);
        return { events: result, privateFact: { before: currentStored, after } };
      }
      return result;
    },
    [`${name}.remove`]: async ({ payload, principal, db, history, scope }: any) => {
      if (!payload.id) throw Object.assign(new Error('remove requires an id'), { status: 400 });
      if (history) {
        if (!conditionalCreateHistory || history.operation !== 'undo' || !history.input || Object.keys(history.input).length !== 2) throw new ValidationError(`${name}.remove history input is invalid`);
        if (!history.input.expected || history.input.replacement !== null || history.input.expected.id !== payload.id) throw new ValidationError(`${name}.remove history input row is invalid`);
        const columns = db.prepare(`PRAGMA table_info(${name})`).all().map((column: any) => column.name);
        const current = rawRow(db, name, payload.id);
        if (!current || Object.keys(history.input.expected).length !== columns.length || columns.some((column: any) => !Object.hasOwn(history.input.expected, column)) || !columns.every((column: any) => Object.is(current[column], history.input.expected[column]))) {
          throw Object.assign(new Error(`${name} remove conflicts`), { status: 409 });
        }
        if (record.removalCascade && (await record.removalCascadeDescendants(payload.id, db)).length > 0) {
          throw Object.assign(new Error(`${name} remove conflicts: cascade descendants exist`), { status: 409 });
        }
        return { events: [{ handle: verbs.removed.handle, type: verbs.removed.type, scope: resolveGeneratedEventScope(record, { id: payload.id, row: current, payload: history.input.expected, scope }), data: { id: payload.id } }], privateFact: { before: history.input.expected, after: null } };
      }
      if (record.removalCascade) {
        return record.removalCascade(payload.id, principal, db)
          .then((rows: any) => {
            const events = rows.map(({ entity, id }: any, index: number) => ({
              ...entity.removedEvent(id, db),
              [CASCADE_PREAUTHORIZED]: true,
              ...(index < rows.length - 1 ? { [CASCADE_DESCENDANT]: true } : {}),
            }));
            if (!conditionalCreateHistory) return events;
            const parent = rows.at(-1);
            const before = rawRow(db, name, parent.id);
            return { events, privateFact: { before, after: null } };
          });
      }
      // A conditional remove reads its private preimage below, so authorize the
      // target row first rather than allowing that read to precede admission.
      const admissionRow = rawRow(db, name, payload.id);
      if (!admissionRow || (!(await admitRow({ kind: 'verb', entity: record, row: admissionRow, principal, verb: 'remove' }))
        && !(record.name === 'Invitation' && admitsInvitationRemoval(principal, payload.id)))) {
        throw Object.assign(new Error('forbidden'), { status: 403 });
      }
      const events = [{
        handle: verbs.removed.handle,
        type: verbs.removed.type,
        scope: resolveGeneratedEventScope(record, { id: payload.id, row: admissionRow, payload, scope }),
        data: { id: payload.id },
      }];
      if (!conditionalCreateHistory) return events;
      return { events, privateFact: { before: admissionRow, after: null } };
    },
  };
  const cursorPolicy: Record<string, any> = {};
  const annotatedEntries = Object.entries(fields).filter(([, descriptor]: [string, any]) => descriptor.kind === 'annotatedText');
  if (conditionalHistory) {
    Object.defineProperty(handlers[`${name}.update`], 'inTransaction', { value: true });
  }
  if (conditionalCreateHistory) {
    Object.defineProperty(handlers[`${name}.create`], 'inTransaction', { value: true });
  }
  Object.defineProperty(handlers[`${name}.remove`], 'inTransaction', { value: true });
  if (annotatedEntries.length > 0) {
    for (const type of [`${name}.create`, `${name}.update`, `${name}.remove`]) {
      Object.defineProperties(handlers[type], { inTransaction: { value: true }, batchForbidden: { value: true } });
    }
  }
  if (annotatedEntries.length > 0) {
    const retirementType = `${name}.annotatedText.retire`;
      const retirementHandler = async ({ payload, principal, db, scope }: any) => {
      if (!payload || Object.keys(payload).length !== 1 || typeof payload.id !== 'string' || !payload.id) throw new ValidationError(`${retirementType} requires { id }`);
      const row = rawRow(db, name, payload.id);
      const owningScope = row && resolveAnnotatedTextOwningScope(annotatedEntries[0][1], fields, row).key;
      if (!row || scope !== owningScope) throw new ValidationError(`${retirementType} requires its declared project scope`);
        if (!row || principal?.id == null || annotatedEntries.some(([, descriptor]: [string, any]) => String(row[descriptor.owner]) !== String(principal.id))) throw Object.assign(new Error('forbidden'), { status: 403 });
        for (const [fieldName] of annotatedEntries) clearAuthoringState(db, `${name}_${fieldName}`, payload.id);
      const targetActionTypes = new Set([`${name}.create`, `${name}.update`, `${name}.remove`, ...annotatedEntries.map(([fieldName]) => `${name}.${fieldName}.operation`)]);
      const targetEventTypes = new Set([verbs.created.type, verbs.updated.type, verbs.removed.type, ...annotatedEntries.map(([fieldName]) => eventHandles.native(name, fieldName, 'operated').type)]);
      const censusRows = db.prepare('SELECT DISTINCT actionType AS type FROM _ActionReceipt WHERE scope = ?').all(owningScope);
      const censusEvents = db.prepare('SELECT DISTINCT eventType AS type FROM _Log WHERE scope = ?').all(owningScope);
      const hasErasureTargets = db.prepare("SELECT 1 FROM _ActionReceipt WHERE scope = ? AND json_extract(actionData, '$.id') = ? LIMIT 1").get(scope, payload.id);
      const generation = randomUUID();
      const events = annotatedEntries.map(([fieldName]) => {
        const handle = eventHandles.native(name, fieldName, 'retired');
        return { handle, type: handle.type, scope: owningScope, data: Object.freeze({ version: 1, id: payload.id, generation, retiredAt: new Date().toISOString() }) };
      });
      const removed = { handle: verbs.removed.handle, type: verbs.removed.type, scope: owningScope, data: { id: payload.id } };
      const commit: Record<string, any> = {
        events: [...events, removed],
      };
      if (hasErasureTargets) commit.directive = erasureDirectivePreparation({ owningScope, subject: payload.id, census: { version: 1, rules: [
          ...censusRows.map(({ type }: any) => ({ kind: 'action', type, disposition: targetActionTypes.has(type) ? 'target' : 'retain', identityPointers: targetActionTypes.has(type) ? ['/id'] : [] })),
          ...censusEvents.map(({ type }: any) => ({ kind: 'event', type, disposition: targetEventTypes.has(type) ? 'target' : 'retain', identityPointers: targetEventTypes.has(type) ? ['/id'] : [] })),
        ] } });
      return commit;
    };
    Object.defineProperties(retirementHandler, { inTransaction: { value: true }, batchForbidden: { value: true }, erasureCapable: { value: true } });
    handlers[retirementType] = retirementHandler;
    cursorPolicy[retirementType] = 'excluded';
  }

  for (const [fieldName, descriptor] of Object.entries(fields) as Array<[string, any]>) {
    if (descriptor.kind !== 'crdt' || descriptor.type !== 'text') continue;
    handlers[`${name}.${fieldName}.apply`] = ({ payload }: any) => {
      if (!payload || typeof payload.id !== 'string' || Object.keys(payload).length !== 2 || !Object.hasOwn(payload, 'operation')) {
        throw new ValidationError(`${name}.${fieldName}.apply requires exactly { id, operation }`);
      }
      const operation = canonicalTextOp(payload.operation);
      const handle = eventHandles.native(name, fieldName, 'applied');
      return [{ handle, type: handle.type, scope: scopeOf(name, payload.id).key, data: { id: payload.id, operation } }];
    };
    cursorPolicy[`${name}.${fieldName}.apply`] = 'excluded';
  }

  for (const [fieldName, descriptor] of Object.entries(fields) as Array<[string, any]>) {
    if (descriptor.kind !== 'annotatedText') continue;
    const operationType = `${name}.${fieldName}.operation`;
    const prefix = `${name}_${fieldName}`;
    const compiledMeta = getAnnotatedTextCompiledMetadata(descriptor);
    const measurementConfigs = compiledMeta?.measurementConfigs ?? {};
    const measurementFamilyList = compiledMeta?.measurementFamilyList ?? [];
    const owningDocumentScope = (db: any, id: any) => {
      const row = rawRow(db, name, id);
      if (!row) throw new ValidationError(`${name}.${fieldName}.operation document does not exist`);
      return resolveAnnotatedTextOwningScope(descriptor, fields, row).key;
    };

    const assertDocumentScope = ({ payload, scope, db, internal = false }: any) => {
      let command;
      if (payload.version === 9) command = assertV9AnnotatedTextOffsetEditPayload(name, fieldName, payload);
      else if (internal && payload.version === 1) command = assertAnnotatedTextOperationPayload(name, fieldName, payload);
      else if (internal && payload.version === 2) command = assertR2BlockSplitPayload(name, fieldName, payload);
      else if (internal && payload.version === 3) command = assertR3BlockMergePayload(name, fieldName, payload);
      else if (internal && payload.version === 4) command = assertR4AnnotationApplyPayload(name, fieldName, payload);
      else if (internal && payload.version === 7) {
        const selection = payload.operation?.selection;
        const keys = selection && typeof selection === 'object' && !Array.isArray(selection) ? Object.keys(selection).sort() : [];
        if (keys.join() !== 'blockId,endBlockId,endUtf16Offset,startBlockId,startUtf16Offset' ||
            selection.blockId !== selection.startBlockId || typeof selection.endBlockId !== 'string' || selection.endBlockId.length === 0) {
          throw new ValidationError(`${name}.${fieldName}.operation requires the exact v7 multi-block selection`);
        }
        const normalized = assertR4AnnotationApplyPayload(name, fieldName, {
          ...payload,
          version: 4,
          operation: { ...payload.operation, selection: {
            blockId: selection.blockId,
            startUtf16Offset: selection.startUtf16Offset,
            endUtf16Offset: selection.endUtf16Offset,
          } },
        });
        command = Object.freeze({ ...normalized, version: 7, operation: Object.freeze({
          ...normalized.operation,
          selection: Object.freeze({ ...selection }),
        }) });
      }
      else if (internal && payload.version === 5) command = assertR5AnnotationDetachPayload(name, fieldName, payload);
      else throw new ValidationError(`${name}.${fieldName}.operation requires version 9`);
      const row = rawRow(db, name, command.id);
      if (!row) throw new ValidationError(`${name}.${fieldName}.operation document does not exist`);
      const documentScope = resolveAnnotatedTextOwningScope(descriptor, fields, row).key;
      if (scope !== documentScope) {
        throw new ValidationError(`${name}.${fieldName}.operation requires document scope '${documentScope}'`);
      }
      return command;
    };

    const assertV9AuthoringBinding = ({ command, db, principal }: any) =>
      assertV9AuthoringBindingFromAdmit({ name, fieldName, prefix, command, db, principal });

    const r1Handler = async ({ payload, db, scope, principal, actionId }: any) => {
      if (payload.version === 9) {
        const command = assertV9AnnotatedTextOffsetEditPayload(name, fieldName, payload);
        return admitV9AnnotatedTextEdit({ name, fieldName, prefix, descriptor, record, compiledMeta, command, db, scope, principal, actionId, handlers: { splitHandler, r3Handler, r4Handler, r5Handler } });
      }
      const command = assertDocumentScope({ payload, scope, db });
      const documentScope = owningDocumentScope(db, command.id);
      const state = db.prepare(`SELECT structure_version, family_checkpoint FROM ${prefix}_state WHERE document_id = ?`).get(command.id);
      if (!state) throw new ValidationError(`${name}.${fieldName}.operation document does not exist`);
      const family = restoreTextFamilyCheckpoint(JSON.parse(state.family_checkpoint));
      if (state.structure_version !== command.expected.structuralRevision) {
        throw new ValidationError(`${name}.${fieldName}.operation conflicts with the current structural revision`);
      }
      const expectedFrontier = assertFrontier(command.expected.frontier);
      if (!frontierDominates(family.checkpoint.frontier, expectedFrontier)) {
        throw new ValidationError(`${name}.${fieldName}.operation frontier is not dominated by current state`);
      }
      if (JSON.stringify(command.operation.operation[4]) !== JSON.stringify(expectedFrontier)) {
        throw new ValidationError(`${name}.${fieldName}.operation dependencies do not match expected frontier`);
      }
      let nextFamily;
      try {
        nextFamily = applyTextOperationToBlock(family, command.operation.blockId, command.operation.operation);
      } catch (error: any) {
        throw new ValidationError(`${name}.${fieldName}.operation ${error.message}`);
      }
      const handle = eventHandles.native(name, fieldName, 'operated');
      return [{
        handle,
        type: handle.type,
        scope: documentScope,
        data: Object.freeze({
          version: 1,
          id: command.id,
          before: Object.freeze({ structuralRevision: state.structure_version, frontier: family.checkpoint.frontier }),
          operation: command.operation,
          after: Object.freeze({ structuralRevision: state.structure_version, frontier: nextFamily.checkpoint.frontier }),
          family: textFamilyCheckpoint(nextFamily),
        }),
      }];
    };

    const splitHandler = ({ payload, db, scope, structural = null }: any) => {
      const command = assertDocumentScope({ payload, scope, db, internal: true });
      const documentScope = owningDocumentScope(db, command.id);
      const state = db.prepare(`SELECT structure_version, family_checkpoint FROM ${prefix}_state WHERE document_id = ?`).get(command.id);
      if (!state) throw new ValidationError(`${name}.${fieldName}.operation document does not exist`);
      const family = restoreTextFamilyCheckpoint(JSON.parse(state.family_checkpoint));
      if (state.structure_version !== command.expected.structuralRevision ||
          JSON.stringify(family.checkpoint.frontier) !== JSON.stringify(command.expected.frontier)) {
        throw new ValidationError(`${name}.${fieldName}.operation conflicts with the current structural revision or frontier`);
      }

      const { blockId, utf16Offset } = command.operation;
      let blockText;
      try {
        blockText = materializeBlock(family, blockId);
      } catch (error: any) {
        throw new ValidationError(`${name}.${fieldName}.operation ${error.message}`);
      }

      if (utf16Offset === 0 || utf16Offset === blockText.length) {
        return [];
      }

      const newBlockId = randomUUID();
      let splitResult;
      try {
        splitResult = splitBlock(family, blockId, newBlockId, utf16Offset);
      } catch (error: any) {
        throw new ValidationError(`${name}.${fieldName}.operation ${error.message}`);
      }
      if (splitResult.type === 'unchanged') {
        return [];
      }

      const afterRevision = state.structure_version + 1;

      const leftBlockStored = rawRow(db, `${prefix}_block`, blockId);
      if (!leftBlockStored) throw new ValidationError(`${name}.${fieldName}.operation source block not found`);

      const blockFields = Object.keys(descriptor.block ?? {});
      const leftBlockFields: Record<string, any> = {};
      for (const bf of blockFields) {
        const bd = descriptor.block[bf];
        leftBlockFields[bf] = deserializeField(bd, leftBlockStored[bf]);
      }

      const leftBlockFact = Object.freeze({
        id: blockId,
        epoch: leftBlockStored.epoch,
        fields: Object.freeze(leftBlockFields),
      });

      const rightBlockFields: Record<string, any> = {};
      for (const bf of blockFields) {
        const bd = descriptor.block[bf];
        rightBlockFields[bf] = deserializeField(bd, leftBlockStored[bf]);
      }

      const rightBlockFact = Object.freeze({
        id: newBlockId,
        epoch: leftBlockStored.epoch,
        fields: Object.freeze(rightBlockFields),
      });

      const cleanBlocks = Object.freeze([leftBlockFact, rightBlockFact]);

      const memberships = db.prepare(
        `SELECT membership.annotation_id, membership.block_id, membership.ordinal, membership.start_point, membership.end_point
           FROM ${prefix}_membership AS membership
           JOIN ${prefix}_annotation AS annotation ON annotation.id = membership.annotation_id
          WHERE annotation.document_id = ?`,
      ).all(command.id);
      const pureMemberships = memberships.map((m: any) => ({
        annotationId: m.annotation_id,
        blockId: m.block_id,
        ordinal: m.ordinal,
        start: JSON.parse(m.start_point),
        end: JSON.parse(m.end_point),
      }));

      const annotations = db.prepare(`SELECT id, family FROM ${prefix}_annotation WHERE document_id = ?`).all(command.id);
      const pureAnnotations = annotations.map((a: any) => ({ id: a.id, family: a.family }));

      const membershipResult = splitBlockMemberships(
        splitResult.family as any, pureAnnotations, pureMemberships, blockId, newBlockId,
      );
      const affectedAnnotationIds = new Set(pureMemberships.filter((m: any) => m.blockId === blockId).map((m: any) => m.annotationId));

      const measurementFacts = [];
      if (measurementFamilyList.length > 0) {
        const sourceMeasurements = db.prepare(`SELECT id, family, format_version, payload FROM ${prefix}_measurement WHERE block_id = ? ORDER BY family`).all(blockId);
        const sourceBlockVisibleText = materializeBlock(family, blockId);
        const leftVisibleText = materializeBlock(splitResult.family, blockId);
        const rightVisibleText = materializeBlock(splitResult.family, newBlockId);

        for (const row of sourceMeasurements) {
          const measConfig = measurementConfigs[row.family];
          if (!measConfig) throw new ValidationError(`${name}.${fieldName}.operation unknown measurement family '${row.family}'`);
          const extSpec = resolveDeclarationMeasurementExtension(measConfig);
          if (!extSpec) throw new ValidationError(`${name}.${fieldName}.operation no structural adapter for measurement '${row.family}'`);

          let oldPayload;
          try {
            oldPayload = frozenJsonSnapshot(JSON.parse(row.payload));
          } catch {
            throw new ValidationError(`${name}.${fieldName}.operation measurement payload is not valid JSON`);
          }
          const partitionInput = Object.freeze({
            version: 1,
            formatVersion: measConfig.formatVersion,
            blockText: sourceBlockVisibleText,
            utf16Offset,
            payload: oldPayload,
          });

          const validatePayload = (payload: any, blockText: any) => {
            try {
              const result = extSpec.validate(Object.freeze({
                version: 1,
                formatVersion: measConfig.formatVersion,
                blockText,
                payload: frozenJsonSnapshot(payload),
              }));
              if (result !== undefined) throw new Error('returned a value');
            } catch {
              throw new ValidationError(`${name}.${fieldName}.operation measurement validation failed`);
            }
          };
          validatePayload(oldPayload, sourceBlockVisibleText);

          let leftResult;
          let rightResult;
          try {
            leftResult = extSpec.partition(partitionInput);
            rightResult = extSpec.partition(partitionInput);
          } catch {
            throw new ValidationError(`${name}.${fieldName}.operation measurement partition failed`);
          }

          if (JSON.stringify(leftResult) !== JSON.stringify(rightResult)) {
            throw new ValidationError(`${name}.${fieldName}.operation measurement partition is not deterministic`);
          }

          if (!leftResult || typeof leftResult !== 'object' || Array.isArray(leftResult) ||
              Object.keys(leftResult).length !== 3 || leftResult.version !== 1 ||
              !Object.hasOwn(leftResult, 'leftPayload') || !Object.hasOwn(leftResult, 'rightPayload')) {
            throw new ValidationError(`${name}.${fieldName}.operation measurement partition result must have leftPayload and rightPayload`);
          }

          let leftJsonPayload;
          let rightJsonPayload;
          try {
            leftJsonPayload = frozenJsonSnapshot(leftResult.leftPayload);
            rightJsonPayload = frozenJsonSnapshot(leftResult.rightPayload);
          } catch {
            throw new ValidationError(`${name}.${fieldName}.operation measurement partition payload is not JSON`);
          }
          validatePayload(leftJsonPayload, leftVisibleText);
          validatePayload(rightJsonPayload, rightVisibleText);

          let leftPayload;
          let rightPayload;
          try {
            leftPayload = JSON.stringify(leftJsonPayload);
            rightPayload = JSON.stringify(rightJsonPayload);
          } catch {
            throw new ValidationError(`${name}.${fieldName}.operation measurement partition payload is not JSON`);
          }
          if (leftPayload === undefined || rightPayload === undefined) {
            throw new ValidationError(`${name}.${fieldName}.operation measurement partition payload is not JSON`);
          }

          measurementFacts.push(Object.freeze({
            id: row.id,
            blockId,
            family: row.family,
            formatVersion: row.format_version,
            payload: frozenJsonSnapshot(JSON.parse(leftPayload)),
          }));
          measurementFacts.push(Object.freeze({
            id: randomUUID(),
            blockId: newBlockId,
            family: row.family,
            formatVersion: row.format_version,
            payload: frozenJsonSnapshot(JSON.parse(rightPayload)),
          }));
        }
      }

      if (structural) {
        if (structural.kind !== 'block.continue' && structural.kind !== 'block.split-and-assign') throw new ValidationError(`${name}.${fieldName}.operation invalid structural kind`);
        const leftGroup = db.prepare(`SELECT group_id FROM ${prefix}_block_group WHERE block_id = ?`).get(blockId);
        if (!leftGroup || leftGroup.group_id !== structural.groupId) throw new ValidationError(`${name}.${fieldName}.operation source group changed`);
        if (structural.kind === 'block.split-and-assign') {
          const annotation = structural.annotation;
          const familyName = annotation?.family;
          const familyMeta = compiledMeta.annotationHandles[familyName];
          const familyDecl = descriptor.annotations.find((d: any) => d.annotationName === familyName);
          if (!familyMeta || !familyDecl || familyDecl.kind !== 'annotation' || familyMeta.appliesTo !== 'block-group' || familyMeta.cardinality !== 'one' ||
               !annotation || Object.keys(annotation).sort().join() !== 'family,fields,id' || typeof annotation.id !== 'string' || !annotation.id ||
              db.prepare(`SELECT 1 FROM ${prefix}_annotation WHERE id = ?`).get(annotation.id) ||
              JSON.stringify(Object.keys(annotation.fields ?? {}).sort()) !== JSON.stringify(Object.keys(familyDecl.fields).sort())) throw new ValidationError(`${name}.${fieldName}.operation annotation must be fresh and valid`);
          for (const [key, value] of Object.entries(annotation.fields)) {
            const result = resolveStrategy(familyDecl.fields[key].kind).validate(value, familyDecl.fields[key]);
            if (result !== true || (typeof familyDecl.fields[key].validate === 'function' && familyDecl.fields[key].validate(value) !== true)) throw new ValidationError(`${name}.${fieldName}.operation annotation field '${key}' is invalid`);
          }
        }
      }
      const handle = eventHandles.native(name, fieldName, 'operated');
      const eventData: Record<string, any> = {
        version: structural ? 8 : 2,
        id: command.id,
        before: Object.freeze({ structuralRevision: state.structure_version, frontier: family.checkpoint.frontier }),
        operation: Object.freeze(structural ? (structural.kind === 'block.continue' ? {
          kind: 'block.continue', leftBlockId: blockId, rightBlockId: newBlockId, utf16Offset, groupId: structural.groupId,
        } : {
          kind: 'block.split-and-assign', leftBlockId: blockId, rightBlockId: newBlockId, utf16Offset,
           leftGroupId: structural.groupId, rightGroupId: newBlockId,
        }) : {
          kind: 'block.split', leftBlockId: blockId, rightBlockId: newBlockId, utf16Offset,
        }),
           after: Object.freeze({ structuralRevision: afterRevision, frontier: family.checkpoint.frontier }),
        family: textFamilyCheckpoint(splitResult.family),
        blocks: cleanBlocks,
        memberships: Object.freeze(membershipResult.memberships.filter(m => affectedAnnotationIds.has(m.annotationId)).map(m => ({
          annotationId: m.annotationId, blockId: m.blockId, ordinal: m.ordinal, start: m.start, end: m.end,
        }))),
        measurements: Object.freeze(measurementFacts),
      };
      if (structural?.kind === 'block.split-and-assign') {
        eventData.annotation = structural.annotation;
        eventData.groupMembership = { annotationId: structural.annotation.id, groupId: newBlockId, ordinal: 0 };
      }
      return [{
        handle,
        type: handle.type,
        scope: documentScope,
        data: Object.freeze(eventData),
      }];
    };

    const r3Handler = ({ payload, db, scope }: any) => {
      const command = assertDocumentScope({ payload, scope, db, internal: true });
      const documentScope = owningDocumentScope(db, command.id);
      const state = db.prepare(`SELECT structure_version, family_checkpoint FROM ${prefix}_state WHERE document_id = ?`).get(command.id);
      if (!state) throw new ValidationError(`${name}.${fieldName}.operation document does not exist`);
      const family = restoreTextFamilyCheckpoint(JSON.parse(state.family_checkpoint));
      if (state.structure_version !== command.expected.structuralRevision ||
          JSON.stringify(family.checkpoint.frontier) !== JSON.stringify(command.expected.frontier)) {
        throw new ValidationError(`${name}.${fieldName}.operation conflicts with the current structural revision or frontier`);
      }

      const { leftBlockId, rightBlockId } = command.operation;
      if (leftBlockId === rightBlockId) {
        throw new ValidationError(`${name}.${fieldName}.operation left and right block IDs must be different`);
      }

      const leftBlockStored = rawRow(db, `${prefix}_block`, leftBlockId);
      if (!leftBlockStored) throw new ValidationError(`${name}.${fieldName}.operation left block not found`);
      const rightBlockStored = rawRow(db, `${prefix}_block`, rightBlockId);
      if (!rightBlockStored) throw new ValidationError(`${name}.${fieldName}.operation right block not found`);

      const blockFields = Object.keys(descriptor.block ?? {});

      const leftBlockCells: Record<string, any> = {};
      for (const bf of blockFields) {
        const bd = descriptor.block[bf];
        leftBlockCells[bf] = deserializeField(bd, leftBlockStored[bf]);
      }
      const rightBlockCells: Record<string, any> = {};
      for (const bf of blockFields) {
        const bd = descriptor.block[bf];
        rightBlockCells[bf] = deserializeField(bd, rightBlockStored[bf]);
      }

      if (JSON.stringify(rightBlockCells) !== JSON.stringify(leftBlockCells)) {
        throw new ValidationError(`${name}.${fieldName}.operation right block cells must equal left block cells`);
      }
      if (rightBlockStored.epoch !== leftBlockStored.epoch) {
        throw new ValidationError(`${name}.${fieldName}.operation right block epoch must equal left block epoch`);
      }

      const afterRevision = state.structure_version + 1;

      let mergeResult;
      try {
        mergeResult = mergeBlocks(family, leftBlockId, rightBlockId);
      } catch (error: any) {
        throw new ValidationError(`${name}.${fieldName}.operation ${error.message}`);
      }

      const memberships = db.prepare(
        `SELECT membership.annotation_id, membership.block_id, membership.ordinal, membership.start_point, membership.end_point
           FROM ${prefix}_membership AS membership
           JOIN ${prefix}_annotation AS annotation ON annotation.id = membership.annotation_id
          WHERE annotation.document_id = ?`,
      ).all(command.id);
      const pureMemberships = memberships.map((m: any) => ({
        annotationId: m.annotation_id,
        blockId: m.block_id,
        ordinal: m.ordinal,
        start: JSON.parse(m.start_point),
        end: JSON.parse(m.end_point),
      }));

      const annotations = db.prepare(`SELECT id, family FROM ${prefix}_annotation WHERE document_id = ?`).all(command.id);
      const pureAnnotations = annotations.map((a: any) => ({ id: a.id, family: a.family }));

      let membershipResult;
      try {
        membershipResult = mergeBlocksMemberships(
          family as any, pureAnnotations, pureMemberships, leftBlockId, rightBlockId,
        );
      } catch (error: any) {
        throw new ValidationError(`${name}.${fieldName}.operation ${error.message}`);
      }

      const affectedAnnotationIds = new Set(pureMemberships.filter((m: any) => m.blockId === leftBlockId || m.blockId === rightBlockId).map((m: any) => m.annotationId));

      const measurementFacts = [];
      if (measurementFamilyList.length > 0) {
        const leftMeasurements = db.prepare(`SELECT id, family, format_version, payload FROM ${prefix}_measurement WHERE block_id = ? ORDER BY family`).all(leftBlockId);
        const rightMeasurements = db.prepare(`SELECT id, family, format_version, payload FROM ${prefix}_measurement WHERE block_id = ? ORDER BY family`).all(rightBlockId);

        const leftByFamily: Record<string, any> = {};
        for (const row of leftMeasurements) leftByFamily[row.family] = row;
        const rightByFamily: Record<string, any> = {};
        for (const row of rightMeasurements) rightByFamily[row.family] = row;

        const allFamilies = new Set([...Object.keys(leftByFamily), ...Object.keys(rightByFamily)]);
        const mergedBlockText = materializeBlock(mergeResult, leftBlockId);

        for (const familyName of allFamilies) {
          const leftRow = leftByFamily[familyName] ?? null;
          const rightRow = rightByFamily[familyName] ?? null;

          if (leftRow === null && rightRow === null) continue;

          const measConfig = measurementConfigs[familyName];
          if (!measConfig) throw new ValidationError(`${name}.${fieldName}.operation unknown measurement family '${familyName}'`);

          const extSpec = resolveDeclarationMeasurementExtension(measConfig);
          if (!extSpec) throw new ValidationError(`${name}.${fieldName}.operation no structural adapter for measurement '${familyName}'`);

          if (leftRow !== null && leftRow.format_version !== measConfig.formatVersion) {
            throw new ValidationError(`${name}.${fieldName}.operation left measurement format version does not match declaration`);
          }
          if (rightRow !== null && rightRow.format_version !== measConfig.formatVersion) {
            throw new ValidationError(`${name}.${fieldName}.operation right measurement format version does not match declaration`);
          }
          if (leftRow !== null && rightRow !== null && leftRow.format_version !== rightRow.format_version) {
            throw new ValidationError(`${name}.${fieldName}.operation measurement format version mismatch between left and right`);
          }

          const leftPayload = leftRow ? frozenJsonSnapshot(JSON.parse(leftRow.payload)) : null;
          const rightPayload = rightRow ? frozenJsonSnapshot(JSON.parse(rightRow.payload)) : null;

          let leftBlockText = null;
          let rightBlockText = null;
          if (leftRow) leftBlockText = materializeBlock(family, leftBlockId);
          if (rightRow) rightBlockText = materializeBlock(family, rightBlockId);

          const validatePayload = (payload: any, blockText: any) => {
            try {
              const result = extSpec.validate(Object.freeze({
                version: 1,
                formatVersion: measConfig.formatVersion,
                blockText,
                payload: frozenJsonSnapshot(payload),
              }));
              if (result !== undefined) throw new Error('returned a value');
            } catch {
              throw new ValidationError(`${name}.${fieldName}.operation measurement validation failed`);
            }
          };

          if (leftRow) validatePayload(leftPayload, leftBlockText);
          if (rightRow) validatePayload(rightPayload, rightBlockText);

          const makeCombineInput = () => {
            const freshLeftPayload = leftPayload !== null ? frozenJsonSnapshot(leftPayload) : null;
            const freshRightPayload = rightPayload !== null ? frozenJsonSnapshot(rightPayload) : null;
            return Object.freeze({
              version: 1,
              formatVersion: measConfig.formatVersion,
              blockText: mergedBlockText,
              left: freshLeftPayload !== null ? Object.freeze({ blockText: leftBlockText, payload: freshLeftPayload }) : null,
              right: freshRightPayload !== null ? Object.freeze({ blockText: rightBlockText, payload: freshRightPayload }) : null,
            });
          };

          let result1;
          let result2;
          try {
            result1 = extSpec.combine(makeCombineInput());
            result2 = extSpec.combine(makeCombineInput());
          } catch {
            throw new ValidationError(`${name}.${fieldName}.operation measurement combine failed`);
          }

          if (!canonicalJsonEqual(result1, result2)) {
            throw new ValidationError(`${name}.${fieldName}.operation measurement combine is not deterministic`);
          }

          if (!result1 || typeof result1 !== 'object' || Array.isArray(result1) ||
              result1.version !== 1 || !Object.hasOwn(result1, 'payload')) {
            throw new ValidationError(`${name}.${fieldName}.operation measurement combine result must have version 1 and payload`);
          }

          let combinedPayload;
          try {
            combinedPayload = frozenJsonSnapshot(result1.payload);
          } catch {
            throw new ValidationError(`${name}.${fieldName}.operation measurement combine payload is not JSON`);
          }

          validatePayload(combinedPayload, mergedBlockText);

          const retainedId = leftRow ? leftRow.id : rightRow.id;
          const removedId = leftRow && rightRow ? rightRow.id : null;
          const formatVersion = (leftRow || rightRow).format_version;

          measurementFacts.push(Object.freeze({
            family: familyName,
            formatVersion,
            leftSource: leftRow ? Object.freeze({ id: leftRow.id, blockId: leftBlockId, payload: leftPayload }) : null,
            rightSource: rightRow ? Object.freeze({ id: rightRow.id, blockId: rightBlockId, payload: rightPayload }) : null,
            result: Object.freeze({ id: retainedId, blockId: leftBlockId, payload: combinedPayload }),
            removedId: removedId || null,
          }));
        }
      }

      const cleanBlockFact = Object.freeze({
        id: leftBlockId,
        epoch: leftBlockStored.epoch,
        cells: Object.freeze(leftBlockCells),
      });

      const handle = eventHandles.native(name, fieldName, 'operated');
      return [{
        handle,
        type: handle.type,
        scope: documentScope,
        data: Object.freeze({
          version: 3,
          id: command.id,
          before: Object.freeze({ structuralRevision: state.structure_version, frontier: family.checkpoint.frontier }),
          operation: Object.freeze({
            kind: 'block.merge',
            leftBlockId,
            rightBlockId,
          }),
          after: Object.freeze({ structuralRevision: afterRevision, frontier: family.checkpoint.frontier }),
          family: textFamilyCheckpoint(mergeResult),
          block: cleanBlockFact,
          memberships: Object.freeze(membershipResult.memberships.filter(m => affectedAnnotationIds.has(m.annotationId)).map(m => ({
            annotationId: m.annotationId,
            blockId: m.blockId,
            ordinal: m.ordinal,
            start: m.start,
            end: m.end,
          }))),
          measurements: Object.freeze(measurementFacts),
        }),
      }];
    };

    const r4Handler = ({ payload, db, scope, principal }: any) => {
      const command = assertDocumentScope({ payload, scope, db, internal: true });
      const documentScope = owningDocumentScope(db, command.id);
      const state = db.prepare(`SELECT structure_version, family_checkpoint FROM ${prefix}_state WHERE document_id = ?`).get(command.id);
      if (!state) throw new ValidationError(`${name}.${fieldName}.operation document does not exist`);
      const family = restoreTextFamilyCheckpoint(JSON.parse(state.family_checkpoint));
      if (state.structure_version !== command.expected.structuralRevision ||
          JSON.stringify(family.checkpoint.frontier) !== JSON.stringify(command.expected.frontier)) {
        throw new ValidationError(`${name}.${fieldName}.operation conflicts with the current structural revision or frontier`);
      }

       const selection = command.operation.selection;
       const blockId = selection.startBlockId ?? selection.blockId;
       const endBlockId = selection.endBlockId ?? blockId;
       const { startUtf16Offset, endUtf16Offset } = selection;
      const annInput = command.operation.annotation;

       let blockText;
       let endBlockText;
       try {
         blockText = materializeBlock(family, blockId);
         endBlockText = materializeBlock(family, endBlockId);
      } catch (error: any) {
        throw new ValidationError(`${name}.${fieldName}.operation ${error.message}`);
      }
       const startIndex = family.blocks.findIndex((block) => block.id === blockId);
       const endIndex = family.blocks.findIndex((block) => block.id === endBlockId);
       if (startIndex < 0 || endIndex < 0 || startIndex > endIndex ||
           startUtf16Offset < 0 || startUtf16Offset > blockText.length ||
           endUtf16Offset < 0 || endUtf16Offset > endBlockText.length ||
           (startIndex === endIndex && startUtf16Offset >= endUtf16Offset)) {
         throw new ValidationError(`${name}.${fieldName}.operation invalid selection offsets`);
       }

      const compiledMeta = getAnnotatedTextCompiledMetadata(descriptor);
      const annotationFamilyMeta = compiledMeta.annotationFields[annInput.family];
      const annotationDescriptor = descriptor.annotations.find((entry: any) => entry.annotationName === annInput.family);
      if (!annotationFamilyMeta || !annotationDescriptor) {
        throw new ValidationError(`${name}.${fieldName}.operation unknown annotation family '${annInput.family}'`);
      }
      if (compiledMeta.annotationHandles[annInput.family]?.appliesTo !== 'block') {
        throw new ValidationError(`${name}.${fieldName}.operation annotation family '${annInput.family}' must apply to blocks`);
      }
      const protectedTargetIds = annInput.protectedTargetIds ?? [];
      if (protectedTargetIds.length !== 0 &&
          (annotationDescriptor.kind !== 'protectingAnnotation' || annotationDescriptor.protects === null)) {
        throw new ValidationError(`${name}.${fieldName}.operation only protecting annotations with a declared target family may name protected targets`);
      }
      if (annotationDescriptor.kind === 'protectingAnnotation' && annotationDescriptor.protects !== null) {
        for (const targetId of protectedTargetIds) {
          const target = db.prepare(`SELECT family FROM ${prefix}_annotation WHERE id = ? AND document_id = ?`).get(targetId, command.id);
          if (!target || target.family !== annotationDescriptor.protects) {
            throw new ValidationError(`${name}.${fieldName}.operation protected target '${targetId}' must be an existing '${annotationDescriptor.protects}' annotation on this document`);
          }
        }
      }

      // A protective annotation applied to a same-block subrange is a span: it
      // creates one partial membership at the requested [start,end) structural
      // endpoints without carving the source block. Non-protecting families and
      // cross-block (v7) selections keep the legacy split-to-block behavior.
      const isProtectingAnnotation = annotationDescriptor.kind === 'protectingAnnotation';
      const sameBlockProtecting = isProtectingAnnotation && blockId === endBlockId;

      const familyFieldDescs = annotationDescriptor.fields;
      const canonicalFields = { ...annInput.fields };
      for (const [key, desc] of Object.entries(familyFieldDescs) as Array<[string, any]>) {
        if (key in canonicalFields) {
          const strategy = resolveStrategy(desc.kind);
          const validationResult = strategy.validate(canonicalFields[key], desc);
          if (validationResult !== true) {
            throw new ValidationError(`${name}.${fieldName}.operation field '${key}' validation failed: ${validationResult}`);
          }
          if (typeof desc.validate === 'function' && desc.validate(canonicalFields[key]) !== true) {
            throw new ValidationError(`${name}.${fieldName}.operation field '${key}' failed declared validation`);
          }
        } else if (desc.default !== undefined) {
          canonicalFields[key] = typeof desc.default === 'function' ? desc.default() : structuredClone(desc.default);
        } else if (!desc.nullable && !desc.optional) {
          throw new ValidationError(`${name}.${fieldName}.operation missing required field '${key}' for family '${annInput.family}'`);
        }
      }
      for (const key of Object.keys(canonicalFields)) {
        if (!familyFieldDescs[key]) {
          throw new ValidationError(`${name}.${fieldName}.operation unexpected field '${key}' for family '${annInput.family}'`);
        }
      }

      const existingAnn = db.prepare(`SELECT id FROM ${prefix}_annotation WHERE id = ?`).get(annInput.id);
      if (existingAnn) {
        throw new ValidationError(`${name}.${fieldName}.operation annotation id '${annInput.id}' already exists`);
      }

       const needsLeftSplit = !sameBlockProtecting && startUtf16Offset > 0;
      const needsRightSplit = !sameBlockProtecting && endUtf16Offset < endBlockText.length;

      let currentFamily = family;
      let selectedBlockId = blockId;
      const splitBlockIds = [];
      let afterRevision = state.structure_version;
      const splitOps = [];

      const sourceMemberships = db.prepare(
        `SELECT membership.annotation_id, membership.block_id, membership.ordinal, membership.start_point, membership.end_point
           FROM ${prefix}_membership AS membership
           JOIN ${prefix}_annotation AS annotation ON annotation.id = membership.annotation_id
          WHERE annotation.document_id = ?`,
      ).all(command.id);
      let pureMemberships = sourceMemberships.map((m: any) => ({
        annotationId: m.annotation_id,
        blockId: m.block_id,
        ordinal: m.ordinal,
        start: JSON.parse(m.start_point),
        end: JSON.parse(m.end_point),
      }));
      const annotationRows = db.prepare(`SELECT id, family FROM ${prefix}_annotation WHERE document_id = ?`).all(command.id);
      const protectedTargets = db.prepare(
        `SELECT annotation_id, target_annotation_id FROM ${prefix}_annotation_protected_target WHERE annotation_id IN (SELECT id FROM ${prefix}_annotation WHERE document_id = ?) ORDER BY annotation_id, target_annotation_id`,
      ).all(command.id);
      const targetsByAnnotation = new Map();
      for (const target of protectedTargets) {
        const ids = targetsByAnnotation.get(target.annotation_id) ?? [];
        ids.push(target.target_annotation_id);
        targetsByAnnotation.set(target.annotation_id, ids);
      }
      let pureAnnotations = annotationRows.map((a: any) => ({ id: a.id, family: a.family, protectedTargetIds: targetsByAnnotation.get(a.id) ?? [] }));

      const blockFields = Object.keys(descriptor.block ?? {});
      const blockFacts = [];
       const storedBlockById = new Map();
       const sourceStoredBlock = rawRow(db, `${prefix}_block`, blockId);
       if (!sourceStoredBlock) throw new ValidationError(`${name}.${fieldName}.operation source block not found`);
       storedBlockById.set(blockId, sourceStoredBlock);
       if (endBlockId !== blockId) {
         const endStoredBlock = rawRow(db, `${prefix}_block`, endBlockId);
         if (!endStoredBlock) throw new ValidationError(`${name}.${fieldName}.operation end block not found`);
         storedBlockById.set(endBlockId, endStoredBlock);
       }

      const readMeasurements = (bid: any) => {
        if (measurementFamilyList.length === 0) return [];
        return db.prepare(`SELECT id, family, format_version, payload FROM ${prefix}_measurement WHERE block_id = ? ORDER BY family`).all(bid);
      };

      let measurementState: Record<string, any> | null = null;
       const splitSources = new Set();
       if (needsLeftSplit) splitSources.add(blockId);
       if (needsRightSplit) splitSources.add(endBlockId);
       if (splitSources.size > 0) {
         measurementState = Object.fromEntries([...splitSources].map((id) => [id, readMeasurements(id)]));
       }

      const partitionMeasurements = (sourceBlockId: any, newBlockId: any, offset: any, familyAtSplit: any, splitFamily: any) => {
        if (!measurementState || !measurementState[sourceBlockId]) return [];
        const measList = measurementState[sourceBlockId];
        const sourceBlockVisibleText = materializeBlock(familyAtSplit, sourceBlockId);
        const leftVisibleText = materializeBlock(splitFamily, sourceBlockId);
        const rightVisibleText = materializeBlock(splitFamily, newBlockId);
        const leftFacts = [];
        const rightFacts = [];

        for (const row of measList) {
          const measConfig = measurementConfigs[row.family];
          if (!measConfig) throw new ValidationError(`${name}.${fieldName}.operation unknown measurement family '${row.family}'`);
          const extSpec = resolveDeclarationMeasurementExtension(measConfig);
          if (!extSpec) throw new ValidationError(`${name}.${fieldName}.operation no structural adapter for measurement '${row.family}'`);
          let oldPayload;
          try { oldPayload = frozenJsonSnapshot(JSON.parse(row.payload)); } catch { throw new ValidationError(`${name}.${fieldName}.operation measurement payload is not valid JSON`); }
          const partitionInput = Object.freeze({ version: 1, formatVersion: measConfig.formatVersion, blockText: sourceBlockVisibleText, utf16Offset: offset, payload: oldPayload });
          const validatePayload = (payload: any, blockText: any) => {
            try { const result = extSpec.validate(Object.freeze({ version: 1, formatVersion: measConfig.formatVersion, blockText, payload: frozenJsonSnapshot(payload) })); if (result !== undefined) throw new Error('returned a value'); } catch { throw new ValidationError(`${name}.${fieldName}.operation measurement validation failed`); }
          };
          validatePayload(oldPayload, sourceBlockVisibleText);
          let leftResult, rightResult;
          try { leftResult = extSpec.partition(partitionInput); rightResult = extSpec.partition(partitionInput); } catch { throw new ValidationError(`${name}.${fieldName}.operation measurement partition failed`); }
          if (JSON.stringify(leftResult) !== JSON.stringify(rightResult)) { throw new ValidationError(`${name}.${fieldName}.operation measurement partition is not deterministic`); }
          if (!leftResult || typeof leftResult !== 'object' || Array.isArray(leftResult) || Object.keys(leftResult).length !== 3 || leftResult.version !== 1 || !Object.hasOwn(leftResult, 'leftPayload') || !Object.hasOwn(leftResult, 'rightPayload')) { throw new ValidationError(`${name}.${fieldName}.operation measurement partition result must have leftPayload and rightPayload`); }
          let leftJsonPayload, rightJsonPayload;
          try { leftJsonPayload = frozenJsonSnapshot(leftResult.leftPayload); rightJsonPayload = frozenJsonSnapshot(leftResult.rightPayload); } catch { throw new ValidationError(`${name}.${fieldName}.operation measurement partition payload is not JSON`); }
          validatePayload(leftJsonPayload, leftVisibleText);
          validatePayload(rightJsonPayload, rightVisibleText);
          let leftPayloadStr, rightPayloadStr;
          try { leftPayloadStr = JSON.stringify(leftJsonPayload); rightPayloadStr = JSON.stringify(rightJsonPayload); } catch { throw new ValidationError(`${name}.${fieldName}.operation measurement partition payload is not JSON`); }
          leftFacts.push(Object.freeze({ id: row.id, blockId: sourceBlockId, family: row.family, formatVersion: row.format_version, payload: frozenJsonSnapshot(JSON.parse(leftPayloadStr)) }));
          const newId = randomUUID();
          rightFacts.push(Object.freeze({ id: newId, blockId: newBlockId, family: row.family, formatVersion: row.format_version, payload: frozenJsonSnapshot(JSON.parse(rightPayloadStr)) }));
        }
        delete measurementState[sourceBlockId];
        measurementState[sourceBlockId] = leftFacts.map(f => ({ id: f.id, family: f.family, format_version: f.formatVersion, payload: JSON.stringify(f.payload) }));
        measurementState[newBlockId] = rightFacts.map(f => ({ id: f.id, family: f.family, format_version: f.formatVersion, payload: JSON.stringify(f.payload) }));
        return [...leftFacts, ...rightFacts];
      };

       const splitOne = (sourceId: any, offset: any, selectsRight: any) => {
         const newBlockId = randomUUID();
         let splitResult;
         try { splitResult = splitBlock(currentFamily, sourceId, newBlockId, offset); } catch (error: any) { throw new ValidationError(`${name}.${fieldName}.operation ${error.message}`); }
        if (splitResult.type === 'unchanged') throw new ValidationError(`${name}.${fieldName}.operation split at start offset returned unchanged`);
        let membershipResult;
         try { membershipResult = splitBlockMemberships(splitResult.family as any, pureAnnotations, pureMemberships, sourceId, newBlockId); } catch (error: any) { throw new ValidationError(`${name}.${fieldName}.operation ${error.message}`); }
        pureAnnotations = membershipResult.annotations;
        pureMemberships = membershipResult.memberships;

         const leftBlockStored = storedBlockById.get(sourceId);
        if (!leftBlockStored) throw new ValidationError(`${name}.${fieldName}.operation source block not found`);
        const leftBlockCells: Record<string, any> = {};
        for (const bf of blockFields) { const bd = descriptor.block[bf]; leftBlockCells[bf] = deserializeField(bd, leftBlockStored[bf]); }
        const rightBlockCells: Record<string, any> = {};
        for (const bf of blockFields) { const bd = descriptor.block[bf]; rightBlockCells[bf] = deserializeField(bd, leftBlockStored[bf]); }
         blockFacts.push(Object.freeze({ id: sourceId, epoch: leftBlockStored.epoch, fields: Object.freeze(leftBlockCells) }));
        blockFacts.push(Object.freeze({ id: newBlockId, epoch: leftBlockStored.epoch, fields: Object.freeze(rightBlockCells) }));
        storedBlockById.set(newBlockId, leftBlockStored);

         partitionMeasurements(sourceId, newBlockId, offset, currentFamily, splitResult.family);

        currentFamily = splitResult.family;
        splitBlockIds.push(newBlockId);
         splitOps.push({ blockId: sourceId, newBlockId, utf16Offset: offset });
         return selectsRight ? newBlockId : sourceId;
       };

       if (needsLeftSplit) {
         selectedBlockId = splitOne(blockId, startUtf16Offset, true);
       }

       if (needsRightSplit) {
         const newBlockId = randomUUID();
         const adjustedOffset = endUtf16Offset;
         // The end block is never changed by the start split unless the range is
         // contained in one block (the legacy two-split case).
         const endSourceId = blockId === endBlockId && needsLeftSplit ? selectedBlockId : endBlockId;
         const splitSourceOffset = blockId === endBlockId && needsLeftSplit ? adjustedOffset - startUtf16Offset : adjustedOffset;
         let splitResult;
         try { splitResult = splitBlock(currentFamily, endSourceId, newBlockId, splitSourceOffset); } catch (error: any) { throw new ValidationError(`${name}.${fieldName}.operation ${error.message}`); }
        if (splitResult.type === 'unchanged') throw new ValidationError(`${name}.${fieldName}.operation split at end offset returned unchanged`);
        let membershipResult;
         try { membershipResult = splitBlockMemberships(splitResult.family as any, pureAnnotations, pureMemberships, endSourceId, newBlockId); } catch (error: any) { throw new ValidationError(`${name}.${fieldName}.operation ${error.message}`); }
        pureAnnotations = membershipResult.annotations;
        pureMemberships = membershipResult.memberships;

         const sourceBlockStored = storedBlockById.get(endSourceId);
        if (!sourceBlockStored) throw new ValidationError(`${name}.${fieldName}.operation source block not found`);
        const leftBlockCells: Record<string, any> = {};
        for (const bf of blockFields) { const bd = descriptor.block[bf]; leftBlockCells[bf] = deserializeField(bd, sourceBlockStored[bf]); }
        const rightBlockCells: Record<string, any> = {};
        for (const bf of blockFields) { const bd = descriptor.block[bf]; rightBlockCells[bf] = deserializeField(bd, sourceBlockStored[bf]); }
         blockFacts.push(Object.freeze({ id: endSourceId, epoch: sourceBlockStored.epoch, fields: Object.freeze(leftBlockCells) }));
        blockFacts.push(Object.freeze({ id: newBlockId, epoch: sourceBlockStored.epoch, fields: Object.freeze(rightBlockCells) }));
        storedBlockById.set(newBlockId, sourceBlockStored);

         partitionMeasurements(endSourceId, newBlockId, splitSourceOffset, currentFamily, splitResult.family);

        currentFamily = splitResult.family;
        splitBlockIds.push(newBlockId);
         splitOps.push({ blockId: endSourceId, newBlockId, utf16Offset: splitSourceOffset });
         if (blockId === endBlockId) selectedBlockId = selectedBlockId;
       }

      const anySplit = needsLeftSplit || needsRightSplit;
      if (anySplit) afterRevision = state.structure_version + 1;

       const basisFrontier = currentFamily.checkpoint.frontier;
       try { resolvePositionToEndpoint(currentFamily, selectedBlockId, 0, basisFrontier, 'right'); } catch (error: any) {
         throw new ValidationError(`${name}.${fieldName}.operation ${error.message}`);
       }

       const selectedEndBlockId = blockId === endBlockId ? selectedBlockId : endBlockId;
       const selectedStartIndex = currentFamily.blocks.findIndex((block) => block.id === selectedBlockId);
       const selectedEndIndex = currentFamily.blocks.findIndex((block) => block.id === selectedEndBlockId);
       const selectedBlockIds = currentFamily.blocks.slice(selectedStartIndex, selectedEndIndex + 1).map((block) => block.id);
       const annotationVirtual = { id: annInput.id, family: annInput.family, protectedTargetIds };
       const virtualAnnotations = [...pureAnnotations, annotationVirtual];
       let addMembershipResult = { annotations: virtualAnnotations, memberships: pureMemberships };
       try {
         if (sameBlockProtecting) {
           // Protective span: one partial membership at the requested
           // [startUtf16Offset,endUtf16Offset) structural endpoints, no splits.
           const start = resolvePositionToEndpoint(currentFamily, selectedBlockId, startUtf16Offset, basisFrontier, 'right');
           const end = resolvePositionToEndpoint(currentFamily, selectedBlockId, endUtf16Offset, basisFrontier, 'right');
           addMembershipResult = addMembership(currentFamily as any, virtualAnnotations, addMembershipResult.memberships, annInput.id, selectedBlockId, start, end);
         } else {
           for (const selectedId of selectedBlockIds) {
             const selectedText = materializeBlock(currentFamily, selectedId);
             const start = resolvePositionToEndpoint(currentFamily, selectedId, 0, basisFrontier, 'right');
             const end = resolvePositionToEndpoint(currentFamily, selectedId, selectedText.length, basisFrontier, 'right');
             addMembershipResult = addMembership(currentFamily as any, virtualAnnotations, addMembershipResult.memberships, annInput.id, selectedId, start, end);
           }
         }
       } catch (error: any) {
         throw new ValidationError(`${name}.${fieldName}.operation ${error.message}`);
       }

       const affectedAnnotationIds = new Set(sourceMemberships.filter((m: any) => m.block_id === blockId).map((m: any) => m.annotation_id));
       for (const sourceId of splitSources) {
         for (const m of sourceMemberships) if (m.block_id === sourceId) affectedAnnotationIds.add(m.annotation_id);
       }
       const membershipFacts = addMembershipResult.memberships.filter((m: any) => m.annotationId === annInput.id || affectedAnnotationIds.has(m.annotationId)).map((m: any) => ({
        annotationId: m.annotationId,
        blockId: m.blockId,
        ordinal: m.ordinal,
        start: m.start,
        end: m.end,
      }));

      const allMeasurementFacts = [];
      if (measurementState) {
        for (const [bid, measList] of Object.entries(measurementState)) {
          for (const row of measList) {
            allMeasurementFacts.push(Object.freeze({
              id: row.id,
              blockId: bid,
              family: row.family,
              formatVersion: row.format_version,
              payload: frozenJsonSnapshot(JSON.parse(row.payload)),
            }));
          }
        }
      }

      const handle = eventHandles.native(name, fieldName, 'operated');
      const actorId = typeof principal?.id === 'string' && principal.id.length > 0 ? principal.id : null;
      return [{
        handle,
        type: handle.type,
        scope: documentScope,
        data: Object.freeze({
          version: command.version,
          id: command.id,
          actorId,
          before: Object.freeze({ structuralRevision: state.structure_version, frontier: family.checkpoint.frontier }),
             operation: Object.freeze({
             kind: 'annotation.apply',
             selection: blockId === endBlockId
                ? { blockId, startUtf16Offset, endUtf16Offset }
                : { blockId, startBlockId: blockId, endBlockId, startUtf16Offset, endUtf16Offset },
            annotation: Object.freeze({ id: annInput.id, family: annInput.family, fields: Object.freeze(canonicalFields), ...(protectedTargetIds.length ? { protectedTargetIds: Object.freeze([...protectedTargetIds]) } : {}) }),
          }),
          after: Object.freeze({ structuralRevision: afterRevision, frontier: family.checkpoint.frontier }),
          family: textFamilyCheckpoint(currentFamily),
          annotation: Object.freeze({ id: annInput.id, family: annInput.family, fields: Object.freeze(canonicalFields), ...(protectedTargetIds.length ? { protectedTargetIds: Object.freeze([...protectedTargetIds]) } : {}) }),
           splitBlockIds: Object.freeze([...splitBlockIds]),
            ...(blockId !== endBlockId ? { selectedBlockIds: Object.freeze([...selectedBlockIds]) } : {}),
          selectedBlockId,
          splitOps: Object.freeze(splitOps),
          blocks: Object.freeze(blockFacts),
          memberships: Object.freeze(membershipFacts),
          measurements: Object.freeze(allMeasurementFacts),
        }),
      }];
    };

    const r5Handler = ({ payload, db, scope }: any) => {
      const command = assertDocumentScope({ payload, scope, db, internal: true });
      const documentScope = owningDocumentScope(db, command.id);
      const state = db.prepare(`SELECT structure_version, family_checkpoint FROM ${prefix}_state WHERE document_id = ?`).get(command.id);
      if (!state) throw new ValidationError(`${name}.${fieldName}.operation document does not exist`);
      const family = restoreTextFamilyCheckpoint(JSON.parse(state.family_checkpoint));
      if (state.structure_version !== command.expected.structuralRevision ||
          JSON.stringify(family.checkpoint.frontier) !== JSON.stringify(command.expected.frontier)) {
        throw new ValidationError(`${name}.${fieldName}.operation conflicts with the current structural revision or frontier`);
      }

      const sourceMemberships = db.prepare(
        `SELECT membership.annotation_id, membership.block_id, membership.ordinal, membership.start_point, membership.end_point
           FROM ${prefix}_membership AS membership
           JOIN ${prefix}_annotation AS annotation ON annotation.id = membership.annotation_id
          WHERE annotation.document_id = ?`,
      ).all(command.id);
      const memberships = sourceMemberships.map((membership: any) => ({
        annotationId: membership.annotation_id,
        blockId: membership.block_id,
        ordinal: membership.ordinal,
        start: JSON.parse(membership.start_point),
        end: JSON.parse(membership.end_point),
      }));
      const annotationRows = db.prepare(`SELECT id, family FROM ${prefix}_annotation WHERE document_id = ? ORDER BY id`).all(command.id);
      const targets = db.prepare(
        `SELECT annotation_id, target_annotation_id FROM ${prefix}_annotation_protected_target WHERE annotation_id IN (SELECT id FROM ${prefix}_annotation WHERE document_id = ?) ORDER BY annotation_id, target_annotation_id`,
      ).all(command.id);
      const targetsByAnnotation = new Map();
      for (const target of targets) targetsByAnnotation.set(target.annotation_id, [...(targetsByAnnotation.get(target.annotation_id) ?? []), target.target_annotation_id]);
      const annotations = annotationRows.map((annotation: any) => {
        const metadata = compiledMeta.annotationHandles[annotation.family];
        if (!metadata) throw new ValidationError(`${name}.${fieldName}.operation unknown annotation family '${annotation.family}'`);
        return { id: annotation.id, family: annotation.family, empty: metadata.empty, protectedTargetIds: targetsByAnnotation.get(annotation.id) ?? [] };
      });
      const targetAnnotation = annotations.find((annotation: any) => annotation.id === command.operation.annotationId);
      if (!targetAnnotation) throw new ValidationError(`${name}.${fieldName}.operation annotation not found`);
      let reduced;
      try {
        reduced = removeMembership(family as any, annotations, memberships, command.operation.annotationId, command.operation.blockId, { structuralRevision: state.structure_version });
      } catch (error: any) {
        throw new ValidationError(`${name}.${fieldName}.operation ${error.message}`);
      }
      const outcome: any = reduced.outcomes[0];
      const changedProtectors = reduced.annotations
        .filter((annotation) => JSON.stringify(annotation.protectedTargetIds ?? []) !== JSON.stringify(targetsByAnnotation.get(annotation.id) ?? []))
        .map((annotation) => Object.freeze({ annotationId: annotation.id, protectsPostimage: Object.freeze([...(annotation.protectedTargetIds ?? [])]) }))
        .sort((left, right) => left.annotationId.localeCompare(right.annotationId));
      const disposition = !outcome
        ? Object.freeze({ kind: 'retained' })
        : outcome.type === 'delete'
          ? Object.freeze({ kind: 'deleted', family: targetAnnotation.family, savedQuote: null, lastMemberships: null })
          : Object.freeze({ kind: 'orphaned', family: targetAnnotation.family, savedQuote: outcome.savedQuote, lastMemberships: outcome.lastMemberships });
      const result = Object.freeze({
        memberships: Object.freeze({
          annotationId: command.operation.annotationId,
          postimage: Object.freeze(reduced.memberships.filter((membership) => membership.annotationId === command.operation.annotationId)
            .map((membership) => Object.freeze({ blockId: membership.blockId, ordinal: membership.ordinal }))),
        }),
        disposition,
        changedProtectors: Object.freeze(changedProtectors),
      });
      const handle = eventHandles.native(name, fieldName, 'operated');
      return [{
        handle,
        type: handle.type,
        scope: documentScope,
        data: Object.freeze({
          version: 5,
          id: command.id,
          before: Object.freeze({ structuralRevision: state.structure_version, frontier: family.checkpoint.frontier }),
          operation: command.operation,
          after: Object.freeze({ structuralRevision: state.structure_version, frontier: family.checkpoint.frontier }),
          lifecycle: Object.freeze({ empty: targetAnnotation.empty }),
          result,
        }),
      }];
    };

    const handler = ({ payload, db, scope, principal, actionId, history }: any) => {
      if (!history?.input && payload?.version === 1) throw new ValidationError('annotated text compensation is history-authored only');
      const command = payload.version === 9 ? assertV9AnnotatedTextOffsetEditPayload(name, fieldName, payload) : null;
      if (history?.input?.kind === ANNOTATED_TEXT_COMPENSATION) {
        if (payload.version !== 1 || !payload.history || payload.history.version !== 1
          || !['undo', 'redo'].includes(payload.history.direction)) throw new ValidationError('invalid annotated text compensation');
        const sourceFact = history.input.targetFact;
        if (!sourceFact || sourceFact.version !== 2 || sourceFact.documentId !== payload.id) throw new ValidationError('invalid annotated text compensation fact');
        const state = db.prepare(`SELECT structure_version, family_checkpoint FROM ${prefix}_state WHERE document_id = ?`).get(payload.id);
        if (!state) throw new ValidationError(`${name}.${fieldName}.operation document does not exist`);
        const family = restoreTextFamilySerialized(state.family_checkpoint);
        if (payload.history.direction === 'redo' && sourceFact.linkage?.outcome === 'noop') {
          return { events: [], privateFact: { version: 2, kind: 'annotated-text.compensation', documentId: payload.id, linkage: { rootActionId: payload.history.rootActionId, targetActionId: payload.history.targetActionId, direction: payload.history.direction, outcome: 'noop' } }, historyOutcome: 'noop' };
        }
        const contribution = payload.history.direction === 'undo' ? sourceFact.contribution : sourceFact.redo;
        if (!contribution || contribution.kind !== 'text.insert') throw new ValidationError('invalid annotated text compensation contribution');
        const originalOp = contribution.opId;
        const expectedKeys = Array.from({ length: contribution.scalarCount }, (_, ordinal) => `${originalOp[0]}:${originalOp[1]}:${ordinal}`);
        const live = expectedKeys.filter((elementKey) => family.checkpoint.elements[elementKey]?.deletedBy.length === 0);
        let operation = null;
        if (payload.history.direction === 'undo' && live.length === expectedKeys.length) {
          const actor = createHash('sha256').update(`${name}\u0000${fieldName}\u0000${payload.id}\u0000${actionId}`).digest('hex').slice(0, 32);
          const lamport = Math.max(0, ...Object.values(family.checkpoint.elements).map((element) => element.lamport)) + 1;
          operation = canonicalTextOp(['workbench.text', 1, [actor, 1], lamport, family.checkpoint.frontier, ['delete', [[originalOp, 0, contribution.scalarCount]]]]);
        } else if (payload.history.direction === 'redo' && sourceFact.linkage?.outcome === 'applied') {
          const actor = createHash('sha256').update(`${name}\u0000${fieldName}\u0000${payload.id}\u0000${actionId}`).digest('hex').slice(0, 32);
          const lamport = Math.max(0, ...Object.values(family.checkpoint.elements).map((element) => element.lamport)) + 1;
          operation = canonicalTextOp(['workbench.text', 1, [actor, 1], lamport, family.checkpoint.frontier, ['insert', contribution.anchor, contribution.text]]);
        }
        if (!operation) return { events: [], privateFact: { version: 2, kind: 'annotated-text.compensation', documentId: payload.id, linkage: { rootActionId: payload.history.rootActionId, targetActionId: payload.history.targetActionId, direction: payload.history.direction, outcome: 'noop' } }, historyOutcome: 'noop' };
        const nextFamily = applyTextOperation(family, operation);
        const handle = eventHandles.native(name, fieldName, 'operated');
        const compensation: Record<string, any> = { version: 2, kind: 'annotated-text.compensation', documentId: payload.id, linkage: { rootActionId: payload.history.rootActionId, targetActionId: payload.history.targetActionId, direction: payload.history.direction, outcome: 'applied' }, contribution: { kind: 'text.insert', opId: operation[2], anchor: contribution.anchor, text: contribution.text, scalarCount: contribution.scalarCount } };
        if (payload.history.direction === 'undo') compensation.redo = { kind: 'text.insert', opId: originalOp, anchor: contribution.anchor, text: contribution.text, scalarCount: contribution.scalarCount };
        const before = Object.freeze({ structuralRevision: state.structure_version, frontier: family.checkpoint.frontier });
        const after = Object.freeze({ structuralRevision: state.structure_version, frontier: nextFamily.checkpoint.frontier });
        const operationData = { id: payload.id, before, after, operation: Object.freeze({ kind: 'text.apply', operation }), family: null };
        const envelope = { id: payload.id, before, after, operation: operationData.operation, version: 14, facts: packOperatedFacts(operationData) };
        return { events: [Object.freeze({ handle, type: handle.type, scope, data: Object.freeze(envelope) })], privateFact: compensation, historyOutcome: 'applied' };
      }
      if (payload.version === 1) throw new ValidationError('annotated text compensation is history-authored only');
      return Promise.resolve(r1Handler({ payload, db, scope, principal, actionId })).then((events: any) => {
        if (payload.version !== 9) return events;
        return {
          events,
          privateFact: command.edit.kind === 'text.insert'
            ? { version: 2, kind: 'annotated-text.contribution', documentId: command.id, contribution: { kind: 'text.insert', opId: events[0].data.operation.operation[2], anchor: events[0].data.operation.operation[5][1], text: command.edit.text, scalarCount: scalarCount(command.edit.text) } }
            : { version: 2, kind: 'annotated-text.barrier', documentId: command.id },
          authoringReceipt: ({ db: receiptDb, confirmedThrough }: any) => {
            // Blockless (issue #33): issue ONE document-scoped position frame
            // bound to the post-commit family so the authoring client can keep
            // typing. The snapshot insert joins this origin transaction.
            const postState = receiptDb.prepare(`SELECT family_checkpoint FROM ${prefix}_state WHERE document_id = ?`).get(command.id);
            const postFamily = restoreTextFamilySerialized(postState.family_checkpoint);
            const issued = issueAuthoringSnapshot({
              db: receiptDb, prefix, leaseId: command.authoring.lease, fence: confirmedThrough,
              positions: [{ familyCheckpoint: textFamilyBasis(postFamily), visibleAtIssue: true, redactions: [] }],
            });
            const envelope = buildAuthoringEnvelope({
              streamToken: command.authoring.stream,
              leaseToken: command.authoring.lease,
              snapshotToken: issued!.snapshot.id,
              fence: confirmedThrough,
              positionFrames: issued!.positionFrames,
            });
            return Object.freeze({ version: 1, actionId, confirmedThrough, authoring: Object.freeze({
              ...envelope,
              family: compactTextFamilyCheckpoint(postFamily),
            }) });
          },
        };
      });
    };
    Object.defineProperty(handler, 'inTransaction', { value: true });
    Object.defineProperty(handler, 'batchForbidden', { value: true });
    Object.defineProperty(handler, 'preDedupe', { value: ({ payload, scope, db, principal, history }: any) => {
      if (history?.input?.kind === ANNOTATED_TEXT_COMPENSATION) return;
      const command = assertDocumentScope({ payload, scope, db });
      if (command.version === 9) assertV9AuthoringBinding({ command, db, principal });
    }});
    Object.defineProperty(handler, 'dedupeReceiptMatches', { value: (receipt: any, request: any) =>
      receipt.actionType === operationType && receipt.actionData === JSON.stringify(request.payload) });
    handlers[operationType] = handler;
    const compensationHandler = (context: any) => {
      if (!context.history?.input || context.history.input.kind !== ANNOTATED_TEXT_COMPENSATION) {
        throw new ValidationError('annotated text compensation is history-authored only');
      }
      return handler(context);
    };
    Object.defineProperties(compensationHandler, {
      inTransaction: { value: true },
      batchForbidden: { value: true },
      preDedupe: { value: ({ history }: any) => {
        if (!history?.input || history.input.kind !== ANNOTATED_TEXT_COMPENSATION) {
          throw new ValidationError('annotated text compensation is history-authored only');
        }
      } },
      dedupeReceiptMatches: { value: (receipt: any, request: any) =>
        receipt.actionType === `${name}.${fieldName}.compensate` && receipt.actionData === JSON.stringify(request.payload) },
    });
    handlers[`${name}.${fieldName}.compensate`] = compensationHandler;
    cursorPolicy[operationType] = 'excluded';
  }

  // Side-table mutation handlers (map.add/setRole/remove, ordered.insert/move/
  // reorder/remove, log.append, ephemeral.set) are generated by their
  // respective strategies and merged in.
  const sideTableHandlers = Object.assign(
    {},
    ...sideTableStrategyEntries.map(({ strategy, fields: strategyFields }) =>
      strategy.mutateHandlers(name, strategyFields)),
  );

  const result = { ...handlers, ...sideTableHandlers };
  Object.defineProperty(result, CRUD_CURSOR_POLICY, {
    value: Object.freeze(cursorPolicy),
  });
  return Object.freeze(result);
}

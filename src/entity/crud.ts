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
import { assertUtf16Offset, assertWellFormedText, canonicalTextOp, scalarCount } from '../annotated-text.ts';
import { getAnnotatedTextCompiledMetadata, resolveAnnotatedTextOwningScope, resolveDeclarationMeasurementExtension } from '../annotated-text-field.ts';
import { frozenJsonSnapshot } from '../frozen-json.ts';
import { erasureDirectivePreparation } from '../erasure-directive.ts';
import { canonicalStringify } from '../canonical-json.ts';
import { CASCADE_DESCENDANT, CASCADE_PREAUTHORIZED } from './removal-cascade.ts';
import { admitRow } from '../row-grant.ts';
import { admitRowTransition } from '../field-admission.ts';
import { admitsInvitationRemoval, admitInvitationAcceptance } from '../auth/invitation-acceptance-authority.ts';
import { clearAuthoringState, issueAuthoringSnapshot, buildAuthoringEnvelope, readAnnotatedTextFamilyCheckpoint } from '../annotated-text-authoring-stream.ts';
import { admitV9AnnotatedTextEdit, assertV9AuthoringBinding as assertV9AuthoringBindingFromAdmit } from '../annotated-text-admit.ts';
import { constructV14OperatedEvent } from '../annotated-text-operated-event.ts';
import { applyTextOperation, compactTextFamilyCheckpoint, materializeText, projectEndpointToOffset, restoreTextFamilySerialized, textFamilyBasis } from '../annotated-text-continuous.ts';
import { projectAnnotatedTextSnapshot } from '../annotated-text-snapshot.ts';
import { authoringRedactionsForRecipient } from '../annotated-text-recipient-projection.ts';
import { mapVisibleOffsetToCanonical } from '../annotated-text-recipient-projection.ts';
import { planTextRangeApply } from '../annotated-text-plan.ts';
import { annotationRangeRows } from '../annotated-text-storage.ts';
import { assertUtf16Range } from '../annotated-text.ts';
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
    const allowedBlock = new Set(['text', 'fields', 'measurements']);
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
    canonicalBlocks.push(Object.freeze({
      id: randomUUID(),
      text: block.text,
      fields: Object.freeze(fields),
      measurements: Object.freeze(measurements),
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
    [`${name}.update`]: async ({ payload, principal, db, history, scope, authorization }: any) => {
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
        // Proposed-transition admission on the history move (S5/A3): an undo/
        // redo is an update like any other, so the row grant / field access runs
        // against BOTH the current row and the proposed after-row — a history
        // move that lands the row outside the principal's write scope is denied
        // even though the current row is in scope. The history rows are the
        // durable raw-cell shapes, so they deserialize through the record's row
        // seam (the same deserialized shape the non-history path gets from
        // record.findById) before the transition gate evaluates them. The
        // invitation-acceptance bypass mirrors the non-history path: acceptance
        // updates run under the acceptance authority, not a write grant.
        const acceptanceManagedUpdate = record.name === 'Invitation'
          && admitInvitationAcceptance({
            event: { handle: verbs.updated.handle as never, data: data as unknown as Record<string, unknown> },
            principal,
          });
        if (!acceptanceManagedUpdate) {
          const before = record.deserializeRow({ ...currentStored });
          const after = record.deserializeRow({ ...replacement });
          if (!(await admitRowTransition({
            entity: record,
            verb: 'update',
            before,
            after,
            principal,
            authorization,
          }))) {
            throw Object.assign(new Error('forbidden'), { status: 403 });
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
      // Proposed-transition admission (S5/A3): the update's row grant / field
      // access runs against BOTH the current row and the proposed after-row, so
      // an update that moves the row out of the principal's write scope is
      // rejected even though the current row is in scope. The current row is
      // read through the record's query seam (the runtime db — a non-history
      // update runs outside the transaction, where the context db is absent),
      // exactly as the state-transition guard above does. An injected
      // authorization adapter wired into the handler context decides; with none
      // the framework row-grant engine — the default adapter's own
      // implementation — runs unchanged. An unavailable current row (in-memory
      // kernel) skips the transition check and keeps its pre-existing behavior.
      let materializedBefore;
      try {
        materializedBefore = record.findById(id);
      } catch {
        materializedBefore = null;
      }
      // Invitation-acceptance updates (useCount bump) run under the acceptance
      // authority and are admitted by the durable gate via admitInvitationAcceptance
      // — the same authority this handler's sibling remove path honors through
      // admitsInvitationRemoval. Their row grant never intended a write grant to
      // the accepting user, so the transition check must not trip on it.
      const acceptanceManagedUpdate = record.name === 'Invitation'
        && admitInvitationAcceptance({
          event: { handle: verbs.updated.handle as never, data: data as unknown as Record<string, unknown> },
          principal,
        });
      if (materializedBefore && !acceptanceManagedUpdate) {
        const proposedAfter = { ...materializedBefore, ...data };
        if (!(await admitRowTransition({
          entity: record,
          verb: 'update',
          before: materializedBefore,
          after: proposedAfter,
          principal,
          authorization,
        }))) {
          throw Object.assign(new Error('forbidden'), { status: 403 });
        }
      }
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
    const assertV9AuthoringBinding = ({ command, db, principal }: any) =>
      assertV9AuthoringBindingFromAdmit({ name, fieldName, prefix, command, db, principal });

    const r1Handler = async ({ payload, db, scope, principal, actionId }: any) => {
      const command = assertV9AnnotatedTextOffsetEditPayload(name, fieldName, payload);
      return admitV9AnnotatedTextEdit({ name, fieldName, prefix, descriptor, record, compiledMeta, command, db, scope, principal, actionId });
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
        const envelope = constructV14OperatedEvent({
          id: payload.id,
          before,
          after,
          operation: Object.freeze({ kind: 'text.apply', operation }),
        });
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
          authoringReceipt: async ({ db: receiptDb, confirmedThrough }: any) => {
            // Blockless (issue #33): issue ONE document-scoped position frame
            // bound to the post-commit family so the authoring client can keep
            // typing. The snapshot insert joins this origin transaction.
            const postCheckpoint = readAnnotatedTextFamilyCheckpoint(receiptDb, prefix, command.id);
            if (postCheckpoint === undefined) throw new Error('annotated-text authoring: post-commit family checkpoint is missing');
            const postFamily = restoreTextFamilySerialized(postCheckpoint);
            // Project the post-commit state through the ACTING principal's own
            // view (the recipient projection + its redaction WeakMap): the
            // issued frame must carry THAT principal's CURRENT wire→canonical
            // basis, and the canonical family checkpoint may only leave the
            // server when the principal reads the ENTIRE document unredacted.
            const receiptRecipient = await projectAnnotatedTextSnapshot({
              db: receiptDb, entity: record, row: rawRow(receiptDb, name, command.id),
              principal, fieldName, descriptor, mintBasis: false,
            });
            const receiptRedactions = authoringRedactionsForRecipient(receiptRecipient);
            const issued = issueAuthoringSnapshot({
              db: receiptDb, prefix, leaseId: command.authoring.lease, fence: confirmedThrough,
              positions: [{ familyCheckpoint: textFamilyBasis(postFamily), visibleAtIssue: true, redactions: receiptRedactions }],
            });
            const envelope = buildAuthoringEnvelope({
              streamToken: command.authoring.stream,
              leaseToken: command.authoring.lease,
              snapshotToken: issued!.snapshot.id,
              fence: confirmedThrough,
              positionFrames: issued!.positionFrames,
            });
            const fullyVisible = !receiptRecipient.restricted && !receiptRecipient.redactions?.length && receiptRedactions.length === 0;
            return Object.freeze({ version: 1, actionId, confirmedThrough, authoring: Object.freeze({
              ...envelope,
              ...(fullyVisible ? { family: compactTextFamilyCheckpoint(postFamily) } : {}),
            }) });
          },
        };
      });
    };
    Object.defineProperty(handler, 'inTransaction', { value: true });
    Object.defineProperty(handler, 'batchForbidden', { value: true });
    Object.defineProperty(handler, 'preDedupe', { value: ({ payload, db, principal, history }: any) => {
      if (history?.input?.kind === ANNOTATED_TEXT_COMPENSATION) return;
      const command = assertV9AnnotatedTextOffsetEditPayload(name, fieldName, payload);
      assertV9AuthoringBinding({ command, db, principal });
    }});
    Object.defineProperty(handler, 'dedupeReceiptMatches', { value: (receipt: any, request: any) =>
      receipt.actionType === operationType && receipt.actionData === canonicalStringify(request.payload) });
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
        receipt.actionType === `${name}.${fieldName}.compensate` && receipt.actionData === canonicalStringify(request.payload) },
    });
    handlers[`${name}.${fieldName}.compensate`] = compensationHandler;
    cursorPolicy[operationType] = 'excluded';

    // Declaration-derived related-entity annotation actions are committed by
    // the same durable handler as ordinary annotated-text operations.  The
    // handler returns both lifecycle events; pipeline.applyInTxn projects them
    // under one receipt/transaction, so a projection or FK failure rolls back
    // both rows.
    const annotationDeclarations = descriptor.annotations ?? [];
    for (const annotationDeclaration of annotationDeclarations) {
      for (const [actionName, action] of Object.entries(annotationDeclaration.actions ?? {}) as Array<[string, any]>) {
        if (action.kind === 'annotationAction') {
          const actionType = `${name}.${fieldName}.${annotationDeclaration.annotationName}.${actionName}`;
          const domainHandler = async ({ payload, db, scope, principal, actionId }: any) => {
            if (!payload || typeof payload !== 'object' || Array.isArray(payload)
              || (Object.getPrototypeOf(payload) !== Object.prototype && Object.getPrototypeOf(payload) !== null)
              || Reflect.ownKeys(payload).some((key) => typeof key !== 'string')
              || Object.keys(payload).sort().join() !== 'basis,from,id,mutationId,to,values,version'
              || payload.version !== 1 || typeof payload.id !== 'string' || !payload.id || typeof payload.basis !== 'string' || !payload.basis
              || typeof payload.mutationId !== 'string' || !payload.mutationId || !Number.isSafeInteger(payload.from) || !Number.isSafeInteger(payload.to)
              || !payload.values || typeof payload.values !== 'object' || Array.isArray(payload.values)
              || (Object.getPrototypeOf(payload.values) !== Object.prototype && Object.getPrototypeOf(payload.values) !== null)
              || Reflect.ownKeys(payload.values).some((key) => typeof key !== 'string')) throw new ValidationError(`${actionType} requires a closed selection payload`);
            const expectedInputs = Object.keys(action.input);
            if (Object.keys(payload.values).sort().join() !== expectedInputs.sort().join()) throw new ValidationError(`${actionType} values contain unknown or missing fields`);
            const canonicalInput: Record<string, unknown> = {};
            for (const inputName of expectedInputs) {
              const inputField = action.input[inputName];
              const validation = resolveStrategy(inputField.kind).validate(payload.values[inputName], inputField);
              if (validation !== true || (typeof inputField.validate === 'function' && inputField.validate(payload.values[inputName]) !== true)) throw new ValidationError(`${actionType} input '${inputName}' failed validation`);
              canonicalInput[inputName] = payload.values[inputName];
            }
            const documentRow = rawRow(db, name, payload.id);
            if (!documentRow) throw new ValidationError(`${actionType} document does not exist`);
            const documentScope = resolveAnnotatedTextOwningScope(descriptor, fields, documentRow).key;
            if (scope !== documentScope) throw new ValidationError(`${actionType} requires its declared document scope`);
            const state = db.prepare(`SELECT structure_version, family_checkpoint FROM ${prefix}_state WHERE document_id = ?`).get(payload.id);
            if (!state) throw new ValidationError(`${actionType} document state is unavailable`);
            const family = restoreTextFamilySerialized(state.family_checkpoint);
            const principalType = principal?.type ?? 'principal';
            const principalId = principal?.id ?? '';
            const position = db.prepare(`SELECT position.*, checkpoint.family_checkpoint AS basis_checkpoint FROM ${prefix}_authoring_position AS position JOIN ${prefix}_authoring_checkpoint AS checkpoint ON checkpoint.id = position.checkpoint_id JOIN ${prefix}_authoring_lease AS lease ON lease.id = position.lease_id JOIN ${prefix}_authoring_stream AS stream ON stream.id = lease.stream_id WHERE position.token = ? AND stream.document_id = ? AND stream.principal_type = ? AND stream.principal_id = ?`).get(payload.basis, payload.id, principalType, principalId);
            if (!position || !position.visible_at_issue || JSON.stringify(JSON.parse(position.basis_checkpoint)) !== JSON.stringify(textFamilyBasis(family))) throw new ValidationError(`${actionType} basis is unavailable or stale`);
            const recipient = await projectAnnotatedTextSnapshot({ db, entity: record, row: documentRow, principal, fieldName, descriptor, mintBasis: false });
            const redactions = JSON.parse(position.redactions ?? '[]');
            if (JSON.stringify(redactions) !== JSON.stringify(authoringRedactionsForRecipient(recipient))) throw new ValidationError(`${actionType} basis is stale`);
            const from = mapVisibleOffsetToCanonical(payload.from, 'right', redactions, 'right');
            const to = mapVisibleOffsetToCanonical(payload.to, 'left', redactions, 'left');
            const text = materializeText(family);
            try { assertUtf16Range(text, from, to); } catch { throw new ValidationError(`${actionType} selection splits a UTF-16 surrogate pair`); }
            if (redactions.some((entry: any) => entry.start < from && from < entry.end || entry.start < to && to < entry.end)
              || redactions.some((entry: any) => Math.min(from, to) <= entry.start && entry.end <= Math.max(from, to))) throw new ValidationError(`${actionType} selection is hidden`);
            if (from < 0 || to > text.length || from >= to) throw new ValidationError(`${actionType} selection is invalid`);
            const generatedAnnotationId = createHash('sha256').update(`${scope}\0${actionId}\0${actionType}\0annotation`).digest('hex').slice(0, 32);
            // Load the document's committed annotation records and ranges ONCE
            // (before the change function runs) so the function receives frozen
            // current state and the handler can merge a partial contribution
            // over the committed record inside the same transaction.
            const rangeRows = annotationRangeRows(db, prefix, payload.id);
            const ranges = rangeRows.map((range) => ({ annotationId: range.annotation_id, start: JSON.parse(range.start_point), end: JSON.parse(range.end_point) }));
            const annotationRows = db.prepare(`SELECT id, family FROM ${prefix}_annotation WHERE document_id = ?`).all(payload.id) as Array<{ id: string; family: string }>;
            const sameFamilyAnnotationIds = new Set<string>(annotationRows.filter((candidate) => candidate.family === annotationDeclaration.annotationName).map((candidate) => String(candidate.id)));
            const declaredFieldNames = Object.keys(annotationDeclaration.fields ?? {}).sort();
            const currentRangeOffsets = (annotationId: string): Array<{ start: number | null; end: number | null }> => ranges
              .filter((range) => range.annotationId === annotationId)
              .map((range) => {
                let start = null;
                let end = null;
                try {
                  start = projectEndpointToOffset(family, range.start);
                  end = projectEndpointToOffset(family, range.end);
                } catch { /* unprojectable */ }
                return { start, end };
              });
            // A correction targets the single same-family annotation whose
            // committed range covers the selection, so a partial field
            // contribution merges over the current record instead of replacing
            // it. Ambiguous (zero or many covering) corrections fall back to a
            // fresh deterministic annotation identity.
            let current: { id: string; family: string; fields: Readonly<Record<string, unknown>>; ranges: ReadonlyArray<Readonly<{ start: number | null; end: number | null }>> } | null = null;
            const coveringIds = [...sameFamilyAnnotationIds].filter((annotationId) => currentRangeOffsets(annotationId)
              .some((offsets) => offsets.start !== null && offsets.end !== null && offsets.start <= from && to <= offsets.end));
            if (coveringIds.length === 1) {
              const currentId = coveringIds[0];
              const fieldRow = db.prepare(`SELECT * FROM ${prefix}_annotation_${annotationDeclaration.annotationName} WHERE annotation_id = ?`).get(currentId);
              const currentFields: Record<string, unknown> = {};
              for (const fieldName of declaredFieldNames) {
                currentFields[fieldName] = fieldRow ? deserializeField(annotationDeclaration.fields[fieldName], fieldRow[fieldName]) : null;
              }
              current = Object.freeze({
                id: currentId,
                family: annotationDeclaration.annotationName,
                fields: Object.freeze(currentFields),
                ranges: Object.freeze(currentRangeOffsets(currentId).map((offsets) => Object.freeze({ start: offsets.start, end: offsets.end }))),
              });
            }
            const context = Object.freeze({
              input: Object.freeze(canonicalInput),
              annotationId: generatedAnnotationId,
              document: Object.freeze({ ...documentRow }),
              selection: Object.freeze({ from, to }),
              principal,
              current,
            });
            const authorization = action.authorize ? action.authorize(context) : true;
            if (authorization && typeof authorization.then === 'function') throw new ValidationError(`${actionType} authorize returned a promise; authorize must be synchronous`);
            if (authorization !== true) throw new ValidationError(`${actionType} is not authorized`);
            const contribution = action.change(context);
            if (contribution && typeof contribution.then === 'function') throw new ValidationError(`${actionType} change returned a promise; change must be synchronous`);
            if (!contribution || typeof contribution !== 'object' || Array.isArray(contribution)
              || (Object.getPrototypeOf(contribution) !== Object.prototype && Object.getPrototypeOf(contribution) !== null)
              || Reflect.ownKeys(contribution).some((key) => typeof key !== 'string')
              || Object.keys(contribution).sort().join() !== 'fields') throw new ValidationError(`${actionType} change returned an invalid contribution`);
            if (!contribution.fields || typeof contribution.fields !== 'object' || Array.isArray(contribution.fields)
              || (Object.getPrototypeOf(contribution.fields) !== Object.prototype && Object.getPrototypeOf(contribution.fields) !== null)
              || Reflect.ownKeys(contribution.fields).some((key) => typeof key !== 'string')) throw new ValidationError(`${actionType} change returned an invalid contribution`);
            // The handler owns annotation identity and range: the change
            // function returns only declared field contributions, and the
            // handler targets the single covering annotation (or a fresh
            // deterministic record) at the client's mapped selection. A
            // callback cannot redirect to another annotation or alter
            // identity, range, lifecycle, protection edges, or ownership.
            const annotationId = current?.id ?? generatedAnnotationId;
            const suppliedFieldNames = Object.keys(contribution.fields);
            if (suppliedFieldNames.some((fieldName) => !declaredFieldNames.includes(fieldName))) throw new ValidationError(`${actionType} change contributed an undeclared field`);
            // Partial contributions merge over the committed record; the merged
            // result must exactly cover the declared field set and validate.
            const mergedFields: Record<string, unknown> = { ...(current?.fields ?? {}) };
            for (const fieldName of suppliedFieldNames) mergedFields[fieldName] = contribution.fields[fieldName];
            if (JSON.stringify(Object.keys(mergedFields).sort()) !== JSON.stringify(declaredFieldNames)) throw new ValidationError(`${actionType} change contribution does not cover every declared field`);
            for (const fieldName of declaredFieldNames) {
              const field = annotationDeclaration.fields[fieldName];
              const validation = resolveStrategy(field.kind).validate(mergedFields[fieldName], field);
              if (validation !== true || (typeof field.validate === 'function' && field.validate(mergedFields[fieldName]) !== true)) throw new ValidationError(`${actionType} field '${fieldName}' failed validation`);
            }
            const plannedAnnotation = { id: annotationId, family: annotationDeclaration.annotationName, empty: annotationDeclaration.empty, fields: mergedFields, protectedTargetIds: [] };
            const plan = planTextRangeApply({ documentId: payload.id, structureVersion: state.structure_version, family, annotation: plannedAnnotation, from: { offset: from, affinity: 'right' }, to: { offset: to, affinity: 'right' }, ranges, actorId: principal?.id ?? '', cardinality: annotationDeclaration.cardinality, sameFamilyAnnotationIds });
            const handle = eventHandles.native(name, fieldName, 'operated');
            return { events: [{ handle, type: handle.type, scope: documentScope, data: plan }], canonicalPayload: payload, authoringReceipt: async ({ confirmedThrough }: any) => Object.freeze({ actionId, confirmedThrough, annotationId }) };
          };
          Object.defineProperties(domainHandler, { inTransaction: { value: true }, batchForbidden: { value: true }, dedupeReceiptMatches: { value: (receipt: any, request: any) => receipt.actionType === actionType && receipt.actionData === canonicalStringify(request.payload) } });
          handlers[actionType] = domainHandler;
          continue;
        }
        if (action.kind !== 'annotationEntityAction') continue;
        const actionType = `${name}.${fieldName}.${annotationDeclaration.annotationName}.${actionName}`;
        const relation = annotationDeclaration.fields?.[action.relation];
        const targetName = typeof relation?.target === 'string' ? relation.target : relation?.target?.name;
        const target = targetName ? record.runtime?.entityOf(targetName) : null;
        const threadHandler = async ({ payload, db, scope, principal, actionId }: any) => {
           if (!payload || typeof payload !== 'object' || Array.isArray(payload)
             || (Object.getPrototypeOf(payload) !== Object.prototype && Object.getPrototypeOf(payload) !== null)
             || Reflect.ownKeys(payload).some((key) => typeof key !== 'string')
             || Object.keys(payload).sort().join() !== 'basis,from,id,mutationId,to,values,version'
            || payload.version !== 1 || typeof payload.id !== 'string' || payload.id !== payload.id
            || typeof payload.basis !== 'string' || !payload.basis
            || typeof payload.mutationId !== 'string' || !payload.mutationId
            || !Number.isSafeInteger(payload.from) || !Number.isSafeInteger(payload.to)
             || !payload.values || typeof payload.values !== 'object' || Array.isArray(payload.values)
             || (Object.getPrototypeOf(payload.values) !== Object.prototype && Object.getPrototypeOf(payload.values) !== null)
             || Reflect.ownKeys(payload.values).some((key) => typeof key !== 'string')) {
             throw new ValidationError(`${actionType} requires a closed selection payload`);
           }
           const valueNames = Object.keys(payload.values);
           const expectedValueNames = Object.keys(action.input ?? {});
           if (valueNames.length !== expectedValueNames.length || valueNames.some((key) => !expectedValueNames.includes(key))) {
             throw new ValidationError(`${actionType} values contain unknown or missing fields`);
           }
          const documentRow = rawRow(db, name, payload.id);
          if (!documentRow) throw new ValidationError(`${actionType} document does not exist`);
          const documentScope = resolveAnnotatedTextOwningScope(descriptor, fields, documentRow).key;
          if (scope !== documentScope) throw new ValidationError(`${actionType} requires its declared document scope`);
          if (!target || !target.crudHandlers) throw new ValidationError(`${actionType} related entity is unavailable`);

          const state = db.prepare(`SELECT structure_version, family_checkpoint FROM ${prefix}_state WHERE document_id = ?`).get(payload.id);
          if (!state) throw new ValidationError(`${actionType} document state is unavailable`);
           const family = restoreTextFamilySerialized(state.family_checkpoint);
           const principalType = principal?.type ?? 'principal';
           const principalId = principal?.id ?? '';
           const position = db.prepare(`SELECT position.*, checkpoint.family_checkpoint AS basis_checkpoint FROM ${prefix}_authoring_position AS position JOIN ${prefix}_authoring_checkpoint AS checkpoint ON checkpoint.id = position.checkpoint_id JOIN ${prefix}_authoring_lease AS lease ON lease.id = position.lease_id JOIN ${prefix}_authoring_stream AS stream ON stream.id = lease.stream_id WHERE position.token = ? AND stream.document_id = ? AND stream.principal_type = ? AND stream.principal_id = ?`).get(payload.basis, payload.id, principalType, principalId);
          if (!position || !position.visible_at_issue) throw new ValidationError(`${actionType} basis is unavailable`);
           const basis = JSON.parse(position.basis_checkpoint);
           if (JSON.stringify(basis) !== JSON.stringify(textFamilyBasis(family))) throw new ValidationError(`${actionType} basis is stale`);
          const recipient = await projectAnnotatedTextSnapshot({ db, entity: record, row: documentRow, principal, fieldName, descriptor, mintBasis: false });
          if (JSON.stringify(JSON.parse(position.redactions ?? '[]')) !== JSON.stringify(authoringRedactionsForRecipient(recipient))) throw new ValidationError(`${actionType} basis is stale`);
          const redactions = JSON.parse(position.redactions ?? '[]');
          const from = mapVisibleOffsetToCanonical(payload.from, 'right', redactions, 'right');
          const to = mapVisibleOffsetToCanonical(payload.to, 'left', redactions, 'left');
          if (redactions.some((entry: any) => entry.start < from && from < entry.end || entry.start < to && to < entry.end)
            || redactions.some((entry: any) => Math.min(from, to) <= entry.start && entry.end <= Math.max(from, to))) throw new ValidationError(`${actionType} selection is hidden`);
          const text = materializeText(family);
          try { assertUtf16Range(text, from, to); } catch { throw new ValidationError(`${actionType} selection splits a UTF-16 surrogate pair`); }
          if (from < 0 || to > text.length || from >= to) throw new ValidationError(`${actionType} selection is invalid`);
          const relatedId = createHash('sha256').update(`${scope}\0${actionId}\0${actionType}\0related`).digest('hex').slice(0, 32);
          const annotationId = createHash('sha256').update(`${scope}\0${actionId}\0${actionType}\0annotation`).digest('hex').slice(0, 32);
           const relatedPayload: Record<string, any> = { id: relatedId };
           for (const [publicName, entityField] of Object.entries(action.input ?? {})) {
             if (!Object.hasOwn(payload.values, publicName)) throw new ValidationError(`${actionType} missing value '${publicName}'`);
             relatedPayload[entityField as string] = payload.values[publicName];
           }
           relatedPayload[action.project] = documentRow[descriptor.project];
           relatedPayload[action.author] = principal?.id;
           const relatedResult = await target.crudHandlers[`${target.name}.create`]({ payload: relatedPayload, principal, db, scope, actionId });
           const relatedEvents = (Array.isArray(relatedResult) ? relatedResult : relatedResult.events)
             .map((event: any) => ({ ...event, scope: documentScope }));
          const annotationFields: Record<string, any> = {};
          for (const [fieldKey, fieldDescriptor] of Object.entries(annotationDeclaration.fields ?? {})) {
            if (fieldKey === action.relation) annotationFields[fieldKey] = relatedId;
            else if ((fieldDescriptor as any).default !== undefined) annotationFields[fieldKey] = materializeDefault((fieldDescriptor as any).default);
            else if ((fieldDescriptor as any).optional || (fieldDescriptor as any).nullable) annotationFields[fieldKey] = null;
            else throw new ValidationError(`${actionType} annotation field '${fieldKey}' has no derived value`);
          }
            const rangeRows = annotationRangeRows(db, prefix, payload.id);
           const ranges = rangeRows.map((range: any) => ({ annotationId: range.annotation_id, start: JSON.parse(range.start_point), end: JSON.parse(range.end_point) }));
           const plan = planTextRangeApply({ documentId: payload.id, structureVersion: state.structure_version, family, annotation: { id: annotationId, family: annotationDeclaration.annotationName, fields: annotationFields } as any, from: { offset: from, affinity: 'right' }, to: { offset: to, affinity: 'right' }, ranges, actorId: principal?.id ?? '' });
          const handle = eventHandles.native(name, fieldName, 'operated');
           const annotationEvent = { handle, type: handle.type, scope: documentScope, data: plan };
           return { events: [...relatedEvents, annotationEvent], canonicalPayload: payload, authoringReceipt: async ({ confirmedThrough }: any) => Object.freeze({ actionId, confirmedThrough, relatedId, annotationId }) };
        };
        Object.defineProperties(threadHandler, { inTransaction: { value: true }, batchForbidden: { value: true }, dedupeReceiptMatches: { value: (receipt: any, request: any) => receipt.actionType === actionType && receipt.actionData === canonicalStringify(request.payload) } });
        handlers[actionType] = threadHandler;
      }
    }
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

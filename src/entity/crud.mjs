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
import { validateMaterializedField, validateMutation, ValidationError, deserializeField, serializeField, flattenStruct, resolveStrategy } from '../field-strategy.mjs';
import { scopeOf } from '../scope-handle.mjs';
import * as eventHandles from '../event-handle.mjs';
import { assertFrontier, assertWellFormedText, canonicalTextOp, frontierDominates } from '../annotated-text.mjs';
import { applyTextOperationToBlock, restoreTextFamilyCheckpoint, splitBlock, mergeBlocks, materializeBlock, textFamilyCheckpoint, resolvePositionToEndpoint, projectEndpointToBlockOffset, textOperationForOffsetEdit } from '../annotated-text-family.mjs';
import { splitBlockMemberships, mergeBlocksMemberships, addMembership, removeMembership } from '../annotated-text-membership.mjs';
import { getAnnotatedTextCompiledMetadata, resolveAnnotatedTextOwningScope, resolveDeclarationMeasurementExtension } from '../annotated-text-field.mjs';
import { projectAnnotatedTextSnapshot } from '../annotated-text-snapshot.mjs';
import { authorizeFieldOp } from '../strategy/index.mjs';
import { write } from '../grant.mjs';
import { assertR2BlockSplitPayload, frozenJsonSnapshot } from '../annotated-text-r2.mjs';
import { assertR3BlockMergePayload, canonicalJsonEqual } from '../annotated-text-r3.mjs';
import { assertR4AnnotationApplyPayload } from '../annotated-text-r4.mjs';
import { assertR5AnnotationDetachPayload } from '../annotated-text-r5.mjs';
import { erasureDirectivePreparation } from '../erasure-directive.mjs';
import { CASCADE_DESCENDANT, CASCADE_PREAUTHORIZED } from './removal-cascade.mjs';
import { mayRow } from '../row-grant.mjs';
import { ANNOTATED_HISTORY_COMPLETION, annotatedTextHistoryImage } from '../annotated-text-history.mjs';
import { admitsInvitationRemoval } from '../auth/invitation-acceptance-authority.mjs';
import { resolveStream, resolveLease, resolvePosition, resolveGroup, issuePositionFrame, recordSplit, clearAuthoringState } from '../annotated-text-authoring-stream.mjs';
import { readSeq } from '../committed-log.mjs';

export const CRUD_CURSOR_POLICY = Symbol('workbench.crud-cursor-policy');

/** Prefer the dispatch scope when it is the inherited parent shell for this row. */
export function resolveGeneratedEventScope(record, { id, row, payload, scope }) {
  const inherit = record.inherit;
  if (inherit && typeof scope === 'string' && scope.length > 0) {
    const ownerId = row?.[inherit.via] ?? payload?.[inherit.via];
    if (typeof ownerId === 'string' && ownerId.length > 0 && scope === scopeOf(inherit.parent, ownerId).key) {
      return scope;
    }
  }
  if (Object.values(record.fields).some((descriptor) => descriptor.kind === 'annotatedText')) {
    const annotated = Object.entries(record.fields).find(([, descriptor]) => descriptor.kind === 'annotatedText');
    return resolveAnnotatedTextOwningScope(annotated[1], record.fields, row ?? payload ?? {}).key;
  }
  return scopeOf(record.name, id).key;
}

export function assertAnnotatedTextOperationPayload(name, fieldName, payload) {
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

export function assertV9AnnotatedTextOffsetEditPayload(name, fieldName, payload) {
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
  const pToken = (value, label) => {
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
    try { assertWellFormedText(e.text); } catch (error) { throw new ValidationError(`${name}.${fieldName}.operation inserted text ${error.message}`); }
    edit = Object.freeze({ kind: 'text.insert', at: pToken(e.at, 'insert position'), text: e.text });
  } else if (e.kind === 'text.delete' && Object.keys(e).length === 3) {
    edit = Object.freeze({ kind: 'text.delete', from: pToken(e.from, 'delete start'), to: pToken(e.to, 'delete end') });
  } else if (e.kind === 'block.split' && Object.keys(e).length === 3 && typeof e.temporaryBlock === 'string' && e.temporaryBlock.length > 0) {
    edit = Object.freeze({ kind: 'block.split', at: pToken(e.at, 'split position'), temporaryBlock: e.temporaryBlock });
  } else if (e.kind === 'block.merge' && Object.keys(e).length === 3 && typeof e.leftPositionToken === 'string' && e.leftPositionToken && typeof e.rightPositionToken === 'string' && e.rightPositionToken) {
    edit = Object.freeze({ kind: 'block.merge', leftPositionToken: e.leftPositionToken, rightPositionToken: e.rightPositionToken });
  } else if (e.kind === 'annotation.apply' && Object.keys(e).length === 4 && e.annotation && typeof e.annotation === 'object') {
    edit = Object.freeze({ kind: 'annotation.apply', annotation: frozenJsonSnapshot(e.annotation), from: pToken(e.from, 'annotation start'), to: pToken(e.to, 'annotation end') });
  } else if (e.kind === 'annotation.detach' && Object.keys(e).length === 3 && typeof e.annotationId === 'string' && e.annotationId && typeof e.positionToken === 'string' && e.positionToken) {
    edit = Object.freeze({ kind: 'annotation.detach', annotationId: e.annotationId, positionToken: e.positionToken });
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

function assertV9GroupSelection(name, fieldName, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError(`${name}.${fieldName}.operation selection is invalid`);
  if (value.kind === 'one' && Object.keys(value).length === 2 && typeof value.groupToken === 'string' && value.groupToken) return Object.freeze({ kind: 'one', groupToken: value.groupToken });
  if ((value.kind === 'consecutive' || value.kind === 'listed') && Object.keys(value).length === 2 && Array.isArray(value.groupTokens) && value.groupTokens.length && value.groupTokens.every((token) => typeof token === 'string' && token) && new Set(value.groupTokens).size === value.groupTokens.length) return Object.freeze({ kind: value.kind, groupTokens: Object.freeze([...value.groupTokens]) });
  throw new ValidationError(`${name}.${fieldName}.operation selection is invalid`);
}

function editTokens(edit, db, prefix, leaseId) {
  if (edit.kind !== 'block.merge') return [];
  return [edit.leftPositionToken, edit.rightPositionToken].map((token) =>
    resolvePosition({ db, prefix, positionToken: token, leaseId }));
}

function ownerFieldOf(entity) {
  for (const [fieldName, descriptor] of Object.entries(entity.fields)) {
    if (descriptor.type === 'ref' && descriptor.role && descriptor.readonly) {
      return fieldName;
    }
  }
  return null;
}

function materializeDefault(defaultValue) {
  const value = typeof defaultValue === 'function' ? defaultValue() : defaultValue;
  return value !== null && typeof value === 'object' ? structuredClone(value) : value;
}

function assertAnnotatedTextImportPayload(name, fieldName, descriptor, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${name}.${fieldName} annotated-text import must be a non-array object`);
  }
  const allowed = new Set(['version', 'blocks']);
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
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      throw new ValidationError(`${name}.${fieldName} annotated-text import blocks[${i}] must be a non-array object`);
    }
    const allowedBlock = new Set(['text', 'fields', 'measurements']);
    for (const key of Object.keys(block)) {
      if (!allowedBlock.has(key)) throw new ValidationError(`${name}.${fieldName} annotated-text import blocks[${i}] has unknown key '${key}'`);
    }
    try { assertWellFormedText(block.text); } catch (error) {
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
    const fields = {};
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
        const config = descriptor.measurements.find((entry) => entry.measurementName === measurement.family);
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
    canonicalBlocks.push(Object.freeze({ id: randomUUID(), text: block.text, fields: Object.freeze(fields), measurements: Object.freeze(measurements) }));
  }
  return Object.freeze({ version: 1, actor: randomUUID().replaceAll('-', ''), blocks: Object.freeze(canonicalBlocks) });
}

export function materializeCreateDefaults(record, payload) {
  const data = { ...payload };
  for (const [fieldName, descriptor] of Object.entries(record.fields)) {
    if (!(fieldName in data) && descriptor.default !== undefined) {
      data[fieldName] = materializeDefault(descriptor.default);
      data[fieldName] = validateMaterializedField(record, fieldName, data[fieldName]);
    }
  }
  return data;
}

export function createCrudHandlers({ record, sideTableStrategyEntries, conditionalHistory = false, conditionalCreateHistory = false }) {
  const { name, fields, verbs } = record;
  const ownerField = ownerFieldOf({ name, fields });

  const handlers = {
    [`${name}.create`]: ({ payload, principal, db, history, scope }) => {
      if (Object.hasOwn(payload, '__workbench')) {
        throw new ValidationError(`${name}.__workbench is reserved for framework event metadata`);
      }
      const { id: requestedId, ...fieldsPayload } = payload;
      const annotatedImports = {};
      for (const [fieldName, descriptor] of Object.entries(fields)) {
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
        const columns = db.prepare(`PRAGMA table_info(${name})`).all().map((column) => column.name);
        if (Object.keys(replacement).length !== columns.length || columns.some((column) => !Object.hasOwn(replacement, column)) || db.prepare(`SELECT 1 FROM ${name} WHERE id = ?`).get(id)) {
          throw Object.assign(new Error(`${name}.create history expected row conflicts`), { status: 409 });
        }
        const restored = { id };
        for (const [fieldName, descriptor] of Object.entries(fields)) restored[fieldName] = deserializeField(descriptor, replacement[fieldName]);
        return { events: [{ handle: verbs.created.handle, type: verbs.created.type, scope: resolveGeneratedEventScope(record, { id, payload: replacement, scope }), data: restored }], privateFact: { before: null, after: replacement } };
      }
      const data = materializeCreateDefaults(record, { ...validatedFields, id });
      if (ownerField) data[ownerField] = principal?.id;
      const annotatedText = Object.fromEntries(
        Object.entries(fields)
          .filter(([, descriptor]) => descriptor.kind === 'annotatedText')
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
      const columns = db.prepare(`PRAGMA table_info(${name})`).all().map((column) => column.name);
      const after = Object.fromEntries(columns.map((column) => {
        if (column === 'id') return [column, id];
        const descriptor = fields[column];
        return [column, descriptor && Object.hasOwn(data, column) ? serializeField(descriptor, data[column]) : null];
      }));
      return { events, privateFact: { before: null, after } };
    },
    [`${name}.update`]: ({ payload, principal: _p, db, history, scope }) => {
      const { id, ...rest } = payload;
      if (!id) throw Object.assign(new Error('update requires an id'), { status: 400 });
      if (Object.keys(rest).length === 0) {
        if (!history) throw new ValidationError(`${name}.update requires at least one field to change`);
      }
      const currentStored = conditionalHistory ? db.prepare(`SELECT * FROM ${name} WHERE id = ?`).get(id) : null;
      if (conditionalHistory && !currentStored) throw Object.assign(new Error(`${name} ${id} not found`), { status: 404 });
      if (history) {
        if (!conditionalHistory || !history || (history.operation !== 'undo' && history.operation !== 'redo') || !history.input || Object.keys(history.input).length !== 2) throw new ValidationError(`${name}.update history input is invalid`);
        const { expected, replacement } = history.input;
        const columns = db.prepare(`PRAGMA table_info(${name})`).all().map((column) => column.name);
        const validRow = (row) => row && typeof row === 'object' && !Array.isArray(row) && Object.keys(row).length === columns.length && columns.every((column) => Object.hasOwn(row, column));
        if (!validRow(expected) || !validRow(replacement) || expected.id !== id || replacement.id !== id) throw new ValidationError(`${name}.update history input rows are invalid`);
        if (!columns.every((column) => Object.is(currentStored[column], expected[column]))) throw Object.assign(new Error(`${name}.update history expected row conflicts`), { status: 409 });
        const data = {};
        for (const [fieldName, descriptor] of Object.entries(fields)) {
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
      for (const [fieldName, descriptor] of Object.entries(fields)) {
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
      const data = { ...validatedFields, id };
      for (const [fieldName, descriptor] of Object.entries(fields)) {
        if (descriptor.touch) data[fieldName] = new Date();
      }
      const updateRow = db?.prepare?.(`SELECT * FROM ${name} WHERE id = ?`).get(id) ?? null;
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
          else after[fieldName] = resolveStrategy(descriptor.kind).serialize(value, descriptor);
        }
        for (const [fieldName, descriptor] of Object.entries(fields)) if (descriptor.touch) after[fieldName] = serializeField(descriptor, data[fieldName]);
        return { events: result, privateFact: { before: currentStored, after } };
      }
      return result;
    },
    [`${name}.remove`]: async ({ payload, principal, db, history, scope }) => {
      if (!payload.id) throw Object.assign(new Error('remove requires an id'), { status: 400 });
      if (history) {
        if (!conditionalCreateHistory || history.operation !== 'undo' || !history.input || Object.keys(history.input).length !== 2) throw new ValidationError(`${name}.remove history input is invalid`);
        if (!history.input.expected || history.input.replacement !== null || history.input.expected.id !== payload.id) throw new ValidationError(`${name}.remove history input row is invalid`);
        const columns = db.prepare(`PRAGMA table_info(${name})`).all().map((column) => column.name);
        const current = db.prepare(`SELECT * FROM ${name} WHERE id = ?`).get(payload.id);
        if (!current || Object.keys(history.input.expected).length !== columns.length || columns.some((column) => !Object.hasOwn(history.input.expected, column)) || !columns.every((column) => Object.is(current[column], history.input.expected[column]))) {
          throw Object.assign(new Error(`${name} remove conflicts`), { status: 409 });
        }
        if (record.removalCascade && (await record.removalCascadeDescendants(payload.id, db)).length > 0) {
          throw Object.assign(new Error(`${name} remove conflicts: cascade descendants exist`), { status: 409 });
        }
        return { events: [{ handle: verbs.removed.handle, type: verbs.removed.type, scope: resolveGeneratedEventScope(record, { id: payload.id, row: current, payload: history.input.expected, scope }), data: { id: payload.id } }], privateFact: { before: history.input.expected, after: null } };
      }
      if (record.removalCascade) {
        return record.removalCascade(payload.id, principal, db)
          .then((rows) => {
            const events = rows.map(({ entity, id }, index) => ({
              ...entity.removedEvent(id, db),
              [CASCADE_PREAUTHORIZED]: true,
              ...(index < rows.length - 1 ? { [CASCADE_DESCENDANT]: true } : {}),
            }));
            if (!conditionalCreateHistory) return events;
            const parent = rows.at(-1);
            const before = db.prepare(`SELECT * FROM ${name} WHERE id = ?`).get(parent.id);
            return { events, privateFact: { before, after: null } };
          });
      }
      // A conditional remove reads its private preimage below, so authorize the
      // target row first rather than allowing that read to precede admission.
      const admissionRow = db.prepare(`SELECT * FROM ${name} WHERE id = ?`).get(payload.id);
      if (!admissionRow || (!(await mayRow(record, 'remove', admissionRow, principal))
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
  const cursorPolicy = {};
  const annotatedEntries = Object.entries(fields).filter(([, descriptor]) => descriptor.kind === 'annotatedText');
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
      const retirementHandler = async ({ payload, principal, db, scope }) => {
      if (!payload || Object.keys(payload).length !== 1 || typeof payload.id !== 'string' || !payload.id) throw new ValidationError(`${retirementType} requires { id }`);
      const row = db.prepare(`SELECT * FROM ${name} WHERE id = ?`).get(payload.id);
      const owningScope = row && resolveAnnotatedTextOwningScope(annotatedEntries[0][1], fields, row).key;
      if (!row || scope !== owningScope) throw new ValidationError(`${retirementType} requires its declared project scope`);
        if (!row || principal?.id == null || annotatedEntries.some(([, descriptor]) => String(row[descriptor.owner]) !== String(principal.id))) throw Object.assign(new Error('forbidden'), { status: 403 });
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
      const commit = {
        events: [...events, removed],
      };
      if (hasErasureTargets) commit.directive = erasureDirectivePreparation({ owningScope, subject: payload.id, census: { version: 1, rules: [
          ...censusRows.map(({ type }) => ({ kind: 'action', type, disposition: targetActionTypes.has(type) ? 'target' : 'retain', identityPointers: targetActionTypes.has(type) ? ['/id'] : [] })),
          ...censusEvents.map(({ type }) => ({ kind: 'event', type, disposition: targetEventTypes.has(type) ? 'target' : 'retain', identityPointers: targetEventTypes.has(type) ? ['/id'] : [] })),
        ] } });
      return commit;
    };
    Object.defineProperties(retirementHandler, { inTransaction: { value: true }, batchForbidden: { value: true }, erasureCapable: { value: true } });
    handlers[retirementType] = retirementHandler;
    cursorPolicy[retirementType] = 'excluded';
  }

  for (const [fieldName, descriptor] of Object.entries(fields)) {
    if (descriptor.kind !== 'crdt' || descriptor.type !== 'text') continue;
    handlers[`${name}.${fieldName}.apply`] = ({ payload }) => {
      if (!payload || typeof payload.id !== 'string' || Object.keys(payload).length !== 2 || !Object.hasOwn(payload, 'operation')) {
        throw new ValidationError(`${name}.${fieldName}.apply requires exactly { id, operation }`);
      }
      const operation = canonicalTextOp(payload.operation);
      const handle = eventHandles.native(name, fieldName, 'applied');
      return [{ handle, type: handle.type, scope: scopeOf(name, payload.id).key, data: { id: payload.id, operation } }];
    };
    cursorPolicy[`${name}.${fieldName}.apply`] = 'excluded';
  }

  for (const [fieldName, descriptor] of Object.entries(fields)) {
    if (descriptor.kind !== 'annotatedText') continue;
    const operationType = `${name}.${fieldName}.operation`;
    const prefix = `${name}_${fieldName}`;
    const compiledMeta = getAnnotatedTextCompiledMetadata(descriptor);
    const measurementConfigs = compiledMeta?.measurementConfigs ?? {};
    const measurementFamilyList = compiledMeta?.measurementFamilyList ?? [];
    const owningDocumentScope = (db, id) => {
      const row = db.prepare(`SELECT * FROM ${name} WHERE id = ?`).get(id);
      if (!row) throw new ValidationError(`${name}.${fieldName}.operation document does not exist`);
      return resolveAnnotatedTextOwningScope(descriptor, fields, row).key;
    };

    const assertDocumentScope = ({ payload, scope, db, internal = false }) => {
      let command;
      if (payload.version === 9) command = assertV9AnnotatedTextOffsetEditPayload(name, fieldName, payload);
      else if (internal && payload.version === 1) command = assertAnnotatedTextOperationPayload(name, fieldName, payload);
      else if (internal && payload.version === 2) command = assertR2BlockSplitPayload(name, fieldName, payload);
      else if (internal && payload.version === 3) command = assertR3BlockMergePayload(name, fieldName, payload);
      else if (internal && payload.version === 4) command = assertR4AnnotationApplyPayload(name, fieldName, payload);
      else if (internal && payload.version === 5) command = assertR5AnnotationDetachPayload(name, fieldName, payload);
      else throw new ValidationError(`${name}.${fieldName}.operation requires version 9`);
      const row = db.prepare(`SELECT * FROM ${name} WHERE id = ?`).get(command.id);
      if (!row) throw new ValidationError(`${name}.${fieldName}.operation document does not exist`);
      const documentScope = resolveAnnotatedTextOwningScope(descriptor, fields, row).key;
      if (scope !== documentScope) {
        throw new ValidationError(`${name}.${fieldName}.operation requires document scope '${documentScope}'`);
      }
      return command;
    };

    const assertV9AuthoringBinding = ({ command, db, principal }) => {
      const stream = resolveStream({ db, prefix, streamToken: command.authoring.stream, documentId: command.id, principalType: principal?.type ?? 'principal', principalId: principal?.id ?? '' });
      if (!stream) throw new ValidationError(`${name}.${fieldName}.operation authoring stream unavailable`, { code: 'authoring-stream-unavailable' });
      const lease = resolveLease({ db, prefix, leaseToken: command.authoring.lease, streamId: stream.id });
      if (!lease) throw new ValidationError(`${name}.${fieldName}.operation authoring lease unavailable`, { code: 'authoring-lease-unavailable' });
      return { stream, lease };
    };

    const r1Handler = async ({ payload, db, scope, principal, actionId }) => {
      if (payload.version === 9) {
        const command = assertV9AnnotatedTextOffsetEditPayload(name, fieldName, payload);
        const row = db.prepare(`SELECT * FROM ${name} WHERE id = ?`).get(command.id);
        if (!row) throw new ValidationError(`${name}.${fieldName}.operation document does not exist`);
        const documentScope = resolveAnnotatedTextOwningScope(descriptor, fields, row).key;
        if (scope !== documentScope) throw new ValidationError(`${name}.${fieldName}.operation requires document scope '${documentScope}'`);
        await authorizeFieldOp(record, fieldName, write, row, principal);
        const { stream, lease } = assertV9AuthoringBinding({ command, db, principal });
        const state = db.prepare(`SELECT structure_version, family_checkpoint FROM ${prefix}_state WHERE document_id = ?`).get(command.id);
        if (!state) throw new ValidationError(`${name}.${fieldName}.operation document does not exist`);
        const family = restoreTextFamilyCheckpoint(JSON.parse(state.family_checkpoint));
        const currentRecipient = await projectAnnotatedTextSnapshot({ db, entity: record, row, principal, fieldName, descriptor, mintBasis: false });
        const currentVisible = new Set(currentRecipient.blocks.filter((block) => block.kind === 'visible').map((block) => block.id));
          const cursor = readSeq(db, documentScope) + 1;
        const primaryToken = command.edit.at?.positionToken ?? command.edit.from?.positionToken ?? command.edit.positionToken;
        const position = primaryToken ? resolvePosition({ db, prefix, positionToken: primaryToken, leaseId: lease.id }) : null;
        const groupAssignment = command.edit.kind === 'block-group.assignment.set' || command.edit.kind === 'block-group.assignment.clear';
        if (!groupAssignment && command.edit.kind !== 'block.merge' && !position) throw new ValidationError(`${name}.${fieldName}.operation position token unavailable`, { code: 'position-token-unavailable' });
        if (position && (!position.visible_at_issue || !currentVisible.has(position.block_id))) throw new ValidationError(`${name}.${fieldName}.operation position no longer visible`, { code: 'position-no-longer-visible' });
        const positionFamily = position ? restoreTextFamilyCheckpoint(JSON.parse(position.family_checkpoint)) : null;
        const mergePositions = editTokens(command.edit, db, prefix, lease.id);
        const referencedBlocks = groupAssignment ? [] : command.edit.kind === 'text.insert' || command.edit.kind === 'block.split' ? [position.block_id]
          : command.edit.kind === 'text.delete' || command.edit.kind === 'annotation.apply' ? [position.block_id, command.edit.to?.positionToken ? resolvePosition({ db, prefix, positionToken: command.edit.to.positionToken, leaseId: lease.id })?.block_id : null].filter(Boolean)
          : command.edit.kind === 'block.merge' ? mergePositions.map((p) => p?.block_id) : [position.block_id];
        if (referencedBlocks.some((blockId) => blockId && !currentVisible.has(blockId))) {
          throw new ValidationError(`${name}.${fieldName}.operation position no longer visible`, { code: 'position-no-longer-visible' });
        }
        const actor = createHash('sha256').update(`${name}\u0000${fieldName}\u0000${command.id}\u0000${principal?.id ?? ''}\u0000${command.authoring.mutationId}`).digest('hex').slice(0, 32);
        const lamport = Math.max(0, ...Object.values(family.checkpoint.elements).map((element) => element.lamport)) + 1;
        const edit = command.edit;
        if (edit.kind === 'text.insert' || edit.kind === 'text.delete') {
          const blockId = position.block_id;
          let offset;
          try {
            const endpoint = resolvePositionToEndpoint(positionFamily, blockId, edit.kind === 'text.insert' ? edit.at.offset : edit.from.offset, positionFamily.checkpoint.frontier, edit.kind === 'text.insert' ? edit.at.affinity : edit.from.affinity);
            offset = projectEndpointToBlockOffset(family, blockId, Object.freeze({ ...endpoint, basisFrontier: family.checkpoint.frontier }));
          } catch (error) {
            throw new ValidationError(`${name}.${fieldName}.operation ${error.message}`);
          }
          const textEdit = edit.kind === 'text.insert'
            ? { kind: 'text.insert', at: { blockId, offset, affinity: edit.at.affinity }, text: edit.text }
            : { kind: 'text.delete', from: { blockId, offset, affinity: edit.from.affinity }, to: { blockId, offset: (() => { try { const ep = resolvePositionToEndpoint(positionFamily, blockId, edit.to.offset, positionFamily.checkpoint.frontier, edit.to.affinity); return projectEndpointToBlockOffset(family, blockId, Object.freeze({ ...ep, basisFrontier: family.checkpoint.frontier })); } catch (e) { throw new ValidationError(`${name}.${fieldName}.operation ${e.message}`); } })(), affinity: edit.to.affinity } };
          let operation;
          try { operation = textOperationForOffsetEdit(family, textEdit, actor, lamport); } catch (error) {
            throw new ValidationError(`${name}.${fieldName}.operation ${error.message}`);
          }
          let nextFamily;
          try { nextFamily = applyTextOperationToBlock(family, blockId, operation); } catch (error) {
            throw new ValidationError(`${name}.${fieldName}.operation ${error.message}`);
          }
          const handle = eventHandles.native(name, fieldName, 'operated');
          return [{ handle, type: handle.type, scope: documentScope, data: Object.freeze({ version: 1, id: command.id, before: Object.freeze({ structuralRevision: state.structure_version, frontier: family.checkpoint.frontier }), operation: Object.freeze({ kind: 'text.apply', blockId, operation }), after: Object.freeze({ structuralRevision: state.structure_version, frontier: nextFamily.checkpoint.frontier }), family: textFamilyCheckpoint(nextFamily) }) }];
        }
        if (edit.kind === 'block.split') {
          let offset;
          try {
            const endpoint = resolvePositionToEndpoint(positionFamily, position.block_id, edit.at.offset, positionFamily.checkpoint.frontier, edit.at.affinity);
            offset = projectEndpointToBlockOffset(family, position.block_id, Object.freeze({ ...endpoint, basisFrontier: family.checkpoint.frontier }));
          } catch (error) {
            throw new ValidationError(`${name}.${fieldName}.operation ${error.message}`);
          }
          const splitResult = splitHandler({ payload: { version: 2, id: command.id, expected: { structuralRevision: state.structure_version, frontier: family.checkpoint.frontier }, operation: { kind: 'block.split', blockId: position.block_id, utf16Offset: offset } }, db, scope });
             if (splitResult.length > 0) {
               const splitData = splitResult[0].data;
               const rightBlockId = splitData.operation.rightBlockId;
               const frame = issuePositionFrame({ db, prefix, leaseId: lease.id, blockId: rightBlockId, fence: cursor, familyCheckpoint: splitData.family, visibleAtIssue: true });
               if (!frame || !recordSplit({ db, prefix, leaseId: lease.id, temporaryBlock: edit.temporaryBlock, authoritativeBlockId: rightBlockId, positionToken: frame.token, actionId, mutationId: command.authoring.mutationId, fence: cursor })) throw new ValidationError(`${name}.${fieldName}.operation authoring stream capacity exceeded`, { code: 'authoring-stream-capacity' });
             }
          return splitResult;
        }
        if (edit.kind === 'block.merge') {
          const expected = Object.freeze({ structuralRevision: state.structure_version, frontier: family.checkpoint.frontier });
          if (mergePositions.length !== 2 || mergePositions.some((p) => !p)) throw new ValidationError(`${name}.${fieldName}.operation merge position token unavailable`, { code: 'position-token-unavailable' });
          return r3Handler({ payload: { version: 3, id: command.id, expected, operation: { kind: 'block.merge', leftBlockId: mergePositions[0].block_id, rightBlockId: mergePositions[1].block_id } }, db, scope });
        }
        if (edit.kind === 'annotation.apply') {
          const fromPos = resolvePosition({ db, prefix, positionToken: edit.from.positionToken, leaseId: lease.id });
          const toPos = resolvePosition({ db, prefix, positionToken: edit.to.positionToken, leaseId: lease.id });
          if (!fromPos || !toPos || fromPos.block_id !== toPos.block_id) throw new ValidationError(`${name}.${fieldName}.operation annotation positions must be on the same block`, { code: 'position-invalid' });
          const fromFamily = restoreTextFamilyCheckpoint(JSON.parse(fromPos.family_checkpoint));
          const toFamily = restoreTextFamilyCheckpoint(JSON.parse(toPos.family_checkpoint));
          let startOffset, endOffset;
          try {
          const startEp = resolvePositionToEndpoint(fromFamily, fromPos.block_id, edit.from.offset, fromFamily.checkpoint.frontier, edit.from.affinity);
            startOffset = projectEndpointToBlockOffset(family, fromPos.block_id, Object.freeze({ ...startEp, basisFrontier: family.checkpoint.frontier }));
          const endEp = resolvePositionToEndpoint(toFamily, toPos.block_id, edit.to.offset, toFamily.checkpoint.frontier, edit.to.affinity);
            endOffset = projectEndpointToBlockOffset(family, toPos.block_id, Object.freeze({ ...endEp, basisFrontier: family.checkpoint.frontier }));
          } catch (error) {
            throw new ValidationError(`${name}.${fieldName}.operation ${error.message}`);
          }
          return r4Handler({ payload: { version: 4, id: command.id, expected: { structuralRevision: state.structure_version, frontier: family.checkpoint.frontier }, operation: { kind: 'annotation.apply', annotation: edit.annotation, selection: { blockId: fromPos.block_id, startUtf16Offset: startOffset, endUtf16Offset: endOffset } } }, db, scope, principal });
        }
        if (edit.kind === 'annotation.detach') {
          const expected = Object.freeze({ structuralRevision: state.structure_version, frontier: family.checkpoint.frontier });
          const detachPosition = resolvePosition({ db, prefix, positionToken: edit.positionToken, leaseId: lease.id });
          if (!detachPosition) throw new ValidationError(`${name}.${fieldName}.operation detach position token unavailable`, { code: 'position-token-unavailable' });
          return r5Handler({ payload: { version: 5, id: command.id, expected, operation: { kind: 'annotation.detach', annotationId: edit.annotationId, blockId: detachPosition.block_id } }, db, scope });
        }
        if (groupAssignment) {
          const tokens = edit.selection.kind === 'one' ? [edit.selection.groupToken] : edit.selection.groupTokens;
          const frames = tokens.map((groupToken) => resolveGroup({ db, prefix, groupToken, leaseId: lease.id }));
          if (frames.some((frame) => !frame || !frame.assignable || !frame.group_id)) {
            throw new ValidationError(`${name}.${fieldName}.operation group token unavailable`, { code: 'position-token-unavailable' });
          }
          for (const frame of frames) {
            let visibleBlocks;
            try { visibleBlocks = JSON.parse(frame.visible_blocks); } catch { visibleBlocks = null; }
            if (!Array.isArray(visibleBlocks) || visibleBlocks.length === 0 || visibleBlocks.some((blockId) => typeof blockId !== 'string' || !currentVisible.has(blockId))) {
              throw new ValidationError(`${name}.${fieldName}.operation position no longer visible`, { code: 'position-no-longer-visible' });
            }
          }
          const groupIds = frames.map((frame) => frame.group_id);
          if (new Set(groupIds).size !== groupIds.length) throw new ValidationError(`${name}.${fieldName}.operation selection is invalid`);
          const ordered = db.prepare(`SELECT block_group.group_id, MIN(block.position) AS position FROM ${prefix}_block_group AS block_group JOIN ${prefix}_block AS block ON block.id = block_group.block_id WHERE block.document_id = ? GROUP BY block_group.group_id ORDER BY position`).all(command.id);
          const rank = new Map(ordered.map((group, index) => [group.group_id, index]));
          if (groupIds.some((groupId) => !rank.has(groupId))) throw new ValidationError(`${name}.${fieldName}.operation group token unavailable`, { code: 'position-token-unavailable' });
          const canonicalGroupIds = [...groupIds].sort((left, right) => rank.get(left) - rank.get(right));
          if (edit.selection.kind === 'consecutive' && (groupIds.some((groupId, index) => index > 0 && rank.get(groupId) !== rank.get(groupIds[index - 1]) + 1) || canonicalGroupIds.some((groupId, index) => index > 0 && rank.get(groupId) !== rank.get(canonicalGroupIds[index - 1]) + 1))) {
            throw new ValidationError(`${name}.${fieldName}.operation consecutive selection is invalid`);
          }
          const familyName = edit.kind.endsWith('.set') ? edit.annotation.family : edit.family;
          const familyMeta = compiledMeta.annotationHandles[familyName];
          const familyDecl = descriptor.annotations.find((entry) => entry.annotationName === familyName);
          if (!familyMeta || !familyDecl || familyDecl.kind !== 'annotation' || familyMeta.appliesTo !== 'block-group' || familyMeta.cardinality !== 'one') {
            throw new ValidationError(`${name}.${fieldName}.operation annotation family is invalid`);
          }
          let annotation = null;
          if (edit.kind.endsWith('.set')) {
            annotation = edit.annotation;
            if (!annotation || Object.keys(annotation).sort().join() !== 'family,fields,id' || annotation.family !== familyName || typeof annotation.id !== 'string' || !annotation.id || db.prepare(`SELECT 1 FROM ${prefix}_annotation WHERE id = ?`).get(annotation.id) || JSON.stringify(Object.keys(annotation.fields ?? {}).sort()) !== JSON.stringify(Object.keys(familyDecl.fields).sort())) {
              throw new ValidationError(`${name}.${fieldName}.operation annotation must be fresh and valid`);
            }
            for (const [key, value] of Object.entries(annotation.fields)) {
              const valid = resolveStrategy(familyDecl.fields[key].kind).validate(value, familyDecl.fields[key]);
              if (valid !== true || (typeof familyDecl.fields[key].validate === 'function' && familyDecl.fields[key].validate(value) !== true)) throw new ValidationError(`${name}.${fieldName}.operation annotation field '${key}' is invalid`);
            }
          }
          const preimage = canonicalGroupIds.map((groupId) => Object.freeze({ groupId, annotationId: db.prepare(`SELECT annotation.id FROM ${prefix}_group_membership AS membership JOIN ${prefix}_annotation AS annotation ON annotation.id = membership.annotation_id WHERE membership.group_id = ? AND annotation.document_id = ? AND annotation.family = ? LIMIT 1`).get(groupId, command.id, familyName)?.id ?? null }));
          const existing = db.prepare(`SELECT DISTINCT annotation.id FROM ${prefix}_group_membership AS membership JOIN ${prefix}_annotation AS annotation ON annotation.id = membership.annotation_id WHERE membership.group_id IN (${canonicalGroupIds.map(() => '?').join(',')}) AND annotation.document_id = ? AND annotation.family = ?`).all(...canonicalGroupIds, command.id, familyName).map((row) => row.id);
          const selected = new Set(canonicalGroupIds);
          const removedAnnotationIds = existing.filter((id) => db.prepare(`SELECT group_id FROM ${prefix}_group_membership WHERE annotation_id = ? UNION SELECT '__block__' AS group_id FROM ${prefix}_membership WHERE annotation_id = ?`).all(id, id).every((membership) => membership.group_id !== '__block__' && selected.has(membership.group_id))).sort();
          const handle = eventHandles.native(name, fieldName, 'operated');
          return [{ handle, type: handle.type, scope: documentScope, data: Object.freeze({
            version: 8, id: command.id,
            before: Object.freeze({ structuralRevision: state.structure_version, frontier: family.checkpoint.frontier }),
            operation: Object.freeze(edit.kind.endsWith('.set') ? { kind: edit.kind, groupIds: Object.freeze(canonicalGroupIds), annotation: Object.freeze(annotation) } : { kind: edit.kind, groupIds: Object.freeze(canonicalGroupIds), family: familyName }),
            after: Object.freeze({ structuralRevision: state.structure_version, frontier: family.checkpoint.frontier }),
            preimage: Object.freeze(preimage),
            postimage: Object.freeze(canonicalGroupIds.map((groupId) => Object.freeze({ groupId, annotationId: annotation?.id ?? null }))),
            removedAnnotationIds: Object.freeze(removedAnnotationIds),
          }) }];
        }
        if (edit.kind === 'block.continue' || edit.kind === 'block.split-and-assign') {
          let offset;
          try {
            const endpoint = resolvePositionToEndpoint(positionFamily, position.block_id, edit.at.offset, positionFamily.checkpoint.frontier, edit.at.affinity);
            offset = projectEndpointToBlockOffset(family, position.block_id, Object.freeze({ ...endpoint, basisFrontier: family.checkpoint.frontier }));
          } catch (error) {
            throw new ValidationError(`${name}.${fieldName}.operation ${error.message}`);
          }
          if (offset <= 0 || offset >= materializeBlock(family, position.block_id).length) throw new ValidationError(`${name}.${fieldName}.operation position must be strictly internal`);
          const groupRow = db.prepare(`SELECT group_id FROM ${prefix}_block_group WHERE block_id = ?`).get(position.block_id);
          if (!groupRow) throw new ValidationError(`${name}.${fieldName}.operation block group not found`);
          const splitResult = splitHandler({ payload: { version: 2, id: command.id, expected: { structuralRevision: state.structure_version, frontier: family.checkpoint.frontier }, operation: { kind: 'block.split', blockId: position.block_id, utf16Offset: offset } }, db, scope, structural: { kind: edit.kind, groupId: groupRow.group_id, annotation: edit.annotation || null } });
          if (splitResult.length > 0) {
            const splitData = splitResult[0].data;
            const rightBlockId = splitData.operation.rightBlockId || (splitData.operation?.leftBlockId !== position.block_id ? splitData.operation.leftBlockId : null);
            if (rightBlockId) {
               const frame = issuePositionFrame({ db, prefix, leaseId: lease.id, blockId: rightBlockId, fence: cursor, familyCheckpoint: splitData.family, visibleAtIssue: true });
               if (!frame || !recordSplit({ db, prefix, leaseId: lease.id, temporaryBlock: edit.temporaryBlock, authoritativeBlockId: rightBlockId, positionToken: frame.token, actionId, mutationId: command.authoring.mutationId, fence: cursor })) throw new ValidationError(`${name}.${fieldName}.operation authoring stream capacity exceeded`, { code: 'authoring-stream-capacity' });
            }
          }
          return splitResult;
        }
        throw new ValidationError(`${name}.${fieldName}.operation v9 edit kind not supported`);
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
      } catch (error) {
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

    const splitHandler = ({ payload, db, scope, structural = null }) => {
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
      } catch (error) {
        throw new ValidationError(`${name}.${fieldName}.operation ${error.message}`);
      }

      if (utf16Offset === 0 || utf16Offset === blockText.length) {
        return [];
      }

      const newBlockId = randomUUID();
      let splitResult;
      try {
        splitResult = splitBlock(family, blockId, newBlockId, utf16Offset);
      } catch (error) {
        throw new ValidationError(`${name}.${fieldName}.operation ${error.message}`);
      }
      if (splitResult.type === 'unchanged') {
        return [];
      }

      const afterRevision = state.structure_version + 1;

      const leftBlockStored = db.prepare(`SELECT * FROM ${prefix}_block WHERE id = ?`).get(blockId);
      if (!leftBlockStored) throw new ValidationError(`${name}.${fieldName}.operation source block not found`);

      const blockFields = Object.keys(descriptor.block ?? {});
      const leftBlockFields = {};
      for (const bf of blockFields) {
        const bd = descriptor.block[bf];
        leftBlockFields[bf] = deserializeField(bd, leftBlockStored[bf]);
      }

      const leftBlockFact = Object.freeze({
        id: blockId,
        epoch: leftBlockStored.epoch,
        fields: Object.freeze(leftBlockFields),
      });

      const rightBlockFields = {};
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
      const pureMemberships = memberships.map(m => ({
        annotationId: m.annotation_id,
        blockId: m.block_id,
        ordinal: m.ordinal,
        start: JSON.parse(m.start_point),
        end: JSON.parse(m.end_point),
      }));

      const annotations = db.prepare(`SELECT id, family FROM ${prefix}_annotation WHERE document_id = ?`).all(command.id);
      const pureAnnotations = annotations.map(a => ({ id: a.id, family: a.family }));

      const membershipResult = splitBlockMemberships(
        splitResult.family, pureAnnotations, pureMemberships, blockId, newBlockId,
      );
      const affectedAnnotationIds = new Set(pureMemberships.filter(m => m.blockId === blockId).map(m => m.annotationId));

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

          const validatePayload = (payload, blockText) => {
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
          const familyDecl = descriptor.annotations.find((d) => d.annotationName === familyName);
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
      const eventData = {
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

    const r3Handler = ({ payload, db, scope }) => {
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

      const leftBlockStored = db.prepare(`SELECT * FROM ${prefix}_block WHERE id = ?`).get(leftBlockId);
      if (!leftBlockStored) throw new ValidationError(`${name}.${fieldName}.operation left block not found`);
      const rightBlockStored = db.prepare(`SELECT * FROM ${prefix}_block WHERE id = ?`).get(rightBlockId);
      if (!rightBlockStored) throw new ValidationError(`${name}.${fieldName}.operation right block not found`);

      const blockFields = Object.keys(descriptor.block ?? {});

      const leftBlockCells = {};
      for (const bf of blockFields) {
        const bd = descriptor.block[bf];
        leftBlockCells[bf] = deserializeField(bd, leftBlockStored[bf]);
      }
      const rightBlockCells = {};
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
      } catch (error) {
        throw new ValidationError(`${name}.${fieldName}.operation ${error.message}`);
      }

      const memberships = db.prepare(
        `SELECT membership.annotation_id, membership.block_id, membership.ordinal, membership.start_point, membership.end_point
           FROM ${prefix}_membership AS membership
           JOIN ${prefix}_annotation AS annotation ON annotation.id = membership.annotation_id
          WHERE annotation.document_id = ?`,
      ).all(command.id);
      const pureMemberships = memberships.map(m => ({
        annotationId: m.annotation_id,
        blockId: m.block_id,
        ordinal: m.ordinal,
        start: JSON.parse(m.start_point),
        end: JSON.parse(m.end_point),
      }));

      const annotations = db.prepare(`SELECT id, family FROM ${prefix}_annotation WHERE document_id = ?`).all(command.id);
      const pureAnnotations = annotations.map(a => ({ id: a.id, family: a.family }));

      let membershipResult;
      try {
        membershipResult = mergeBlocksMemberships(
          family, pureAnnotations, pureMemberships, leftBlockId, rightBlockId,
        );
      } catch (error) {
        throw new ValidationError(`${name}.${fieldName}.operation ${error.message}`);
      }

      const affectedAnnotationIds = new Set(pureMemberships.filter(m => m.blockId === leftBlockId || m.blockId === rightBlockId).map(m => m.annotationId));

      const measurementFacts = [];
      if (measurementFamilyList.length > 0) {
        const leftMeasurements = db.prepare(`SELECT id, family, format_version, payload FROM ${prefix}_measurement WHERE block_id = ? ORDER BY family`).all(leftBlockId);
        const rightMeasurements = db.prepare(`SELECT id, family, format_version, payload FROM ${prefix}_measurement WHERE block_id = ? ORDER BY family`).all(rightBlockId);

        const leftByFamily = {};
        for (const row of leftMeasurements) leftByFamily[row.family] = row;
        const rightByFamily = {};
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

          const validatePayload = (payload, blockText) => {
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

    const r4Handler = ({ payload, db, scope, principal }) => {
      const command = assertDocumentScope({ payload, scope, db, internal: true });
      const documentScope = owningDocumentScope(db, command.id);
      const state = db.prepare(`SELECT structure_version, family_checkpoint FROM ${prefix}_state WHERE document_id = ?`).get(command.id);
      if (!state) throw new ValidationError(`${name}.${fieldName}.operation document does not exist`);
      const family = restoreTextFamilyCheckpoint(JSON.parse(state.family_checkpoint));
      if (state.structure_version !== command.expected.structuralRevision ||
          JSON.stringify(family.checkpoint.frontier) !== JSON.stringify(command.expected.frontier)) {
        throw new ValidationError(`${name}.${fieldName}.operation conflicts with the current structural revision or frontier`);
      }

      const { blockId, startUtf16Offset, endUtf16Offset } = command.operation.selection;
      const annInput = command.operation.annotation;

      let blockText;
      try {
        blockText = materializeBlock(family, blockId);
      } catch (error) {
        throw new ValidationError(`${name}.${fieldName}.operation ${error.message}`);
      }
      if (startUtf16Offset < 0 || endUtf16Offset > blockText.length || startUtf16Offset >= endUtf16Offset) {
        throw new ValidationError(`${name}.${fieldName}.operation invalid selection offsets`);
      }

      const compiledMeta = getAnnotatedTextCompiledMetadata(descriptor);
      const annotationFamilyMeta = compiledMeta.annotationFields[annInput.family];
      const annotationDescriptor = descriptor.annotations.find((entry) => entry.annotationName === annInput.family);
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

      const familyFieldDescs = annotationDescriptor.fields;
      const canonicalFields = { ...annInput.fields };
      for (const [key, desc] of Object.entries(familyFieldDescs)) {
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

      const needsLeftSplit = startUtf16Offset > 0;
      const needsRightSplit = endUtf16Offset < blockText.length;

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
      let pureMemberships = sourceMemberships.map(m => ({
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
      let pureAnnotations = annotationRows.map(a => ({ id: a.id, family: a.family, protectedTargetIds: targetsByAnnotation.get(a.id) ?? [] }));

      const blockFields = Object.keys(descriptor.block ?? {});
      const blockFacts = [];
      const storedBlockById = new Map();
      const sourceStoredBlock = db.prepare(`SELECT * FROM ${prefix}_block WHERE id = ?`).get(blockId);
      if (!sourceStoredBlock) throw new ValidationError(`${name}.${fieldName}.operation source block not found`);
      storedBlockById.set(blockId, sourceStoredBlock);

      const readMeasurements = (bid) => {
        if (measurementFamilyList.length === 0) return [];
        return db.prepare(`SELECT id, family, format_version, payload FROM ${prefix}_measurement WHERE block_id = ? ORDER BY family`).all(bid);
      };

      let measurementState = null;
      const sourceMeas = readMeasurements(blockId);
      if (sourceMeas.length > 0 && (needsLeftSplit || needsRightSplit)) {
        measurementState = { [blockId]: sourceMeas };
      }

      const partitionMeasurements = (sourceBlockId, newBlockId, offset, familyAtSplit, splitFamily) => {
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
          const validatePayload = (payload, blockText) => {
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

      if (needsLeftSplit) {
        const newBlockId = randomUUID();
        let splitResult;
        try { splitResult = splitBlock(currentFamily, blockId, newBlockId, startUtf16Offset); } catch (error) { throw new ValidationError(`${name}.${fieldName}.operation ${error.message}`); }
        if (splitResult.type === 'unchanged') throw new ValidationError(`${name}.${fieldName}.operation split at start offset returned unchanged`);
        let membershipResult;
        try { membershipResult = splitBlockMemberships(splitResult.family, pureAnnotations, pureMemberships, blockId, newBlockId); } catch (error) { throw new ValidationError(`${name}.${fieldName}.operation ${error.message}`); }
        pureAnnotations = membershipResult.annotations;
        pureMemberships = membershipResult.memberships;

        const leftBlockStored = storedBlockById.get(blockId);
        if (!leftBlockStored) throw new ValidationError(`${name}.${fieldName}.operation source block not found`);
        const leftBlockCells = {};
        for (const bf of blockFields) { const bd = descriptor.block[bf]; leftBlockCells[bf] = deserializeField(bd, leftBlockStored[bf]); }
        const rightBlockCells = {};
        for (const bf of blockFields) { const bd = descriptor.block[bf]; rightBlockCells[bf] = deserializeField(bd, leftBlockStored[bf]); }
        blockFacts.push(Object.freeze({ id: blockId, epoch: leftBlockStored.epoch, fields: Object.freeze(leftBlockCells) }));
        blockFacts.push(Object.freeze({ id: newBlockId, epoch: leftBlockStored.epoch, fields: Object.freeze(rightBlockCells) }));
        storedBlockById.set(newBlockId, leftBlockStored);

        partitionMeasurements(blockId, newBlockId, startUtf16Offset, currentFamily, splitResult.family);

        currentFamily = splitResult.family;
        splitBlockIds.push(newBlockId);
        splitOps.push({ blockId, newBlockId, utf16Offset: startUtf16Offset });
        selectedBlockId = newBlockId;
      }

      if (needsRightSplit) {
        const newBlockId = randomUUID();
        const adjustedOffset = needsLeftSplit ? endUtf16Offset - startUtf16Offset : endUtf16Offset;
        let splitResult;
        try { splitResult = splitBlock(currentFamily, selectedBlockId, newBlockId, adjustedOffset); } catch (error) { throw new ValidationError(`${name}.${fieldName}.operation ${error.message}`); }
        if (splitResult.type === 'unchanged') throw new ValidationError(`${name}.${fieldName}.operation split at end offset returned unchanged`);
        let membershipResult;
        try { membershipResult = splitBlockMemberships(splitResult.family, pureAnnotations, pureMemberships, selectedBlockId, newBlockId); } catch (error) { throw new ValidationError(`${name}.${fieldName}.operation ${error.message}`); }
        pureAnnotations = membershipResult.annotations;
        pureMemberships = membershipResult.memberships;

        const sourceBlockStored = storedBlockById.get(selectedBlockId);
        if (!sourceBlockStored) throw new ValidationError(`${name}.${fieldName}.operation source block not found`);
        const leftBlockCells = {};
        for (const bf of blockFields) { const bd = descriptor.block[bf]; leftBlockCells[bf] = deserializeField(bd, sourceBlockStored[bf]); }
        const rightBlockCells = {};
        for (const bf of blockFields) { const bd = descriptor.block[bf]; rightBlockCells[bf] = deserializeField(bd, sourceBlockStored[bf]); }
        blockFacts.push(Object.freeze({ id: selectedBlockId, epoch: sourceBlockStored.epoch, fields: Object.freeze(leftBlockCells) }));
        blockFacts.push(Object.freeze({ id: newBlockId, epoch: sourceBlockStored.epoch, fields: Object.freeze(rightBlockCells) }));
        storedBlockById.set(newBlockId, sourceBlockStored);

        partitionMeasurements(selectedBlockId, newBlockId, adjustedOffset, currentFamily, splitResult.family);

        currentFamily = splitResult.family;
        splitBlockIds.push(newBlockId);
        splitOps.push({ blockId: selectedBlockId, newBlockId, utf16Offset: adjustedOffset });
      }

      const anySplit = needsLeftSplit || needsRightSplit;
      if (anySplit) afterRevision = state.structure_version + 1;

      const basisFrontier = currentFamily.checkpoint.frontier;
      const selectedBlockText = materializeBlock(currentFamily, selectedBlockId);
      let startEndpoint;
      let endEndpoint;
      try {
        startEndpoint = resolvePositionToEndpoint(currentFamily, selectedBlockId, 0, basisFrontier);
        endEndpoint = resolvePositionToEndpoint(currentFamily, selectedBlockId, selectedBlockText.length, basisFrontier);
      } catch (error) {
        throw new ValidationError(`${name}.${fieldName}.operation ${error.message}`);
      }

      const annotationVirtual = { id: annInput.id, family: annInput.family, protectedTargetIds };
      const virtualAnnotations = [...pureAnnotations, annotationVirtual];
      let addMembershipResult;
      try {
        addMembershipResult = addMembership(currentFamily, virtualAnnotations, pureMemberships, annInput.id, selectedBlockId, startEndpoint, endEndpoint);
      } catch (error) {
        throw new ValidationError(`${name}.${fieldName}.operation ${error.message}`);
      }

      const affectedAnnotationIds = new Set(sourceMemberships.filter(m => m.block_id === blockId).map(m => m.annotation_id));
      if (needsRightSplit) {
        for (const m of sourceMemberships) {
          if (m.block_id === (needsLeftSplit ? splitBlockIds[0] : blockId)) affectedAnnotationIds.add(m.annotation_id);
        }
      }
      const membershipFacts = addMembershipResult.memberships.filter(m => m.annotationId === annInput.id || affectedAnnotationIds.has(m.annotationId)).map(m => ({
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
          version: 4,
          id: command.id,
          actorId,
          before: Object.freeze({ structuralRevision: state.structure_version, frontier: family.checkpoint.frontier }),
          operation: Object.freeze({
            kind: 'annotation.apply',
            selection: { blockId, startUtf16Offset, endUtf16Offset },
            annotation: Object.freeze({ id: annInput.id, family: annInput.family, fields: Object.freeze(canonicalFields), ...(protectedTargetIds.length ? { protectedTargetIds: Object.freeze([...protectedTargetIds]) } : {}) }),
          }),
          after: Object.freeze({ structuralRevision: afterRevision, frontier: family.checkpoint.frontier }),
          family: textFamilyCheckpoint(currentFamily),
          annotation: Object.freeze({ id: annInput.id, family: annInput.family, fields: Object.freeze(canonicalFields), ...(protectedTargetIds.length ? { protectedTargetIds: Object.freeze([...protectedTargetIds]) } : {}) }),
          splitBlockIds: Object.freeze([...splitBlockIds]),
          selectedBlockId,
          splitOps: Object.freeze(splitOps),
          blocks: Object.freeze(blockFacts),
          memberships: Object.freeze(membershipFacts),
          measurements: Object.freeze(allMeasurementFacts),
        }),
      }];
    };

    const r5Handler = ({ payload, db, scope }) => {
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
      const memberships = sourceMemberships.map((membership) => ({
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
      const annotations = annotationRows.map((annotation) => {
        const metadata = compiledMeta.annotationHandles[annotation.family];
        if (!metadata) throw new ValidationError(`${name}.${fieldName}.operation unknown annotation family '${annotation.family}'`);
        return { id: annotation.id, family: annotation.family, empty: metadata.empty, protectedTargetIds: targetsByAnnotation.get(annotation.id) ?? [] };
      });
      const targetAnnotation = annotations.find((annotation) => annotation.id === command.operation.annotationId);
      if (!targetAnnotation) throw new ValidationError(`${name}.${fieldName}.operation annotation not found`);
      let reduced;
      try {
        reduced = removeMembership(family, annotations, memberships, command.operation.annotationId, command.operation.blockId, { structuralRevision: state.structure_version });
      } catch (error) {
        throw new ValidationError(`${name}.${fieldName}.operation ${error.message}`);
      }
      const outcome = reduced.outcomes[0];
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

    const handler = ({ payload, db, scope, principal, actionId, history }) => {
      if (history?.input?.kind === 'annotated-text.restore') {
        const command = assertV9AnnotatedTextOffsetEditPayload(name, fieldName, payload);
        const handle = eventHandles.native(name, fieldName, 'operated');
        return {
          events: [Object.freeze({ handle, type: handle.type, scope, data: Object.freeze({ version: 8, id: command.id, operation: Object.freeze({ kind: 'history.restore' }) }) })],
          privateFact: { before: history.input.expected, after: history.input.target },
        };
      }
      const command = payload.version === 9 ? assertV9AnnotatedTextOffsetEditPayload(name, fieldName, payload) : null;
      const before = command ? annotatedTextHistoryImage({ db, prefix, documentId: command.id, metadata: compiledMeta }) : null;
      return Promise.resolve(r1Handler({ payload, db, scope, principal, actionId })).then((events) => {
        if (payload.version !== 9) return events;
        return {
          events,
          privateFact: { before, after: before },
          authoringReceipt: ({ db: receiptDb, confirmedThrough }) => {
            const splits = receiptDb.prepare(`SELECT temporary_block, authoritative_block_id, position_token FROM ${prefix}_authoring_split WHERE lease_id = ? AND action_id = ? AND mutation_id = ? ORDER BY temporary_block`).all(command.authoring.lease, actionId, command.authoring.mutationId);
            return Object.freeze({ version: 1, actionId, confirmedThrough, authoring: Object.freeze({
              version: 1, stream: command.authoring.stream, lease: command.authoring.lease, acknowledgementFence: confirmedThrough,
              positionFrames: Object.freeze(splits.map((split) => Object.freeze({ temporaryBlock: split.temporary_block, positionToken: split.position_token }))),
              splitResolutions: Object.freeze(splits.map((split) => Object.freeze({ temporaryBlock: split.temporary_block, blockId: split.authoritative_block_id }))),
            }) });
          },
        };
      });
    };
    Object.defineProperty(handler, 'inTransaction', { value: true });
    Object.defineProperty(handler, ANNOTATED_HISTORY_COMPLETION, { value: ({ db, actionId, scope, payload, result, history }) => {
      if (history?.handlerInputs) return;
      if (!Array.isArray(result?.events ?? result) || (result?.events ?? result).length === 0) return;
      const factRow = db.prepare('SELECT fact FROM _PrivateActionFact WHERE scope = ? AND actionId = ?').get(scope, actionId);
      if (!factRow) throw new TypeError('annotated history private fact was not persisted');
      const fact = JSON.parse(factRow.fact);
      const after = annotatedTextHistoryImage({ db, prefix: `${name}_${fieldName}`, documentId: payload.id, metadata: compiledMeta });
      db.prepare('UPDATE _PrivateActionFact SET fact = ? WHERE scope = ? AND actionId = ?').run(JSON.stringify({ ...fact, after }), scope, actionId);
    }});
    Object.defineProperty(handler, 'batchForbidden', { value: true });
    Object.defineProperty(handler, 'preDedupe', { value: ({ payload, scope, db, principal, history }) => {
      const command = assertDocumentScope({ payload, scope, db });
      if (command.version === 9 && history?.input?.kind !== 'annotated-text.restore') assertV9AuthoringBinding({ command, db, principal });
    }});
    Object.defineProperty(handler, 'dedupeReceiptMatches', { value: (receipt, request) =>
      receipt.actionType === operationType && receipt.actionData === JSON.stringify(request.payload) });
    handlers[operationType] = handler;
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

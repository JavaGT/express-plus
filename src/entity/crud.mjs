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

export const CRUD_CURSOR_POLICY = Symbol('workbench.crud-cursor-policy');

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

function assertAnnotatedTextOffsetEditPayload(name, fieldName, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length !== 5 ||
      (payload.version !== 6 && payload.version !== 7) || typeof payload.id !== 'string' || payload.id.length === 0 ||
      typeof payload.basis !== 'string' || payload.basis.length === 0 || typeof payload.mutationId !== 'string' || payload.mutationId.length === 0 ||
      !payload.edit || typeof payload.edit !== 'object' || Array.isArray(payload.edit)) {
    throw new ValidationError(`${name}.${fieldName}.operation requires version 6 { id, basis, mutationId, edit }`);
  }
  const position = (value, label) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2 ||
        typeof value.blockId !== 'string' || value.blockId.length === 0 || !Number.isSafeInteger(value.offset) || value.offset < 0) {
      throw new ValidationError(`${name}.${fieldName}.operation ${label} requires { blockId, offset }`);
    }
    return Object.freeze({ blockId: value.blockId, offset: value.offset });
  };
  let edit;
  if (payload.edit.kind === 'text.insert' && Object.keys(payload.edit).length === 3 && typeof payload.edit.text === 'string' && payload.edit.text.length > 0) {
    try { assertWellFormedText(payload.edit.text); } catch (error) { throw new ValidationError(`${name}.${fieldName}.operation inserted text ${error.message}`); }
    edit = Object.freeze({ kind: 'text.insert', at: position(payload.edit.at, 'insert position'), text: payload.edit.text });
  } else if (payload.edit.kind === 'text.delete' && Object.keys(payload.edit).length === 3) {
    edit = Object.freeze({ kind: 'text.delete', from: position(payload.edit.from, 'delete start'), to: position(payload.edit.to, 'delete end') });
  } else if (payload.version === 7 && payload.edit.kind === 'block.split' && Object.keys(payload.edit).length === 2) {
    edit = Object.freeze({ kind: 'block.split', at: position(payload.edit.at, 'split position') });
  } else if (payload.version === 7 && payload.edit.kind === 'block.merge' && Object.keys(payload.edit).length === 3 && typeof payload.edit.leftBlockId === 'string' && payload.edit.leftBlockId && typeof payload.edit.rightBlockId === 'string' && payload.edit.rightBlockId) {
    edit = Object.freeze({ kind: 'block.merge', leftBlockId: payload.edit.leftBlockId, rightBlockId: payload.edit.rightBlockId });
  } else if (payload.version === 7 && payload.edit.kind === 'annotation.apply' && Object.keys(payload.edit).length === 4 && payload.edit.annotation && typeof payload.edit.annotation === 'object') {
    edit = Object.freeze({ kind: 'annotation.apply', annotation: frozenJsonSnapshot(payload.edit.annotation), from: position(payload.edit.from, 'annotation start'), to: position(payload.edit.to, 'annotation end') });
  } else if (payload.version === 7 && payload.edit.kind === 'annotation.detach' && Object.keys(payload.edit).length === 3 && typeof payload.edit.annotationId === 'string' && payload.edit.annotationId && typeof payload.edit.blockId === 'string' && payload.edit.blockId) {
    edit = Object.freeze({ kind: 'annotation.detach', annotationId: payload.edit.annotationId, blockId: payload.edit.blockId });
  } else {
    throw new ValidationError(`${name}.${fieldName}.operation edit is not supported`);
  }
  return Object.freeze({ version: payload.version, id: payload.id, basis: payload.basis, mutationId: payload.mutationId, edit });
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

export function createCrudHandlers({ record, sideTableStrategyEntries, conditionalHistory = false }) {
  const { name, fields, verbs } = record;
  const ownerField = ownerFieldOf({ name, fields });

  const handlers = {
    [`${name}.create`]: ({ payload, principal }) => {
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
      return [{
        handle: verbs.created.handle,
        type: verbs.created.type,
        scope: Object.values(fields).some((descriptor) => descriptor.kind === 'annotatedText')
          ? resolveAnnotatedTextOwningScope(Object.values(fields).find((descriptor) => descriptor.kind === 'annotatedText'), fields, data).key
          : scopeOf(name, id).key,
        data,
      }];
    },
    [`${name}.update`]: ({ payload, principal: _p, db, history }) => {
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
        return { events: [{ handle: verbs.updated.handle, type: verbs.updated.type, scope: scopeOf(name, id).key, data: { ...data, id } }], privateFact: { before: expected, after: replacement } };
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
      const result = [{
        handle: verbs.updated.handle,
        type: verbs.updated.type,
        scope: annotatedEntries.length > 0
          ? resolveAnnotatedTextOwningScope(annotatedEntries[0][1], fields, db.prepare(`SELECT * FROM ${name} WHERE id = ?`).get(id) ?? {}).key
          : scopeOf(name, id).key,
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
    [`${name}.remove`]: ({ payload, principal, db }) => {
      if (!payload.id) throw Object.assign(new Error('remove requires an id'), { status: 400 });
      if (record.removalCascade) {
        return record.removalCascade(payload.id, principal, db)
          .then((rows) => rows.map(({ entity, id }) => entity.removedEvent(id, db)));
      }
      return [{
        handle: verbs.removed.handle,
        type: verbs.removed.type,
        scope: annotatedEntries.length > 0
          ? resolveAnnotatedTextOwningScope(annotatedEntries[0][1], fields, db.prepare(`SELECT * FROM ${name} WHERE id = ?`).get(payload.id) ?? {}).key
          : scopeOf(name, payload.id).key,
        data: { id: payload.id },
      }];
    },
  };
  const cursorPolicy = {};
  const annotatedEntries = Object.entries(fields).filter(([, descriptor]) => descriptor.kind === 'annotatedText');
  if (conditionalHistory) {
    Object.defineProperty(handlers[`${name}.update`], 'inTransaction', { value: true });
  }
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

    const assertDocumentScope = ({ payload, scope, db }) => {
      let command;
      if (payload.version === 1) {
        command = assertAnnotatedTextOperationPayload(name, fieldName, payload);
      } else if (payload.version === 2) {
        command = assertR2BlockSplitPayload(name, fieldName, payload);
      } else if (payload.version === 3) {
        command = assertR3BlockMergePayload(name, fieldName, payload);
      } else if (payload.version === 4) {
        command = assertR4AnnotationApplyPayload(name, fieldName, payload);
      } else if (payload.version === 5) {
        command = assertR5AnnotationDetachPayload(name, fieldName, payload);
      } else {
        throw new ValidationError(`${name}.${fieldName}.operation requires version 1, 2, 3, 4, or 5`);
      }
      const row = db.prepare(`SELECT * FROM ${name} WHERE id = ?`).get(command.id);
      if (!row) throw new ValidationError(`${name}.${fieldName}.operation document does not exist`);
      const documentScope = resolveAnnotatedTextOwningScope(descriptor, fields, row).key;
      if (scope !== documentScope) {
        throw new ValidationError(`${name}.${fieldName}.operation requires document scope '${documentScope}'`);
      }
      return command;
    };

    const r1Handler = async ({ payload, db, scope, principal }) => {
      if (payload.version === 6 || payload.version === 7) {
        const command = assertAnnotatedTextOffsetEditPayload(name, fieldName, payload);
        const row = db.prepare(`SELECT * FROM ${name} WHERE id = ?`).get(command.id);
        if (!row) throw new ValidationError(`${name}.${fieldName}.operation document does not exist`);
        const documentScope = resolveAnnotatedTextOwningScope(descriptor, fields, row).key;
        if (scope !== documentScope) throw new ValidationError(`${name}.${fieldName}.operation requires document scope '${documentScope}'`);
        const basis = db.prepare(`SELECT structural_revision, family_checkpoint, visible_blocks FROM ${prefix}_basis WHERE token = ? AND document_id = ? AND principal_id = ?`).get(command.basis, command.id, principal?.id ?? '');
        if (!basis) throw new ValidationError(`${name}.${fieldName}.operation basis is unavailable`);
        const visibleBlocks = new Set(JSON.parse(basis.visible_blocks));
        const referencedBlocks = command.edit.kind === 'text.insert' || command.edit.kind === 'block.split' ? [command.edit.at.blockId]
          : command.edit.kind === 'text.delete' || command.edit.kind === 'annotation.apply' ? [command.edit.from.blockId, command.edit.to.blockId]
            : command.edit.kind === 'block.merge' ? [command.edit.leftBlockId, command.edit.rightBlockId] : [command.edit.blockId];
        if (referencedBlocks.some((blockId) => !visibleBlocks.has(blockId))) {
          throw new ValidationError(`${name}.${fieldName}.operation basis does not permit the requested block`);
        }
        const state = db.prepare(`SELECT structure_version, family_checkpoint FROM ${prefix}_state WHERE document_id = ?`).get(command.id);
        if (!state) throw new ValidationError(`${name}.${fieldName}.operation document does not exist`);
        await authorizeFieldOp(record, fieldName, write, row, principal);
        const currentRecipient = await projectAnnotatedTextSnapshot({ db, entity: record, row, principal, fieldName, descriptor, mintBasis: false });
        const currentVisible = new Set(currentRecipient.blocks.filter((block) => block.kind === 'visible').map((block) => block.id));
        if (referencedBlocks.some((blockId) => !currentVisible.has(blockId))) {
          throw new ValidationError(`${name}.${fieldName}.operation is not currently visible to this recipient`);
        }
        if (state.structure_version !== basis.structural_revision) throw new ValidationError(`${name}.${fieldName}.operation conflicts with the basis structural revision`);
        const basedFamily = restoreTextFamilyCheckpoint(JSON.parse(basis.family_checkpoint));
        const family = restoreTextFamilyCheckpoint(JSON.parse(state.family_checkpoint));
        if (!frontierDominates(family.checkpoint.frontier, basedFamily.checkpoint.frontier)) throw new ValidationError(`${name}.${fieldName}.operation basis is not dominated by current state`);
        if (command.version === 7 && command.edit.kind !== 'text.insert' && command.edit.kind !== 'text.delete') {
          const expected = Object.freeze({ structuralRevision: state.structure_version, frontier: family.checkpoint.frontier });
          const offset = (point) => {
            const endpoint = resolvePositionToEndpoint(basedFamily, point.blockId, point.offset, basedFamily.checkpoint.frontier);
            // The anchor/affinity names the semantic basis position. Current
            // projection evaluates that stable point in the dominated family;
            // only its observation frontier advances.
            return projectEndpointToBlockOffset(family, point.blockId, Object.freeze({ ...endpoint, basisFrontier: family.checkpoint.frontier }));
          };
          if (command.edit.kind === 'block.split') return r2Handler({ payload: { version: 2, id: command.id, expected, operation: { kind: 'block.split', blockId: command.edit.at.blockId, utf16Offset: offset(command.edit.at) } }, db, scope });
          if (command.edit.kind === 'block.merge') return r3Handler({ payload: { version: 3, id: command.id, expected, operation: command.edit }, db, scope });
          if (command.edit.kind === 'annotation.apply') {
            if (command.edit.from.blockId !== command.edit.to.blockId) throw new ValidationError(`${name}.${fieldName}.operation annotation range must remain in one block`);
            return r4Handler({ payload: { version: 4, id: command.id, expected, operation: { kind: 'annotation.apply', annotation: command.edit.annotation, selection: { blockId: command.edit.from.blockId, startUtf16Offset: offset(command.edit.from), endUtf16Offset: offset(command.edit.to) } } }, db, scope });
          }
          return r5Handler({ payload: { version: 5, id: command.id, expected, operation: command.edit }, db, scope });
        }
        const actor = createHash('sha256').update(`${name}\u0000${fieldName}\u0000${command.id}\u0000${principal?.id ?? ''}\u0000${command.mutationId}`).digest('hex').slice(0, 32);
        const lamport = Math.max(0, ...Object.values(basedFamily.checkpoint.elements).map((element) => element.lamport)) + 1;
        let operation;
        try { operation = textOperationForOffsetEdit(basedFamily, command.edit, actor, lamport); } catch (error) {
          throw new ValidationError(`${name}.${fieldName}.operation ${error.message}`);
        }
        let nextFamily;
        try { nextFamily = applyTextOperationToBlock(family, command.edit.kind === 'text.insert' ? command.edit.at.blockId : command.edit.from.blockId, operation); } catch (error) {
          throw new ValidationError(`${name}.${fieldName}.operation ${error.message}`);
        }
        const handle = eventHandles.native(name, fieldName, 'operated');
        return [{ handle, type: handle.type, scope: documentScope, data: Object.freeze({ version: 1, id: command.id, before: Object.freeze({ structuralRevision: state.structure_version, frontier: family.checkpoint.frontier }), operation: Object.freeze({ kind: 'text.apply', blockId: command.edit.kind === 'text.insert' ? command.edit.at.blockId : command.edit.from.blockId, operation }), after: Object.freeze({ structuralRevision: state.structure_version, frontier: nextFamily.checkpoint.frontier }), family: textFamilyCheckpoint(nextFamily) }) }];
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

    const r2Handler = ({ payload, db, scope }) => {
      const command = assertDocumentScope({ payload, scope, db });
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

      const handle = eventHandles.native(name, fieldName, 'operated');
      return [{
        handle,
        type: handle.type,
        scope: documentScope,
        data: Object.freeze({
          version: 2,
          id: command.id,
          before: Object.freeze({ structuralRevision: state.structure_version, frontier: family.checkpoint.frontier }),
          operation: Object.freeze({
            kind: 'block.split',
            leftBlockId: blockId,
            rightBlockId: newBlockId,
            utf16Offset,
          }),
          after: Object.freeze({ structuralRevision: afterRevision, frontier: family.checkpoint.frontier }),
          family: textFamilyCheckpoint(splitResult.family),
          blocks: cleanBlocks,
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

    const r3Handler = ({ payload, db, scope }) => {
      const command = assertDocumentScope({ payload, scope, db });
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

    const r4Handler = ({ payload, db, scope }) => {
      const command = assertDocumentScope({ payload, scope, db });
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
      return [{
        handle,
        type: handle.type,
        scope: documentScope,
        data: Object.freeze({
          version: 4,
          id: command.id,
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
      const command = assertDocumentScope({ payload, scope, db });
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

    const handler = ({ payload, db, scope, principal }) => {
      if (payload.version === 1 || payload.version === 6 || payload.version === 7) return r1Handler({ payload, db, scope, principal });
      if (payload.version === 2) return r2Handler({ payload, db, scope });
      if (payload.version === 3) return r3Handler({ payload, db, scope });
      if (payload.version === 4) return r4Handler({ payload, db, scope });
      return r5Handler({ payload, db, scope });
    };
    Object.defineProperty(handler, 'inTransaction', { value: true });
    Object.defineProperty(handler, 'batchForbidden', { value: true });
    Object.defineProperty(handler, 'preDedupe', { value: ({ payload, scope, db }) => payload.version === 6 || payload.version === 7
      ? (() => {
        const command = assertAnnotatedTextOffsetEditPayload(name, fieldName, payload);
        const documentScope = owningDocumentScope(db, command.id);
        if (scope !== documentScope) throw new ValidationError(`${name}.${fieldName}.operation requires document scope '${documentScope}'`);
        return command;
      })()
      : assertDocumentScope({ payload, scope, db }) });
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

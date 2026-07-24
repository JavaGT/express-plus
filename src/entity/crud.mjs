// Entity CRUD handler generation — the mutation handlers for create, update,
// and remove, extracted from the entity compiler so the compiler stays focused
// on validation and assembly, not handler bodies.
//
// createCrudHandlers builds the { `${name}.create`, `${name}.update`,
// `${name}.remove` } handlers that turn an authorized action payload into
// emitted lifecycle events. Side-table mutation handlers (map.add, log.append,
// etc.) are delegated to the side-table strategy, keeping the CRUD generator
// focused on the entity-row lifecycle.

import { randomUUID } from 'node:crypto';
import { validateMaterializedField, validateMutation, ValidationError } from '../field-strategy.mjs';
import { scopeOf } from '../scope-handle.mjs';
import * as eventHandles from '../event-handle.mjs';
import { canonicalTextOp } from '../annotated-text.mjs';
import { applyTextOperationToBlock, restoreTextFamilyCheckpoint, textFamilyCheckpoint } from '../annotated-text-family.mjs';

export const CRUD_CURSOR_POLICY = Symbol('workbench.crud-cursor-policy');

function assertAnnotatedTextOperationPayload(name, fieldName, payload) {
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

export function materializeCreateDefaults(record, payload) {
  const data = { ...payload };
  for (const [fieldName, descriptor] of Object.entries(record.fields)) {
    if (!(fieldName in data) && descriptor.default !== undefined) {
      data[fieldName] = materializeDefault(descriptor.default);
      validateMaterializedField(record, fieldName, data[fieldName]);
    }
  }
  return data;
}

export function createCrudHandlers({ record, sideTableStrategyEntries }) {
  const { name, fields, verbs } = record;
  const ownerField = ownerFieldOf({ name, fields });

  const handlers = {
    [`${name}.create`]: ({ payload, principal }) => {
      if (Object.hasOwn(payload, '__workbench')) {
        throw new ValidationError(`${name}.__workbench is reserved for framework event metadata`);
      }
      const { id: requestedId, ...fieldsPayload } = payload;
      for (const [fieldName, descriptor] of Object.entries(fields)) {
        if (descriptor.kind === 'annotatedText' && Object.hasOwn(fieldsPayload, fieldName)) {
          throw new ValidationError(`${name}.${fieldName} is an annotated-text field and cannot be set through create payloads`);
        }
        if (descriptor.kind === 'crdt' && descriptor.type === 'text' && fieldName in fieldsPayload) {
          throw new ValidationError(`${name}.${fieldName} accepts native operations only; create the row then dispatch ${name}.${fieldName}.apply`);
        }
      }
      validateMutation(record, fieldsPayload);
      if (requestedId !== undefined && (typeof requestedId !== 'string' || requestedId.length === 0)) {
        throw new ValidationError(`${name}.id: expected a non-empty text id`);
      }
      const id = requestedId ?? randomUUID();
      const data = materializeCreateDefaults(record, { ...fieldsPayload, id });
      if (ownerField) data[ownerField] = principal?.id;
      const annotatedText = Object.fromEntries(
        Object.entries(fields)
          .filter(([, descriptor]) => descriptor.kind === 'annotatedText')
          .map(([fieldName]) => [fieldName, Object.freeze({ initialBlockId: randomUUID() })]),
      );
      if (Object.keys(annotatedText).length > 0) {
        data.__workbench = Object.freeze({ annotatedText: Object.freeze(annotatedText) });
      }
      return [{
        handle: verbs.created.handle,
        type: verbs.created.type,
        scope: scopeOf(name, id).key,
        data,
      }];
    },
    [`${name}.update`]: ({ payload, principal: _p }) => {
      const { id, ...rest } = payload;
      if (!id) throw Object.assign(new Error('update requires an id'), { status: 400 });
      if (Object.keys(rest).length === 0) {
        throw new ValidationError(`${name}.update requires at least one field to change`);
      }
      for (const fieldName of Object.keys(rest)) {
        if (fields[fieldName]?.kind === 'annotatedText') {
          throw new ValidationError(`${name}.${fieldName} is an annotated-text field and cannot be set through update payloads`);
        }
        if (fields[fieldName]?.immutable === true) {
          throw new ValidationError(`${name}.${fieldName} is immutable: a client may set it on create but may not change it.`);
        }
      }
      validateMutation(record, rest);
      const stateTransitions = [];
      // Transition guard: for every state field in the payload, pre-read the
      // current row and verify the move is in the declared transition graph.
      // Runs after structural validation so invalid targets report as domain
      // errors before transition errors (clearer diagnostic order).
      for (const [fieldName, descriptor] of Object.entries(fields)) {
        if (descriptor.kind !== 'state') continue;
        if (!(fieldName in rest)) continue;
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
              `${name}.${fieldName}: illegal transition (no current state) -> ${rest[fieldName]}`,
            ),
            { status: 400 },
          );
        }
        const currentValue = current[fieldName];
        if (currentValue === rest[fieldName]) continue; // no-op, skip check
        const legalTargets = descriptor.transitions[currentValue];
        if (!legalTargets || !legalTargets.includes(rest[fieldName])) {
          throw Object.assign(
            new ValidationError(
              `${name}.${fieldName}: illegal transition ${currentValue} -> ${rest[fieldName]}`,
            ),
            { status: 400 },
          );
        }
        stateTransitions.push({ fieldName, from: currentValue, to: rest[fieldName] });
      }
      const data = { ...rest, id };
      for (const [fieldName, descriptor] of Object.entries(fields)) {
        if (descriptor.touch) data[fieldName] = new Date();
      }
      return [{
        handle: verbs.updated.handle,
        type: verbs.updated.type,
        scope: scopeOf(name, id).key,
        data,
        ...(stateTransitions.length > 0 ? { _stateTransitions: stateTransitions } : {}),
      }];
    },
    [`${name}.remove`]: ({ payload, principal: _p }) => {
      if (!payload.id) throw Object.assign(new Error('remove requires an id'), { status: 400 });
      return [{
        handle: verbs.removed.handle,
        type: verbs.removed.type,
        scope: scopeOf(name, payload.id).key,
        data: { id: payload.id },
      }];
    },
  };
  const cursorPolicy = {};

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
    const assertDocumentScope = ({ payload, scope }) => {
      const command = assertAnnotatedTextOperationPayload(name, fieldName, payload);
      const documentScope = scopeOf(name, command.id).key;
      if (scope !== documentScope) {
        throw new ValidationError(`${name}.${fieldName}.operation requires document scope '${documentScope}'`);
      }
      return command;
    };
    const handler = ({ payload, db, scope }) => {
      const command = assertDocumentScope({ payload, scope });
      const documentScope = scopeOf(name, command.id).key;
      const prefix = `${name}_${fieldName}`;
      const state = db.prepare(`SELECT structure_version, family_checkpoint FROM ${prefix}_state WHERE document_id = ?`).get(command.id);
      if (!state) throw new ValidationError(`${name}.${fieldName}.operation document does not exist`);
      const family = restoreTextFamilyCheckpoint(JSON.parse(state.family_checkpoint));
      if (state.structure_version !== command.expected.structuralRevision ||
          JSON.stringify(family.checkpoint.frontier) !== JSON.stringify(command.expected.frontier)) {
        throw new ValidationError(`${name}.${fieldName}.operation conflicts with the current structural revision or frontier`);
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
    Object.defineProperty(handler, 'inTransaction', { value: true });
    Object.defineProperty(handler, 'batchForbidden', { value: true });
    Object.defineProperty(handler, 'preDedupe', { value: assertDocumentScope });
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

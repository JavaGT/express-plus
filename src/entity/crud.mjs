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
import { validateMaterializedField, validateMutation, ValidationError, deserializeField } from '../field-strategy.mjs';
import { scopeOf } from '../scope-handle.mjs';
import * as eventHandles from '../event-handle.mjs';
import { canonicalTextOp } from '../annotated-text.mjs';
import { applyTextOperationToBlock, restoreTextFamilyCheckpoint, splitBlock, mergeBlocks, materializeBlock, textFamilyCheckpoint } from '../annotated-text-family.mjs';
import { splitBlockMemberships, mergeBlocksMemberships } from '../annotated-text-membership.mjs';
import { getAnnotatedTextCompiledMetadata, resolveDeclarationMeasurementExtension } from '../annotated-text-field.mjs';
import { assertR2BlockSplitPayload, frozenJsonSnapshot } from '../annotated-text-r2.mjs';
import { assertR3BlockMergePayload, canonicalJsonEqual } from '../annotated-text-r3.mjs';

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
    const prefix = `${name}_${fieldName}`;
    const compiledMeta = getAnnotatedTextCompiledMetadata(descriptor);
    const measurementConfigs = compiledMeta?.measurementConfigs ?? {};
    const measurementFamilyList = compiledMeta?.measurementFamilyList ?? [];

    const assertDocumentScope = ({ payload, scope }) => {
      let command;
      if (payload.version === 1) {
        command = assertAnnotatedTextOperationPayload(name, fieldName, payload);
      } else if (payload.version === 2) {
        command = assertR2BlockSplitPayload(name, fieldName, payload);
      } else if (payload.version === 3) {
        command = assertR3BlockMergePayload(name, fieldName, payload);
      } else {
        throw new ValidationError(`${name}.${fieldName}.operation requires version 1, 2, or 3`);
      }
      const documentScope = scopeOf(name, command.id).key;
      if (scope !== documentScope) {
        throw new ValidationError(`${name}.${fieldName}.operation requires document scope '${documentScope}'`);
      }
      return command;
    };

    const r1Handler = ({ payload, db, scope }) => {
      const command = assertDocumentScope({ payload, scope });
      const documentScope = scopeOf(name, command.id).key;
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

    const r2Handler = ({ payload, db, scope }) => {
      const command = assertDocumentScope({ payload, scope });
      const documentScope = scopeOf(name, command.id).key;
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
      const command = assertDocumentScope({ payload, scope });
      const documentScope = scopeOf(name, command.id).key;
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

    const handler = ({ payload, db, scope }) => {
      if (payload.version === 1) return r1Handler({ payload, db, scope });
      if (payload.version === 2) return r2Handler({ payload, db, scope });
      return r3Handler({ payload, db, scope });
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

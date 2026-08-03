import { randomBytes } from 'node:crypto';
import { assertWellFormedText } from './annotated-text.mjs';
import { resolveDeclarationMeasurementExtension } from './annotated-text-field.mjs';
import { frozenJsonSnapshot } from './annotated-text-r2.mjs';

function validateEntityAndField(entity, field) {
  if (!entity || typeof entity !== 'object' || Array.isArray(entity)) {
    throw new Error('annotatedTextAction: entity must be a non-null object');
  }
  if (typeof entity.name !== 'string' || entity.name.length === 0) {
    throw new Error('annotatedTextAction: entity name must be a non-empty string');
  }
  if (!field || typeof field !== 'object' || typeof field.fieldName !== 'string' || field.fieldName.length === 0) {
    throw new Error('annotatedTextAction: field must be an annotatedText field handle');
  }
  const fieldName = field.fieldName;
  const descriptor = entity.fields?.[fieldName];
  if (!descriptor || descriptor.kind !== 'annotatedText') {
    throw new Error(`annotatedTextAction: '${entity.name}.${fieldName}' is not an annotatedText field`);
  }
  return fieldName;
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) return value;
  for (const v of Object.values(value)) deepFreeze(v);
  return Object.freeze(value);
}

function selection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('annotatedTextAction: selection must be an object');
  }
  const keys = Object.keys(value);
  if (value.kind === 'one' && keys.length === 2 && typeof value.groupToken === 'string' && value.groupToken.length > 0) {
    return { kind: 'one', groupToken: value.groupToken };
  }
  if ((value.kind === 'consecutive' || value.kind === 'listed') && keys.length === 2 &&
      Array.isArray(value.groupTokens) && value.groupTokens.length > 0 &&
      value.groupTokens.every((id) => typeof id === 'string' && id.length > 0) &&
       new Set(value.groupTokens).size === value.groupTokens.length) {
    return { kind: value.kind, groupTokens: [...value.groupTokens] };
  }
  throw new Error('annotatedTextAction: selection must be one, consecutive, or listed with exact keys');
}

function annotation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3 ||
      typeof value.id !== 'string' || value.id.length === 0 ||
      typeof value.family !== 'string' || value.family.length === 0 ||
      !value.fields || typeof value.fields !== 'object' || Array.isArray(value.fields)) {
    throw new Error('annotatedTextAction: annotation must be { id, family, fields }');
  }
  return { id: value.id, family: value.family, fields: value.fields };
}

export function annotatedTextAction(entity, field, command) {
  const fieldName = validateEntityAndField(entity, field);

  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    throw new Error('annotatedTextAction: command must be a non-null object');
  }
  if (typeof command.id !== 'string' || command.id.length === 0) {
    throw new Error('annotatedTextAction: command must include a non-empty document id');
  }
  if (!command.authoring || typeof command.authoring !== 'object' ||
      command.authoring.version !== 1 || typeof command.authoring.stream !== 'string' || !command.authoring.stream ||
      typeof command.authoring.lease !== 'string' || !command.authoring.lease ||
      typeof command.authoring.mutationId !== 'string' || !command.authoring.mutationId) {
    throw new Error('annotatedTextAction: command requires an authoring stream binding');
  }
  const kinds = new Set(['text.insert', 'text.delete', 'block.split', 'block.merge', 'annotation.apply', 'annotation.detach',
    'block.continue', 'block-group.assignment.set', 'block-group.assignment.clear', 'block.split-and-assign']);
  if (!kinds.has(command.kind)) throw new Error(`annotatedTextAction: unsupported command kind '${String(command.kind)}'`);
  const position = (value, label) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        typeof value.positionToken !== 'string' || value.positionToken.length === 0 ||
        !Number.isSafeInteger(value.offset) || value.offset < 0 ||
        (value.affinity !== 'left' && value.affinity !== 'right')) {
       throw new Error(`annotatedTextAction: ${label} must be { positionToken, offset, affinity }`);
    }
    return { positionToken: value.positionToken, offset: value.offset, affinity: value.affinity };
  };
  let edit;
  if (command.kind === 'text.insert') {
    edit = (() => {
      if (typeof command.text !== 'string' || command.text.length === 0) throw new Error('annotatedTextAction: inserted text must be non-empty');
      return { kind: command.kind, at: position(command.at, 'at'), text: command.text };
    })();
  } else if (command.kind === 'text.delete') {
    edit = { kind: command.kind, from: position(command.from, 'from'), to: position(command.to, 'to') };
  } else if (command.kind === 'block.split') {
    edit = { kind: command.kind, at: position(command.at, 'at'), temporaryBlock: typeof command.temporaryBlock === 'string' && command.temporaryBlock.length > 0 ? command.temporaryBlock : randomBytes(32).toString('base64url') };
  } else if (command.kind === 'block.merge') {
    if (typeof command.leftPositionToken !== 'string' || !command.leftPositionToken || typeof command.rightPositionToken !== 'string' || !command.rightPositionToken) {
      throw new Error('annotatedTextAction: block.merge requires position tokens');
    }
    edit = { kind: command.kind, leftPositionToken: command.leftPositionToken, rightPositionToken: command.rightPositionToken };
  } else if (command.kind === 'annotation.apply') {
    if (!command.annotation || typeof command.annotation !== 'object' || Array.isArray(command.annotation)) throw new Error('annotatedTextAction: annotation.apply requires annotation');
    edit = { kind: command.kind, annotation: command.annotation, from: position(command.from, 'from'), to: position(command.to, 'to') };
  } else if (command.kind === 'annotation.detach') {
    if (typeof command.annotationId !== 'string' || !command.annotationId || typeof command.positionToken !== 'string' || !command.positionToken) {
      throw new Error('annotatedTextAction: annotation.detach requires annotationId and positionToken');
    }
    edit = { kind: command.kind, annotationId: command.annotationId, positionToken: command.positionToken };
  } else if (command.kind === 'block.continue') {
    edit = { kind: command.kind, at: position(command.at, 'at'), temporaryBlock: typeof command.temporaryBlock === 'string' && command.temporaryBlock.length > 0 ? command.temporaryBlock : randomBytes(32).toString('base64url') };
  } else if (command.kind === 'block-group.assignment.set') {
    edit = { kind: command.kind, selection: selection(command.selection), annotation: annotation(command.annotation) };
  } else if (command.kind === 'block-group.assignment.clear') {
    if (typeof command.family !== 'string' || command.family.length === 0) {
      throw new Error('annotatedTextAction: block-group.assignment.clear requires a non-empty family');
    }
    edit = { kind: command.kind, selection: selection(command.selection), family: command.family };
  } else {
    edit = { kind: command.kind, at: position(command.at, 'at'), temporaryBlock: typeof command.temporaryBlock === 'string' && command.temporaryBlock.length > 0 ? command.temporaryBlock : randomBytes(32).toString('base64url'), annotation: annotation(command.annotation) };
  }
  const payload = deepFreeze({ version: 9, id: command.id, authoring: command.authoring, edit });

  const type = `${entity.name}.${fieldName}.operation`;

  return deepFreeze({ type, payload });
}

export function annotatedTextRetireAction(entity, documentId) {
  if (!entity || typeof entity.name !== 'string' || !entity.name || typeof documentId !== 'string' || !documentId) {
    throw new Error('annotatedTextRetireAction: entity and non-empty documentId are required');
  }
  return deepFreeze({ type: `${entity.name}.annotatedText.retire`, payload: { id: documentId } });
}

export function annotatedTextCreateAction(entity, field, input) {
  if (!entity || typeof entity !== 'object' || Array.isArray(entity)) {
    throw new Error('annotatedTextCreateAction: entity must be a non-null object');
  }
  if (typeof entity.name !== 'string' || entity.name.length === 0) {
    throw new Error('annotatedTextCreateAction: entity name must be a non-empty string');
  }
  const fieldName = validateEntityAndField(entity, field);
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('annotatedTextCreateAction: input must be a non-null object');
  }
  const inputKeys = Object.keys(input);
  if (inputKeys.some((key) => !['id', 'projectId', 'ownerId', 'fields', 'source'].includes(key))) {
    throw new Error('annotatedTextCreateAction: input has unknown keys');
  }
  if (typeof input.id !== 'string' || input.id.length === 0) {
    throw new Error('annotatedTextCreateAction: create payload must include a non-empty id');
  }
  const descriptor = entity.fields[fieldName];
  const projectField = descriptor.project;
  const ownerField = descriptor.owner;
  if (typeof input.projectId !== 'string' || input.projectId.length === 0 || typeof input.ownerId !== 'string' || input.ownerId.length === 0) {
    throw new Error('annotatedTextCreateAction: input requires non-empty projectId and ownerId');
  }
  if (input.fields !== undefined && (!input.fields || typeof input.fields !== 'object' || Array.isArray(input.fields))) throw new Error('annotatedTextCreateAction: fields must be a non-array object');
  const fields = input.fields ?? {};
  for (const key of Object.keys(fields)) {
    if (!Object.hasOwn(entity.fields, key) || entity.fields[key]?.kind === 'annotatedText' || key === projectField || key === ownerField) throw new Error(`annotatedTextCreateAction: fields cannot include '${key}'`);
  }
  const payload = { id: input.id, [projectField]: input.projectId, [ownerField]: input.ownerId, ...structuredClone(fields) };
  if (input.source !== undefined) {
    const source = input.source;
    if (!source || typeof source !== 'object' || Array.isArray(source) ||
        Object.keys(source).length !== 1 || !Array.isArray(source.blocks) || source.blocks.length === 0) {
      throw new Error('annotatedTextCreateAction: source requires exactly non-empty blocks');
    }
    const blocks = source.blocks.map((block, index) => {
      if (!block || typeof block !== 'object' || Array.isArray(block) ||
          Object.keys(block).some((key) => !['text', 'fields', 'measurements'].includes(key)) || typeof block.text !== 'string') {
        throw new Error(`annotatedTextCreateAction: source block ${index} is invalid`);
      }
      try { assertWellFormedText(block.text); } catch (error) { throw new Error(`annotatedTextCreateAction: source block ${index} text ${error.message}`); }
      if (block.text.length === 0) throw new Error('annotatedTextCreateAction: source has an empty block');
      if (block.fields !== undefined && (!block.fields || typeof block.fields !== 'object' || Array.isArray(block.fields))) {
        throw new Error(`annotatedTextCreateAction: source block ${index} fields must be a non-array object`);
      }
      if (block.measurements !== undefined && !Array.isArray(block.measurements)) {
        throw new Error(`annotatedTextCreateAction: source block ${index} measurements must be an array`);
      }
      const families = new Set();
      const measurements = (block.measurements ?? []).map((measurement, measurementIndex) => {
        if (!measurement || typeof measurement !== 'object' || Array.isArray(measurement) ||
            Object.keys(measurement).length !== 2 || typeof measurement.family !== 'string' || !Object.hasOwn(measurement, 'payload')) {
          throw new Error(`annotatedTextCreateAction: source block ${index} measurement ${measurementIndex} is invalid`);
        }
        if (families.has(measurement.family)) throw new Error(`annotatedTextCreateAction: source block ${index} has duplicate measurement family '${measurement.family}'`);
        families.add(measurement.family);
        const config = descriptor.measurements.find((entry) => entry.measurementName === measurement.family);
        const extension = config && resolveDeclarationMeasurementExtension(config);
        if (!config || !extension) throw new Error(`annotatedTextCreateAction: source measurement family '${measurement.family}' is not declared`);
        let measurementPayload;
        try {
          measurementPayload = frozenJsonSnapshot(measurement.payload);
          if (extension.validate(Object.freeze({ version: 1, formatVersion: config.formatVersion, blockText: block.text, payload: measurementPayload })) !== undefined) throw new Error('validator returned a value');
        } catch {
          throw new Error(`annotatedTextCreateAction: source measurement '${measurement.family}' failed validation`);
        }
        return { family: measurement.family, payload: measurementPayload };
      });
      return {
        text: block.text,
        ...(block.fields === undefined ? {} : { fields: structuredClone(block.fields) }),
        ...(block.measurements === undefined ? {} : { measurements }),
      };
    });
    payload[fieldName] = { version: 1, blocks };
  }
  const type = `${entity.name}.create`;

  return deepFreeze({ type, payload });
}

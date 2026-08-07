import { randomBytes } from 'node:crypto';
import { assertWellFormedText } from './annotated-text.mjs';
import { resolveDeclarationMeasurementExtension } from './annotated-text-field.mjs';
import { frozenJsonSnapshot } from './annotated-text-r2.mjs';
import { annotatedTextAction as buildAnnotatedTextAction } from './annotated-text-action-builder.mjs';

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

export function annotatedTextAction(entity, field, command) {
  return buildAnnotatedTextAction(entity, field, command, {
    mintTemporaryBlock: () => randomBytes(32).toString('base64url'),
  });
}

export function annotatedTextRetireAction(entity, documentId) {
  if (!entity || typeof entity.name !== 'string' || !entity.name || typeof documentId !== 'string' || !documentId) {
    throw new Error('annotatedTextRetireAction: entity and non-empty documentId are required');
  }
  return deepFreeze({ type: `${entity.name}.annotatedText.retire`, payload: { id: documentId } });
}

/**
 * A word-timing evidence payload carried event-only on an annotated-text
 * create source block. Never folded into the CRDT checkpoint: a committed-log
 * projection materializes it into relational rows anchored to immutable RGA
 * endpoints (Sol D2).
 */
export function assertWordTimingPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.version !== 1) return false;
  const arrays = {
    ids: 'string',
    starts: 'number',
    ends: 'number',
    mediaStartsMs: 'number',
    mediaEndsMs: 'number',
  };
  for (const [key, type] of Object.entries(arrays)) {
    if (!Array.isArray(value[key]) || value[key].some((entry) => typeof entry !== type)) return false;
  }
  const length = value.ids.length;
  if (length === 0) return false;
  for (const key of ['starts', 'ends', 'mediaStartsMs', 'mediaEndsMs']) {
    if (value[key].length !== length) return false;
  }
  for (const [key, type] of Object.entries({
    confidence: ['number', 'null'],
    originalTokens: 'string',
    providers: 'string',
    alignment: 'string',
    fragmentStarts: 'number',
    fragmentEnds: 'number',
  })) {
    if (value[key] === undefined) continue;
    if (!Array.isArray(value[key]) || value[key].length !== length) return false;
    const allowed = Array.isArray(type) ? type : [type];
    if (value[key].some((entry) => !allowed.includes(typeof entry))) return false;
  }
  if (value.start !== undefined && (typeof value.start !== 'number' || !Number.isSafeInteger(value.start))) return false;
  if (value.end !== undefined && (typeof value.end !== 'number' || !Number.isSafeInteger(value.end))) return false;
  return true;
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
          Object.keys(block).some((key) => !['text', 'fields', 'measurements', 'words'].includes(key)) || typeof block.text !== 'string') {
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
      if (block.words !== undefined && !assertWordTimingPayload(block.words)) {
        throw new Error(`annotatedTextCreateAction: source block ${index} words must be a well-formed word timing payload`);
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
        ...(block.words === undefined ? {} : { words: frozenJsonSnapshot(block.words) }),
      };
    });
    payload[fieldName] = { version: 1, blocks };
  }
  const type = `${entity.name}.create`;

  return deepFreeze({ type, payload });
}

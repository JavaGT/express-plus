import { assertUtf16Offset, assertWellFormedText } from './annotated-text.ts';
import { resolveDeclarationMeasurementExtension } from './annotated-text-field.ts';
import { frozenJsonSnapshot } from './frozen-json.ts';
import { annotatedTextAction as buildAnnotatedTextAction } from './annotated-text-action-builder.ts';

interface AnnotatedTextEntity {
  name: string;
  fields?: Record<string, any>;
}

interface AnnotatedTextFieldHandle {
  fieldName: string;
}

interface AnnotatedTextMeasurementDescriptor {
  measurementName: string;
  formatVersion: number;
}

interface AnnotatedTextMeasurementExtension {
  validate: (input: unknown) => unknown;
  edit: (input: unknown) => unknown;
  partition: (input: unknown) => unknown;
  combine: (input: unknown) => unknown;
}

interface AnnotatedTextAnnotationDescriptor {
  annotationName: string;
}

interface AnnotatedTextFieldDescriptor {
  kind: string;
  project: string;
  owner: string;
  measurements: ReadonlyArray<AnnotatedTextMeasurementDescriptor>;
  annotations?: ReadonlyArray<AnnotatedTextAnnotationDescriptor>;
}

interface AnnotatedTextSourceBlock {
  text: string;
  fields?: Record<string, unknown>;
  measurements?: Array<{ family: string; payload: unknown }>;
}

interface AnnotatedTextSourceRange {
  annotationId: string;
  family: string;
  start: number;
  end: number;
  fields?: Record<string, unknown>;
}

function validateEntityAndField(entity: AnnotatedTextEntity, field: AnnotatedTextFieldHandle): string {
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

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value) as T;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) return value;
  for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  return Object.freeze(value) as T;
}

export function annotatedTextAction(entity: AnnotatedTextEntity, field: AnnotatedTextFieldHandle, command: Record<string, any>): { type: string; payload: unknown } {
  return buildAnnotatedTextAction(entity, field, command);
}

export function annotatedTextRetireAction(entity: AnnotatedTextEntity, documentId: string): { type: string; payload: { id: string } } {
  if (!entity || typeof entity.name !== 'string' || !entity.name || typeof documentId !== 'string' || !documentId) {
    throw new Error('annotatedTextRetireAction: entity and non-empty documentId are required');
  }
  return deepFreeze({ type: `${entity.name}.annotatedText.retire`, payload: { id: documentId } });
}

export function annotatedTextCreateAction(entity: AnnotatedTextEntity, field: AnnotatedTextFieldHandle, input: Record<string, any>): { type: string; payload: unknown } {
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
  const descriptor = entity.fields![fieldName] as AnnotatedTextFieldDescriptor;
  const projectField = descriptor.project;
  const ownerField = descriptor.owner;
  if (typeof input.projectId !== 'string' || input.projectId.length === 0 || typeof input.ownerId !== 'string' || input.ownerId.length === 0) {
    throw new Error('annotatedTextCreateAction: input requires non-empty projectId and ownerId');
  }
  if (input.fields !== undefined && (!input.fields || typeof input.fields !== 'object' || Array.isArray(input.fields))) throw new Error('annotatedTextCreateAction: fields must be a non-array object');
  const fields = input.fields ?? {};
  for (const key of Object.keys(fields)) {
    if (!Object.hasOwn(entity.fields!, key) || entity.fields![key]?.kind === 'annotatedText' || key === projectField || key === ownerField) throw new Error(`annotatedTextCreateAction: fields cannot include '${key}'`);
  }
  const payload: Record<string, unknown> = { id: input.id, [projectField]: input.projectId, [ownerField]: input.ownerId, ...structuredClone(fields) };
  if (input.source !== undefined) {
    const source = input.source;
    if (!source || typeof source !== 'object' || Array.isArray(source) ||
        Object.keys(source).some((key) => !['text', 'ranges', 'measurements'].includes(key)) ||
        typeof source.text !== 'string' || source.text.length === 0) {
      throw new Error('annotatedTextCreateAction: source requires non-empty text');
    }
    const text = source.text;
    try { assertWellFormedText(text); } catch (error) { throw new Error(`annotatedTextCreateAction: source text ${(error as Error).message}`); }
    const families = new Set<string>();
    let measurements;
    if (source.measurements !== undefined) {
      if (!Array.isArray(source.measurements)) throw new Error('annotatedTextCreateAction: source measurements must be an array');
      measurements = source.measurements.map((measurement: Record<string, any>, measurementIndex: number): { family: string; payload: unknown } => {
        if (!measurement || typeof measurement !== 'object' || Array.isArray(measurement) ||
            Object.keys(measurement).length !== 2 || typeof measurement.family !== 'string' || !Object.hasOwn(measurement, 'payload')) {
          throw new Error(`annotatedTextCreateAction: source measurement ${measurementIndex} is invalid`);
        }
        if (families.has(measurement.family)) throw new Error(`annotatedTextCreateAction: source has duplicate measurement family '${measurement.family}'`);
        families.add(measurement.family);
        const config = descriptor.measurements.find((entry) => entry.measurementName === measurement.family);
        const extension = config && resolveDeclarationMeasurementExtension(config) as unknown as AnnotatedTextMeasurementExtension | null;
        if (!config || !extension) throw new Error(`annotatedTextCreateAction: source measurement family '${measurement.family}' is not declared`);
        let measurementPayload;
        try {
          measurementPayload = frozenJsonSnapshot(measurement.payload);
          if (extension.validate(Object.freeze({ version: 1, formatVersion: config.formatVersion, blockText: text, payload: measurementPayload })) !== undefined) throw new Error('validator returned a value');
        } catch {
          throw new Error(`annotatedTextCreateAction: source measurement '${measurement.family}' failed validation`);
        }
        return { family: measurement.family, payload: measurementPayload };
      });
    }
    const ranges = source.ranges === undefined ? undefined : (() => {
      if (!Array.isArray(source.ranges)) throw new Error('annotatedTextCreateAction: source ranges must be an array');
      const fullText = text;
      const annotationIds = new Set<string>();
      return source.ranges.map((range: Record<string, any>, rangeIndex: number): AnnotatedTextSourceRange => {
        if (!range || typeof range !== 'object' || Array.isArray(range) ||
            Object.keys(range).some((key) => !['annotationId', 'family', 'start', 'end', 'fields'].includes(key))) {
          throw new Error(`annotatedTextCreateAction: source range ${rangeIndex} is invalid`);
        }
        const { annotationId, family, start, end } = range;
        if (typeof annotationId !== 'string' || annotationId.length === 0) {
          throw new Error(`annotatedTextCreateAction: source range ${rangeIndex} annotationId must be a non-empty string`);
        }
        if (annotationIds.has(annotationId)) throw new Error(`annotatedTextCreateAction: source range ${rangeIndex} has duplicate annotationId '${annotationId}'`);
        annotationIds.add(annotationId);
        if (typeof family !== 'string' || !descriptor.annotations?.some((entry) => entry.annotationName === family)) {
          throw new Error(`annotatedTextCreateAction: source range ${rangeIndex} family '${String(family)}' is not declared`);
        }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > fullText.length) {
          throw new Error(`annotatedTextCreateAction: source range ${rangeIndex} offsets are outside the source text`);
        }
        try { assertUtf16Offset(fullText, start); assertUtf16Offset(fullText, end); } catch (error) {
          throw new Error(`annotatedTextCreateAction: source range ${rangeIndex} ${(error as Error).message}`);
        }
        if (range.fields !== undefined && (!range.fields || typeof range.fields !== 'object' || Array.isArray(range.fields))) {
          throw new Error(`annotatedTextCreateAction: source range ${rangeIndex} fields must be a non-array object`);
        }
        return {
          annotationId,
          family,
          start,
          end,
          ...(range.fields === undefined ? {} : { fields: structuredClone(range.fields) }),
        };
      });
    })();
    const block: AnnotatedTextSourceBlock = {
      text,
      ...(measurements === undefined ? {} : { measurements }),
    };
    payload[fieldName] = { version: 1, blocks: [block], ...(ranges === undefined ? {} : { ranges }) };
  }
  const type = `${entity.name}.create`;

  return deepFreeze({ type, payload });
}

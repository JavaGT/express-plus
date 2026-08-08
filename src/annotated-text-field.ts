// T3 owns declarations and schema. T4 adds structural prerequisites here, but
// action handlers remain separate so a descriptor cannot imply a partial write.

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
import { assertGuarded } from './guard/static.ts';
const CAPABILITY_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const SCALAR_TYPES = new Set(['text', 'boolean', 'date', 'number', 'json', 'vector', 'ref']);
const RESERVED_ANNOTATION_COLUMNS = new Set(['annotation_id', 'id', 'document_id', 'project_id', 'owner_id', 'family']);
const ORPHAN_TABLE_SUFFIX = '_annotation_orphan_state';
const RESERVED_ANNOTATION_FAMILIES = new Set(['orphan_state']);

// -- Compiled metadata storage (WeakMap keyed on descriptor) --
const compiledMeta = new WeakMap<object, any>();

export function resolveAnnotatedTextOwningScope(descriptor: any, fields: Record<string, any>, row: Record<string, any>): { entity: string; id: string; key: string } {
  if (!descriptor || descriptor.kind !== 'annotatedText') {
    throw new Error('resolveAnnotatedTextOwningScope requires an annotatedText descriptor');
  }
  const projectField = descriptor.project;
  if (typeof projectField !== 'string' || !fields[projectField]) {
    throw new Error('annotatedText descriptor missing a valid project ref field');
  }
  const projectDesc = fields[projectField];
  if (projectDesc.kind !== 'value' || projectDesc.type !== 'ref') {
    throw new Error('annotatedText descriptor project field must be a ref');
  }
  const projectTarget = targetName(projectDesc);
  if (!projectTarget) {
    throw new Error('annotatedText descriptor project ref field must have a target');
  }
  const projectId = row[projectField];
  if (projectId == null || projectId === '') {
    throw new Error('annotatedText owning project ref is null or empty');
  }
  return { entity: projectTarget, id: String(projectId), key: `${projectTarget}:${projectId}` };
}

export function annotatedTextClientHandle(entity: any, field: any): any {
  if (!entity || typeof entity.name !== 'string' || !field || typeof field.fieldName !== 'string'
    || entity.fields?.[field.fieldName]?.kind !== 'annotatedText') {
    throw new TypeError('annotatedTextClientHandle requires a compiled annotatedText field');
  }
  const fields = Object.freeze(Object.fromEntries(
    Object.entries(entity.fields).map(([name, descriptor]) => [name, Object.freeze({ kind: (descriptor as any).kind })]),
  ));
  const annotatedField = Object.freeze({
    fieldName: field.fieldName,
    annotations: field.annotations,
    measurements: field.measurements,
    capabilities: field.capabilities,
  });
  return Object.freeze({ name: entity.name, fields, [field.fieldName]: annotatedField });
}

export function annotatedTextHistorySession(session: string, { entity, field, documentId }: { entity: string; field: string; documentId: string }): string {
  if (typeof session !== 'string' || session.length === 0
    || typeof entity !== 'string' || entity.length === 0
    || typeof field !== 'string' || field.length === 0
    || typeof documentId !== 'string' || documentId.length === 0) {
    throw new TypeError('annotated text history identity is invalid');
  }
  return JSON.stringify([session, entity, field, documentId]);
}

export function getAnnotatedTextCompiledMetadata(descriptor: any): any {
  return compiledMeta.get(descriptor) ?? null;
}

// -- Contract registry for semantic measurement extensions and action/event contracts --
// Each contract must declare a semantic kind: 'measurement', 'measurement-query',
// 'annotation-action', or 'event'. Queries must match 'measurement-query' contracts,
// annotation actions must match 'annotation-action' contracts, and measurement
// extensions must match 'measurement' contracts.
const CONTRACT_KINDS = new Set(['measurement', 'measurement-query', 'annotation-action', 'event']);
const contractRegistry = new Map<string, any>();

export function registerAnnotatedTextContract(contractName: string, contract: any) {
  if (typeof contractName !== 'string' || !IDENTIFIER.test(contractName)) {
    throw new Error(`annotatedText contract name '${contractName}' is not a valid identifier`);
  }
  if (contractRegistry.has(contractName)) {
    throw new Error(`annotatedText contract '${contractName}' is already registered`);
  }
  if (!contract || typeof contract !== 'object' || !Object.isFrozen(contract)) {
    throw new Error(`annotatedText contract '${contractName}' must be a frozen object`);
  }
  if (!CONTRACT_KINDS.has(contract.kind)) {
    throw new Error(`annotatedText contract '${contractName}' must have a kind in ${[...CONTRACT_KINDS].join(', ')}`);
  }
  contractRegistry.set(contractName, contract);
}

// -- Structural extension registry --
// Each registered extension must provide a frozen, closed spec with exactly
// {version: 1, validate, edit, partition, combine}. Every callback is a
// named, synchronous function. T4 atomic split/merge orchestration will
// call these with frozen inputs and expect closed results.
const STRUCTURAL_SPEC_KEYS = ['version', 'validate', 'edit', 'partition', 'combine'];
const STRUCTURAL_REQUIRED_FNS = ['validate', 'edit', 'partition', 'combine'];
const structuralExtensions = new Map<string, any>();

export function registerAnnotatedTextStructuralExtension(extensionName: string, spec: any) {
  if (typeof extensionName !== 'string' || !IDENTIFIER.test(extensionName)) {
    throw new Error(`annotatedText structural extension name '${extensionName}' is not a valid identifier`);
  }
  if (structuralExtensions.has(extensionName)) {
    throw new Error(`annotatedText structural extension '${extensionName}' is already registered`);
  }
  if (!spec || typeof spec !== 'object' || !Object.isFrozen(spec)) {
    throw new Error(`annotatedText structural extension '${extensionName}' requires a frozen spec object`);
  }
  const prototype = Object.getPrototypeOf(spec);
  if (prototype !== null && prototype !== Object.prototype) {
    throw new Error(`annotatedText structural extension '${extensionName}' requires a plain spec object`);
  }
  const keys = Reflect.ownKeys(spec);
  if (keys.length !== STRUCTURAL_SPEC_KEYS.length ||
      keys.some((key) => typeof key !== 'string' || !STRUCTURAL_SPEC_KEYS.includes(key))) {
    throw new Error(`annotatedText structural extension '${extensionName}' must have exactly version, validate, edit, partition, and combine own properties`);
  }
  const descriptors = Object.fromEntries(STRUCTURAL_SPEC_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(spec, key)]));
  for (const key of STRUCTURAL_SPEC_KEYS) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
      throw new Error(`annotatedText structural extension '${extensionName}' '${key}' must be an enumerable own data property`);
    }
  }
  if (descriptors.version!.value !== 1) {
    throw new Error(`annotatedText structural extension '${extensionName}' requires version exactly 1`);
  }
  for (const fnName of STRUCTURAL_REQUIRED_FNS) {
    const fn = descriptors[fnName]!.value;
    if (typeof fn !== 'function') {
      throw new Error(`annotatedText structural extension '${extensionName}' requires a named '${fnName}' function`);
    }
    if (typeof fn.name !== 'string' || fn.name === '') {
      throw new Error(`annotatedText structural extension '${extensionName}' '${fnName}' must be a named function`);
    }
    const source = Function.prototype.toString.call(fn);
    if (source.startsWith('async ') || source.includes('[native code]')) {
      throw new Error(`annotatedText structural extension '${extensionName}' '${fnName}' must be a direct synchronous function`);
    }
    Object.freeze(fn);
  }
  structuralExtensions.set(extensionName, spec);
}

export function resolveDeclarationMeasurementExtension(descriptor: any): any {
  if (!descriptor || descriptor.kind !== 'measurement') return null;
  const extension = descriptor.extension;
  if (!extension) return null;
  const spec = structuralExtensions.get(extension);
  if (!spec) return null;
  return spec;
}

// -- Helpers --
function fail(entity: string, field: string, path: string | null, message: string): never {
  throw new Error(`annotatedText declaration at ${entity}.${field}${path ? `.${path}` : ''}: ${message}`);
}

function assertName(entity: string, field: string, path: string, name: any, reserved: Set<string> = new Set()) {
  if (typeof name !== 'string' || !IDENTIFIER.test(name) || reserved.has(name)) {
    fail(entity, field, path, `invalid or reserved identifier '${String(name)}'`);
  }
}

function targetName(descriptor: any): string | undefined {
  return typeof descriptor.target === 'string' ? descriptor.target : descriptor.target?.name;
}

function assertScalarFields(entity: string, field: string, path: string, entries: any, reserved: Set<string>): string[] {
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
    fail(entity, field, path, 'must be an object of persisted scalar field descriptors');
  }
  const names = Object.keys(entries);
  for (const name of names) {
    assertName(entity, field, `${path}.${name}`, name, reserved);
    const descriptor = entries[name];
    if (!descriptor || !Object.isFrozen(descriptor) || descriptor.kind !== 'value' || !SCALAR_TYPES.has(descriptor.type)) {
      fail(entity, field, `${path}.${name}`, 'must be a frozen persisted scalar Workbench field descriptor');
    }
    if (descriptor.indexed === 'fts' || descriptor.access || descriptor.role || descriptor.blob) {
      fail(entity, field, `${path}.${name}`, 'uses behavior unsupported by generated annotated-text child rows');
    }
  }
  return names.sort();
}

// -- Declarative annotation / measurement descriptor constructors --

export function annotation(name: string, { appliesTo = 'text-range', cardinality = 'many', fields = {} as any, actions = [], empty = 'delete' }: any = {}): any {
  if (typeof name !== 'string' || !IDENTIFIER.test(name)) {
    throw new Error(`annotation name '${name}' is not a valid identifier`);
  }
  if (appliesTo !== 'text-range') {
    throw new Error(`annotation '${name}' appliesTo must be 'text-range' (issue #33: blocks are removed)`);
  }
  if (cardinality !== 'many' && cardinality !== 'one') {
    throw new Error(`annotation '${name}' cardinality must be 'many' or 'one'`);
  }
  if (cardinality === 'one' && appliesTo !== 'text-range') {
    throw new Error(`annotation '${name}' cardinality 'one' requires appliesTo 'text-range'`);
  }
  if (empty !== 'delete' && empty !== 'orphan') {
    throw new Error(`annotation '${name}' empty policy must be 'delete' or 'orphan'`);
  }
  const frozenFields: Record<string, any> = {};
  for (const [k, v] of Object.entries(fields as Record<string, any>)) {
    frozenFields[k] = Object.freeze({ ...v });
  }
  const frozenActions = Object.freeze([...actions]);
  return Object.freeze({
    kind: 'annotation',
    annotationName: name,
    appliesTo,
    cardinality,
    fields: Object.freeze(frozenFields),
    actions: frozenActions,
    empty,
  });
}

export function protectingAnnotation(name: string, { fields = {} as any, protects = null, placeholder = '[Restricted]', access = null, actions = [], empty = 'delete' }: any = {}): any {
  if (typeof name !== 'string' || !IDENTIFIER.test(name)) {
    throw new Error(`protectingAnnotation name '${name}' is not a valid identifier`);
  }
  if (empty !== 'delete' && empty !== 'orphan') {
    throw new Error(`protectingAnnotation '${name}' empty policy must be 'delete' or 'orphan'`);
  }
  if (protects !== null) {
    if (typeof protects !== 'string' || !IDENTIFIER.test(protects)) {
      throw new Error(`protectingAnnotation '${name}' protects must name a valid annotation family or be null`);
    }
  }
  if (typeof placeholder !== 'string' || placeholder.length === 0) {
    throw new Error(`protectingAnnotation '${name}' placeholder must be a non-empty string`);
  }
  if (access !== null && typeof access !== 'function') {
    throw new Error(`protectingAnnotation '${name}' access must be a function or null`);
  }
  const frozenFields: Record<string, any> = {};
  for (const [k, v] of Object.entries(fields as Record<string, any>)) {
    frozenFields[k] = Object.freeze({ ...v });
  }
  const frozenActions = Object.freeze([...actions]);
  return Object.freeze({
    kind: 'protectingAnnotation',
    annotationName: name,
    fields: Object.freeze(frozenFields),
    protects,
    placeholder,
    access,
    actions: frozenActions,
    empty,
  });
}

export function measurement(name: string, { extension = null, formatVersion = 1, queries = [] }: any = {}): any {
  if (typeof name !== 'string' || !IDENTIFIER.test(name)) {
    throw new Error(`measurement name '${name}' is not a valid identifier`);
  }
  if (extension !== null && (typeof extension !== 'string' || !IDENTIFIER.test(extension))) {
    throw new Error(`measurement '${name}' extension '${extension}' is not a valid identifier`);
  }
  if (typeof formatVersion !== 'number' || !Number.isSafeInteger(formatVersion) || formatVersion <= 0) {
    throw new Error(`measurement '${name}' formatVersion must be a positive integer`);
  }
  const frozenQueries = Object.freeze([...queries]);
  for (const q of frozenQueries) {
    if (typeof q !== 'string' || !IDENTIFIER.test(q)) {
      throw new Error(`measurement '${name}' query '${String(q)}' is not a valid identifier`);
    }
  }
  return Object.freeze({
    kind: 'measurement',
    measurementName: name,
    extension,
    formatVersion,
    queries: frozenQueries,
  });
}

/**
 * Declare a word-evidence family on an annotatedText field. Word evidence is
 * event-only import data (never CRDT state) materialized into the generated
 * relational word-evidence table by a committed-log consumer. Each family
 * declares a `parse(value)` that validates one per-word payload value and
 * returns its canonical JSON-safe form.
 */
export function wordEvidenceFamily(name: string, { formatVersion = 1, parse }: any = {}): any {
  if (typeof name !== 'string' || !IDENTIFIER.test(name)) {
    throw new Error(`word evidence family name '${name}' is not a valid identifier`);
  }
  if (typeof formatVersion !== 'number' || !Number.isSafeInteger(formatVersion) || formatVersion <= 0) {
    throw new Error(`word evidence family '${name}' formatVersion must be a positive integer`);
  }
  if (typeof parse !== 'function') {
    throw new Error(`word evidence family '${name}' requires a parse function`);
  }
  return Object.freeze({
    kind: 'wordEvidenceFamily',
    familyName: name,
    formatVersion,
    parse,
  });
}

export function annotationAction(name: string): any {
  if (typeof name !== 'string' || !IDENTIFIER.test(name)) {
    throw new Error(`annotationAction name '${name}' is not a valid identifier`);
  }
  return Object.freeze({
    kind: 'annotationAction',
    actionName: name,
  });
}

// -- Main validation and compilation --

export function validateAnnotatedTextDeclaration(entity: string, field: string, descriptor: any, fields: any): any {
  for (const key of ['project', 'owner']) {
    const name = descriptor[key];
    if (typeof name !== 'string' || !IDENTIFIER.test(name) || !fields[name]) {
      fail(entity, field, key, 'must name an enclosing ref field');
    }
    if (fields[name].kind !== 'value' || fields[name].type !== 'ref' || !targetName(fields[name])) {
      fail(entity, field, key, 'must name an enclosing ref field with a target');
    }
  }

  const blockFields = Object.freeze([]);

  let caret: { field: string; cell: string } | null = null;
  if (descriptor.carets !== undefined) {
    const spec = descriptor.carets;
    if (!spec || typeof spec !== 'object' || Array.isArray(spec) ||
        Object.keys(spec).length !== 2 || !Object.hasOwn(spec, 'field') || !Object.hasOwn(spec, 'cell')) {
      fail(entity, field, 'carets', 'must be exactly { field, cell }');
    }
    if (typeof spec.field !== 'string' || !IDENTIFIER.test(spec.field) ||
        typeof spec.cell !== 'string' || !IDENTIFIER.test(spec.cell)) {
      fail(entity, field, 'carets', 'field and cell must be identifiers');
    }
    const presenceField = fields[spec.field];
    if (!presenceField || presenceField.kind !== 'ephemeral') {
      fail(entity, field, 'carets.field', 'must name an enclosing ephemeral field');
    }
    if (!Object.hasOwn(presenceField.cells ?? {}, spec.cell)) {
      fail(entity, field, 'carets.cell', 'must name a declared ephemeral cell');
    }
    caret = Object.freeze({ field: spec.field, cell: spec.cell });
  }

  // Validate annotations array
  if (!Array.isArray(descriptor.annotations)) {
    fail(entity, field, 'annotations', 'must be an array of annotation descriptors');
  }
  const annotationNames = new Set<string>();
  const annotationFields: Record<string, any> = {};
  for (const ann of descriptor.annotations) {
    if (!ann || typeof ann !== 'object' || !Object.isFrozen(ann)) {
      fail(entity, field, 'annotations', 'each annotation must be a frozen descriptor');
    }
    if (ann.kind !== 'annotation' && ann.kind !== 'protectingAnnotation') {
      fail(entity, field, 'annotations', `expected annotation or protectingAnnotation descriptor, got '${ann.kind}'`);
    }
    const name = ann.annotationName;
    if (RESERVED_ANNOTATION_FAMILIES.has(name)) {
      fail(entity, field, `annotations.${name}`, 'uses a reserved internal annotation family name');
    }
    if (ann.empty !== 'delete' && ann.empty !== 'orphan') {
      fail(entity, field, `annotations.${name}.empty`, "must be 'delete' or 'orphan'");
    }
    const appliesTo = ann.appliesTo === undefined ? 'text-range' : ann.appliesTo;
    if (appliesTo !== 'text-range') {
      fail(entity, field, `annotations.${name}.appliesTo`, "must be 'text-range' (issue #33: blocks are removed)");
    }
    const cardinality = ann.cardinality === undefined ? 'many' : ann.cardinality;
    if (cardinality !== 'many' && cardinality !== 'one') {
      fail(entity, field, `annotations.${name}.cardinality`, "must be 'many' or 'one'");
    }
    if (cardinality === 'one' && appliesTo !== 'text-range') {
      fail(entity, field, `annotations.${name}.cardinality`, "'one' requires appliesTo 'text-range'");
    }
    if (annotationNames.has(name)) {
      fail(entity, field, `annotations.${name}`, 'duplicate annotation name');
    }
    assertName(entity, field, `annotations.${name}`, name);
    annotationNames.add(name);
    const annFields = assertScalarFields(entity, field, `annotations.${name}`, ann.fields, RESERVED_ANNOTATION_COLUMNS);
    annotationFields[name] = { fields: annFields, descriptor: ann };
  }

  // Validate protecting annotation contracts
  for (const ann of descriptor.annotations) {
    if (ann.kind === 'protectingAnnotation' && ann.protects !== null) {
      if (!annotationNames.has(ann.protects)) {
        fail(entity, field, `annotations.${ann.annotationName}.protects`,
          `'${ann.protects}' does not name a declared annotation family`);
      }
      if (typeof ann.access !== 'function') {
        fail(entity, field, `annotations.${ann.annotationName}.access`, 'must be a function');
      }
      assertGuarded(ann.access, { where: `annotatedText protecting annotation '${ann.annotationName}' access` });
    }
  }

  // Validate measurements array
  if (!Array.isArray(descriptor.measurements)) {
    fail(entity, field, 'measurements', 'must be an array of measurement descriptors');
  }
  const measurementNames = new Set<string>();
  const measurementConfigs: Record<string, any> = {};
  for (const meas of descriptor.measurements) {
    if (!meas || typeof meas !== 'object' || !Object.isFrozen(meas)) {
      fail(entity, field, 'measurements', 'each measurement must be a frozen descriptor');
    }
    if (meas.kind !== 'measurement') {
      fail(entity, field, 'measurements', `expected measurement descriptor, got '${meas.kind}'`);
    }
    const name = meas.measurementName;
    if (measurementNames.has(name)) {
      fail(entity, field, `measurements.${name}`, 'duplicate measurement name');
    }
    assertName(entity, field, `measurements.${name}`, name);
    measurementNames.add(name);
    measurementConfigs[name] = meas;

    // Validate extension: every measurement must declare an extension that
    // resolves BOTH a registered semantic contract of kind 'measurement' AND
    // a matching registered structural adapter.
    if (meas.extension === null) {
      fail(entity, field, `measurements.${name}.extension`,
        'measurement must declare an extension');
    }
    const extContract = contractRegistry.get(meas.extension);
    if (!extContract) {
      fail(entity, field, `measurements.${name}.extension`,
        `'${meas.extension}' is not a registered contract`);
    }
    if (extContract.kind !== 'measurement') {
      fail(entity, field, `measurements.${name}.extension`,
        `'${meas.extension}' is a '${extContract.kind}' contract, not a 'measurement' contract`);
    }
    const structuralSpec = structuralExtensions.get(meas.extension);
    if (!structuralSpec) {
      fail(entity, field, `measurements.${name}.extension`,
        `'${meas.extension}' has no registered structural adapter`);
    }
  }

  // Validate wordEvidence families array
  const wordEvidenceNames = new Set<string>();
  if (descriptor.wordEvidence !== undefined) {
    if (!Array.isArray(descriptor.wordEvidence)) {
      fail(entity, field, 'wordEvidence', 'must be an array of word evidence family descriptors');
    }
    for (const family of descriptor.wordEvidence) {
      if (!family || typeof family !== 'object' || !Object.isFrozen(family)) {
        fail(entity, field, 'wordEvidence', 'each family must be a frozen descriptor');
      }
      if (family.kind !== 'wordEvidenceFamily') {
        fail(entity, field, 'wordEvidence', `expected wordEvidenceFamily descriptor, got '${String(family.kind)}'`);
      }
      const familyName = family.familyName;
      if (wordEvidenceNames.has(familyName)) {
        fail(entity, field, `wordEvidence.${familyName}`, 'duplicate family name');
      }
      assertName(entity, field, `wordEvidence.${familyName}`, familyName);
      if (typeof family.formatVersion !== 'number' || !Number.isSafeInteger(family.formatVersion) || family.formatVersion <= 0) {
        fail(entity, field, `wordEvidence.${familyName}.formatVersion`, 'must be a positive integer');
      }
      if (typeof family.parse !== 'function') {
        fail(entity, field, `wordEvidence.${familyName}.parse`, 'must be a function');
      }
      wordEvidenceNames.add(familyName);
    }
  }

  // Validate capabilities
  if (descriptor.capabilities !== undefined) {
    if (!descriptor.capabilities || typeof descriptor.capabilities !== 'object' || Array.isArray(descriptor.capabilities)) {
      fail(entity, field, 'capabilities', 'must be a non-empty object of named capability handles');
    }
    for (const capKey of Object.keys(descriptor.capabilities)) {
      if (!CAPABILITY_IDENTIFIER.test(capKey)) {
        fail(entity, field, `capabilities.${capKey}`, `invalid capability name '${capKey}'`);
      }
      const cap = descriptor.capabilities[capKey];
      if (!cap || typeof cap !== 'object' || !Object.isFrozen(cap)) {
        fail(entity, field, `capabilities.${capKey}`, 'must be a frozen descriptor');
      }
    }
  }

  // Validate no unknown keys on descriptor
  // `access` is set by makeDescriptor's initial properties, and `can` is a
  // method added by makeDescriptor. Both are field descriptor properties, not
  // declaration keys, and are allowed to pass through.
  const ALLOWED_KEYS = new Set(['project', 'owner', 'annotations', 'measurements', 'capabilities', 'carets', 'wordEvidence', 'kind', 'type', 'access', 'can']);
  for (const key of Object.keys(descriptor)) {
    if (!ALLOWED_KEYS.has(key)) {
      fail(entity, field, key, `unknown key '${key}'`);
    }
  }

  // Validate no unknown keys on annotation annotations
  const ALLOWED_ANN_KEYS = new Set(['kind', 'annotationName', 'appliesTo', 'cardinality', 'fields', 'actions', 'empty', 'protects', 'placeholder', 'access']);
  for (const ann of descriptor.annotations) {
    for (const key of Object.keys(ann)) {
      if (!ALLOWED_ANN_KEYS.has(key)) {
        fail(entity, field, `annotations.${ann.annotationName}.${key}`, `unknown key '${key}'`);
      }
    }
  }

  // Validate no unknown keys on measurement descriptors
  const ALLOWED_MEAS_KEYS = new Set(['kind', 'measurementName', 'extension', 'formatVersion', 'queries']);
  for (const meas of descriptor.measurements) {
    for (const key of Object.keys(meas)) {
      if (!ALLOWED_MEAS_KEYS.has(key)) {
        fail(entity, field, `measurements.${meas.measurementName}.${key}`, `unknown key '${key}'`);
      }
    }
  }

  // Validate no unknown keys on word evidence family descriptors
  const ALLOWED_WORD_EVIDENCE_KEYS = new Set(['kind', 'familyName', 'formatVersion', 'parse']);
  if (descriptor.wordEvidence !== undefined) {
    for (const family of descriptor.wordEvidence) {
      for (const key of Object.keys(family)) {
        if (!ALLOWED_WORD_EVIDENCE_KEYS.has(key)) {
          fail(entity, field, `wordEvidence.${family.familyName}.${key}`, `unknown key '${key}'`);
        }
      }
    }
  }

  // Reject handlers/reducers/SQL callbacks at T3 boundary
  for (const ann of descriptor.annotations) {
    for (const action of ann.actions) {
      if (action && typeof action === 'object' && (action.handler || action.reducer || action.sql || action.SQL)) {
        fail(entity, field, `annotations.${ann.annotationName}.actions`,
          'T3 does not accept action handlers, reducers, or SQL callbacks');
      }
    }
  }

  // Validate query contracts reference registered contracts with 'measurement-query' kind
  for (const meas of descriptor.measurements) {
    for (const q of meas.queries) {
      const queryContract = contractRegistry.get(q);
      if (!queryContract) {
        fail(entity, field, `measurements.${meas.measurementName}.queries`,
          `'${q}' is not a registered contract`);
      }
      if (queryContract.kind !== 'measurement-query') {
        fail(entity, field, `measurements.${meas.measurementName}.queries`,
          `'${q}' is a '${queryContract.kind}' contract, not a 'measurement-query' contract`);
      }
    }
  }

  // Validate annotation actions — each must be a frozen annotationAction descriptor
  // with exactly allowed keys and a registered contract of kind 'annotation-action'
  const ALLOWED_ACTION_KEYS = new Set(['kind', 'actionName']);
  for (const ann of descriptor.annotations) {
    for (const action of ann.actions) {
      if (typeof action !== 'object' || !action || !Object.isFrozen(action)) {
        fail(entity, field, `annotations.${ann.annotationName}.actions`,
          'each action must be a frozen object');
      }
      if (action.kind !== 'annotationAction') {
        fail(entity, field, `annotations.${ann.annotationName}.actions`,
          `expected annotationAction descriptor, got '${String(action.kind)}'`);
      }
      if (typeof action.actionName !== 'string' || !IDENTIFIER.test(action.actionName)) {
        fail(entity, field, `annotations.${ann.annotationName}.actions`,
          `actionName '${String(action.actionName)}' is not a valid identifier`);
      }
      for (const key of Object.keys(action)) {
        if (!ALLOWED_ACTION_KEYS.has(key)) {
          fail(entity, field, `annotations.${ann.annotationName}.actions`,
            `unknown key '${key}' on action '${action.actionName}'`);
        }
      }
      const actionContract = contractRegistry.get(action.actionName);
      if (!actionContract) {
        fail(entity, field, `annotations.${ann.annotationName}.actions`,
          `'${action.actionName}' is not a registered contract`);
      }
      if (actionContract.kind !== 'annotation-action') {
        fail(entity, field, `annotations.${ann.annotationName}.actions`,
          `'${action.actionName}' is a '${actionContract.kind}' contract, not an 'annotation-action' contract`);
      }
    }
  }

  // Compile metadata and store in WeakMap
  const families = [...annotationNames].sort();
  const measurementFamilyList = [...measurementNames].sort();
  const wordEvidenceFamilyList = descriptor.wordEvidence === undefined ? [] : [...wordEvidenceNames].sort();
  const wordEvidenceConfigs: Record<string, any> = {};
  if (descriptor.wordEvidence !== undefined) {
    for (const family of descriptor.wordEvidence) {
      wordEvidenceConfigs[family.familyName] = family;
    }
  }

  // Build action identifiers per annotation
  const annotationActionIds: Record<string, any> = {};
  const protectingFamilies: Record<string, any> = {};
  for (const ann of descriptor.annotations) {
    const actionIds = ann.actions.map((a: any) => a.actionName);
    annotationActionIds[ann.annotationName] = Object.freeze([...actionIds]);
    if (ann.kind === 'protectingAnnotation') protectingFamilies[ann.annotationName] = Object.freeze({ placeholder: ann.placeholder, access: ann.access });
  }
  const protectingPlaceholders = [...new Set(Object.values(protectingFamilies).map((family) => family.placeholder))];
  if (protectingPlaceholders.length > 1) {
    fail(entity, field, 'annotations', 'protecting annotations must share one placeholder');
  }

  const projectTarget = targetName(fields[descriptor.project]);
  const projectField = descriptor.project;

  const compiled = {
    blockFields,
    families,
    annotationFields,
    measurementConfigs,
    measurementFamilyList,
    wordEvidenceConfigs: Object.freeze({ ...wordEvidenceConfigs }),
    wordEvidenceFamilyList: Object.freeze(wordEvidenceFamilyList),
    capabilities: descriptor.capabilities ? Object.freeze({ ...descriptor.capabilities }) : null,
    protectingFamilies: Object.freeze({ ...protectingFamilies }),
    restrictedPlaceholder: protectingPlaceholders[0] ?? null,
    projectField,
    projectTarget,
    // Create frozen typed runtime static handles
    annotationHandles: Object.freeze(
      Object.fromEntries([...annotationNames].map((n: any) => {
        const annConfig = descriptor.annotations.find((a: any) => a.annotationName === n);
        return [n, Object.freeze({
          family: n,
          annotationName: n,
          appliesTo: 'text-range',
          cardinality: annConfig?.cardinality === undefined ? 'many' : annConfig.cardinality,
          actions: annotationActionIds[n] || Object.freeze([]),
          empty: (annConfig && annConfig.empty) || 'delete',
        })];
      }))
    ),
    measurementHandles: Object.freeze(
      Object.fromEntries([...measurementNames].map((n: any) => {
        const measDesc = measurementConfigs[n];
        const queryNames = measDesc ? measDesc.queries : [];
        const handle: Record<string, any> = { family: n, measurementName: n };
        // Attach query facade methods only for declared query names
        for (const qn of queryNames) {
          handle[qn] = () => {
            throw new Error(`measurement '${n}' query '${qn}' requires T4 runtime`);
          };
        }
        return [n, Object.freeze(handle)];
      }))
    ),
    capabilityHandles: descriptor.capabilities
      ? Object.freeze(Object.fromEntries(Object.keys(descriptor.capabilities).map((n: any) => [n, Object.freeze({ name: n })])))
      : null,
    caret,
  };
  compiledMeta.set(descriptor, Object.freeze(compiled));

  return { blockFields, families, measurements: measurementFamilyList, wordEvidence: wordEvidenceFamilyList };
}

function columnType(descriptor: any): string {
  if (descriptor.type === 'boolean' || descriptor.type === 'date') return 'INTEGER';
  if (descriptor.type === 'number') return 'REAL';
  return 'TEXT';
}

function extensionColumns(fields: any, names: string[]): string[] {
  return names.map((name) => `${name} ${columnType(fields[name])}${fields[name].nullable || fields[name].optional ? '' : ' NOT NULL'}`);
}

export function annotatedTextDDL(entity: string, field: string, descriptor: any, fields: any): string[] {
  const { families, measurements, wordEvidence } = validateAnnotatedTextDeclaration(entity, field, descriptor, fields);
  const prefix = `${entity}_${field}`;
  const projectTarget = targetName(fields[descriptor.project]);
  const ownerTarget = targetName(fields[descriptor.owner]);
  const annotation = `${prefix}_annotation`;
  const orphan = `${prefix}${ORPHAN_TABLE_SUFFIX}`;
  const protectedTarget = `${prefix}_annotation_protected_target`;
  const membership = `${prefix}_membership`;
  const measurement = `${prefix}_measurement`;
  const state = `${prefix}_state`;
  const retired = `${prefix}_retired`;
  const statements = [
    `CREATE TABLE IF NOT EXISTS ${retired} (\n  document_id TEXT PRIMARY KEY,\n  generation TEXT NOT NULL,\n  retired_at TEXT NOT NULL\n);`,
    `CREATE TABLE IF NOT EXISTS ${state} (\n  document_id TEXT PRIMARY KEY,\n  structure_version INTEGER NOT NULL CHECK (structure_version >= 0),\n  family_checkpoint TEXT NOT NULL CHECK (json_valid(family_checkpoint)),\n  FOREIGN KEY (document_id) REFERENCES ${entity}(id) ON DELETE CASCADE\n);`,
    `CREATE TABLE IF NOT EXISTS ${annotation} (\n  id TEXT PRIMARY KEY,\n  document_id TEXT NOT NULL,\n  project_id TEXT NOT NULL,\n  owner_id TEXT NOT NULL,\n  family TEXT NOT NULL CHECK (family IN (${families.map((name: any) => `'${name}'`).join(', ')})),\n  FOREIGN KEY (document_id) REFERENCES ${entity}(id) ON DELETE CASCADE,\n  FOREIGN KEY (project_id) REFERENCES ${projectTarget}(id) ON DELETE CASCADE,\n  FOREIGN KEY (owner_id) REFERENCES ${ownerTarget}(id) ON DELETE CASCADE\n);`,
    `CREATE TABLE IF NOT EXISTS ${protectedTarget} (\n  annotation_id TEXT NOT NULL,\n  target_annotation_id TEXT NOT NULL,\n  PRIMARY KEY (annotation_id, target_annotation_id),\n  FOREIGN KEY (annotation_id) REFERENCES ${annotation}(id) ON DELETE CASCADE,\n  FOREIGN KEY (target_annotation_id) REFERENCES ${annotation}(id) ON DELETE RESTRICT\n);`,
    `CREATE INDEX IF NOT EXISTS idx_${prefix}_annotation_protected_target_target ON ${protectedTarget} (target_annotation_id, annotation_id);`,
    `CREATE TABLE IF NOT EXISTS ${orphan} (\n  annotation_id TEXT PRIMARY KEY,\n  saved_quote TEXT NOT NULL,\n  last_range TEXT NOT NULL CHECK (json_valid(last_range)),\n  FOREIGN KEY (annotation_id) REFERENCES ${annotation}(id) ON DELETE CASCADE\n);`,
  ];
  for (const family of families) {
    const annConfig = descriptor.annotations.find((a: any) => a.annotationName === family);
    const annFields = annConfig ? annConfig.fields : {};
    const names = Object.keys(annFields).sort();
    statements.push(`CREATE TABLE IF NOT EXISTS ${prefix}_annotation_${family} (\n  annotation_id TEXT PRIMARY KEY${names.length ? `,\n  ${extensionColumns(annFields, names).join(',\n  ')}` : ''},\n  FOREIGN KEY (annotation_id) REFERENCES ${annotation}(id) ON DELETE CASCADE\n);`);
  }
  statements.push(
    `CREATE TABLE IF NOT EXISTS ${membership} (\n  annotation_id TEXT PRIMARY KEY,\n  start_point TEXT NOT NULL CHECK (json_valid(start_point)),\n  end_point TEXT NOT NULL CHECK (json_valid(end_point)),\n  FOREIGN KEY (annotation_id) REFERENCES ${annotation}(id) ON DELETE CASCADE\n);`,
    `CREATE TABLE IF NOT EXISTS ${measurement} (\n  id TEXT PRIMARY KEY,\n  document_id TEXT NOT NULL,\n  family TEXT NOT NULL CHECK (family IN (${measurements.map((name: any) => `'${name}'`).join(', ')})),\n  format_version INTEGER NOT NULL CHECK (format_version > 0),\n  payload TEXT NOT NULL CHECK (json_valid(payload)),\n  FOREIGN KEY (document_id) REFERENCES ${entity}(id) ON DELETE CASCADE\n);`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_${prefix}_measurement_once ON ${measurement} (document_id, family);`,
  );
  if (wordEvidence.length > 0) {
    const wordEvidenceTable = `${prefix}_word_evidence`;
    const familyCheck = wordEvidence.map((name: any) => `'${name}'`).join(', ');
    statements.push(
      `CREATE TABLE IF NOT EXISTS ${wordEvidenceTable} (\n  scope TEXT NOT NULL,\n  document_id TEXT NOT NULL,\n  word_id TEXT NOT NULL,\n  family TEXT NOT NULL CHECK (family IN (${familyCheck})),\n  start_anchor TEXT NOT NULL CHECK (json_valid(start_anchor)),\n  end_anchor TEXT NOT NULL CHECK (json_valid(end_anchor)),\n  source_start_utf16 INTEGER NOT NULL,\n  source_end_utf16 INTEGER NOT NULL,\n  original_token TEXT NOT NULL,\n  payload TEXT NOT NULL CHECK (json_valid(payload)),\n  origin_seq INTEGER NOT NULL,\n  format_version INTEGER NOT NULL,\n  PRIMARY KEY (scope, document_id, word_id, family),\n  FOREIGN KEY (document_id) REFERENCES ${entity}(id) ON DELETE CASCADE\n);`,
      `CREATE INDEX IF NOT EXISTS idx_${prefix}_word_evidence_doc ON ${wordEvidenceTable} (scope, document_id, family, source_start_utf16);`,
    );
  }
  return statements;
}

export function annotatedTextAuthoringStreamDDL(entity: string, field: string): string[] {
  const prefix = `${entity}_${field}`;
  return [
    `CREATE TABLE IF NOT EXISTS ${prefix}_authoring_stream (\n  id TEXT PRIMARY KEY,\n  document_id TEXT NOT NULL,\n  principal_type TEXT NOT NULL,\n  principal_id TEXT NOT NULL,\n  created_at TEXT NOT NULL,\n  last_used_at TEXT NOT NULL,\n  expires_at TEXT NOT NULL,\n  FOREIGN KEY (document_id) REFERENCES ${entity}(id) ON DELETE CASCADE\n);`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_${prefix}_authoring_stream_doc_principal ON ${prefix}_authoring_stream (document_id, principal_type, principal_id);`,
    `CREATE TABLE IF NOT EXISTS ${prefix}_authoring_lease (\n  id TEXT PRIMARY KEY,\n  stream_id TEXT NOT NULL,\n  client_nonce_hash TEXT NOT NULL,\n  acknowledged_fence INTEGER NOT NULL DEFAULT 0,\n  created_at TEXT NOT NULL,\n  expires_at TEXT NOT NULL,\n  FOREIGN KEY (stream_id) REFERENCES ${prefix}_authoring_stream(id) ON DELETE CASCADE\n);`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_${prefix}_authoring_lease_stream_nonce ON ${prefix}_authoring_lease (stream_id, client_nonce_hash);`,
     `CREATE TABLE IF NOT EXISTS ${prefix}_authoring_checkpoint (\n  id TEXT PRIMARY KEY,\n  lease_id TEXT NOT NULL,\n  family_checkpoint TEXT NOT NULL CHECK (json_valid(family_checkpoint)),\n  created_at TEXT NOT NULL,\n  FOREIGN KEY (lease_id) REFERENCES ${prefix}_authoring_lease(id) ON DELETE CASCADE\n);`,
     `CREATE TABLE IF NOT EXISTS ${prefix}_authoring_position (\n  token TEXT PRIMARY KEY,\n  lease_id TEXT NOT NULL,\n  issued_fence INTEGER NOT NULL,\n  checkpoint_id TEXT NOT NULL,\n  visible_at_issue INTEGER NOT NULL DEFAULT 1,\n  redactions TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(redactions)),\n  created_at TEXT NOT NULL,\n  FOREIGN KEY (lease_id) REFERENCES ${prefix}_authoring_lease(id) ON DELETE CASCADE,\n  FOREIGN KEY (checkpoint_id) REFERENCES ${prefix}_authoring_checkpoint(id) ON DELETE RESTRICT\n);`,
    `CREATE INDEX IF NOT EXISTS idx_${prefix}_authoring_position_lease ON ${prefix}_authoring_position (lease_id, issued_fence);`,
    `CREATE TABLE IF NOT EXISTS ${prefix}_authoring_snapshot (\n  id TEXT PRIMARY KEY,\n  lease_id TEXT NOT NULL,\n  fence INTEGER NOT NULL,\n  issued_at TEXT NOT NULL,\n  acknowledged_at TEXT,\n  FOREIGN KEY (lease_id) REFERENCES ${prefix}_authoring_lease(id) ON DELETE CASCADE\n);`,
    `CREATE INDEX IF NOT EXISTS idx_${prefix}_authoring_snapshot_lease ON ${prefix}_authoring_snapshot (lease_id, fence);`,
    `CREATE TABLE IF NOT EXISTS ${prefix}_authoring_snapshot_position (\n  snapshot_id TEXT NOT NULL,\n  position_token TEXT NOT NULL,\n  PRIMARY KEY (snapshot_id, position_token),\n  FOREIGN KEY (snapshot_id) REFERENCES ${prefix}_authoring_snapshot(id) ON DELETE CASCADE,\n  FOREIGN KEY (position_token) REFERENCES ${prefix}_authoring_position(token) ON DELETE CASCADE\n);`,
    `CREATE INDEX IF NOT EXISTS idx_${prefix}_authoring_snapshot_position_token ON ${prefix}_authoring_snapshot_position (position_token, snapshot_id);`,
  ];
}

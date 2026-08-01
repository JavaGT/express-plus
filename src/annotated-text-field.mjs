// T3 owns declarations and schema. T4 adds structural prerequisites here, but
// action handlers remain separate so a descriptor cannot imply a partial write.

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
import { assertGuarded } from './guard/static.mjs';
const CAPABILITY_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const SCALAR_TYPES = new Set(['text', 'boolean', 'date', 'number', 'json', 'vector', 'ref']);
const RESERVED_BLOCK_COLUMNS = new Set(['id', 'document_id', 'project_id', 'owner_id', 'position', 'epoch', 'structure_version']);
const RESERVED_ANNOTATION_COLUMNS = new Set(['annotation_id', 'id', 'document_id', 'project_id', 'owner_id', 'family']);
const ORPHAN_TABLE_SUFFIX = '_annotation_orphan_state';
const RESERVED_ANNOTATION_FAMILIES = new Set(['orphan_state']);

// -- Compiled metadata storage (WeakMap keyed on descriptor) --
const compiledMeta = new WeakMap();

export function resolveAnnotatedTextOwningScope(descriptor, fields, row) {
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

export function getAnnotatedTextCompiledMetadata(descriptor) {
  return compiledMeta.get(descriptor) ?? null;
}

// -- Contract registry for semantic measurement extensions and action/event contracts --
// Each contract must declare a semantic kind: 'measurement', 'measurement-query',
// 'annotation-action', or 'event'. Queries must match 'measurement-query' contracts,
// annotation actions must match 'annotation-action' contracts, and measurement
// extensions must match 'measurement' contracts.
const CONTRACT_KINDS = new Set(['measurement', 'measurement-query', 'annotation-action', 'event']);
const contractRegistry = new Map();

export function registerAnnotatedTextContract(contractName, contract) {
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
const structuralExtensions = new Map();

export function registerAnnotatedTextStructuralExtension(extensionName, spec) {
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
  if (descriptors.version.value !== 1) {
    throw new Error(`annotatedText structural extension '${extensionName}' requires version exactly 1`);
  }
  for (const fnName of STRUCTURAL_REQUIRED_FNS) {
    const fn = descriptors[fnName].value;
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

export function resolveDeclarationMeasurementExtension(descriptor) {
  if (!descriptor || descriptor.kind !== 'measurement') return null;
  const extension = descriptor.extension;
  if (!extension) return null;
  const spec = structuralExtensions.get(extension);
  if (!spec) return null;
  return spec;
}

// -- Helpers --
function fail(entity, field, path, message) {
  throw new Error(`annotatedText declaration at ${entity}.${field}${path ? `.${path}` : ''}: ${message}`);
}

function assertName(entity, field, path, name, reserved = new Set()) {
  if (typeof name !== 'string' || !IDENTIFIER.test(name) || reserved.has(name)) {
    fail(entity, field, path, `invalid or reserved identifier '${String(name)}'`);
  }
}

function targetName(descriptor) {
  return typeof descriptor.target === 'string' ? descriptor.target : descriptor.target?.name;
}

function assertScalarFields(entity, field, path, entries, reserved) {
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

export function annotation(name, { appliesTo = 'block', cardinality = 'many', fields = {}, actions = [], empty = 'delete' } = {}) {
  if (typeof name !== 'string' || !IDENTIFIER.test(name)) {
    throw new Error(`annotation name '${name}' is not a valid identifier`);
  }
  if (appliesTo !== 'block' && appliesTo !== 'block-group') {
    throw new Error(`annotation '${name}' appliesTo must be 'block' or 'block-group'`);
  }
  if (cardinality !== 'many' && cardinality !== 'one') {
    throw new Error(`annotation '${name}' cardinality must be 'many' or 'one'`);
  }
  if (cardinality === 'one' && appliesTo !== 'block-group') {
    throw new Error(`annotation '${name}' cardinality 'one' requires appliesTo 'block-group'`);
  }
  if (empty !== 'delete' && empty !== 'orphan') {
    throw new Error(`annotation '${name}' empty policy must be 'delete' or 'orphan'`);
  }
  const frozenFields = {};
  for (const [k, v] of Object.entries(fields)) {
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

export function protectingAnnotation(name, { fields = {}, protects = null, placeholder = '[Restricted]', access = null, actions = [], empty = 'delete' } = {}) {
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
  const frozenFields = {};
  for (const [k, v] of Object.entries(fields)) {
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

export function measurement(name, { extension = null, formatVersion = 1, queries = [] } = {}) {
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

export function annotationAction(name) {
  if (typeof name !== 'string' || !IDENTIFIER.test(name)) {
    throw new Error(`annotationAction name '${name}' is not a valid identifier`);
  }
  return Object.freeze({
    kind: 'annotationAction',
    actionName: name,
  });
}

// -- Main validation and compilation --

export function validateAnnotatedTextDeclaration(entity, field, descriptor, fields) {
  for (const key of ['project', 'owner']) {
    const name = descriptor[key];
    if (typeof name !== 'string' || !IDENTIFIER.test(name) || !fields[name]) {
      fail(entity, field, key, 'must name an enclosing ref field');
    }
    if (fields[name].kind !== 'value' || fields[name].type !== 'ref' || !targetName(fields[name])) {
      fail(entity, field, key, 'must name an enclosing ref field with a target');
    }
  }

  const blockFields = assertScalarFields(entity, field, 'block', descriptor.block ?? {}, RESERVED_BLOCK_COLUMNS);

  let caret = null;
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
  if (!descriptor.annotations || !Array.isArray(descriptor.annotations)) {
    fail(entity, field, 'annotations', 'must be a non-empty array of annotation descriptors');
  }
  if (descriptor.annotations.length === 0) {
    fail(entity, field, 'annotations', 'must declare at least one annotation');
  }
  const annotationNames = new Set();
  const annotationFields = {};
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
    const appliesTo = ann.appliesTo === undefined ? 'block' : ann.appliesTo;
    if (appliesTo !== 'block' && appliesTo !== 'block-group') {
      fail(entity, field, `annotations.${name}.appliesTo`, "must be 'block' or 'block-group'");
    }
    const cardinality = ann.cardinality === undefined ? 'many' : ann.cardinality;
    if (cardinality !== 'many' && cardinality !== 'one') {
      fail(entity, field, `annotations.${name}.cardinality`, "must be 'many' or 'one'");
    }
    if (cardinality === 'one' && appliesTo !== 'block-group') {
      fail(entity, field, `annotations.${name}.cardinality`, "'one' requires appliesTo 'block-group'");
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
  if (!descriptor.measurements || !Array.isArray(descriptor.measurements)) {
    fail(entity, field, 'measurements', 'must be a non-empty array of measurement descriptors');
  }
  if (descriptor.measurements.length === 0) {
    fail(entity, field, 'measurements', 'must declare at least one measurement');
  }
  const measurementNames = new Set();
  const measurementConfigs = {};
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
  const ALLOWED_KEYS = new Set(['project', 'owner', 'block', 'annotations', 'measurements', 'capabilities', 'carets', 'kind', 'type', 'access', 'can']);
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

  // Build action identifiers per annotation
  const annotationActionIds = {};
  const protectingFamilies = {};
  for (const ann of descriptor.annotations) {
    const actionIds = ann.actions.map(a => a.actionName);
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
    capabilities: descriptor.capabilities ? Object.freeze({ ...descriptor.capabilities }) : null,
    protectingFamilies: Object.freeze({ ...protectingFamilies }),
    restrictedPlaceholder: protectingPlaceholders[0] ?? null,
    projectField,
    projectTarget,
    // Create frozen typed runtime static handles
    annotationHandles: Object.freeze(
      Object.fromEntries([...annotationNames].map(n => {
        const annConfig = descriptor.annotations.find(a => a.annotationName === n);
        return [n, Object.freeze({
          family: n,
          annotationName: n,
          appliesTo: annConfig?.appliesTo === undefined ? 'block' : annConfig.appliesTo,
          cardinality: annConfig?.cardinality === undefined ? 'many' : annConfig.cardinality,
          actions: annotationActionIds[n] || Object.freeze([]),
          empty: (annConfig && annConfig.empty) || 'delete',
        })];
      }))
    ),
    measurementHandles: Object.freeze(
      Object.fromEntries([...measurementNames].map(n => {
        const measDesc = measurementConfigs[n];
        const queryNames = measDesc ? measDesc.queries : [];
        const handle = { family: n, measurementName: n };
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
      ? Object.freeze(Object.fromEntries(Object.keys(descriptor.capabilities).map(n => [n, Object.freeze({ name: n })])))
      : null,
    caret,
  };
  compiledMeta.set(descriptor, Object.freeze(compiled));

  return { blockFields, families, measurements: measurementFamilyList };
}

function columnType(descriptor) {
  if (descriptor.type === 'boolean' || descriptor.type === 'date') return 'INTEGER';
  if (descriptor.type === 'number') return 'REAL';
  return 'TEXT';
}

function extensionColumns(fields, names) {
  return names.map((name) => `${name} ${columnType(fields[name])}${fields[name].nullable || fields[name].optional ? '' : ' NOT NULL'}`);
}

export function annotatedTextDDL(entity, field, descriptor, fields) {
  const { blockFields, families, measurements } = validateAnnotatedTextDeclaration(entity, field, descriptor, fields);
  const prefix = `${entity}_${field}`;
  const projectTarget = targetName(fields[descriptor.project]);
  const ownerTarget = targetName(fields[descriptor.owner]);
  const block = `${prefix}_block`;
  const annotation = `${prefix}_annotation`;
  const orphan = `${prefix}${ORPHAN_TABLE_SUFFIX}`;
  const protectedTarget = `${prefix}_annotation_protected_target`;
  const membership = `${prefix}_membership`;
  const groupMembership = `${prefix}_group_membership`;
  const measurement = `${prefix}_measurement`;
  const state = `${prefix}_state`;
  const basis = `${prefix}_basis`;
  const retired = `${prefix}_retired`;
  const statements = [
    `CREATE TABLE IF NOT EXISTS ${retired} (\n  document_id TEXT PRIMARY KEY,\n  generation TEXT NOT NULL,\n  retired_at TEXT NOT NULL\n);`,
    `CREATE TABLE IF NOT EXISTS ${state} (\n  document_id TEXT PRIMARY KEY,\n  structure_version INTEGER NOT NULL CHECK (structure_version >= 0),\n  family_checkpoint TEXT NOT NULL CHECK (json_valid(family_checkpoint)),\n  FOREIGN KEY (document_id) REFERENCES ${entity}(id) ON DELETE CASCADE\n);`,
     `CREATE TABLE IF NOT EXISTS ${basis} (\n  token TEXT PRIMARY KEY,\n  document_id TEXT NOT NULL,\n  principal_id TEXT NOT NULL,\n  structural_revision INTEGER NOT NULL CHECK (structural_revision >= 1),\n  family_checkpoint TEXT NOT NULL CHECK (json_valid(family_checkpoint)),\n  visible_blocks TEXT NOT NULL CHECK (json_valid(visible_blocks)),\n  exposed_groups TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(exposed_groups)),\n  FOREIGN KEY (document_id) REFERENCES ${entity}(id) ON DELETE CASCADE\n);`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_${prefix}_basis_recipient ON ${basis} (document_id, principal_id);`,
    `CREATE TABLE IF NOT EXISTS ${block} (\n  id TEXT PRIMARY KEY,\n  document_id TEXT NOT NULL,\n  project_id TEXT NOT NULL,\n  owner_id TEXT NOT NULL,\n  position TEXT NOT NULL,\n  epoch INTEGER NOT NULL DEFAULT 1 CHECK (epoch > 0),\n  structure_version INTEGER NOT NULL DEFAULT 1 CHECK (structure_version > 0)${blockFields.length ? `,\n  ${extensionColumns(descriptor.block, blockFields).join(',\n  ')}` : ''},\n  FOREIGN KEY (document_id) REFERENCES ${entity}(id) ON DELETE CASCADE,\n  FOREIGN KEY (project_id) REFERENCES ${projectTarget}(id) ON DELETE CASCADE,\n  FOREIGN KEY (owner_id) REFERENCES ${ownerTarget}(id) ON DELETE CASCADE\n);`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_${prefix}_block_order ON ${block} (document_id, position);`,
    `CREATE INDEX IF NOT EXISTS idx_${prefix}_block_project ON ${block} (project_id, document_id, position, id);`,
    `CREATE TABLE IF NOT EXISTS ${annotation} (\n  id TEXT PRIMARY KEY,\n  document_id TEXT NOT NULL,\n  project_id TEXT NOT NULL,\n  owner_id TEXT NOT NULL,\n  family TEXT NOT NULL CHECK (family IN (${families.map((name) => `'${name}'`).join(', ')})),\n  FOREIGN KEY (document_id) REFERENCES ${entity}(id) ON DELETE CASCADE,\n  FOREIGN KEY (project_id) REFERENCES ${projectTarget}(id) ON DELETE CASCADE,\n  FOREIGN KEY (owner_id) REFERENCES ${ownerTarget}(id) ON DELETE CASCADE\n);`,
    `CREATE TABLE IF NOT EXISTS ${protectedTarget} (\n  annotation_id TEXT NOT NULL,\n  target_annotation_id TEXT NOT NULL,\n  PRIMARY KEY (annotation_id, target_annotation_id),\n  FOREIGN KEY (annotation_id) REFERENCES ${annotation}(id) ON DELETE CASCADE,\n  FOREIGN KEY (target_annotation_id) REFERENCES ${annotation}(id) ON DELETE RESTRICT\n);`,
    `CREATE INDEX IF NOT EXISTS idx_${prefix}_annotation_protected_target_target ON ${protectedTarget} (target_annotation_id, annotation_id);`,
    `CREATE TABLE IF NOT EXISTS ${orphan} (\n  annotation_id TEXT PRIMARY KEY,\n  saved_quote TEXT NOT NULL,\n  last_memberships TEXT NOT NULL CHECK (json_valid(last_memberships)),\n  FOREIGN KEY (annotation_id) REFERENCES ${annotation}(id) ON DELETE CASCADE\n);`,
  ];
  statements.push(`CREATE TABLE IF NOT EXISTS ${prefix}_block_group (block_id TEXT PRIMARY KEY, group_id TEXT NOT NULL, FOREIGN KEY (block_id) REFERENCES ${block}(id) ON DELETE CASCADE);`);
  for (const family of families) {
    const annConfig = descriptor.annotations.find(a => a.annotationName === family);
    const annFields = annConfig ? annConfig.fields : {};
    const names = Object.keys(annFields).sort();
    statements.push(`CREATE TABLE IF NOT EXISTS ${prefix}_annotation_${family} (\n  annotation_id TEXT PRIMARY KEY${names.length ? `,\n  ${extensionColumns(annFields, names).join(',\n  ')}` : ''},\n  FOREIGN KEY (annotation_id) REFERENCES ${annotation}(id) ON DELETE CASCADE\n);`);
  }
  statements.push(
    `CREATE TABLE IF NOT EXISTS ${membership} (\n  annotation_id TEXT NOT NULL,\n  block_id TEXT NOT NULL,\n  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),\n  start_point TEXT NOT NULL CHECK (json_valid(start_point)),\n  end_point TEXT NOT NULL CHECK (json_valid(end_point)),\n  PRIMARY KEY (annotation_id, ordinal),\n  FOREIGN KEY (annotation_id) REFERENCES ${annotation}(id) ON DELETE CASCADE,\n  FOREIGN KEY (block_id) REFERENCES ${block}(id) ON DELETE CASCADE\n);`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_${prefix}_membership_block_once ON ${membership} (annotation_id, block_id);`,
    `CREATE INDEX IF NOT EXISTS idx_${prefix}_membership_by_block ON ${membership} (block_id, annotation_id);`,
    `CREATE TABLE IF NOT EXISTS ${groupMembership} (
  annotation_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (annotation_id, ordinal),
  UNIQUE (annotation_id, group_id),
  FOREIGN KEY (annotation_id) REFERENCES ${annotation}(id) ON DELETE CASCADE
);`,
    `CREATE INDEX IF NOT EXISTS idx_${prefix}_group_membership_by_group ON ${groupMembership} (group_id, annotation_id);`,
    `CREATE TABLE IF NOT EXISTS ${measurement} (\n  id TEXT PRIMARY KEY,\n  block_id TEXT NOT NULL,\n  family TEXT NOT NULL CHECK (family IN (${measurements.map((name) => `'${name}'`).join(', ')})),\n  format_version INTEGER NOT NULL CHECK (format_version > 0),\n  payload TEXT NOT NULL CHECK (json_valid(payload)),\n  FOREIGN KEY (block_id) REFERENCES ${block}(id) ON DELETE CASCADE\n);`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_${prefix}_measurement_once ON ${measurement} (block_id, family);`,
    `CREATE INDEX IF NOT EXISTS idx_${prefix}_measurement_block ON ${measurement} (block_id, family, id);`,
  );
  return statements;
}

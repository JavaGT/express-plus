// Browser-safe typed authoring grammar. This mirrors the public package action
// constructor without exposing canonical text operations or authoring bindings.
const OPAQUE_TOKEN = /^[A-Za-z0-9_-]{43}$/;

function opaqueToken(value) {
  return typeof value === 'string' && OPAQUE_TOKEN.test(value);
}

function exactKeys(value, keys) {
  return Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function position(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !exactKeys(value, ['positionToken', 'offset', 'affinity']) || !opaqueToken(value.positionToken)
    || !Number.isSafeInteger(value.offset) || value.offset < 0
    || (value.affinity !== 'left' && value.affinity !== 'right')) {
    throw new TypeError(`${label} must be a block position`);
  }
  return Object.freeze({ positionToken: value.positionToken, offset: value.offset, affinity: value.affinity });
}

function selection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('selection must be an object');
  const keys = Object.keys(value);
    if (value.kind === 'one' && keys.length === 2 && opaqueToken(value.groupToken)) {
     return Object.freeze({ kind: 'one', groupToken: value.groupToken });
  }
   if ((value.kind === 'consecutive' || value.kind === 'listed') && keys.length === 2 && Array.isArray(value.groupTokens) &&
        value.groupTokens.length > 0 && value.groupTokens.every(opaqueToken) &&
       new Set(value.groupTokens).size === value.groupTokens.length) {
     return Object.freeze({ kind: value.kind, groupTokens: Object.freeze([...value.groupTokens]) });
  }
  throw new TypeError('selection must have an exact supported shape');
}

function annotation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3 ||
      typeof value.id !== 'string' || value.id.length === 0 || typeof value.family !== 'string' || value.family.length === 0 ||
      !value.fields || typeof value.fields !== 'object' || Array.isArray(value.fields)) throw new TypeError('annotation must be { id, family, fields }');
  return Object.freeze({ id: value.id, family: value.family, fields: Object.freeze(value.fields) });
}

export function annotatedTextAction(entity, field, command) {
  if (!entity || typeof entity.name !== 'string' || entity.name.length === 0
    || !field || typeof field.fieldName !== 'string' || field.fieldName.length === 0
    || entity.fields?.[field.fieldName]?.kind !== 'annotatedText') {
    throw new TypeError('annotated text context requires a declared entity and annotatedText field');
  }
  if (!command || typeof command !== 'object' || Array.isArray(command)
    || typeof command.id !== 'string' || command.id.length === 0
    || !command.authoring || typeof command.authoring !== 'object' || Array.isArray(command.authoring)
    || !exactKeys(command.authoring, ['version', 'stream', 'lease', 'mutationId'])
    || command.authoring.version !== 1 || !opaqueToken(command.authoring.stream)
    || !opaqueToken(command.authoring.lease)
    || typeof command.authoring.mutationId !== 'string' || !command.authoring.mutationId) {
    throw new TypeError('annotated text action requires a document id and authoring stream binding');
  }
  let edit;
  if (command.kind === 'text.insert') {
    if (typeof command.text !== 'string' || command.text.length === 0) throw new TypeError('inserted text must be non-empty');
    edit = Object.freeze({ kind: command.kind, at: position(command.at, 'insert position'), text: command.text });
  } else if (command.kind === 'text.delete') {
    edit = Object.freeze({ kind: command.kind, from: position(command.from, 'delete start'), to: position(command.to, 'delete end') });
  } else if (command.kind === 'text.replace') {
    if (typeof command.text !== 'string' || command.text.length === 0) throw new TypeError('replacement text must be non-empty');
    edit = Object.freeze({ kind: command.kind, from: position(command.from, 'replace start'), to: position(command.to, 'replace end'), text: command.text });
  } else if (command.kind === 'block.split') {
    if (!opaqueToken(command.temporaryBlock)) throw new TypeError('split requires a private temporary block');
    edit = Object.freeze({ kind: command.kind, at: position(command.at, 'split position'), temporaryBlock: command.temporaryBlock });
   } else if (command.kind === 'block.merge') {
      if (!opaqueToken(command.leftPositionToken) || !opaqueToken(command.rightPositionToken)) throw new TypeError('block merge requires position tokens');
     edit = Object.freeze({ kind: command.kind, leftPositionToken: command.leftPositionToken, rightPositionToken: command.rightPositionToken });
  } else if (command.kind === 'annotation.apply') {
    if (!command.annotation || typeof command.annotation !== 'object' || Array.isArray(command.annotation)) throw new TypeError('annotation apply requires an annotation');
    edit = Object.freeze({ kind: command.kind, annotation: command.annotation, from: position(command.from, 'annotation start'), to: position(command.to, 'annotation end') });
   } else if (command.kind === 'annotation.detach') {
      if (typeof command.annotationId !== 'string' || command.annotationId.length === 0 || !opaqueToken(command.positionToken)) throw new TypeError('annotation detach requires annotation and position token');
      edit = Object.freeze({ kind: command.kind, annotationId: command.annotationId, positionToken: command.positionToken });
  } else if (command.kind === 'annotation.remove') {
    if (typeof command.annotationId !== 'string' || command.annotationId.length === 0) throw new TypeError('annotation remove requires annotation');
    edit = Object.freeze({ kind: command.kind, annotationId: command.annotationId });
  } else if (command.kind === 'block.continue') {
    if (!opaqueToken(command.temporaryBlock)) throw new TypeError('continue requires a private temporary block');
    edit = Object.freeze({ kind: command.kind, at: position(command.at, 'continue position'), temporaryBlock: command.temporaryBlock });
  } else if (command.kind === 'block-group.assignment.set') {
    edit = Object.freeze({ kind: command.kind, selection: selection(command.selection), annotation: annotation(command.annotation) });
  } else if (command.kind === 'block-group.assignment.clear') {
    if (typeof command.family !== 'string' || command.family.length === 0) throw new TypeError('clear assignment requires a non-empty family');
    edit = Object.freeze({ kind: command.kind, selection: selection(command.selection), family: command.family });
  } else if (command.kind === 'block.split-and-assign') {
    if (!opaqueToken(command.temporaryBlock)) throw new TypeError('split-and-assign requires a private temporary block');
    edit = Object.freeze({ kind: command.kind, at: position(command.at, 'split-and-assign position'), temporaryBlock: command.temporaryBlock, annotation: annotation(command.annotation) });
  } else throw new TypeError(`unsupported annotated text action kind '${String(command.kind)}'`);
  return Object.freeze({
    type: `${entity.name}.${field.fieldName}.operation`,
    scope: `${entity.name}:${command.id}`,
    payload: Object.freeze({ version: 9, id: command.id, authoring: Object.freeze({ ...command.authoring }), edit }),
  });
}

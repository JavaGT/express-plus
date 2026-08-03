// Browser-safe typed authoring grammar. This mirrors the public package action
// constructor without exposing canonical text operations or authoring bindings.
function position(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.positionToken !== 'string' || value.positionToken.length === 0
    || !Number.isSafeInteger(value.offset) || value.offset < 0) {
    throw new TypeError(`${label} must be a block position`);
  }
  return Object.freeze({ positionToken: value.positionToken, offset: value.offset });
}

function selection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('selection must be an object');
  const keys = Object.keys(value);
   if (value.kind === 'one' && keys.length === 2 && typeof value.groupToken === 'string' && value.groupToken.length > 0) {
     return Object.freeze({ kind: 'one', groupToken: value.groupToken });
  }
   if ((value.kind === 'consecutive' || value.kind === 'listed') && keys.length === 2 && Array.isArray(value.groupTokens) &&
       value.groupTokens.length > 0 && value.groupTokens.every((id) => typeof id === 'string' && id.length > 0) &&
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
    || !command.authoring || typeof command.authoring !== 'object'
    || command.authoring.version !== 1 || typeof command.authoring.stream !== 'string' || !command.authoring.stream
    || typeof command.authoring.lease !== 'string' || !command.authoring.lease
    || typeof command.authoring.mutationId !== 'string' || !command.authoring.mutationId) {
    throw new TypeError('annotated text action requires a document id and authoring stream binding');
  }
  let edit;
  if (command.kind === 'text.insert') {
    if (typeof command.text !== 'string' || command.text.length === 0) throw new TypeError('inserted text must be non-empty');
    edit = Object.freeze({ kind: command.kind, at: position(command.at, 'insert position'), text: command.text });
  } else if (command.kind === 'text.delete') {
    edit = Object.freeze({ kind: command.kind, from: position(command.from, 'delete start'), to: position(command.to, 'delete end') });
  } else if (command.kind === 'block.split') {
    if (typeof command.temporaryBlock !== 'string' || !command.temporaryBlock) throw new TypeError('split requires a private temporary block');
    edit = Object.freeze({ kind: command.kind, at: position(command.at, 'split position'), temporaryBlock: command.temporaryBlock });
   } else if (command.kind === 'block.merge') {
     if (typeof command.leftPositionToken !== 'string' || command.leftPositionToken.length === 0 || typeof command.rightPositionToken !== 'string' || command.rightPositionToken.length === 0) throw new TypeError('block merge requires position tokens');
     edit = Object.freeze({ kind: command.kind, leftPositionToken: command.leftPositionToken, rightPositionToken: command.rightPositionToken });
  } else if (command.kind === 'annotation.apply') {
    if (!command.annotation || typeof command.annotation !== 'object' || Array.isArray(command.annotation)) throw new TypeError('annotation apply requires an annotation');
    edit = Object.freeze({ kind: command.kind, annotation: command.annotation, from: position(command.from, 'annotation start'), to: position(command.to, 'annotation end') });
   } else if (command.kind === 'annotation.detach') {
     if (typeof command.annotationId !== 'string' || command.annotationId.length === 0 || typeof command.positionToken !== 'string' || command.positionToken.length === 0) throw new TypeError('annotation detach requires annotation and position token');
     edit = Object.freeze({ kind: command.kind, annotationId: command.annotationId, positionToken: command.positionToken });
  } else if (command.kind === 'block.continue') {
    if (typeof command.temporaryBlock !== 'string' || !command.temporaryBlock) throw new TypeError('continue requires a private temporary block');
    edit = Object.freeze({ kind: command.kind, at: position(command.at, 'continue position'), temporaryBlock: command.temporaryBlock });
  } else if (command.kind === 'block-group.assignment.set') {
    edit = Object.freeze({ kind: command.kind, selection: selection(command.selection), annotation: annotation(command.annotation) });
  } else if (command.kind === 'block-group.assignment.clear') {
    if (typeof command.family !== 'string' || command.family.length === 0) throw new TypeError('clear assignment requires a non-empty family');
    edit = Object.freeze({ kind: command.kind, selection: selection(command.selection), family: command.family });
  } else if (command.kind === 'block.split-and-assign') {
    if (typeof command.temporaryBlock !== 'string' || !command.temporaryBlock) throw new TypeError('split-and-assign requires a private temporary block');
    edit = Object.freeze({ kind: command.kind, at: position(command.at, 'split-and-assign position'), temporaryBlock: command.temporaryBlock, annotation: annotation(command.annotation) });
  } else throw new TypeError(`unsupported annotated text action kind '${String(command.kind)}'`);
  return Object.freeze({
    type: `${entity.name}.${field.fieldName}.operation`,
    scope: `${entity.name}:${command.id}`,
    payload: Object.freeze({ version: 9, id: command.id, authoring: Object.freeze({ ...command.authoring }), edit }),
  });
}

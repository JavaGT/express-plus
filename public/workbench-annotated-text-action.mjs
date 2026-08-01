// Browser-safe typed authoring grammar. This mirrors the public package action
// constructor without exposing canonical text operations or basis management.
function position(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.blockId !== 'string' || value.blockId.length === 0
    || !Number.isSafeInteger(value.offset) || value.offset < 0) {
    throw new TypeError(`${label} must be a block position`);
  }
  return Object.freeze({ blockId: value.blockId, offset: value.offset });
}

function selection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('selection must be an object');
  const keys = Object.keys(value);
  if (value.kind === 'one' && keys.length === 2 && typeof value.blockGroupId === 'string' && value.blockGroupId.length > 0) {
    return Object.freeze({ kind: 'one', blockGroupId: value.blockGroupId });
  }
  if ((value.kind === 'consecutive' || value.kind === 'listed') && keys.length === 2 && Array.isArray(value.blockGroupIds) &&
      value.blockGroupIds.length > 0 && value.blockGroupIds.every((id) => typeof id === 'string' && id.length > 0) &&
      new Set(value.blockGroupIds).size === value.blockGroupIds.length) {
    return Object.freeze({ kind: value.kind, blockGroupIds: Object.freeze([...value.blockGroupIds]) });
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
    || typeof command.basis !== 'string' || command.basis.length === 0
    || typeof command.mutationId !== 'string' || command.mutationId.length === 0) {
    throw new TypeError('annotated text action requires a document id, basis, and mutation id');
  }
  let edit;
  if (command.kind === 'text.insert') {
    if (typeof command.text !== 'string' || command.text.length === 0) throw new TypeError('inserted text must be non-empty');
    edit = Object.freeze({ kind: command.kind, at: position(command.at, 'insert position'), text: command.text });
  } else if (command.kind === 'text.delete') {
    edit = Object.freeze({ kind: command.kind, from: position(command.from, 'delete start'), to: position(command.to, 'delete end') });
  } else if (command.kind === 'block.split') {
    edit = Object.freeze({ kind: command.kind, at: position(command.at, 'split position') });
  } else if (command.kind === 'block.merge') {
    if (typeof command.leftBlockId !== 'string' || command.leftBlockId.length === 0 || typeof command.rightBlockId !== 'string' || command.rightBlockId.length === 0) throw new TypeError('block merge requires left and right block IDs');
    edit = Object.freeze({ kind: command.kind, leftBlockId: command.leftBlockId, rightBlockId: command.rightBlockId });
  } else if (command.kind === 'annotation.apply') {
    if (!command.annotation || typeof command.annotation !== 'object' || Array.isArray(command.annotation)) throw new TypeError('annotation apply requires an annotation');
    edit = Object.freeze({ kind: command.kind, annotation: command.annotation, from: position(command.from, 'annotation start'), to: position(command.to, 'annotation end') });
  } else if (command.kind === 'annotation.detach') {
    if (typeof command.annotationId !== 'string' || command.annotationId.length === 0 || typeof command.blockId !== 'string' || command.blockId.length === 0) throw new TypeError('annotation detach requires annotation and block IDs');
    edit = Object.freeze({ kind: command.kind, annotationId: command.annotationId, blockId: command.blockId });
  } else if (command.kind === 'block.continue') {
    edit = Object.freeze({ kind: command.kind, at: position(command.at, 'continue position') });
  } else if (command.kind === 'block-group.assignment.set') {
    edit = Object.freeze({ kind: command.kind, selection: selection(command.selection), annotation: annotation(command.annotation) });
  } else if (command.kind === 'block-group.assignment.clear') {
    if (typeof command.family !== 'string' || command.family.length === 0) throw new TypeError('clear assignment requires a non-empty family');
    edit = Object.freeze({ kind: command.kind, selection: selection(command.selection), family: command.family });
  } else if (command.kind === 'block.split-and-assign') {
    edit = Object.freeze({ kind: command.kind, at: position(command.at, 'split-and-assign position'), annotation: annotation(command.annotation) });
  } else throw new TypeError(`unsupported annotated text action kind '${String(command.kind)}'`);
  return Object.freeze({
    type: `${entity.name}.${field.fieldName}.operation`,
    scope: `${entity.name}:${command.id}`,
    payload: Object.freeze({ version: command.kind === 'text.insert' || command.kind === 'text.delete' ? 6 :
      command.kind === 'block.continue' || command.kind === 'block-group.assignment.set' ||
      command.kind === 'block-group.assignment.clear' || command.kind === 'block.split-and-assign' ? 8 : 7, id: command.id, basis: command.basis, mutationId: command.mutationId, edit }),
  });
}

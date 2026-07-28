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
  } else throw new TypeError('annotated text action kind must be text.insert or text.delete');
  return Object.freeze({
    type: `${entity.name}.${field.fieldName}.operation`,
    scope: `${entity.name}:${command.id}`,
    payload: Object.freeze({ version: 6, id: command.id, basis: command.basis, mutationId: command.mutationId, edit }),
  });
}

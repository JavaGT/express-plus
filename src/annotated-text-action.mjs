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
  const fieldName = validateEntityAndField(entity, field);

  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    throw new Error('annotatedTextAction: command must be a non-null object');
  }
  if (typeof command.id !== 'string' || command.id.length === 0) {
    throw new Error('annotatedTextAction: command must include a non-empty document id');
  }
  if (typeof command.basis !== 'string' || command.basis.length === 0 ||
      typeof command.mutationId !== 'string' || command.mutationId.length === 0) {
    throw new Error('annotatedTextAction: command requires a non-empty basis and mutationId');
  }
  const kinds = new Set(['text.insert', 'text.delete', 'block.split', 'block.merge', 'annotation.apply', 'annotation.detach']);
  if (!kinds.has(command.kind)) throw new Error(`annotatedTextAction: unsupported command kind '${String(command.kind)}'`);
  const position = (value, label) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        typeof value.blockId !== 'string' || value.blockId.length === 0 ||
        !Number.isSafeInteger(value.offset) || value.offset < 0) {
      throw new Error(`annotatedTextAction: ${label} must be { blockId, offset }`);
    }
    return { blockId: value.blockId, offset: value.offset };
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
    edit = { kind: command.kind, at: position(command.at, 'at') };
  } else if (command.kind === 'block.merge') {
    if (typeof command.leftBlockId !== 'string' || !command.leftBlockId || typeof command.rightBlockId !== 'string' || !command.rightBlockId) {
      throw new Error('annotatedTextAction: block.merge requires leftBlockId and rightBlockId');
    }
    edit = { kind: command.kind, leftBlockId: command.leftBlockId, rightBlockId: command.rightBlockId };
  } else if (command.kind === 'annotation.apply') {
    if (!command.annotation || typeof command.annotation !== 'object' || Array.isArray(command.annotation)) throw new Error('annotatedTextAction: annotation.apply requires annotation');
    edit = { kind: command.kind, annotation: command.annotation, from: position(command.from, 'from'), to: position(command.to, 'to') };
  } else {
    if (typeof command.annotationId !== 'string' || !command.annotationId || typeof command.blockId !== 'string' || !command.blockId) {
      throw new Error('annotatedTextAction: annotation.detach requires annotationId and blockId');
    }
    edit = { kind: command.kind, annotationId: command.annotationId, blockId: command.blockId };
  }
  const payload = deepFreeze({ version: command.kind === 'text.insert' || command.kind === 'text.delete' ? 6 : 7, id: command.id, basis: command.basis, mutationId: command.mutationId, edit });

  const scope = `${entity.name}:${command.id}`;
  const type = `${entity.name}.${fieldName}.operation`;

  return deepFreeze({ type, scope, payload });
}

export function annotatedTextRetireAction(entity, documentId) {
  if (!entity || typeof entity.name !== 'string' || !entity.name || typeof documentId !== 'string' || !documentId) {
    throw new Error('annotatedTextRetireAction: entity and non-empty documentId are required');
  }
  return deepFreeze({ type: `${entity.name}.annotatedText.retire`, scope: `${entity.name}:${documentId}`, payload: { id: documentId } });
}

export function annotatedTextCreateAction(entity, payload) {
  if (!entity || typeof entity !== 'object' || Array.isArray(entity)) {
    throw new Error('annotatedTextCreateAction: entity must be a non-null object');
  }
  if (typeof entity.name !== 'string' || entity.name.length === 0) {
    throw new Error('annotatedTextCreateAction: entity name must be a non-empty string');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('annotatedTextCreateAction: payload must be a non-null object');
  }
  if (typeof payload.id !== 'string' || payload.id.length === 0) {
    throw new Error('annotatedTextCreateAction: create payload must include a non-empty id');
  }

  const scope = `${entity.name}:${payload.id}`;
  const type = `${entity.name}.create`;

  return deepFreeze({ type, scope, payload });
}

// Pure annotated-text action builder. Zero imports — browser-safe. This is the
// single source of truth for the operation-path action grammar shared by the
// server package entry and the browser SDK. The browser is served THIS file at
// /workbench-annotated-text-action.mjs; the server package thin-wraps it.

const OPAQUE_TOKEN = /^[A-Za-z0-9_-]{43}$/;

interface Position {
  positionToken: string;
  offset: number;
  affinity: 'left' | 'right';
}

interface Annotation {
  id: string;
  family: string;
  fields: Record<string, unknown>;
}

interface PasteAnnotation extends Annotation {
  protectedTargetIds?: readonly string[];
}

interface AuthoringBinding {
  version: 1;
  stream: string;
  lease: string;
  mutationId: string;
}

type AnnotatedTextEdit =
  | { kind: 'text.insert'; at: Position; text: string }
  | { kind: 'text.delete'; from: Position; to: Position }
  | { kind: 'text.replace'; from: Position; to: Position; text: string }
  | { kind: 'annotation.apply'; annotation: Annotation; from: Position; to: Position }
  | { kind: 'annotation.paste'; annotation: PasteAnnotation; at: Position; text: string }
  | { kind: 'annotation.remove'; annotationId: string }
  // Semantic atomic update (#174): new fields (complete declared record) on an
  // EXISTING annotation, optionally moving its range in the same history step.
  | { kind: 'annotation.update'; annotationId: string; fields?: Record<string, unknown>; from?: Position; to?: Position };

interface AnnotatedTextActionPayload {
  version: 9;
  id: string;
  authoring: AuthoringBinding;
  edit: AnnotatedTextEdit;
}

function opaqueToken(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_TOKEN.test(value);
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

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function position(value: unknown, label: string): Position {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !exactKeys(value as Record<string, unknown>, ['positionToken', 'offset', 'affinity']) || !opaqueToken((value as { positionToken?: unknown }).positionToken) ||
      !Number.isSafeInteger((value as { offset?: unknown }).offset) || (value as { offset: number }).offset < 0 ||
      ((value as { affinity?: unknown }).affinity !== 'left' && (value as { affinity?: unknown }).affinity !== 'right')) {
    throw new Error(`annotatedTextAction: ${label} must be { positionToken, offset, affinity }`);
  }
  return { positionToken: (value as { positionToken: string }).positionToken, offset: (value as { offset: number }).offset, affinity: (value as { affinity: 'left' | 'right' }).affinity };
}

export function annotatedTextAction(
  entity: { name: string; fields?: Record<string, unknown> },
  field: { fieldName: string },
  command: Record<string, any>,
): { type: string; payload: AnnotatedTextActionPayload } {
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
  if ((entity.fields?.[fieldName] as { kind?: unknown } | undefined)?.kind !== 'annotatedText') {
    throw new Error(`annotatedTextAction: '${entity.name}.${fieldName}' is not an annotatedText field`);
  }

  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    throw new Error('annotatedTextAction: command must be a non-null object');
  }
  if (typeof command.id !== 'string' || command.id.length === 0) {
    throw new Error('annotatedTextAction: command must include a non-empty document id');
  }
  if (!command.authoring || typeof command.authoring !== 'object' || Array.isArray(command.authoring) ||
      !exactKeys(command.authoring, ['version', 'stream', 'lease', 'mutationId']) ||
      command.authoring.version !== 1 || !opaqueToken(command.authoring.stream) ||
      !opaqueToken(command.authoring.lease) ||
      typeof command.authoring.mutationId !== 'string' || command.authoring.mutationId.length === 0) {
    throw new Error('annotatedTextAction: command requires an authoring stream binding');
  }

  let edit: AnnotatedTextEdit;
  switch (command.kind) {
    case 'text.insert':
      if (typeof command.text !== 'string' || command.text.length === 0) throw new Error('annotatedTextAction: inserted text must be non-empty');
      edit = { kind: command.kind, at: position(command.at, 'at'), text: command.text };
      break;
    case 'text.delete':
      edit = { kind: command.kind, from: position(command.from, 'from'), to: position(command.to, 'to') };
      break;
    case 'text.replace':
      if (typeof command.text !== 'string' || command.text.length === 0) throw new Error('annotatedTextAction: replacement text must be non-empty');
      edit = { kind: command.kind, from: position(command.from, 'from'), to: position(command.to, 'to'), text: command.text };
      break;
    case 'annotation.apply':
      if (!command.annotation || typeof command.annotation !== 'object' || Array.isArray(command.annotation)) {
        throw new Error('annotatedTextAction: annotation.apply requires annotation');
      }
      edit = { kind: command.kind, annotation: command.annotation, from: position(command.from, 'from'), to: position(command.to, 'to') };
      break;
    case 'annotation.paste':
      if (!command.annotation || typeof command.annotation !== 'object' || Array.isArray(command.annotation)) {
        throw new Error('annotatedTextAction: annotation.paste requires annotation');
      }
      if (typeof command.text !== 'string' || command.text.length === 0) {
        throw new Error('annotatedTextAction: pasted text must be non-empty');
      }
      edit = { kind: command.kind, annotation: command.annotation, at: position(command.at, 'at'), text: command.text };
      break;
    case 'annotation.remove':
      if (typeof command.annotationId !== 'string' || command.annotationId.length === 0) {
        throw new Error('annotatedTextAction: annotation.remove requires annotationId');
      }
      edit = { kind: command.kind, annotationId: command.annotationId };
      break;
    case 'annotation.update': {
      if (typeof command.annotationId !== 'string' || command.annotationId.length === 0) {
        throw new Error('annotatedTextAction: annotation.update requires annotationId');
      }
      const hasFields = Object.hasOwn(command, 'fields');
      if (hasFields && (!command.fields || typeof command.fields !== 'object' || Array.isArray(command.fields))) {
        throw new Error('annotatedTextAction: annotation.update fields must be a non-array object');
      }
      const hasFrom = Object.hasOwn(command, 'from');
      const hasTo = Object.hasOwn(command, 'to');
      if (hasFrom !== hasTo) {
        throw new Error('annotatedTextAction: annotation.update range requires both from and to');
      }
      if (!hasFields && !hasFrom) {
        throw new Error('annotatedTextAction: annotation.update requires fields or a from/to range');
      }
      edit = {
        kind: command.kind,
        annotationId: command.annotationId,
        ...(hasFields ? { fields: command.fields } : {}),
        ...(hasFrom ? { from: position(command.from, 'from'), to: position(command.to, 'to') } : {}),
      };
      break;
    }
    default:
      throw new Error(`annotatedTextAction: unsupported command kind '${String(command.kind)}'`);
  }

  const payload = deepFreeze<AnnotatedTextActionPayload>({
    version: 9,
    id: command.id,
    authoring: { ...command.authoring },
    edit,
  });

  return deepFreeze({
    type: `${entity.name}.${fieldName}.operation`,
    payload,
  });
}

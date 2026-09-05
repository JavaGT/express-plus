export const EventKind = Object.freeze({
  created: 'created',
  updated: 'updated',
  removed: 'removed',
  fieldSet: 'fieldSet',
  native: 'native',
} as const);

export type EventKind = typeof EventKind[keyof typeof EventKind];

const LIFECYCLE_TYPES = new Set([
  EventKind.created,
  EventKind.updated,
  EventKind.removed,
]);
const LIFECYCLE_VERBS = Object.freeze({
  [EventKind.created]: 'create',
  [EventKind.updated]: 'update',
  [EventKind.removed]: 'remove',
} as const);

interface EventHandleBase {
  readonly brand: 'event-handle';
  readonly entity: string;
  toString(): string;
}

export type EventIdentityHandle =
  | (EventHandleBase & {
      readonly kind: typeof EventKind.created;
      readonly type: string;
    })
  | (EventHandleBase & {
      readonly kind: typeof EventKind.updated;
      readonly type: string;
    })
  | (EventHandleBase & {
      readonly kind: typeof EventKind.removed;
      readonly type: string;
    })
  | (EventHandleBase & {
      readonly kind: typeof EventKind.fieldSet;
      readonly field: string;
      readonly type: string;
    })
  | (EventHandleBase & {
      readonly kind: typeof EventKind.native;
      readonly field: string;
      readonly nativeName: string;
      readonly type: string;
    });

function assertName(label: string, value: unknown): void {
  if (typeof value !== 'string' || value.length === 0 || value.includes('.')) {
    throw new Error(`${label} must be a non-empty dot-free string`);
  }
}

interface HandleParts {
  entity: string;
  kind: EventKind;
  field?: string;
  nativeName?: string;
  type: string;
}

function freezeHandle(parts: HandleParts): EventIdentityHandle {
  const handle: Record<string, unknown> = { brand: 'event-handle', ...parts };
  Object.defineProperty(handle, 'toString', { value: () => handle.type });
  return Object.freeze(handle) as unknown as EventIdentityHandle;
}

export function created(entity: string): EventIdentityHandle {
  assertName('event entity', entity);
  return freezeHandle({
    entity,
    kind: EventKind.created,
    type: `${entity}.created`,
  });
}

export function updated(entity: string): EventIdentityHandle {
  assertName('event entity', entity);
  return freezeHandle({
    entity,
    kind: EventKind.updated,
    type: `${entity}.updated`,
  });
}

export function removed(entity: string): EventIdentityHandle {
  assertName('event entity', entity);
  return freezeHandle({
    entity,
    kind: EventKind.removed,
    type: `${entity}.removed`,
  });
}

export function fieldSet(entity: string, field: string): EventIdentityHandle {
  assertName('event entity', entity);
  assertName('event field', field);
  return freezeHandle({
    entity,
    kind: EventKind.fieldSet,
    field,
    type: `${entity}.${field}.set`,
  });
}

export function native(
  entity: string,
  field: string,
  nativeName: string,
): EventIdentityHandle {
  assertName('event entity', entity);
  assertName('event field', field);
  assertName('event native name', nativeName);
  if (nativeName === 'set') return fieldSet(entity, field);
  return freezeHandle({
    entity,
    kind: EventKind.native,
    field,
    nativeName,
    type: `${entity}.${field}.${nativeName}`,
  });
}

function parseEventTypeUncached(type: string): EventIdentityHandle {
  if (typeof type !== 'string') {
    throw new Error(`event type must be a string, got ${typeof type}`);
  }
  const parts = type.split('.');
  if (parts.length === 2) {
    const [entity, kind] = parts;
    if (LIFECYCLE_TYPES.has(kind as typeof EventKind.created)) {
      if (kind === EventKind.created) return created(entity);
      if (kind === EventKind.updated) return updated(entity);
      return removed(entity);
    }
  }
  if (parts.length === 3) {
    const [entity, field, nativeName] = parts;
    return native(entity, field, nativeName);
  }
  throw new Error(`invalid event type '${type}'`);
}

/**
 * The commit and delivery loops parse the same small vocabulary of event type
 * strings once per event per loop; handles are immutable and their identity is
 * the type string, so one parse per distinct string per process is sound. The
 * cache is bounded FIFO: adversarial distinct strings still validate (and
 * throw) exactly as before, they just are not retained.
 */
const PARSED_EVENT_TYPE_CACHE_LIMIT = 1024;
const parsedEventTypeCache = new Map<string, EventIdentityHandle>();

export function parseEventType(type: string): EventIdentityHandle {
  if (typeof type !== 'string') {
    throw new Error(`event type must be a string, got ${typeof type}`);
  }
  const cached = parsedEventTypeCache.get(type);
  if (cached) return cached;
  const handle = parseEventTypeUncached(type);
  parsedEventTypeCache.set(type, handle);
  if (parsedEventTypeCache.size > PARSED_EVENT_TYPE_CACHE_LIMIT) {
    parsedEventTypeCache.delete(parsedEventTypeCache.keys().next().value as string);
  }
  return handle;
}

export function lifecycleVerb(
  handle: EventIdentityHandle | undefined | null,
): 'create' | 'update' | 'remove' | undefined {
  if (!handle || handle.brand !== 'event-handle') return undefined;
  // Native field mutations change an existing entity row just like an update.
  // Routing them through the lifecycle admission keeps field actions on the
  // same row-grant authorization path as PATCH.
  if (handle.kind === EventKind.native) return 'update';
  return LIFECYCLE_VERBS[
    handle.kind as typeof EventKind.created | typeof EventKind.updated | typeof EventKind.removed
  ];
}

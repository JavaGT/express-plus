// Scope handle — typed identity for one entity row in the committed log,
// live delivery, and cursor streams. Derives the persisted scope string
// (`Entity:id`). Peer of Event handle (ADR-0001 / ADR-0004).
//
// Distinct from Grant row-scope (`src/scope.mjs`): that module compiles SQL
// visibility predicates; this module owns identity grammar only.

function assertEntity(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('.') || value.includes(':')) {
    throw new Error('scope entity must be a non-empty string without "." or ":"');
  }
}

function assertId(value) {
  if (value === undefined || value === null || value === '') {
    throw new Error('scope id must be a non-empty value');
  }
}

function freezeHandle(parts) {
  const handle = { brand: 'scope-handle', ...parts };
  Object.defineProperty(handle, 'toString', { value: () => handle.key });
  return Object.freeze(handle);
}

/** Build a Scope handle from entity name + row id. */
export function scopeOf(entity, id) {
  assertEntity(entity);
  assertId(id);
  const idStr = String(id);
  return freezeHandle({ entity, id: idStr, key: `${entity}:${idStr}` });
}

/** Parse a persisted scope key (`Entity:id`) into a Scope handle. Fail closed. */
export function parseScopeKey(key) {
  if (typeof key !== 'string') {
    throw new Error(`scope key must be a string, got ${typeof key}`);
  }
  const colon = key.indexOf(':');
  if (colon <= 0 || colon === key.length - 1) {
    throw new Error(`invalid scope key '${key}'`);
  }
  return scopeOf(key.slice(0, colon), key.slice(colon + 1));
}

/** Like parseScopeKey, but returns null instead of throwing. */
export function tryParseScopeKey(key) {
  try {
    return parseScopeKey(key);
  } catch {
    return null;
  }
}

export function isScopeHandle(value) {
  return !!value && value.brand === 'scope-handle';
}

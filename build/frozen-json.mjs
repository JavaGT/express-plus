function validateJsonInput(value     , seen = new WeakSet     ()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('JSON number must be finite');
    return;
  }
  if (typeof value === 'undefined') throw new Error('JSON value must not be undefined');
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new Error('JSON value must not be a function, symbol, or bigint');
  }
  if (!value || typeof value !== 'object' || seen.has(value)) throw new Error('value is not JSON');
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (!Object.hasOwn(value, i)) throw new Error('JSON array cannot be sparse');
      validateJsonInput(value[i], seen);
    }
    return;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) throw new Error('JSON object must be plain');
  for (const [, item] of Object.entries(value)) {
    validateJsonInput(item, seen);
  }
}

function freezeJson(value     , seen = new WeakSet     ()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('JSON number must be finite');
    return value;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) throw new Error('value is not JSON');
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (!Object.hasOwn(value, i)) throw new Error('JSON array cannot be sparse');
      freezeJson(value[i], seen);
    }
    return Object.freeze(value);
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) throw new Error('JSON object must be plain');
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'undefined') throw new Error(`JSON object property '${key}' is undefined`);
    freezeJson(item, seen);
  }
  return Object.freeze(value);
}

export function frozenJsonSnapshot(value     ) {
  validateJsonInput(value);
  let snapshot     ;
  try {
    snapshot = JSON.parse(JSON.stringify(value));
  } catch {
    throw new Error('value is not JSON');
  }
  return freezeJson(snapshot);
}

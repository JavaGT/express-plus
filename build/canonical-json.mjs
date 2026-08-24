// Canonical JSON serialization for stable payload identity (scope#992 W2
// review round 1). JSON.stringify is insertion-order-sensitive: two payloads
// with the same content but different object-key insertion order produce
// different strings, which made same-actionId retry dedupe falsely report a
// changed-payload conflict. `canonicalStringify` recursively sorts object keys
// (arrays keep their order), so equivalent payloads serialize identically. It
// is the SINGLE canonicalizer shared by receipt storage and every dedupe
// comparison — never hand-rolled at the call sites.

function isPlainObject(value         )                                   {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function canonicalize(value         , seen = new WeakSet        ())          {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null; // JSON.stringify: NaN/Infinity → null
    return value;
  }
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    return undefined; // caller decides: object key dropped, array item → null
  }
  if (seen.has(value          )) throw new TypeError('canonical JSON value must not contain cycles');
  seen.add(value          );
  try {
    if (Array.isArray(value)) {
      return value.map((item) => {
        const canonical = canonicalize(item, seen);
        return canonical === undefined ? null : canonical;
      });
    }
    if (isPlainObject(value)) {
      const names = Object.keys(value).sort();
      const out                          = {};
      for (const name of names) {
        const canonical = canonicalize(value[name], seen);
        if (canonical !== undefined) out[name] = canonical; // JSON.stringify drops undefined props
      }
      return out;
    }
    // Non-plain objects (dates, class instances) have no canonical key order; a
    // payload must be plain JSON to participate in receipt identity.
    astringWarning(value);
    return null;
  } finally {
    seen.delete(value          );
  }
}

let warned = false;
function astringWarning(value         )       {
  if (!warned) {
    warned = true;
    // eslint-disable-next-line no-console
    console.warn(`workbench: canonical JSON encountered a non-plain value (${Object.prototype.toString.call(value)}); serialized as null`);
  }
}

/**
 * Canonical stable serialization: recursively sorted object keys, arrays in
 * their given order. Two JSON-equivalent payloads always produce the same
 * string. Json-stringify edge semantics are preserved (undefined object
 * properties dropped, NaN → null).
 */
export function canonicalStringify(value         )         {
  const canonical = canonicalize(value);
  return canonical === undefined ? 'undefined' : JSON.stringify(canonical);
}
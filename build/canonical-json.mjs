// Canonical JSON serialization for stable payload identity (scope#992 W2
// review round 1). JSON.stringify is insertion-order-sensitive: two payloads
// with the same content but different object-key insertion order produce
// different strings, which made same-actionId retry dedupe falsely report a
// changed-payload conflict. `canonicalStringify` recursively sorts object keys
// (arrays keep their order), so equivalent payloads serialize identically. It
// is the SINGLE canonicalizer shared by receipt storage and every dedupe
// comparison — never hand-rolled at the call sites.
//
// It FAILS CLOSED on every non-JSON-safe value: Date/RegExp/Map/Set, functions,
// symbols, BigInt, null-prototype objects, root undefined, and non-finite
// numbers all throw `CanonicalJsonError` naming the offending path. It never
// silently coerces a non-plain value (two different Dates must never collapse
// to the same receipt identity). Only plain JSON — objects with the
// Object.prototype, finite numbers, strings, booleans, null, arrays — is
// serialized, exactly as JSON.stringify would but with sorted object keys.

import { ValidationError } from './field-strategy.mjs';

/** Typed rejection for a non-JSON-safe value handed to canonicalStringify. */
export class CanonicalJsonError extends ValidationError {
  constructor(message        ) {
    super(message, { code: 'canonical-json-not-plain' });
    this.name = 'CanonicalJsonError';
  }
}

function isPlainObject(value         )                                   {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function reject(path        , what        )        {
  throw new CanonicalJsonError(`canonical JSON value at ${path} is ${what}; receipt identity requires plain JSON`);
}

function describeType(value         )         {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (value instanceof Date) return 'a Date';
  if (value instanceof RegExp) return 'a RegExp';
  if (value instanceof Map) return 'a Map';
  if (value instanceof Set) return 'a Set';
  if (value instanceof Uint8Array || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return 'a typed buffer';
  return `a non-plain object (${Object.prototype.toString.call(value)})`;
}

function canonicalize(value         , seen                 , path        )          {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) reject(path, 'not a finite number');
    return value;
  }
  if (typeof value === 'undefined') reject(path, 'undefined');
  if (typeof value === 'function') reject(path, 'a function');
  if (typeof value === 'symbol') reject(path, 'a symbol');
  if (typeof value === 'bigint') reject(path, 'a BigInt');
  if (seen.has(value          )) throw new CanonicalJsonError(`canonical JSON value at ${path} contains a cycle`);
  seen.add(value          );
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => canonicalize(item, seen, `${path}[${index}]`));
    }
    if (isPlainObject(value)) {
      const names = Object.keys(value).sort();
      const out                          = {};
      for (const name of names) out[name] = canonicalize(value[name], seen, `${path}${path ? '.' : ''}${name}`);
      return out;
    }
    reject(path, describeType(value));
  } finally {
    seen.delete(value          );
  }
  return undefined; // unreachable
}

/**
 * Canonical stable serialization: recursively sorted object keys, arrays in
 * their given order. Two JSON-equivalent plain-JSON payloads always produce the
 * same string. Throws `CanonicalJsonError` naming the offending path on ANY
 * non-JSON-safe value — never a silent coercion.
 */
export function canonicalStringify(value         )         {
  const canonical = canonicalize(value, new WeakSet(), 'payload');
  return JSON.stringify(canonical);
}
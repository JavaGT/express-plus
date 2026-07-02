import { getActiveEntity, setActiveEntity } from '../db.mjs';
import { fieldHandle } from '../scope-sql.mjs';
import { created, updated, removed } from '../event-handle.mjs';

// Lifecycle event handles are reserved member names on an entity handle:
// `Doc.created` / `Doc.updated` / `Doc.removed` are typed, stringifiable event
// handles (a derived identifier, never a magic string literal). A declared
// field may not take one of these names (the compiler rejects it at load time),
// so the proxy may resolve them unambiguously before the field lookup.
const LIFECYCLE_HANDLES = Object.freeze({
  created: (name) => created(name),
  updated: (name) => updated(name),
  removed: (name) => removed(name),
});

export function registerEntityHandle({ record, fields, name }) {
  const frozen = Object.freeze(record);
  const proxy = new Proxy(frozen, {
    get(target, key, receiver) {
      if (key in target || typeof key !== 'string') {
        return Reflect.get(target, key, receiver);
      }
      if (key === 'id') return { fieldName: 'id' };
      if (LIFECYCLE_HANDLES[key]) {
        return LIFECYCLE_HANDLES[key](name);
      }
      if (Object.prototype.hasOwnProperty.call(fields, key)) {
        return fieldHandle(key, fields[key], name, getActiveEntity);
      }
      return undefined;
    },
  });
  setActiveEntity(name, proxy);
  return proxy;
}

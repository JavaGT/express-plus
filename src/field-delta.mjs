import { EventKind } from './event-handle.mjs';
import { resolveStrategy } from './field-strategy.mjs';

const DIFF_ELIGIBLE = new Set(['value', 'state', 'crdt', 'struct']);
const DEFAULT_MAX_SCOPES = 10_000;

export function computeDelta(entityRecord, prevRow, nextRow, changedFieldNames) {
  const prev = prevRow ?? {};
  const next = nextRow ?? {};
  const fields = entityRecord.fields ?? {};
  const result = {};
  const fieldNames = changedFieldNames != null
    ? changedFieldNames
    : Object.keys(fields);

  for (const fieldName of fieldNames) {
    const descriptor = fields[fieldName];
    if (!descriptor) continue;
    const kind = descriptor.kind;
    if (!DIFF_ELIGIBLE.has(kind)) continue;
    const strategy = resolveStrategy(kind);
    const delta = strategy.diff(prev[fieldName], next[fieldName], descriptor);
    if (delta != null) result[fieldName] = delta;
  }

  return result;
}

export function createDeltaProjector({ maxScopes = DEFAULT_MAX_SCOPES } = {}) {
  const prevState = new Map();

  function scopeFor(entityRecord, id) {
    return `${entityRecord.name}:${String(id)}`;
  }

  function seed(scope, row) {
    prevState.set(scope, row);
    if (prevState.size > maxScopes) {
      const oldest = prevState.keys().next().value;
      prevState.delete(oldest);
    }
  }

  function project(entityRecord, id, row, committedEvent) {
    const handle = committedEvent?.handle;
    if (handle?.brand !== 'event-handle') return undefined;
    const scope = scopeFor(entityRecord, id);

    if (row === undefined || handle.kind === EventKind.removed) {
      prevState.delete(scope);
      return undefined;
    }

    if (handle.kind === EventKind.created) {
      seed(scope, row);
      return undefined;
    }

    if (handle.kind === EventKind.updated) {
      const changed = Object.keys(committedEvent.data ?? {}).filter((key) => key !== 'id');
      const delta = computeDelta(entityRecord, prevState.get(scope) ?? {}, row, changed);
      seed(scope, row);
      return delta;
    }

    if (handle.kind === EventKind.native) {
      return { [handle.field]: committedEvent.data };
    }

    return undefined;
  }

  function clear() {
    prevState.clear();
  }

  return Object.freeze({ project, clear });
}

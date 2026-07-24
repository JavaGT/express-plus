import { EventKind } from './event-handle.mjs';
import { resolveStrategy } from './field-strategy.mjs';
import { config } from './config.mjs';
import { getLog } from './log.mjs';
import { scopeOf } from './scope-handle.mjs';

const DIFF_ELIGIBLE = new Set(['value', 'state', 'struct']);
const DEFAULT_MAX_SCOPES = 10_000;

function isReplaceStubCrdt(descriptor) {
  return descriptor?.kind === 'crdt' && (descriptor.type === 'raster' || descriptor.type === 'polyline');
}

function reportReplaceStubDelta(entityRecord, fieldName, descriptor, diagnostics) {
  if (config.env === 'production') return;
  const ctx = { entity: entityRecord.name, field: fieldName, type: descriptor.type };
  if (typeof diagnostics === 'function') {
    diagnostics(ctx);
    return;
  }
  getLog().warn('live', 'replace-stub crdt field updated with last-write-wins semantics; concurrent edits will not merge', ctx);
}

export function computeDelta(entityRecord, prevRow, nextRow, changedFieldNames, { diagnostics = null } = {}) {
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
    if (delta != null) {
      result[fieldName] = delta;
      if (isReplaceStubCrdt(descriptor)) reportReplaceStubDelta(entityRecord, fieldName, descriptor, diagnostics);
    }
  }

  return result;
}

export function createDeltaProjector({ maxScopes = DEFAULT_MAX_SCOPES, diagnostics = null } = {}) {
  const prevState = new Map();

  function scopeFor(entityRecord, id) {
    return scopeOf(entityRecord.name, id).key;
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
      const delta = computeDelta(entityRecord, prevState.get(scope) ?? {}, row, changed, { diagnostics });
      seed(scope, row);
      return delta;
    }

    if (handle.kind === EventKind.native) {
      if (entityRecord.fields?.[handle.field]?.kind === 'crdt' && entityRecord.fields[handle.field].type === 'text') {
        return undefined;
      }
      return { [handle.field]: committedEvent.data };
    }

    return undefined;
  }

  function clear() {
    prevState.clear();
  }

  return Object.freeze({ project, clear });
}

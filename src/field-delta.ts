import { EventKind } from './event-handle.ts';
import type { EventIdentityHandle } from './event-handle.ts';
import { resolveStrategy } from './field-strategy.ts';
import type { EntityRecord, FieldDescriptor } from './field-strategy.ts';
import { config } from './config.ts';
import { getLog } from './log.ts';
import { scopeOf } from './scope-handle.ts';

const DIFF_ELIGIBLE = new Set(['value', 'state', 'struct']);
const DEFAULT_MAX_SCOPES = 10_000;

export interface DeltaDiagnostics {
  (context: { entity: string; field: string; type: string | undefined }): void;
}

export interface DeltaCommittedEvent {
  handle?: EventIdentityHandle;
  data?: Record<string, unknown> | null;
}

export interface DeltaProjector {
  project(entityRecord: EntityRecord, id: unknown, row: unknown, committedEvent?: DeltaCommittedEvent | null): Record<string, unknown> | undefined;
  clear(): void;
}

function isReplaceStubCrdt(descriptor: FieldDescriptor) {
  return descriptor?.kind === 'crdt' && (descriptor.type === 'raster' || descriptor.type === 'polyline');
}

function reportReplaceStubDelta(entityRecord: EntityRecord, fieldName: string, descriptor: FieldDescriptor, diagnostics: DeltaDiagnostics | null) {
  if (config.env === 'production') return;
  const ctx = { entity: entityRecord.name, field: fieldName, type: descriptor.type };
  if (typeof diagnostics === 'function') {
    diagnostics(ctx);
    return;
  }
  getLog().warn('live', 'replace-stub crdt field updated with last-write-wins semantics; concurrent edits will not merge', ctx);
}

export function computeDelta(
  entityRecord: EntityRecord,
  prevRow: unknown,
  nextRow: unknown,
  changedFieldNames: string[] | null | undefined,
  { diagnostics = null }: { diagnostics?: DeltaDiagnostics | null } = {},
): Record<string, unknown> {
  const prev = (prevRow ?? {}) as Record<string, unknown>;
  const next = (nextRow ?? {}) as Record<string, unknown>;
  const fields = entityRecord.fields ?? {};
  const result: Record<string, unknown> = {};
  const fieldNames = changedFieldNames != null
    ? changedFieldNames
    : Object.keys(fields);

  for (const fieldName of fieldNames) {
    const descriptor = fields[fieldName];
    if (!descriptor) continue;
    const kind = descriptor.kind;
    if (!DIFF_ELIGIBLE.has(kind)) continue;
    const strategy = resolveStrategy(kind);
    const delta = strategy.diff?.(prev[fieldName], next[fieldName], descriptor);
    if (delta != null) {
      result[fieldName] = delta;
      if (isReplaceStubCrdt(descriptor)) reportReplaceStubDelta(entityRecord, fieldName, descriptor, diagnostics);
    }
  }

  return result;
}

export function createDeltaProjector({
  maxScopes = DEFAULT_MAX_SCOPES,
  diagnostics = null,
}: { maxScopes?: number; diagnostics?: DeltaDiagnostics | null } = {}): DeltaProjector {
  const prevState = new Map<string, unknown>();

  function scopeFor(entityRecord: EntityRecord, id: unknown) {
    return scopeOf(entityRecord.name, id).key;
  }

  function seed(scope: string, row: unknown) {
    prevState.set(scope, row);
    if (prevState.size > maxScopes) {
      const oldest = prevState.keys().next().value;
      prevState.delete(oldest as string);
    }
  }

  function project(entityRecord: EntityRecord, id: unknown, row: unknown, committedEvent?: DeltaCommittedEvent | null) {
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
      const changed = Object.keys(committedEvent?.data ?? {}).filter((key) => key !== 'id');
      const delta = computeDelta(entityRecord, prevState.get(scope) ?? {}, row, changed, { diagnostics });
      seed(scope, row);
      return delta;
    }

    if (handle.kind === EventKind.native) {
      if (entityRecord.fields?.[handle.field]?.kind === 'crdt' && entityRecord.fields[handle.field].type === 'text') {
        return undefined;
      }
      return { [handle.field]: committedEvent?.data };
    }

    return undefined;
  }

  function clear() {
    prevState.clear();
  }

  return Object.freeze({ project, clear });
}

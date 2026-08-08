// Live fan-out core — scope-keyed subscription registry, delivery-time
// re-authorization, pace buffers, and event delivery.
//
// W5 slice 2: registry is keyed by scope string (e.g. "Entity:id" for
// per-entity, "project:p1" for coarse). The old entity→id→conn map
// is retired — per-entity is a degenerate scope, not a separate path.
//
// W3 slice 2: a foreign-entity event (e.g. a Job event) may ride the ANCHOR
// row's own scope stream (e.g. "Project:p1") when its committedEvent.scope
// equals that anchor's Scope handle key — authz is re-checked against the
// anchor row, never against the foreign entity. Any other entity mismatch
// is still dropped (guards caller bugs on the per-entity path).
//
// This module also owns the shared live-delivery type vocabulary (entity
// records, connections, database, fan-out handles) that the admission,
// connection, core, and public delivery modules all consume.

import type { Principal } from './principal.ts';
import { anonymous } from './principal.ts';
import { mayRow } from './row-grant.ts';
import { PACE_STRATEGIES } from './field-pace.ts';
import type { PaceProfile } from './field-pace.ts';
import { createDeltaProjector } from './field-delta.ts';
import { EventKind, parseEventType } from './event-handle.ts';
import type { EventIdentityHandle } from './event-handle.ts';
import { scopeOf, tryParseScopeKey } from './scope-handle.ts';
import type { ScopeHandle } from './scope-handle.ts';
import { createdTextReducerSeeds } from './text-reducer-transport.ts';
import { publicEvent } from './event-delivery.ts';

// ---- Shared live-delivery type vocabulary ---------------------------------

export interface FieldDescriptor {
  kind?: string;
  type?: string;
  [key: string]: unknown;
}

/** The subset of a compiled entity record the live-delivery seams rely on. */
export interface LiveEntityRecord {
  name: string;
  fields?: Record<string, FieldDescriptor>;
  scopeFilter(principal: Principal): { sql: string; params: Readonly<Record<string, unknown>> };
  hydrate?(raw: unknown, principal: Principal): Record<string, unknown> | null | undefined;
  findById?(id: string, principal: unknown): Record<string, unknown> | null | undefined;
  [key: string]: unknown;
}

export type MayVerb = (
  entity: LiveEntityRecord,
  verb: string,
  row: Record<string, unknown> | null | undefined,
  principal: Principal,
) => boolean | Promise<boolean>;

// A row read from the SQLite layer. The optional lastSeq keeps the shape
// compatible with cursor.ts's narrow CursorDatabase contract.
export interface LiveRow extends Record<string, unknown> {
  lastSeq?: number;
}

export interface LiveStatement {
  run(...params: unknown[]): { changes: number | bigint };
  get(...params: unknown[]): LiveRow | undefined;
  all(...params: unknown[]): LiveRow[];
}

export interface LiveDatabase {
  prepare(sql: string): LiveStatement;
  exec(sql: string): void;
}

/** Structural connection contract — the LiveConnection class satisfies it. */
export interface LiveConn {
  readonly id: string;
  readonly closed: boolean;
  readonly principal: Principal | null;
  send(data: unknown): void;
}

export interface LiveSubscriptionSpec {
  fields: Record<string, true> | null;
  latch: boolean;
  pace: PaceProfile | null;
  interest: Record<string, unknown>;
}

interface PaceBufferEntry {
  conn: LiveConn;
  scope: string;
  field: string | null;
  events: unknown[];
  timer: ReturnType<typeof setTimeout> | null;
  by: string | null;
  entityRecord: LiveEntityRecord;
  authzRow: Record<string, unknown> | undefined;
}

export interface FanoutCommittedEvent {
  type: string;
  scope?: string;
  seq?: number;
  data?: Record<string, unknown>;
  handle?: EventIdentityHandle | null;
  [key: string]: unknown;
}

export interface LiveFanoutHandle {
  addSubscription(scope: string, conn: LiveConn, fields?: Record<string, true> | null, pace?: PaceProfile | null, interest?: Record<string, unknown>): void;
  removeSubscription(scope: string, conn: LiveConn): void;
  removeAll(conn: LiveConn): void;
  subscriptionCount(conn: LiveConn): number;
  hasSubscription(conn: LiveConn, scopeOrEntity: string, id?: unknown): boolean;
  recipients(scope: string, field: string): Array<[LiveConn, LiveSubscriptionSpec]>;
  hasCaretInterest(conn: LiveConn, scope: string, field: string): boolean;
  setOnCaretInterestChange(callback: ((conn: LiveConn, scope: string, removedFields: string[]) => void) | null): void;
  emit(entityRecord: LiveEntityRecord, id: unknown, row: Record<string, unknown> | undefined, committedEvent: FanoutCommittedEvent, options?: { hydrated?: boolean }): Promise<void>;
  close(): void;
}

// ---- Live fan-out -----------------------------------------------------------

function hasAnnotatedText(entityRecord: LiveEntityRecord): boolean {
  return Object.values(entityRecord.fields ?? {}).some((field) => field?.kind === 'annotatedText');
}

export function createLiveFanout({ mayVerb = null }: { mayVerb?: MayVerb | null } = {}): LiveFanoutHandle {
  const byScope = new Map<string, Map<LiveConn, LiveSubscriptionSpec>>(); // Map<scopeKey, Map<conn, SubSpec>>
  const connSubs = new Map<LiveConn, Set<string>>();  // Map<conn, Set<scopeKey>>
  const paceBuffers = new Map<string, PaceBufferEntry>();
  let onCaretInterestChange: ((conn: LiveConn, scope: string, removedFields: string[]) => void) | null = null;

  const deltaProjector = createDeltaProjector();

  function subscriptionCount(conn: LiveConn): number {
    return connSubs.get(conn)?.size ?? 0;
  }

  // hasSubscription(conn, scopeOrEntity, id?) — two-arg form checks by scope
  // key; three-arg form derives the key via Scope handle.
  function hasSubscription(conn: LiveConn, scopeOrEntity: string, id?: unknown): boolean {
    if (arguments.length >= 3) {
      return connSubs.get(conn)?.has(scopeOf(scopeOrEntity, id).key) ?? false;
    }
    return connSubs.get(conn)?.has(scopeOrEntity) ?? false;
  }

  function addSubscription(a: string | ScopeHandle | LiveEntityRecord, b: LiveConn, c: Record<string, true> | null | undefined = null, d: PaceProfile | null | undefined = null, e: Record<string, unknown> = {}): void {
    // Scope key form (contains ':') or Scope handle → scope-keyed path.
    // Legacy entity+id form still works; both concentrate through Scope handle.
    if (typeof a === 'string' && a.includes(':')) {
      addSubscriptionScope(a, b, c, d, e);
      return;
    }
    if (a && (a as { brand?: unknown }).brand === 'scope-handle') {
      addSubscriptionScope((a as ScopeHandle).key, b, c, d, e);
      return;
    }
    addSubscriptionLegacy(a as string, b as unknown, c as unknown as LiveConn, d as never);
  }

  function addSubscriptionScope(scope: string, conn: LiveConn, fields: Record<string, true> | null = null, pace: PaceProfile | null = null, interest: Record<string, unknown> = {}): void {
    if (!byScope.has(scope)) byScope.set(scope, new Map());
    const previous = byScope.get(scope)!.get(conn);
    const nextCarets = (interest.carets as string[] | undefined) ?? [];
    const removedCarets = ((previous?.interest?.carets as string[] | undefined) ?? []).filter((field) => !nextCarets.includes(field));
    if (removedCarets.length > 0) onCaretInterestChange?.(conn, scope, removedCarets);
    byScope.get(scope)!.set(conn, { fields, latch: true, pace, interest });
    let mine = connSubs.get(conn);
    if (!mine) { mine = new Set(); connSubs.set(conn, mine); }
    mine.add(scope);
  }

  function addSubscriptionLegacy(entity: string, id: unknown, conn: LiveConn, fields: Record<string, true> | null | undefined = null, pace: PaceProfile | null | undefined = null): void {
    const handle = scopeOf(entity, id);
    addSubscriptionScope(handle.key, conn, fields, pace, { entity: handle.entity, id: handle.id });
  }

  function removeSubscription(a: string | ScopeHandle | LiveEntityRecord, b: LiveConn, c?: unknown): void {
    if (typeof a === 'string' && a.includes(':')) {
      removeSubscriptionScope(a, b);
      return;
    }
    if (a && (a as { brand?: unknown }).brand === 'scope-handle') {
      removeSubscriptionScope((a as ScopeHandle).key, b);
      return;
    }
    removeSubscriptionLegacy(a as string, b as unknown, c as unknown as LiveConn);
  }

  function removeSubscriptionScope(scope: string, conn: LiveConn): void {
    const subs = byScope.get(scope);
    if (subs) {
      const removedCarets = (subs.get(conn)?.interest?.carets as string[] | undefined) ?? [];
      if (removedCarets.length > 0) onCaretInterestChange?.(conn, scope, removedCarets);
      subs.delete(conn);
      if (subs.size === 0) byScope.delete(scope);
    }
    const mine = connSubs.get(conn);
    if (mine) {
      mine.delete(scope);
      if (mine.size === 0) connSubs.delete(conn);
    }
  }

  function removeSubscriptionLegacy(entity: string, id: unknown, conn: LiveConn): void {
    removeSubscriptionScope(scopeOf(entity, id).key, conn);
  }

  function removeAll(conn: LiveConn): void {
    const mine = connSubs.get(conn);
    if (!mine) return;
    for (const scope of mine) {
      const subs = byScope.get(scope);
      if (subs) {
        const removedCarets = (subs.get(conn)?.interest?.carets as string[] | undefined) ?? [];
        if (removedCarets.length > 0) onCaretInterestChange?.(conn, scope, removedCarets);
        subs.delete(conn);
        if (subs.size === 0) byScope.delete(scope);
      }
    }
    connSubs.delete(conn);

    for (const [bufKey, entry] of paceBuffers) {
      if (entry.conn === conn) {
        if (entry.timer !== null) { clearTimeout(entry.timer); entry.timer = null; }
        paceBuffers.delete(bufKey);
      }
    }

  }

  function recipients(scope: string, field: string): Array<[LiveConn, LiveSubscriptionSpec]> {
    return [...(byScope.get(scope) ?? [])]
      .filter(([conn, spec]) => !conn.closed && ((spec.interest?.carets as string[] | undefined)?.includes(field) ?? false));
  }

  function hasCaretInterest(conn: LiveConn, scope: string, field: string): boolean {
    return ((byScope.get(scope)?.get(conn)?.interest?.carets as string[] | undefined)?.includes(field)) ?? false;
  }

  function setOnCaretInterestChange(callback: ((conn: LiveConn, scope: string, removedFields: string[]) => void) | null): void {
    onCaretInterestChange = callback;
  }

  async function flushPacedBuffer(key: string): Promise<void> {
    const entry = paceBuffers.get(key);
    if (!entry) return;
    const { conn, scope, events, entityRecord, authzRow } = entry;
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    paceBuffers.delete(key);
    if (events.length === 0) return;
    if (conn.closed) return;

    if (!(await mayRow(entityRecord as never, 'subscribe', authzRow, conn.principal ?? anonymous, mayVerb as never))) return;

    const kind = PACE_STRATEGIES.ephemeral;
    const coalescer = entry.by ? kind.coalescers[entry.by] : null;
    const coalesced = coalescer ? events.reduce(coalescer) : events[events.length - 1];
    const reduceSpan = kind.reduceSpan;
    if (!reduceSpan) return;
    const span = reduceSpan(events as Parameters<NonNullable<typeof kind.reduceSpan>>[0]);
    const handle = tryParseScopeKey(scope);
    const entityName = handle?.entity ?? scope;
    const idStr = handle?.id ?? scope;
    conn.send({
      type: 'event', entity: entityName, id: idStr,
      seq: span.seq, seqSpan: span.seqSpan, event: publicEvent(coalesced as Parameters<typeof publicEvent>[0]),
    });
  }

  // Fan-out: forward a committed kernel event to authorized subscribers
  // of the event's scope. One registry, one fan-out path.
  async function emit(entityRecord: LiveEntityRecord, id: unknown, row: Record<string, unknown> | undefined, committedEvent: FanoutCommittedEvent, { hydrated = false }: { hydrated?: boolean } = {}): Promise<void> {
    const name = entityRecord?.name;
    if (!name) return;
    let committed: FanoutCommittedEvent = committedEvent;
    if (committed.handle?.brand !== 'event-handle') {
      try {
        committed = { ...committedEvent };
        Object.defineProperty(committed, 'handle', { value: parseEventType(committedEvent.type), enumerable: false });
        Object.freeze(committed);
      } catch { return; }
    }
    const handle = committed.handle as EventIdentityHandle;
    // Scope-anchored case: a foreign-entity event (e.g. Job.updated) riding
    // the anchor row's own scope stream. The caller deliberately delivers it
    // here, authorized against the anchor row — not a per-entity mismatch.
    let scopeAnchored = false;
    if (handle.entity !== name) {
      let anchorKey;
      try { anchorKey = scopeOf(name, id).key; } catch { return; }
      if (typeof committedEvent.scope !== 'string' || committedEvent.scope !== anchorKey) return;
      scopeAnchored = true;
    }

    const eventScope = committedEvent.scope ?? scopeOf(name, id).key;
    const directScope = scopeOf(name, id).key;
    const removed = row === undefined;

    // Annotated-text operations have no recipient event grammar. Classify them
    // before delta/reducer construction so canonical family facts cannot enter
    // any live envelope; recipients recover through the projected snapshot.
    const isAnnotatedTextOperation = !scopeAnchored
      && eventScope === directScope
      && handle.kind === EventKind.native
      && handle.nativeName === 'operated'
      && entityRecord.fields?.[handle.field]?.kind === 'annotatedText';

    let authzRow: Record<string, unknown> | undefined = row;
    if (!removed && !hydrated && entityRecord.findById) {
      try { authzRow = entityRecord.findById(String(id), null) ?? row; } catch { authzRow = row; }
    }

    let ephemeralField: string | null = null;
    // Ephemeral-field pacing only makes sense on the per-entity path — a
    // scope-anchored foreign event (e.g. Job.updated) never has a field on
    // the anchor entity's fieldSet grammar, so it can't false-trigger this.
    if (!scopeAnchored && !removed && handle.kind === EventKind.fieldSet) {
      const fd = entityRecord.fields?.[handle.field];
      if (fd?.kind === 'ephemeral') {
        ephemeralField = handle.field;
      }
    }
    const isAnnotatedTextEphemeral = ephemeralField !== null && hasAnnotatedText(entityRecord);

    // Delta projection is per-entity state diffing; a scope-anchored foreign
    // event carries its own data and must not be fed to the anchor's projector.
    const delta = scopeAnchored || isAnnotatedTextOperation || isAnnotatedTextEphemeral
      ? undefined
      : deltaProjector.project(entityRecord as never, id, authzRow, committed as never);

    const scopeSubs = byScope.get(eventScope);
    if (!scopeSubs) return;

    for (const [conn, subSpec] of scopeSubs) {
      if (conn.closed) {
        scopeSubs.delete(conn);
        continue;
      }
      if (!removed && !(await mayRow(entityRecord as never, 'subscribe', authzRow, conn.principal ?? anonymous, mayVerb as never))) {
        continue;
      }

      // Annotated-text resync must be sent to ALL subscribers regardless of
      // field interest — the subscriber needs to know about the event to
      // maintain its cursor, even if it didn't ask for the ephemeral field.
      if (isAnnotatedTextOperation || isAnnotatedTextEphemeral) {
        const seq = committed.seq as number;
        if (!Number.isSafeInteger(seq) || seq < 0) continue;
        conn.send({
          type: 'resync', entity: name, id, seq,
          reason: 'annotated-text-snapshot-required',
        });
        continue;
      }

      if (ephemeralField !== null) {
        const fields = subSpec?.fields;
        if (!fields || fields[ephemeralField] !== true) continue;
      }

      let pace: PaceProfile = { window: 0, by: null };
      if (ephemeralField !== null && subSpec?.pace !== null && subSpec?.pace !== undefined) {
        pace = subSpec.pace;
      }

      if (pace.window === 0) {
        // Envelope identity (entity, id) is always the ANCHOR — matching the
        // subscription's scope — even for a scope-anchored foreign event;
        // the nested `event` carries its own type/data (e.g. Job.updated).
        const envelope: Record<string, unknown> = {
          type: 'event', entity: name, id, seq: committed.seq,
          seqSpan: [committed.seq, committed.seq],
          event: publicEvent(committed),
        };
        if (delta !== undefined) envelope.delta = delta;
        const reducers = createdTextReducerSeeds(entityRecord, committed as Parameters<typeof createdTextReducerSeeds>[1]);
        if (reducers) envelope.reducers = reducers;
        conn.send(envelope);
      } else {
        const bufKey = `${conn.id}|${eventScope}|${ephemeralField}`;
        let entry = paceBuffers.get(bufKey);
        if (!entry) {
          entry = {
            conn,
            scope: eventScope,
            field: ephemeralField,
            events: [],
            timer: null,
            by: pace.by,
            entityRecord,
            authzRow,
          };
          paceBuffers.set(bufKey, entry);
        }
        entry.events.push(committed);
        entry.authzRow = authzRow;
        if (entry.timer === null) {
          entry.timer = setTimeout(() => flushPacedBuffer(bufKey), pace.window);
        }
      }
    }
  }

  function close(): void {
    byScope.clear();
    connSubs.clear();
    for (const [, entry] of paceBuffers) {
      if (entry.timer !== null) { clearTimeout(entry.timer); entry.timer = null; }
    }
    paceBuffers.clear();
    deltaProjector.clear();
  }

  return {
    addSubscription,
    removeSubscription,
    removeAll,
    subscriptionCount,
    hasSubscription,
    recipients,
    hasCaretInterest,
    setOnCaretInterestChange,
    emit,
    close,
  };
}

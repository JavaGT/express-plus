// Shared live delivery envelope builder — package-private projection helper.
//
// One envelope grammar for all live delivery paths (committed-event core and
// ephemeral fan-out). The core uses buildEnvelope to produce the same delta,
// reducer, and annotated-text resync envelopes that the fan-out produced.
//
// Delta projector state is owned by the builder instance and must be reused
// for the lifetime of the delivery seam, not recreated per batch.

import { createDeltaProjector } from './field-delta.ts';
import type { DeltaProjector } from './field-delta.ts';
import { EventKind, parseEventType } from './event-handle.ts';
import type { EventIdentityHandle } from './event-handle.ts';
import type { EntityRecord } from './field-strategy.ts';
import { createdTextReducerSeeds } from './text-reducer-transport.ts';
import type { TextReducerSeed } from './text-reducer-transport.ts';
import { tryParseScopeKey } from './scope-handle.ts';
import type { CollectionChange } from './collection-subscription.ts';

// S3/A7 envelope grammar: feature code distinguishes full-log `event` delivery
// from live `state` replacement / `state-invalidate` recovery purely by the
// envelope kind — never by the storage tier behind the resource. The existing
// `resync` grammar is retained unchanged for composite/text recovery controls.

export interface LiveEnvelopeEvent {
  type: string;
  scope: string;
  seq: number;
  committedAt: string;
  actionId?: string;
  data?: Record<string, unknown>;
  handle?: EventIdentityHandle;
}

export interface CommittedEventLike {
  seq: number;
  scope: string;
  committedAt: string;
  eventType?: string;
  type?: string;
  actionId?: string;
}

export interface EnvelopeContext {
  entity: EntityRecord & { tier?: 'history' | 'live' };
  event: CommittedEventLike;
  principal: unknown;
  row: Record<string, unknown> | null | undefined;
  scope: string;
  composite?: boolean;
  document?: unknown;
  // The principal's readable field subset (S5/A3). When present, native-field
  // deltas and text reducer seeds for unreadable fields are withheld.
  readableFields?: ReadonlySet<string>;
}

export type LiveEnvelopeKind = 'event' | 'state' | 'state-invalidate' | 'resync';

export interface LiveEnvelope {
  type: LiveEnvelopeKind;
  entity?: string;
  id?: string;
  seq?: number;
  seqSpan?: [number, number];
  event?: LiveEnvelopeEvent;
  // `state` replacement projection for a live resource. For a live row this
  // is the recipient-projected declared-field view; for a live collection it
  // is the bounded membership replacement (additions/removals/reorderings/rows).
  state?: Record<string, unknown>;
  additions?: readonly Record<string, unknown>[];
  removals?: readonly string[];
  reorderings?: readonly { id: string; from: number; to: number }[];
  rows?: readonly Record<string, unknown>[];
  delta?: Record<string, unknown>;
  reducers?: TextReducerSeed[];
  reason?: string;
}

export interface LiveEnvelopeBuilder {
  buildEnvelope(ctx: EnvelopeContext): LiveEnvelope[];
  clear(): void;
}

function hasAnnotatedText(entityRecord: EntityRecord) {
  return Object.values(entityRecord.fields ?? {}).some((field) => field?.kind === 'annotatedText');
}

function assertCommittedSequence(event: CommittedEventLike) {
  if (!Number.isSafeInteger(event.seq) || event.seq < 0) {
    throw new Error('invalid committed event sequence');
  }
}

function recovery(ctx: EnvelopeContext, entity: string, id: string, reason: string): LiveEnvelope[] {
  return [{ type: 'resync', entity, id, seq: ctx.event.seq, reason }];
}

function recipientLifecycleData(ctx: EnvelopeContext, handle: EventIdentityHandle, id: string): Record<string, unknown> | null {
  if (handle.kind === EventKind.removed) return { id };
  if (!ctx.row || typeof ctx.row !== 'object' || Array.isArray(ctx.row)) return null;

  const declared = ctx.entity?.fields ?? {};
  // Recipient lifecycle output derives only from declarations and the
  // recipient-hydrated row, never from raw durable operation keys.
  const keys = Object.keys(declared);
  const data: Record<string, unknown> = { id };
  for (const key of keys) {
    if (Object.hasOwn(ctx.row, key)) data[key] = ctx.row[key];
  }
  return data;
}

export function createLiveEnvelopeBuilder({ stateful = true, includeActionId = true } = {}): LiveEnvelopeBuilder {
  const deltaProjector: DeltaProjector | null = stateful ? createDeltaProjector() : null;

  function buildEnvelope(ctx: EnvelopeContext): LiveEnvelope[] {
    const handle = tryParseScopeKey(ctx.scope);
    if (!handle) return [];
    assertCommittedSequence(ctx.event);

    const entityName = handle.entity;
    const id = handle.id;

    // Aggregate scope declarations have no public event reducer. Every fact,
    // including one on the anchor itself, is an opaque snapshot boundary.
    if (ctx.composite) return recovery(ctx, entityName, id, 'recipient-snapshot-required');

    // _Log rows carry storage columns such as eventType/eventData. The durable
    // payload is rebuilt below from the recipient-hydrated row, never copied.
    const loggedEvent: LiveEnvelopeEvent = {
      type: ctx.event.eventType ?? (ctx.event.type as string),
      scope: ctx.event.scope,
      seq: ctx.event.seq,
      committedAt: ctx.event.committedAt,
    };
    if (includeActionId) loggedEvent.actionId = ctx.event.actionId;

    let evHandle;
    try {
      evHandle = parseEventType(loggedEvent.type);
    } catch {
      throw new Error('invalid committed event type');
    }

    const lifecycle = [EventKind.created, EventKind.updated, EventKind.removed].includes(
      evHandle.kind as typeof EventKind.created | typeof EventKind.updated | typeof EventKind.removed,
    );
    if (evHandle.entity !== entityName) {
      // A composite stream can be anchored to an authorized container such as
      // Project while carrying changes to many declared child entities. Without
      // a declared cross-entity recipient grammar, the only safe output is an
      // opaque snapshot requirement, never the raw event fact.
      return recovery(ctx, entityName, id, 'recipient-snapshot-required');
    }

    if (!lifecycle) {
      return recovery(ctx, entityName, id, hasAnnotatedText(ctx.entity)
        ? 'annotated-text-snapshot-required'
        : 'recipient-snapshot-required');
    }

    const data = recipientLifecycleData(ctx, evHandle, id);
    if (!data) throw new Error('invalid lifecycle event data');
    // A live-tier resource has no committed event history: the revision-driven
    // row IS the recipient's authoritative state. Emit a `state` replacement —
    // never a logged `event` — so feature code sees the envelope kind, never the
    // storage tier. Delta/reducer grammar is meaningless for a whole-state
    // replacement and is intentionally absent. `seq` carries the live revision.
    if (ctx.entity.tier === 'live') {
      return [{ type: 'state', entity: entityName, id, seq: ctx.event.seq, state: data }];
    }
    const event: LiveEnvelopeEvent = { ...loggedEvent, data };
    Object.defineProperty(event, 'handle', { value: evHandle, enumerable: false });

    const envelope: LiveEnvelope = {
      type: 'event',
      entity: entityName,
      id,
      seq: ctx.event.seq,
      seqSpan: [ctx.event.seq, ctx.event.seq],
      event,
    };
    // Public transport-neutral delivery is a stateless recipient grammar.
    // Delta baselines and reducer seeds belong to the connection-owned WebSocket
    // path; sharing either between recipients would make delivery state unsafe.
    if (deltaProjector) {
      // Field-read admission (S5/A3): a native delta names its field explicitly
      // (the whole committed data under the field key), so it is withheld when
      // the principal cannot read that field. Updated-event deltas are already
      // confined to the projected row + lifecycle data (readable fields only).
      const fieldReadable = ctx.readableFields == null || evHandle.kind !== EventKind.native || ctx.readableFields.has(evHandle.field as string);
      if (fieldReadable) {
        const delta = deltaProjector.project(ctx.entity, id, ctx.row, event);
        if (delta !== undefined) envelope.delta = delta;
      }
      const reducers = createdTextReducerSeeds(ctx.entity, event);
      if (reducers) {
        envelope.reducers = ctx.readableFields == null ? reducers : reducers.filter((seed) => ctx.readableFields!.has(seed.field));
      }
    }

    return [envelope];
  }

  function clear() {
    deltaProjector?.clear();
  }

  return { buildEnvelope, clear };
}

// Translate a collection subscription's internal change into the shared live
// envelope grammar. The change carries the bounded membership replacement; a
// bounded-overflow boundary demotes the whole delivery to `state-invalidate`
// so the client resnapshots/refreshes instead of trusting a truncated view.
// The membership data is still carried (informational — a client may show the
// partial view while its resnapshot is in flight) but the kind is the
// invalidation boundary and never reconciles authoritative state by itself.
export function collectionDeliveryEnvelope(
  change: CollectionChange,
  ctx: { entityName: string; revision: number },
): LiveEnvelope {
  if (change.overflow !== null) {
    return {
      type: 'state-invalidate',
      entity: ctx.entityName,
      id: ctx.entityName,
      seq: ctx.revision,
      reason: 'bounded-overflow',
      additions: change.additions,
      removals: change.removals,
      reorderings: change.reorderings,
      rows: change.rows,
    };
  }
  return {
    type: 'state',
    entity: ctx.entityName,
    id: ctx.entityName,
    seq: ctx.revision,
    additions: change.additions,
    removals: change.removals,
    reorderings: change.reorderings,
    rows: change.rows,
  };
}

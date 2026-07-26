// Shared live delivery envelope builder — package-private projection helper.
//
// One envelope grammar for all live delivery paths (committed-event core and
// ephemeral fan-out). The core uses buildEnvelope to produce the same delta,
// reducer, and annotated-text resync envelopes that the fan-out produced.
//
// Delta projector state is owned by the builder instance and must be reused
// for the lifetime of the delivery seam, not recreated per batch.

import { createDeltaProjector } from './field-delta.mjs';
import { EventKind, parseEventType } from './event-handle.mjs';
import { createdTextReducerSeeds } from './text-reducer-transport.mjs';
import { tryParseScopeKey } from './scope-handle.mjs';

function hasAnnotatedText(entityRecord) {
  return Object.values(entityRecord.fields ?? {}).some((field) => field?.kind === 'annotatedText');
}

function assertCommittedSequence(event) {
  if (!Number.isSafeInteger(event.seq) || event.seq < 0) {
    throw new Error('invalid committed event sequence');
  }
}

function recovery(ctx, entity, id, reason) {
  return [{ type: 'resync', entity, id, seq: ctx.event.seq, reason }];
}

function recipientLifecycleData(ctx, handle, id) {
  if (handle.kind === EventKind.removed) return { id };
  if (!ctx.row || typeof ctx.row !== 'object' || Array.isArray(ctx.row)) return null;

  const declared = ctx.entity?.fields ?? {};
  // Recipient lifecycle output derives only from declarations and the
  // recipient-hydrated row, never from raw durable operation keys.
  const keys = Object.keys(declared);
  const data = { id };
  for (const key of keys) {
    if (Object.hasOwn(ctx.row, key)) data[key] = ctx.row[key];
  }
  return data;
}

export function createLiveEnvelopeBuilder({ stateful = true } = {}) {
  const deltaProjector = stateful ? createDeltaProjector() : null;

  /**
   * Build WebSocket envelopes from a core projection context.
   *
   * @param {object} ctx
   * @param {object} ctx.entity - entity record
   * @param {object} ctx.event - committed event (may have eventType or type)
   * @param {object} ctx.principal - subscription principal
   * @param {object} ctx.row - hydrated db row
   * @param {string} ctx.scope - scope key
   * @returns {object[]} array of envelopes (usually one, but zero for skips)
   */
  function buildEnvelope(ctx) {
    const handle = tryParseScopeKey(ctx.scope);
    if (!handle) return [];
    assertCommittedSequence(ctx.event);

    const entityName = handle.entity;
    const id = handle.id;

    // _Log rows carry storage columns such as eventType/eventData. The durable
    // payload is rebuilt below from the recipient-hydrated row, never copied.
    const loggedEvent = {
      type: ctx.event.eventType ?? ctx.event.type,
      scope: ctx.event.scope,
      seq: ctx.event.seq,
      actionId: ctx.event.actionId,
      committedAt: ctx.event.committedAt,
    };

    let evHandle;
    try {
      evHandle = parseEventType(loggedEvent.type);
    } catch {
      throw new Error('invalid committed event type');
    }

    const lifecycle = [EventKind.created, EventKind.updated, EventKind.removed].includes(evHandle.kind);
    if (evHandle.entity !== entityName) {
      // Jobs are scoped to an authorized anchor (for example Note:n1), but
      // have no recipient-hydrated lifecycle grammar yet.
      if (evHandle.entity !== '_Job' || !lifecycle) {
        throw new Error('committed event entity does not match delivery scope');
      }
      return recovery(ctx, entityName, id, 'recipient-snapshot-required');
    }

    if (!lifecycle) {
      return recovery(ctx, entityName, id, hasAnnotatedText(ctx.entity)
        ? 'annotated-text-snapshot-required'
        : 'recipient-snapshot-required');
    }

    const data = recipientLifecycleData(ctx, evHandle, id);
    if (!data) throw new Error('invalid lifecycle event data');
    const event = { ...loggedEvent, data };
    Object.defineProperty(event, 'handle', { value: evHandle, enumerable: false });

    const envelope = {
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
      const delta = deltaProjector.project(ctx.entity, id, ctx.row, event);
      if (delta !== undefined) envelope.delta = delta;
      const reducers = createdTextReducerSeeds(ctx.entity, event);
      if (reducers) envelope.reducers = reducers;
    }

    return [envelope];
  }

  function clear() {
    deltaProjector?.clear();
  }

  return { buildEnvelope, clear };
}

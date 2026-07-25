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
import { publicEvent } from './event-delivery.mjs';
import { createdTextReducerSeeds } from './text-reducer-transport.mjs';
import { tryParseScopeKey } from './scope-handle.mjs';

function hasAnnotatedText(entityRecord) {
  return Object.values(entityRecord.fields ?? {}).some((field) => field?.kind === 'annotatedText');
}

export function createLiveEnvelopeBuilder() {
  const deltaProjector = createDeltaProjector();

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

    const entityName = handle.entity;
    const id = handle.id;

    // _Log rows carry storage columns such as eventType/eventData. Expose only
    // the committed public event grammar, never the raw durable row.
    const event = {
      type: ctx.event.eventType ?? ctx.event.type,
      scope: ctx.event.scope,
      seq: ctx.event.seq,
      actionId: ctx.event.actionId,
      committedAt: ctx.event.committedAt,
      data: ctx.event.data,
    };

    let evHandle;
    try {
      evHandle = parseEventType(event.type);
      Object.defineProperty(event, 'handle', { value: evHandle, enumerable: false });
    } catch {
      return [];
    }

    const isAnnotatedTextOperated =
      evHandle.kind === EventKind.native &&
      evHandle.nativeName === 'operated' &&
      ctx.entity?.fields?.[evHandle.field]?.kind === 'annotatedText';

    if (isAnnotatedTextOperated) {
      return [{
        type: 'resync',
        entity: entityName,
        id,
        seq: ctx.event.seq,
        reason: 'annotated-text-snapshot-required',
      }];
    }

    const isAnnotatedTextEphemeral =
      evHandle.kind === EventKind.fieldSet &&
      ctx.entity?.fields?.[evHandle.field]?.kind === 'ephemeral' &&
      hasAnnotatedText(ctx.entity);

    if (isAnnotatedTextEphemeral) {
      return [{
        type: 'resync',
        entity: entityName,
        id,
        seq: ctx.event.seq,
        reason: 'annotated-text-snapshot-required',
      }];
    }

    const delta = deltaProjector.project(ctx.entity, id, ctx.row, event);
    const envelope = {
      type: 'event',
      entity: entityName,
      id,
      seq: ctx.event.seq,
      seqSpan: [ctx.event.seq, ctx.event.seq],
      event: publicEvent(event),
    };
    if (delta !== undefined) envelope.delta = delta;
    const reducers = createdTextReducerSeeds(ctx.entity, event);
    if (reducers) envelope.reducers = reducers;

    return [envelope];
  }

  function clear() {
    deltaProjector.clear();
  }

  return { buildEnvelope, clear };
}

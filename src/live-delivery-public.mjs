// Public, transport-neutral committed delivery. The package owns reread,
// authorization, projection, and cursor semantics; adapters only deliver the
// recipient-safe batch and acknowledge it by resolving their callback.

import { createLiveDeliveryCore } from './live-delivery-core.mjs';
import { createLiveEnvelopeBuilder } from './live-delivery-envelope.mjs';
import { scopeOf, tryParseScopeKey } from './scope-handle.mjs';

function jsonSnapshot(value, path = 'snapshot', ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must contain only finite JSON numbers`);
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError(`${path} must not contain cycles`);
    ancestors.add(value);
    const copy = value.map((entry, index) => jsonSnapshot(entry, `${path}[${index}]`, ancestors));
    ancestors.delete(value);
    return Object.freeze(copy);
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${path} must be a JSON value`);
  }
  if (ancestors.has(value)) throw new TypeError(`${path} must not contain cycles`);
  ancestors.add(value);
  const copy = {};
  for (const [key, entry] of Object.entries(value)) copy[key] = jsonSnapshot(entry, `${path}.${key}`, ancestors);
  ancestors.delete(value);
  return Object.freeze(copy);
}

function compositeScopeProviders(compositeScopes) {
  if (compositeScopes === undefined) return new Map();
  if (!(compositeScopes instanceof Map)) throw new TypeError('compositeScopes must be a Map');
  const providers = new Map();
  for (const [entity, declaration] of compositeScopes) {
    // Reuse the package scope grammar rather than accepting a second spelling.
    scopeOf(entity, 'declaration');
    if (!declaration || typeof declaration.snapshot !== 'function') {
      throw new TypeError(`composite scope '${entity}' requires a synchronous snapshot function`);
    }
    providers.set(entity, declaration.snapshot);
  }
  return providers;
}

// Package-private assembly for an application-owned activation. The public
// factory below deliberately returns only the delivery protocol; application
// lifecycle wiring retains the committed consumer and shutdown capability.
export function createOwnedLiveDelivery({ db, entities, mayVerb, compositeScopes, log = null, maxCatchupEvents = 1000, includeActionId = true }) {
  if (!Number.isSafeInteger(maxCatchupEvents) || maxCatchupEvents < 1) throw new TypeError('maxCatchupEvents must be a positive safe integer');
  const composites = compositeScopeProviders(compositeScopes);
  // Public delivery deliberately has no connection state. It emits only
  // recipient-hydrated lifecycle snapshots or opaque recovery controls.
  const envelopes = createLiveEnvelopeBuilder({ stateful: false, includeActionId });
  const core = createLiveDeliveryCore({
    db,
    entities,
    mayVerb,
    projectRecipient: (context) => {
      // The public projector must never receive raw _Log eventData. The
      // envelope grammar uses only metadata plus the recipient-hydrated row.
      const { data: _data, eventData: _eventData, ...event } = context.event;
      const handle = tryParseScopeKey(context.scope);
      return envelopes.buildEnvelope({ ...context, event, composite: !!handle && composites.has(handle.entity) });
    },
    log,
  });

  const delivery = {
    // Public subscribers always acknowledge before any durable batch drains.
    subscribe(input) {
      const { paused: _paused, signal, revoke, ...subscription } = input ?? {};
      if (!signal || typeof signal.addEventListener !== 'function') {
        throw new Error('live delivery subscription requires an AbortSignal');
      }
      if (signal.aborted) {
        throw new Error('live delivery subscription is aborted');
      }
      return core.subscribe({ ...subscription, signal, paused: true, revoke }).catch((error) => {
        if (error?.code !== 'live-delivery-revoked') throw error;
        revoke?.();
        return { activate: async () => undefined };
      });
    },
    bootstrap({ principal, scope }) {
      // The declaration is selected by the package scope grammar, before the
      // core pairs its synchronous result with the committed cursor.
      return core.bootstrap({
        principal,
        scope,
        snapshot: ({ principal: recipient, scope: snapshotScope }) => {
          const handle = tryParseScopeKey(snapshotScope);
          const provider = handle && composites.get(handle.entity);
          if (!provider) return core.snapshot({ principal: recipient, scope: snapshotScope });
          const anchor = core.snapshot({ principal: recipient, scope: snapshotScope });
          // Providers can inspect an immutable recipient projection, never a
          // mutable row that could affect later authorization or delivery.
          const safeAnchor = jsonSnapshot(anchor, 'composite scope anchor');
          const value = provider(Object.freeze({ principal: recipient, scope: snapshotScope, anchor: safeAnchor }));
          if (value && typeof value.then === 'function') throw new TypeError('composite scope snapshot function must be synchronous');
          return jsonSnapshot(value);
        },
      });
    },
    async catchup(input) {
      // Never materialize an unbounded retained history merely to discover it
      // cannot fit a transport frame. A fresh paired recipient snapshot is the
      // canonical opaque recovery for a long gap.
      if (core.exceedsCatchupLimit(input.scope, input.after ?? 0, maxCatchupEvents)) {
        return this.bootstrap({ principal: input.principal, scope: input.scope });
      }
      return core.catchup(input);
    },
    wake(scope) {
      // A wake is only a payloadless hint; it is not a delivery barrier.
      void core.wake(scope);
    },
  };

  return {
    delivery,
    consumer: async (events) => {
      const scopes = new Set();
      for (const event of events) {
        if (event?.scope) scopes.add(event.scope);
      }
      for (const scope of scopes) core.wake(scope);
    },
    close() {
      core.close();
    },
  };
}

/**
 * Direct transport-neutral delivery factory.
 *
 * This is for hosts that already own their entity registry and authorization
 * kernel. Workbench applications should use app.attachLiveDelivery() instead,
 * so the package binds delivery to the application's own authority.
 */
export function createLiveDelivery(options) {
  return createOwnedLiveDelivery(options).delivery;
}

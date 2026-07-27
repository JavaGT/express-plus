// Public, transport-neutral committed delivery. The package owns reread,
// authorization, projection, and cursor semantics; adapters only deliver the
// recipient-safe batch and acknowledge it by resolving their callback.

import { createLiveDeliveryCore } from './live-delivery-core.mjs';
import { createLiveEnvelopeBuilder } from './live-delivery-envelope.mjs';

export function createLiveDelivery({ db, entities, mayVerb, log = null, maxCatchupEvents = 1000 }) {
  if (!Number.isSafeInteger(maxCatchupEvents) || maxCatchupEvents < 1) throw new TypeError('maxCatchupEvents must be a positive safe integer');
  // Public delivery deliberately has no connection state. It emits only
  // recipient-hydrated lifecycle snapshots or opaque recovery controls.
  const envelopes = createLiveEnvelopeBuilder({ stateful: false });
  const core = createLiveDeliveryCore({
    db,
    entities,
    mayVerb,
    projectRecipient: (context) => {
      // The public projector must never receive raw _Log eventData. The
      // envelope grammar uses only metadata plus the recipient-hydrated row.
      const { data: _data, eventData: _eventData, ...event } = context.event;
      return envelopes.buildEnvelope({ ...context, event });
    },
    log,
  });

  return {
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
    bootstrap({ principal, scope, snapshot = null }) {
      // A public bootstrap is a recipient-hydrated entity snapshot paired with
      // its cursor by the core. Apps do not provide snapshot/projection code.
      return core.bootstrap({
        principal,
        scope,
        snapshot: snapshot ?? (({ principal: recipient, scope: snapshotScope }) => core.snapshot({ principal: recipient, scope: snapshotScope })),
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
}

// Public, transport-neutral committed delivery. The package owns reread,
// authorization, projection, and cursor semantics; adapters only deliver the
// recipient-safe batch and acknowledge it by resolving their callback.

import { createLiveDeliveryCore } from './live-delivery-core.mjs';
import { createLiveEnvelopeBuilder } from './live-delivery-envelope.mjs';
import { mayRow } from './row-grant.mjs';
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

function aggregateScopes(compositeScopes, resolveEntity) {
  if (compositeScopes === undefined) return new Map();
  if (!(compositeScopes instanceof Map)) throw new TypeError('compositeScopes must be a Map');
  const scopes = new Map();
  for (const [entity, declaration] of compositeScopes) {
    // Reuse the package scope grammar rather than accepting a second spelling.
    scopeOf(entity, 'declaration');
    const anchor = declaration?.anchor;
    if (!anchor || anchor.name !== entity || resolveEntity(entity) !== anchor) {
      throw new TypeError(`composite scope '${entity}' requires its registered anchor entity`);
    }
    if (!Array.isArray(declaration.members)) throw new TypeError(`composite scope '${entity}' requires members`);
    const members = declaration.members.map((member, index) => {
      const target = member?.entity;
      const where = member?.where;
      if (!target || resolveEntity(target.name) !== target) throw new TypeError(`composite scope '${entity}' member ${index} must declare a registered entity`);
      if (!where || typeof where.field !== 'string' || typeof where.fromAnchor !== 'string') throw new TypeError(`composite scope '${entity}' member ${index} requires where.field and where.fromAnchor`);
      if (!(where.field in target.fields) || !(where.fromAnchor in anchor.fields)) throw new TypeError(`composite scope '${entity}' member ${index} has an undeclared cross-anchor field`);
      return { entity: target, where };
    });
    scopes.set(entity, { anchor, members });
  }
  return scopes;
}

// Package-private assembly for an application-owned activation. The public
// factory below deliberately returns only the delivery protocol; application
// lifecycle wiring retains the committed consumer and shutdown capability.
export function createOwnedLiveDelivery({ db, entities, mayVerb, compositeScopes, log = null, maxCatchupEvents = 1000, includeActionId = true }) {
  if (!Number.isSafeInteger(maxCatchupEvents) || maxCatchupEvents < 1) throw new TypeError('maxCatchupEvents must be a positive safe integer');
  const resolveEntity = typeof entities === 'function' ? entities : (name) => entities.get(name);
  const composites = aggregateScopes(compositeScopes, resolveEntity);
  const aggregateRevision = () => Number(db.prepare("SELECT revision FROM _CommittedRevision WHERE name = 'actions'").get().revision);
  async function aggregateSnapshot({ principal, scope, declaration }) {
    const rows = new Map();
    const add = (entity, row) => {
      const id = String(row.id);
      let byId = rows.get(entity.name);
      if (!byId) rows.set(entity.name, byId = new Map());
      byId.set(id, jsonSnapshot(row, `aggregate.${entity.name}.${id}`));
    };
    const anchor = core.snapshot({ principal, scope });
    add(declaration.anchor, anchor);
    for (const member of declaration.members) {
      const { sql, params } = member.entity.scopeFilter(principal);
      const rawRows = db.prepare(`SELECT * FROM ${member.entity.name} AS t0 WHERE ${sql} AND t0.${member.where.field} = :aggregate_anchor ORDER BY t0.id`)
        .all({ ...params, aggregate_anchor: anchor[member.where.fromAnchor] });
      for (const raw of rawRows) {
        if ('hydrate' in member.entity && typeof member.entity.hydrate !== 'function') continue;
        const row = typeof member.entity.hydrate === 'function' ? member.entity.hydrate(raw, principal) : raw;
        if (row === null || row === undefined) continue;
        // scopeFilter is necessary but a member still needs its subscribe grant.
        // This synchronous boolean form is the same entity grant used by delivery.
        const permitted = await mayRow(member.entity, 'subscribe', row, principal, mayVerb);
        if (!permitted) continue;
        add(member.entity, row);
      }
    }
    const entities = {};
    for (const name of [...rows.keys()].sort()) {
      entities[name] = Object.freeze(Object.fromEntries([...rows.get(name).entries()].sort(([a], [b]) => a.localeCompare(b))));
    }
    return Object.freeze({ entities: Object.freeze(entities) });
  }
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
      const handle = tryParseScopeKey(subscription.scope);
      const declaration = handle && composites.get(handle.entity);
      const supplied = subscription.after;
      const after = declaration && supplied && typeof supplied === 'object' ? supplied.anchor : supplied;
      let recoveryQueued = false;
      const activation = core.subscribe({ ...subscription, after, signal, paused: true, revoke }).catch((error) => {
        if (error?.code !== 'live-delivery-revoked') throw error;
        revoke?.();
        return { activate: async () => undefined };
      });
      if (!declaration) return activation;
      return activation.then((value) => ({
        activate: async () => {
          // Admission is async, so latch stale-cursor recovery only after the
          // paused subscription has been installed. Compare now: a commit may
          // have completed while admission awaited its anchor grant.
          if (!supplied || typeof supplied !== 'object' || supplied.aggregate !== aggregateRevision()) {
            core.resync(subscription.scope, { type: 'resync', entity: handle.entity, id: handle.id, seq: after ?? 0, reason: 'recipient-snapshot-required' });
            recoveryQueued = true;
          }
          const anchor = await value.activate();
          // Activation can await delivery. A member commit in that interval is
          // not represented by the anchor cursor, so never acknowledge it.
          const aggregate = aggregateRevision();
          if (supplied && typeof supplied === 'object' && supplied.aggregate !== aggregate) {
            if (!recoveryQueued) core.resync(subscription.scope, { type: 'resync', entity: handle.entity, id: handle.id, seq: after ?? 0, reason: 'recipient-snapshot-required' });
            return anchor === undefined ? undefined : Object.freeze({ anchor, aggregate });
          }
          return anchor === undefined ? undefined : Object.freeze({ anchor, aggregate });
        },
      }));
    },
    async bootstrap({ principal, scope }) {
      // The declaration is selected by the package scope grammar, before the
      // core pairs its synchronous result with the committed cursor.
      let pairedRevision;
      const result = await core.bootstrap({
        principal,
        scope,
        snapshot: ({ principal: recipient, scope: snapshotScope }) => {
          const handle = tryParseScopeKey(snapshotScope);
          const declaration = handle && composites.get(handle.entity);
          if (!declaration) return core.snapshot({ principal: recipient, scope: snapshotScope });
          const before = aggregateRevision();
          return aggregateSnapshot({ principal: recipient, scope: snapshotScope, declaration }).then((value) => {
            pairedRevision = aggregateRevision();
            if (pairedRevision !== before) throw new Error('aggregate snapshot changed while materializing');
            return value;
          });
        },
      });
      const handle = tryParseScopeKey(scope);
      if (result.kind !== 'snapshot' || !handle || !composites.has(handle.entity)) return result;
      return { ...result, cursor: Object.freeze({ anchor: result.cursor, aggregate: pairedRevision }) };
    },
    async catchup(input) {
      const handle = tryParseScopeKey(input.scope);
      const declaration = handle && composites.get(handle.entity);
      if (declaration) {
        const cursor = input.after;
        if (!cursor || typeof cursor !== 'object' || cursor.aggregate !== aggregateRevision()) {
          return this.bootstrap({ principal: input.principal, scope: input.scope });
        }
        const result = await core.catchup({ ...input, after: cursor.anchor });
        return result.kind === 'revoked' ? result : { ...result, cursor: Object.freeze({ anchor: result.cursor, aggregate: cursor.aggregate }) };
      }
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
      const invalidatedAnchors = new Set();
      for (const event of events) {
        const handle = tryParseScopeKey(event?.scope);
        if (!handle) continue;
        for (const [anchorName, declaration] of composites) {
          if (declaration.members.some((member) => member.entity.name === handle.entity)) invalidatedAnchors.add(anchorName);
        }
      }
      // Member events invalidate every live aggregate of that declaration. The
      // deliberate broad fan-out needs no pre-image cache, so deletion and both
      // sides of a reparent are authoritative.
      for (const anchorName of invalidatedAnchors) {
        core.resyncEntity(anchorName, (scope) => {
          const anchor = tryParseScopeKey(scope);
          return { type: 'resync', entity: anchorName, id: anchor.id, seq: 0, reason: 'recipient-snapshot-required' };
        });
      }
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

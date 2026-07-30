// Public, transport-neutral committed delivery. The package owns reread,
// authorization, projection, and cursor semantics; adapters only deliver the
// recipient-safe batch and acknowledge it by resolving their callback.

import { createLiveDeliveryCore } from './live-delivery-core.mjs';
import { createLiveEnvelopeBuilder } from './live-delivery-envelope.mjs';
import { tryParseScopeKey } from './scope-handle.mjs';
import { readSeq } from './committed-log.mjs';
import { compileSnapshots, captureSnapshot, authorizeSnapshot, projectSnapshot } from './snapshot-projection.mjs';
import { hasAnnotatedTextFields, projectEntitySnapshot } from './entity-snapshot-projection.mjs';
import { resolveAnnotatedTextOwningScope } from './annotated-text-field.mjs';

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

// Package-private assembly for an application-owned activation. The public
// factory below deliberately returns only the delivery protocol; application
// lifecycle wiring retains the committed consumer and shutdown capability.
export function createOwnedLiveDelivery({ db, entities, mayVerb, snapshots, log = null, maxCatchupEvents = 1000, includeActionId = true }) {
  if (!Number.isSafeInteger(maxCatchupEvents) || maxCatchupEvents < 1) throw new TypeError('maxCatchupEvents must be a positive safe integer');
  const resolveEntity = typeof entities === 'function' ? entities : (name) => entities.get(name);
  const composites = compileSnapshots(snapshots, resolveEntity, db);
  const requiredEntities = composites.requiredEntities ?? new Set();
  const aggregateRevision = () => Number(db.prepare("SELECT revision FROM _CommittedRevision WHERE name = 'actions'").get().revision);
  async function aggregateSnapshot({ principal, scope, declaration }) {
    const handle = tryParseScopeKey(scope);
    // No transaction crosses authorization awaits. Each attempt detaches a
    // complete candidate graph and its two committed fences before authorizing.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let captured;
      db.exec('BEGIN');
      try {
        captured = Object.freeze({
          anchor: readSeq(db, scope),
          aggregate: aggregateRevision(),
          candidate: captureSnapshot({ db, principal, anchor: declaration.anchor, id: handle.id, output: declaration.output, tombstones: declaration.tombstones }),
        });
      } catch {
        // A visibility read that cannot establish absence is a denied snapshot,
        // never a partially projected recipient view.
        return { kind: 'revoked' };
      } finally {
        db.exec('COMMIT');
      }
      if (!captured.candidate) return { kind: 'revoked' };
      const authorization = await authorizeSnapshot({ principal, anchor: declaration.anchor, candidate: captured.candidate, mayVerb });
      if (!authorization.anchorAllowed) return { kind: 'revoked' };
      const value = jsonSnapshot(projectSnapshot({ anchor: declaration.anchor, candidate: captured.candidate, output: declaration.output, authorized: authorization.authorized }));
      if (readSeq(db, scope) === captured.anchor && aggregateRevision() === captured.aggregate) {
        return Object.freeze({ kind: 'snapshot', snapshot: value, cursor: Object.freeze({ anchor: captured.anchor, aggregate: captured.aggregate }) });
      }
      await Promise.resolve();
    }
    // The caller receives only an opaque recovery result, never an unstable pair.
    return { kind: 'retry' };
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
    scopeVisible: ({ entity, principal, scope: handle }) => {
      const declaration = composites.get(entity.name);
      if (!declaration?.tombstones?.some((rule) => rule.target === entity)) return true;
      try {
        return captureSnapshot({ db, principal, anchor: declaration.anchor, id: handle.id, output: declaration.output, tombstones: declaration.tombstones }) !== null;
      } catch {
        return false;
      }
    },
    log,
  });

  const delivery = {
    resolveAnnotatedTextDocument({ entity: entityName, field: fieldName, documentId }) {
      const entity = resolveEntity(entityName);
      const descriptor = entity?.fields?.[fieldName];
      if (!entity || descriptor?.kind !== 'annotatedText' || typeof documentId !== 'string' || !documentId) return null;
      const row = db.prepare(`SELECT * FROM ${entity.name} WHERE id = ?`).get(documentId);
      if (!row) return null;
      return Object.freeze({ scope: resolveAnnotatedTextOwningScope(descriptor, entity.fields, row).key, entity, row, fieldName, descriptor, documentId });
    },
    async authorizeAnnotatedTextDocument(document, principal) {
      const project = tryParseScopeKey(document.scope);
      const projectEntity = project && resolveEntity(project.entity);
      if (projectEntity) {
        const projectScope = projectEntity.scopeFilter(principal);
        const projectRow = db.prepare(`SELECT * FROM ${projectEntity.name} AS t0 WHERE ${projectScope.sql} AND t0.id = :id`)
          .get({ ...projectScope.params, id: project.id });
        if (!projectRow || !(await mayVerb(projectEntity, 'subscribe', projectRow, principal))) return null;
      }
      const { sql, params } = document.entity.scopeFilter(principal);
      const row = db.prepare(`SELECT * FROM ${document.entity.name} AS t0 WHERE ${sql} AND t0.id = :id`)
        .get({ ...params, id: document.documentId });
      if (!row || !(await mayVerb(document.entity, 'subscribe', row, principal))) return null;
      return row;
    },
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
      if ((subscription.document && requiredEntities.has(subscription.document.entity.name)) || (handle && requiredEntities.has(handle.entity))) {
        revoke?.();
        return Promise.resolve({ activate: async () => undefined });
      }
      const supplied = subscription.after;
      const after = declaration && supplied && typeof supplied === 'object' ? supplied.anchor : supplied;
      let recoveryQueued = false;
      const authorizeDocument = input.document
        ? this.authorizeAnnotatedTextDocument(input.document, subscription.principal).then((row) => {
          if (!row) {
            revoke?.();
            return { activate: async () => undefined };
          }
          return core.subscribe({ ...subscription, after, signal, paused: true, revoke });
        })
        : core.subscribe({ ...subscription, after, signal, paused: true, revoke });
      const activation = Promise.resolve(authorizeDocument).then((value) => value).catch((error) => {
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
    async bootstrap({ principal, scope, document = null }) {
      const handle = tryParseScopeKey(scope);
      if ((document && requiredEntities.has(document.entity.name)) || (handle && requiredEntities.has(handle.entity))) {
        return { kind: 'revoked' };
      }
      if (document) {
        if (document.scope !== scope) return { kind: 'revoked' };
        const row = await this.authorizeAnnotatedTextDocument(document, principal);
        if (!row) return { kind: 'revoked' };
        const before = readSeq(db, scope);
        const snapshot = await projectEntitySnapshot({ db, entity: document.entity, row, principal });
        if (readSeq(db, scope) !== before) return { kind: 'retry' };
        return Object.freeze({ kind: 'snapshot', snapshot, cursor: before });
      }
      // The declaration is selected by the package scope grammar, before the
      // core pairs its synchronous result with the committed cursor.
      const aggregate = handle && composites.get(handle.entity);
      if (aggregate) return aggregateSnapshot({ principal, scope, declaration: aggregate });
      const result = await core.bootstrap({
        principal,
        scope,
      snapshot: ({ principal: recipient, scope: snapshotScope }) => {
          const row = core.snapshot({ principal: recipient, scope: snapshotScope });
          const direct = tryParseScopeKey(snapshotScope);
          const entity = direct && resolveEntity(direct.entity);
          if (!entity || !hasAnnotatedTextFields(entity)) return row;
          return projectEntitySnapshot({ db, entity, row, principal: recipient });
        },
      });
       return result;
    },
    async catchup(input) {
      const handle = tryParseScopeKey(input.scope);
      if ((input.document && requiredEntities.has(input.document.entity.name)) || (handle && requiredEntities.has(handle.entity))) {
        return { kind: 'revoked' };
      }
      if (input.document) return this.bootstrap({ principal: input.principal, scope: input.scope, document: input.document });
      const declaration = handle && composites.get(handle.entity);
      if (declaration) {
        const cursor = input.after;
        if (!cursor || typeof cursor !== 'object' || cursor.aggregate !== aggregateRevision()) {
          return this.bootstrap({ principal: input.principal, scope: input.scope });
        }
        const result = await core.catchup({ ...input, after: cursor.anchor });
        // Core admission awaits authorization. Never return an anchor catch-up
        // paired with the aggregate revision observed before that await.
        if (aggregateRevision() !== cursor.aggregate) {
          return this.bootstrap({ principal: input.principal, scope: input.scope });
        }
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
          // Declaration-wide resync is deliberately conservative: it covers
          // deletes and reparenting without retaining pre-image state.
          if (declaration.output) invalidatedAnchors.add(anchorName);
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

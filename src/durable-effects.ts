// @ts-nocheck
import { effectEntries } from './effect-compiler.ts';
import { parseEventType } from './event-handle.ts';
import { consumerCursorMap, upsertConsumerCursor } from './consumer-cursor.ts';
import { txn } from './driver.ts';
import { getLog } from './log.ts';
import { tryParseScopeKey } from './scope-handle.ts';

const CONSUMER = 'effect.durable';

function isDurableEffectDeclaration(effect) {
  return effect && typeof effect === 'object' && typeof effect.durable === 'string';
}

function resolveTriggerEventType(handle) {
  if (handle && typeof handle === 'object' && handle.brand === 'event-handle' && typeof handle.type === 'string') {
    return handle.type;
  }
  if (handle && typeof handle === 'object' && handle.brand === 'state-transition-handle' && typeof handle.type === 'string') {
    return handle.type;
  }
  throw new Error(`durable effect trigger '${String(handle)}' must be a typed event handle. Strings are not accepted.`);
}

export function buildDurableEffectsRegistry(entities) {
  const registry = new Map();
  for (const entityRecord of entities ?? []) {
    if (!entityRecord.effects) continue;
    for (const [triggerHandle, effect] of effectEntries(entityRecord.effects, { sourceEntityName: entityRecord.name })) {
      if (!isDurableEffectDeclaration(effect)) continue;
      const eventType = resolveTriggerEventType(triggerHandle);
      if (!registry.has(eventType)) registry.set(eventType, []);
      registry.get(eventType).push({ sourceEntity: entityRecord.name, effect });
    }
  }
  return registry;
}

function durableJobId(ev, kind) {
  return `durable-effect:${ev.scope.replace(':', ':')}:${ev.seq}:${kind}`;
}

function durablePayload(ev, effect) {
  const delta = ev.data || {};
  const origin = { id: tryParseScopeKey(ev.scope)?.id };
  const data = typeof effect.with === 'function' ? effect.with({ delta, origin }) : (effect.with ?? {});
  return {
    event: {
      type: ev.type,
      scope: ev.scope,
      seq: ev.seq,
      actionId: ev.actionId,
    },
    data,
  };
}

function enqueueDurableEffectsForEvent(ev, effects, jobs) {
  for (const { effect } of effects) {
    jobs.enqueue({
      id: durableJobId(ev, effect.durable),
      kind: effect.durable,
      payload: durablePayload(ev, effect),
    });
  }
}

async function enqueueDurableEffectsAndAdvance(db, ev, effects, jobs) {
  await txn(db, () => {
    enqueueDurableEffectsForEvent(ev, effects, jobs);
    upsertConsumerCursor(db, { consumer: CONSUMER, scope: ev.scope, lastSeq: ev.seq });
  });
}

export function createDurableEffectsConsumer({ durableEffectsRegistry, jobs }) {
  if (!jobs || !durableEffectsRegistry || durableEffectsRegistry.size === 0) return null;
  return async (events, { db }) => {
    for (const ev of events) {
      if (typeof ev.seq !== 'number') continue;
      const effects = durableEffectsRegistry.get(ev.type);
      if (!effects || effects.length === 0) continue;
      try {
        await enqueueDurableEffectsAndAdvance(db, ev, effects, jobs);
      } catch (err) {
        getLog().warn('system', 'durable effect enqueue failed', { err, scope: ev.scope, seq: ev.seq });
      }
    }
  };
}

function rowToEvent(row) {
  let handle;
  try {
    handle = parseEventType(row.eventType);
  } catch {
    handle = undefined;
  }
  const ev = {
    type: row.eventType,
    scope: row.scope,
    seq: row.seq,
    actionId: row.actionId,
    committedAt: row.committedAt,
    data: JSON.parse(row.eventData),
  };
  return handle ? Object.freeze({ ...ev, handle }) : Object.freeze(ev);
}

export async function reconcileDurableEffects(db, { durableEffectsRegistry, jobs }) {
  if (!jobs || !durableEffectsRegistry || durableEffectsRegistry.size === 0) return { enqueued: 0 };
  const recoveryByScope = consumerCursorMap(db, CONSUMER);
  const rows = db.prepare('SELECT * FROM _Log ORDER BY scope, seq').all();
  let enqueued = 0;
  for (const row of rows) {
    const applied = recoveryByScope.get(row.scope) ?? 0;
    if (applied >= row.seq) continue;
    const ev = rowToEvent(row);
    const effects = durableEffectsRegistry.get(ev.type);
    if (!effects || effects.length === 0) {
      upsertConsumerCursor(db, { consumer: CONSUMER, scope: ev.scope, lastSeq: ev.seq });
      recoveryByScope.set(ev.scope, ev.seq);
      continue;
    }
    try {
      await enqueueDurableEffectsAndAdvance(db, ev, effects, jobs);
      recoveryByScope.set(ev.scope, ev.seq);
      enqueued += effects.length;
    } catch (err) {
      getLog().warn('system', 'durable effect recovery failed', { err, scope: ev.scope, seq: ev.seq });
    }
  }
  return { enqueued };
}

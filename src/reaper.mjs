// Schedule reaper — per-interval discovery of due schedule.at/schedule.after
// rows + dispatch under scheduler system principals. A CLOCK TRIGGER, not an
// authority (DECISIONLOG #19, #62). Mirrors startTickEngine. ONE reconciliation
// path — the durable variant's admission.beforeProjection seam re-admits in-txn
// (TOCTOU-safe; stale candidates deny as normal skips, zero footprint).
//
// Each dispatch try/catch mirrors the tick engine's per-iteration pattern: a
// single row's deny/throw logs to stderr and CONTINUES the sweep — never aborts
// it. setInterval MUST unref() so the test process exits without leak.
//
// When a `clock` is provided, the reaper registers as a watcher on the shared
// clock (one timer, nearest-deadline scheduling) instead of starting its own
// setInterval. Callers that provide a clock MUST call clock._schedule() to start
// real timers.

import { randomUUID } from 'node:crypto';
import { principalFrom } from './principal.mjs';
import { discoverDueSchedules, schedulerSource, triggerList } from './schedule.mjs';
import { getLog } from './log.mjs';
import { createClockRunner } from './clock-runner.mjs';

const SCAN_INTERVAL_MS = 1000;

/**
 * startReaper — start the per-interval schedule-dispatch loop.
 *
 * Scans all entities for schedule.at/schedule.after triggers, fires the sweep
 * every 1000ms. If NO schedule triggers exist across any entity, returns a
 * no-op `{stop(){}}` — the engine does NOT start a timer for an empty config.
 *
 * When `opts.clock` is provided, schedules via the shared clock (single
 * setTimeout, nearest-deadline). Otherwise starts its own setInterval.
 *
 * @param {object} opts
 * @param {object} opts.db — DatabaseSync handle for discovery queries.
 * @param {Map<string, object>} opts.entities — Entity map (entity name →
 *   entity descriptor; entity.schedule holds deadline triggers with
 *   {kind, fieldName, whileSql, with}).
 * @param {function} opts.dispatch — Pipeline dispatch function.
 * @param {function} [opts.now=Date.now] — Time source for discovery.
 * @param {object} [opts.clock] — Shared clock from createClock().
 * @returns {{stop(): void}} Engine handle. `.stop()` is idempotent.
 */
export function startReaper({ db, entities, dispatch, now = Date.now, clock }) {
  // Normalize entities to an array — discoverDueSchedules iterates with for…of,
  // which over a Map yields [key, value] tuples, not entity objects.
  const entityList = entities instanceof Map ? [...entities.values()] : entities;

  // Build a name->entity map for per-row trigger lookups.
  const entityMap = new Map(entityList.map((e) => [e.name, e]));

  // Check if any entity has a schedule.at or schedule.after trigger.
  let hasDeadlineTrigger = false;
  for (const entity of entityList) {
    if (!entity || !entity.schedule) continue;
    for (const triggerOrTriggers of Object.values(entity.schedule)) {
      for (const trigger of triggerList(triggerOrTriggers)) {
        if (!trigger) continue;
        if (trigger.kind === 'schedule.at' || trigger.kind === 'schedule.after') {
          hasDeadlineTrigger = true;
          break;
        }
      }
      if (hasDeadlineTrigger) break;
    }
    if (hasDeadlineTrigger) break;
  }

  if (!hasDeadlineTrigger) {
    return { stop() {} };
  }

  function scan() {
    const rows = discoverDueSchedules(db, entityList, now());
    for (const { entity: entityName, verb, rowId, payload, sourceName } of rows) {
      try {
        const entity = entityMap.get(entityName);
        if (!entity) continue;
        const trigger = triggerList(entity.schedule?.[verb]).find((t) => (t.sourceName ?? t.fieldName) === sourceName);
        if (!trigger?.fieldName) continue;
        const source = schedulerSource(entityName, verb, sourceName ?? trigger.fieldName);
        const principal = principalFrom(source);
        dispatch({ actionId: randomUUID(), type: `${entityName}.${verb}`, principal, payload: { id: rowId, ...payload } });
      } catch (err) {
        getLog().warn('system', 'reaper dispatch failed', { err, entity: entityName, verb, rowId });
      }
    }
  }

  return createClockRunner({ clock, intervalMs: SCAN_INTERVAL_MS, fn: scan, name: 'schedule-reaper' });
}

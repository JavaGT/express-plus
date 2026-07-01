// Schedule reaper — per-interval discovery of due schedule.at/schedule.after
// rows + dispatch under scheduler system principals. A CLOCK TRIGGER, not an
// authority (DECISIONLOG #19, #62). Mirrors startTickEngine. ONE reconciliation
// path — preProjectionAuthorize re-admits in-txn (TOCTOU-safe; stale candidates
// deny as normal skips, zero footprint).
//
// Each dispatch try/catch mirrors the tick engine's per-iteration pattern: a
// single row's deny/throw logs to stderr and CONTINUES the sweep — never aborts
// it. setInterval MUST unref() so the test process exits without leak.

import { randomUUID } from 'node:crypto';
import { principalFrom } from './principal.mjs';
import { discoverDueSchedules, schedulerSource } from './schedule.mjs';
import { getLog } from './log.mjs';

const SCAN_INTERVAL_MS = 1000;

/**
 * startReaper — start the per-interval schedule-dispatch loop.
 *
 * Scans all entities for schedule.at/schedule.after triggers, fires the sweep
 * every 1000ms. If NO schedule triggers exist across any entity, returns a
 * no-op `{stop(){}}` — the engine does NOT start a timer for an empty config.
 *
 * @param {object} opts
 * @param {object} opts.db — DatabaseSync handle for discovery queries.
 * @param {Map<string, object>} opts.entities — Entity map (entity name →
 *   entity descriptor; entity.schedule holds deadline triggers with
 *   {kind, fieldName, whileSql, with}).
 * @param {function} opts.dispatch — Pipeline dispatch function:
 *   `({type, principal, payload, actionId?})`. Called per discovered row as
 *   `{type: "${entityName}.${verb}", principal, payload: {id: rowId, ...with}}`.
 * @param {function} [opts.now=Date.now] — Time source for discovery.
 * @returns {{stop(): void}} Engine handle. `.stop()` is idempotent.
 */
export function startReaper({ db, entities, dispatch, now = Date.now }) {
  let timer = null;

  // Normalize entities to an array — discoverDueSchedules iterates with for…of,
  // which over a Map yields [key, value] tuples, not entity objects.
  const entityList = entities instanceof Map ? [...entities.values()] : entities;

  // Build a name->entity map for per-row trigger lookups.
  const entityMap = new Map(entityList.map((e) => [e.name, e]));

  // Check if any entity has a schedule.at or schedule.after trigger.
  let hasDeadlineTrigger = false;
  for (const entity of entityList) {
    if (!entity || !entity.schedule) continue;
    for (const trigger of Object.values(entity.schedule)) {
      if (!trigger) continue;
      if (trigger.kind === 'schedule.at' || trigger.kind === 'schedule.after') {
        hasDeadlineTrigger = true;
        break;
      }
    }
    if (hasDeadlineTrigger) break;
  }

  if (!hasDeadlineTrigger) {
    return { stop() {} };
  }

  function scan() {
    const rows = discoverDueSchedules(db, entityList, now());
    for (const { entity: entityName, verb, rowId, payload } of rows) {
      try {
        const entity = entityMap.get(entityName);
        if (!entity) continue;
        const trigger = entity.schedule?.[verb];
        if (!trigger?.fieldName) continue;
        const source = schedulerSource(entityName, verb, trigger.fieldName);
        const principal = principalFrom(source);
        dispatch({ actionId: randomUUID(), type: `${entityName}.${verb}`, principal, payload: { id: rowId, ...payload } });
      } catch (err) {
        getLog().warn('system', 'reaper dispatch failed', { err, entity: entityName, verb, rowId });
      }
    }
  }

  if (!timer) {
    timer = setInterval(() => {
      try {
        scan();
      } catch (err) {
        getLog().warn('system', 'reaper scan failed', { err });
      }
    }, SCAN_INTERVAL_MS);
    if (typeof timer.unref === 'function') timer.unref();
  }

  return {
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
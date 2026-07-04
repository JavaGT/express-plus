// Tick engine — per-interval scan + dispatch for row-set ticks (tick.hz / tick.every).
//
// A tick engine is a CLOCK TRIGGER, not an authority (DECISIONLOG #19). Each
// interval it calls `discoverTickedRows` to find rows whose `while` predicate
// still holds, then dispatches `update` under a system principal whose `source`
// is `${entityName}.${verb}`. The dispatch spine routes this through the durable
// variant's admission.beforeProjection seam (not the engine itself admitting).
// ONE reconciliation path — no second auth path.
//
// Each dispatch try/catch mirrors the reaper's per-iteration pattern: a single
// row's deny/throw logs to stderr and CONTINUES the sweep — never aborts it.
// `setInterval` MUST `unref()` so the test process exits without leak.
//
// When a `clock` is provided, the engine registers as a watcher on the shared
// clock (one timer, nearest-deadline scheduling) instead of starting its own
// setInterval. Callers that provide a clock MUST call clock._schedule() to
// start real timers.

import { randomUUID } from 'node:crypto';
import { principalFrom } from './principal.mjs';
import { tickSource, discoverTickedRows, triggerList } from './schedule.mjs';
import { getLog } from './log.mjs';
import { createClockRunner } from './clock-runner.mjs';

/**
 * startTickEngine — start the per-interval tick-dispatch loop.
 *
 * Scans all entities for tick triggers, derives a single (fastest) interval,
 * and fires the sweep every interval. If NO tick triggers exist across any
 * entity, returns a no-op `{stop(){}}` — the engine does NOT start a timer
 * for an empty configuration.
 *
 * When `opts.clock` is provided, schedules via the shared clock. Otherwise
 * starts its own setInterval.
 *
 * @param {object} opts
 * @param {object} opts.db — DatabaseSync handle for discovery queries.
 * @param {Map<string, object>} opts.entities — Entity map.
 * @param {function} opts.dispatch — Pipeline dispatch function.
 * @param {function} [opts.now=Date.now] — Time source for discovery.
 * @param {object} [opts.clock] — Shared clock from createClock().
 * @returns {{stop(): void}} Engine handle. `.stop()` is idempotent.
 */
export function startTickEngine({ db, entities, dispatch, now = Date.now, clock }) {
  const entityList = entities instanceof Map ? [...entities.values()] : entities;
  const scanInterval = computeTickInterval(entityList);

  if (scanInterval <= 0) {
    return { stop() {} };
  }

  function scan() {
    const rows = discoverTickedRows(db, entityList, now());
    for (const { entity: entityName, verb, rowId, payload } of rows) {
      try {
        const source = tickSource(entityName, verb);
        const principal = principalFrom(source);
        dispatch({ actionId: randomUUID(), type: `${entityName}.${verb}`, principal, payload: { id: rowId, ...payload } });
      } catch (err) {
        getLog().warn('system', 'tick-engine dispatch failed', { err, entity: entityName, verb, rowId });
      }
    }
  }

  return createClockRunner({ clock, intervalMs: scanInterval, fn: scan, name: 'tick-engine' });
}

function computeIntervalFromTrigger(trigger) {
  if (trigger.kind === 'tick.every') return trigger.intervalMs;
  if (trigger.kind === 'tick.hz') return Math.floor(1000 / trigger.hertz);
  return NaN;
}

function computeTickInterval(entities) {
  let min = Infinity;
  for (const entity of entities) {
    if (!entity || !entity.schedule) continue;
    for (const triggerOrTriggers of Object.values(entity.schedule)) {
      for (const trigger of triggerList(triggerOrTriggers)) {
        if (!trigger) continue;
        const iv = computeIntervalFromTrigger(trigger);
        if (Number.isFinite(iv) && iv < min) min = iv;
      }
    }
  }
  return min === Infinity ? 0 : min;
}

// Tick engine — per-interval scan + dispatch for row-set ticks (tick.hz / tick.every).
//
// A tick engine is a CLOCK TRIGGER, not an authority (DECISIONLOG #19). Each
// interval it calls `discoverTickedRows` to find rows whose `while` predicate
// still holds, then dispatches `update` under a system principal whose `source`
// is `${entityName}.${verb}`. The dispatch spine routes this through
// `preProjectionAuthorize` → `admitSystemMutation` (not the engine itself
// admitting). ONE reconciliation path — no second auth path.
//
// Each dispatch try/catch mirrors the reaper's per-iteration pattern: a single
// row's deny/throw logs to stderr and CONTINUES the sweep — never aborts it.
// `setInterval` MUST `unref()` so the test process exits without leak.

import { randomUUID } from 'node:crypto';
import { principalFrom } from './principal.mjs';
import { tickSource, discoverTickedRows } from './schedule.mjs';
import { getLog } from './log.mjs';

/**
 * startTickEngine — start the per-interval tick-dispatch loop.
 *
 * Scans all entities for tick triggers, derives a single (fastest) interval,
 * and fires the sweep every interval. If NO tick triggers exist across any
 * entity, returns a no-op `{stop(){}}` — the engine does NOT start a timer
 * for an empty configuration.
 *
 * @param {object} opts
 * @param {object} opts.db — DatabaseSync handle for discovery queries.
 * @param {Map<string, object>} opts.entities — Entity map (entity name →
 *   entity descriptor; entity.schedule holds tick triggers with
 *   {kind, whileSql, with}).
 * @param {function} opts.dispatch — Pipeline dispatch function:
 *   `({type, principal, payload, actionId?})`. Called per discovered row as
 *   `{type: "${entityName}.updated", principal, payload: {id: rowId, ...with}}`.
 * @param {function} [opts.now=Date.now] — Time source for discovery.
 * @returns {{stop(): void}} Engine handle. `.stop()` is idempotent.
 */
export function startTickEngine({ db, entities, dispatch, now = Date.now }) {
  let timer = null;

  // Normalize entities to an array — discoverTickedRows iterates with for…of,
  // which over a Map yields [key, value] tuples, not entity objects.
  const entityList = entities instanceof Map ? [...entities.values()] : entities;

  // Compute the sweep interval: find fastest tick among ALL tick triggers.
  // tick.hz(n) → 1000/n ms; tick.every(duration) → parsed intervalMs.
  // The single fastest interval drives every sweep pass
  // (discoverTickedRows re-scans all entities, so we don't need per-entity timers).
  const scanInterval = computeTickInterval(entityList);

  if (scanInterval <= 0) {
    // No tick triggers across any entity → return no-op (don't burn a timer).
    return { stop() {} };
  }

  // discoverTickedRows queries the DB → dispatches the action for each row.
  function scan() {
    const rows = discoverTickedRows(db, entityList, now());
    for (const { entity: entityName, verb, rowId, payload } of rows) {
      // Per-row try/catch — one row's deny/throw NEVER aborts the sweep
      // (mirror reaper: stderr + continue). A deny here means the in-txn
      // admission (`admitSystemMutation`) rejected this row — a normal skip.
      try {
        const source = tickSource(entityName, verb);
        const principal = principalFrom(source);
        // The dispatch ACTION type is `<entity>.<verb>` (CRUD verb `update`,
        // NOT the event noun `updated`). The handler registry keys on the
        // action type (entity.mjs: `${name}.update`); the handler then EMITS
        // the event noun (`<entity>.updated`) which VERB_FROM_EVENT maps back
        // to `update` for projection routing. Merge rowId as `id` — the
        // `update` handler REQUIRES payload.id as the row target pointer
        // (not a schedule-written field); admission strips it before the
        // declared-`with` payload compare.
        dispatch({ actionId: randomUUID(), type: `${entityName}.${verb}`, principal, payload: { id: rowId, ...payload } });
      } catch (err) {
        getLog().warn('system', 'tick-engine dispatch failed', { err, entity: entityName, verb, rowId });
      }
    }
  }

  // Start the interval (idempotent: if an old timer exists, skip). The outer
  // try/catch guards against a discovery-phase throw (e.g. bad SQL) so the timer
  // never throws into the event loop; per-row throws are handled inside scan().
  if (!timer) {
    timer = setInterval(() => {
      try {
        scan();
      } catch (err) {
        getLog().warn('system', 'tick-engine scan failed', { err });
      }
    }, scanInterval);
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

// Extract per-trigger interval (ms). tick.hz(n, …) has hertz → 1000/hertz;
// tick.every(d) has intervalMs directly; other kinds return NaN.
function computeIntervalFromTrigger(trigger) {
  if (trigger.kind === 'tick.every') return trigger.intervalMs;
  if (trigger.kind === 'tick.hz') return Math.floor(1000 / trigger.hertz);
  return NaN;
}

// Scan all entities for tick triggers, return the minimum interval or 0 if none.
function computeTickInterval(entities) {
  let min = Infinity;
  for (const entity of entities) {
    if (!entity || !entity.schedule) continue;
    for (const trigger of Object.values(entity.schedule)) {
      if (!trigger) continue;
      const iv = computeIntervalFromTrigger(trigger);
      if (Number.isFinite(iv) && iv < min) min = iv;
    }
  }
  return min === Infinity ? 0 : min;
}

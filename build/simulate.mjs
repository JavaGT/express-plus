// Simulation engine — runs declared `simulation` loops. Holds ephemeral
// working state per scope in memory (no per-tick DB writes). The step
// function returns events to persist as checkpoints through the normal
// pipeline. Events write through BEGIN→projection→COMMIT, just like any
// other mutation — simulation short-circuits the DB per tick, not per
// checkpoint.


import { createClockRunner } from './clock-runner.mjs';
import { getLog } from './log.mjs';

import { principal as makePrincipal } from './principal.mjs';






































function simulationEntities(entities                   )                     {
  const sims                     = [];
  for (const entity of entities) {
    // `entities` is either a Map (app.entities: entries are [name, entity]) or
    // an array of entity records; pick the record either way.
    const record = (entity                                                   )?.[1] ?? entity;
    const candidate = record                                               ;
    if (!candidate || !candidate.simulation) continue;
    sims.push(candidate                    );
  }
  return sims;
}

// Build the system principal this simulation dispatches under. Mirrors
// tickSource: the authority IS the declared simulation on this entity.
function simPrincipal(entityName        )            {
  return makePrincipal({
    type: 'system',
    attributes: { source: `${entityName}.simulate` },
  });
}













export function startSimulation({ db, entities, dispatch, clock }                        )                   {
  const sims = simulationEntities(entities);
  if (sims.length === 0) return { stop() {} };

  const log = getLog();

  // Ephemeral working state, keyed by `${entityName}:${rowId}`.
  // Never written to DB directly — step reads/writes it in memory.
  const ephemeral = new Map                                 ();
  const lastTick = new Map                ();

  const fastestHz = Math.max(...sims.map((s) => s.simulation.hz));
  const intervalMs = Math.round(1000 / fastestHz);

  async function tick(ms        )                {
    for (const entity of sims) {
      const { simulation } = entity;
      const scopeKey = `${entity.name}:`;

      // Read all rows for this entity.
      let rows           ;
      try {
        rows = db.prepare(`SELECT * FROM ${entity.name}`).all()             ;
      } catch {
        log.warn('system', 'simulation row read failed', { entity: entity.name });
        continue;
      }

      const interval = Math.round(1000 / simulation.hz);
      for (const row of rows) {
        const key = `${scopeKey}${row.id}`;

        // when guard: skip scopes whose lifecycle condition doesn't hold.
        if (typeof simulation.when === 'function') {
          try {
            if (!simulation.when({ row })) continue;
          } catch {
            continue;
          }
        }

        const prev = lastTick.get(key) ?? (ms - interval);
        const dt = ms - prev;
        if (dt < interval) continue;

        lastTick.set(key, ms);

        try {
          const state = ephemeral.get(key) ?? {};
          const result = simulation.step({ state, dt, row });

          if (!result || typeof result !== 'object') continue;
          const stepResult = result                        ;

          ephemeral.set(key, stepResult.state ?? state);

          if (Array.isArray(stepResult.events) && stepResult.events.length > 0 && typeof dispatch === 'function') {
            const principal = simPrincipal(entity.name);
            for (const ev of stepResult.events) {
              try {
                await dispatch({
                  actionId: `sim-${entity.name}-${row.id}-${ms}`,
                  type: ev.type ?? `${entity.name}.update`,
                  principal,
                  payload: { id: row.id, ...ev.data },
                });
              } catch {
                log.warn('system', 'simulation event dispatch failed', {
                  entity: entity.name,
                  scope: row.id,
                  event: ev.type,
                });
              }
            }
          }
        } catch {
          log.warn('system', 'simulation step failed', {
            entity: entity.name,
            scope: row.id,
          });
        }
      }
    }
  }

  const { stop } = createClockRunner({ clock, intervalMs, fn: tick, name: 'simulation' });

  return { stop, _tick: (ms        ) => tick(ms) };
}

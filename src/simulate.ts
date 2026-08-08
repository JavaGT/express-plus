// Simulation engine — runs declared `simulation` loops. Holds ephemeral
// working state per scope in memory (no per-tick DB writes). The step
// function returns events to persist as checkpoints through the normal
// pipeline. Events write through BEGIN→projection→COMMIT, just like any
// other mutation — simulation short-circuits the DB per tick, not per
// checkpoint.

import type { SharedClock } from './clock-runner.ts';
import { createClockRunner } from './clock-runner.ts';
import { getLog } from './log.ts';
import type { Principal } from './principal.ts';
import { principal as makePrincipal } from './principal.ts';

interface SimulationDb {
  prepare(sql: string): { all(...params: unknown[]): RowLike[] };
}

interface RowLike {
  id: string | number;
  [field: string]: unknown;
}

interface Simulation {
  hz: number;
  when?(ctx: { row: RowLike }): boolean;
  step(ctx: { state: Record<string, unknown>; dt: number; row: RowLike }): unknown;
}

interface SimulationEntity {
  name: string;
  simulation: Simulation;
}

interface SimulationEvent {
  type?: string;
  data?: Record<string, unknown>;
}

interface SimulationStepResult {
  state?: Record<string, unknown>;
  events?: readonly SimulationEvent[];
}

interface SimulationDispatchArgs {
  actionId: string;
  type: string;
  principal: Principal;
  payload: Record<string, unknown>;
}

function simulationEntities(entities: Iterable<unknown>): SimulationEntity[] {
  const sims: SimulationEntity[] = [];
  for (const entity of entities) {
    // `entities` is either a Map (app.entities: entries are [name, entity]) or
    // an array of entity records; pick the record either way.
    const record = (entity as { [index: number]: unknown } | null | undefined)?.[1] ?? entity;
    const candidate = record as { simulation?: unknown } | null | undefined;
    if (!candidate || !candidate.simulation) continue;
    sims.push(candidate as SimulationEntity);
  }
  return sims;
}

// Build the system principal this simulation dispatches under. Mirrors
// tickSource: the authority IS the declared simulation on this entity.
function simPrincipal(entityName: string): Principal {
  return makePrincipal({
    type: 'system',
    attributes: { source: `${entityName}.simulate` },
  });
}

export interface StartSimulationOptions {
  db: SimulationDb;
  entities: Iterable<unknown>;
  dispatch: (args: SimulationDispatchArgs) => unknown;
  clock: SharedClock | null | undefined;
}

export interface SimulationHandle {
  stop(): void;
  _tick?(ms: number): Promise<void>;
}

export function startSimulation({ db, entities, dispatch, clock }: StartSimulationOptions): SimulationHandle {
  const sims = simulationEntities(entities);
  if (sims.length === 0) return { stop() {} };

  const log = getLog();

  // Ephemeral working state, keyed by `${entityName}:${rowId}`.
  // Never written to DB directly — step reads/writes it in memory.
  const ephemeral = new Map<string, Record<string, unknown>>();
  const lastTick = new Map<string, number>();

  const fastestHz = Math.max(...sims.map((s) => s.simulation.hz));
  const intervalMs = Math.round(1000 / fastestHz);

  async function tick(ms: number): Promise<void> {
    for (const entity of sims) {
      const { simulation } = entity;
      const scopeKey = `${entity.name}:`;

      // Read all rows for this entity.
      let rows: RowLike[];
      try {
        rows = db.prepare(`SELECT * FROM ${entity.name}`).all() as RowLike[];
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
          const stepResult = result as SimulationStepResult;

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

  return { stop, _tick: (ms: number) => tick(ms) };
}

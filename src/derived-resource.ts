// derived-resource.ts — durable state for data that can be rebuilt from source.
//
// Derived callbacks are deliberately outside authoritative source transactions.
// A callback failure only records retry information here; it cannot roll back or
// otherwise alter the source commit that made the resource stale.

import type { DbHandle } from './driver.ts';

export const DERIVED_RESOURCE_TABLE = '_DerivedResource';
export type DerivedResourceStatus = 'absent' | 'preparing' | 'current' | 'stale' | 'rebuilding' | 'failed';

export type DerivedResourceState = Readonly<{
  id: string;
  state: DerivedResourceStatus;
  attempts: number;
  lastError: string | null;
  updatedAt: string;
}>;

export type DerivedResourceContext = Readonly<{ db: DbHandle; state: DerivedResourceState }>;

export type DerivedResource = Readonly<{
  id: string;
  prepare?: (context: DerivedResourceContext) => void | Promise<void>;
  rebuild: (context: DerivedResourceContext) => void | Promise<void>;
  onTransition?: (state: DerivedResourceState) => void;
}>;

export type DerivedResourceRegistry = Readonly<{
  register(resource: DerivedResource): void;
  engage(): Promise<void>;
  stateOf(id: string): DerivedResourceState;
  states(): readonly DerivedResourceState[];
  markStale(id: string): Promise<DerivedResourceState>;
  prepareAll(): Promise<readonly DerivedResourceState[]>;
  reconcileBatches(options?: { readonly batchSize?: number }): Promise<Readonly<{ processed: number; remaining: number }>>;
}>;

const DDL = `CREATE TABLE IF NOT EXISTS ${DERIVED_RESOURCE_TABLE} (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  lastError TEXT,
  updatedAt TEXT NOT NULL
)`;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createDerivedResourceRegistry({
  db,
  writeCoordinator,
  batchSize = 100,
  now = () => new Date().toISOString(),
}: {
  readonly db: DbHandle | (() => DbHandle | null | undefined);
  readonly writeCoordinator: { run<T>(fn: () => T | Promise<T>): Promise<T> };
  readonly batchSize?: number;
  readonly now?: () => string;
}): DerivedResourceRegistry {
  const resources = new Map<string, DerivedResource>();
  const resolveDb = (): DbHandle => {
    const handle = typeof db === 'function' ? db() : db;
    if (!handle) throw new Error('derived resources require a database');
    return handle;
  };
  const validate = (resource: DerivedResource): void => {
    if (!resource || typeof resource.id !== 'string' || resource.id.length === 0 || typeof resource.rebuild !== 'function') {
      throw new TypeError('derived resources require a non-empty id and rebuild function');
    }
    if (resource.prepare !== undefined && typeof resource.prepare !== 'function') throw new TypeError(`derived resource '${resource.id}' prepare must be a function`);
    if (resource.onTransition !== undefined && typeof resource.onTransition !== 'function') throw new TypeError(`derived resource '${resource.id}' onTransition must be a function`);
  };
  const read = (id: string): DerivedResourceState => {
    const row = resolveDb().prepare(`SELECT id, state, attempts, lastError, updatedAt FROM ${DERIVED_RESOURCE_TABLE} WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`derived resource '${id}' is not engaged`);
    return Object.freeze({ id: String(row.id), state: String(row.state) as DerivedResourceStatus, attempts: Number(row.attempts), lastError: row.lastError == null ? null : String(row.lastError), updatedAt: String(row.updatedAt) });
  };
  const transition = (id: string, state: DerivedResourceStatus, lastError: string | null = null, incrementAttempts = false): DerivedResourceState => {
    const handle = resolveDb();
    handle.prepare(`UPDATE ${DERIVED_RESOURCE_TABLE} SET state = ?, attempts = attempts + ?, lastError = ?, updatedAt = ? WHERE id = ?`)
      .run(state, incrementAttempts ? 1 : 0, lastError, now(), id);
    const next = read(id);
    resources.get(id)?.onTransition?.(next);
    return next;
  };

  async function engage(): Promise<void> {
    if (resources.size === 0) return;
    await writeCoordinator.run(() => {
      const handle = resolveDb();
      handle.exec(DDL);
      for (const id of resources.keys()) {
        const exists = handle.prepare(`SELECT 1 FROM ${DERIVED_RESOURCE_TABLE} WHERE id = ?`).get(id);
        if (!exists) {
          handle.prepare(`INSERT INTO ${DERIVED_RESOURCE_TABLE} (id, state, attempts, lastError, updatedAt) VALUES (?, 'absent', 0, NULL, ?)`).run(id, now());
          resources.get(id)?.onTransition?.(read(id));
        }
      }
    });
  }

  function register(resource: DerivedResource): void {
    validate(resource);
    if (resources.has(resource.id)) throw new Error(`derived resource '${resource.id}' is already registered`);
    resources.set(resource.id, resource);
  }

  function stateOf(id: string): DerivedResourceState {
    if (!resources.has(id)) throw new Error(`derived resource '${id}' is not registered`);
    return read(id);
  }

  function states(): readonly DerivedResourceState[] {
    if (resources.size === 0) return [];
    const handle = resolveDb();
    return (handle.prepare(`SELECT id, state, attempts, lastError, updatedAt FROM ${DERIVED_RESOURCE_TABLE} ORDER BY id`).all() as Array<Record<string, unknown>>)
      .filter((row) => resources.has(String(row.id)))
      .map((row) => Object.freeze({ id: String(row.id), state: String(row.state) as DerivedResourceStatus, attempts: Number(row.attempts), lastError: row.lastError == null ? null : String(row.lastError), updatedAt: String(row.updatedAt) }));
  }

  async function markStale(id: string): Promise<DerivedResourceState> {
    if (!resources.has(id)) throw new Error(`derived resource '${id}' is not registered`);
    await engage();
    return writeCoordinator.run(() => {
      const current = read(id);
      return current.state === 'absent' ? current : transition(id, 'stale');
    });
  }

  async function materialize(id: string, kind: 'prepare' | 'rebuild'): Promise<DerivedResourceState> {
    const resource = resources.get(id)!;
    await engage();
    const before = await writeCoordinator.run(() => transition(id, kind === 'prepare' ? 'preparing' : 'rebuilding'));
    try {
      if (kind === 'prepare') await resource.prepare?.({ db: resolveDb(), state: before });
      else await resource.rebuild({ db: resolveDb(), state: before });
      return writeCoordinator.run(() => transition(id, 'current'));
    } catch (error) {
      return writeCoordinator.run(() => transition(id, 'failed', messageOf(error), true));
    }
  }

  async function prepareAll(): Promise<readonly DerivedResourceState[]> {
    await engage();
    for (const [id] of resources) {
      if (stateOf(id).state === 'absent') await materialize(id, 'prepare');
    }
    return states();
  }

  async function reconcileBatches(options: { readonly batchSize?: number } = {}): Promise<Readonly<{ processed: number; remaining: number }>> {
    await engage();
    const limit = Math.max(1, Math.floor(options.batchSize ?? batchSize));
    const pending = states().filter((entry) => entry.state === 'stale' || entry.state === 'failed' || entry.state === 'rebuilding').slice(0, limit);
    for (const entry of pending) await materialize(entry.id, 'rebuild');
    const remaining = states().filter((entry) => entry.state === 'stale' || entry.state === 'failed' || entry.state === 'rebuilding').length;
    return Object.freeze({ processed: pending.length, remaining });
  }

  return Object.freeze({ register, engage, stateOf, states, markStale, prepareAll, reconcileBatches });
}

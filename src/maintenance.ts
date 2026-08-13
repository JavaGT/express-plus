// maintenance.ts — the shared-state PRAGMA maintenance seam (epic scope#23,
// S1/A5; S1/B1 consumes it).
//
// A shared-state PRAGMA toggle (foreign_keys, the one S1/B1 needs) must enter
// through THIS seam and no other route: it is serialized through the platform
// write coordinator (so it can never interleave with an in-flight write), and
// it restores `foreign_keys = ON` in a finally even when the body throws. A raw
// `PRAGMA foreign_keys` toggle on the shared connection stays forbidden — the
// statement text itself lives only in driver.ts (setForeignKeys).
//
// The seam needs a db handle, which an adapter-backed app may not have until
// its deferred open completes; accept a thunk so the seam is constructible at
// app build time and resolves the handle at call time (fail-closed when the
// app never opened one).

import { withForeignKeysDisabledSync, type DbHandle } from './driver.ts';
import type { WriteQueue } from './write-queue.ts';

export type MaintenanceSeam = {
  // Run `fn` with `PRAGMA foreign_keys = OFF` inside one coordinated write
  // turn, then restore `ON` in a finally. Rejects when the app has no db
  // handle (fail-closed). The body runs synchronously within the turn; an
  // async body is awaited before the restore happens.
  withForeignKeysDisabled<T>(fn: () => T | Promise<T>): Promise<T>;
};

export type MaintenanceDb = DbHandle | (() => DbHandle | null | undefined);

export function createMaintenanceSeam(dbOrHandle: MaintenanceDb, writeQueue: WriteQueue): MaintenanceSeam {
  const resolveDb = (): DbHandle => {
    const db = typeof dbOrHandle === 'function' ? dbOrHandle() : dbOrHandle;
    if (!db) {
      throw new Error('maintenance requires a database — the application has no db handle (fail closed)');
    }
    return db;
  };
  return {
    withForeignKeysDisabled<T>(fn: () => T | Promise<T>): Promise<T> {
      // One coordinated turn: the write queue cannot hold a concurrent write
      // while the shared PRAGMA is toggled, and nested turns (already owned)
      // join the current turn rather than interleaving. run's fn may be async,
      // so the queued value can itself be a promise; `.then` flattens it once
      // (the same awaiting every queued async fn already does).
      return writeQueue.run(() => withForeignKeysDisabledSync(resolveDb(), fn)).then((value) => value as T);
    },
  };
}

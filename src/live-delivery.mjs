// Live Delivery — singular seam for live subscribe, fan-out, row-latch, and
// the post-commit consumer that delivers committed events over WebSocket.
//
// Kernel does not implement fanout/latch; it only registers the consumer
// this module contributes when `app.live` is engaged.

import { tryParseScopeKey } from './scope-handle.mjs';
import { createLiveServer as createLiveServerImpl } from './live.mjs';

export { createLiveServerImpl as createLiveServer };

/**
 * Post-commit consumer: latch the hydrated authz row per Scope handle within
 * a commit batch, then emit through the live server. A batch may carry several
 * events for the same row; re-reading+hydrating each is wasted work at 30–60Hz.
 * A removed row is `undefined` and stays so for the rest of the batch.
 */
export function createLivePostCommitConsumer(app) {
  if (!app.live) return null;
  return async (events, { db }) => {
    const rowLatch = new Map();
    for (const ev of events) {
      const handle = tryParseScopeKey(ev.scope);
      if (!handle) continue;
      const { entity: entityName, id, key: scope } = handle;
      const entity = app.entities?.get(entityName);
      let row = rowLatch.get(scope);
      if (row === undefined && !rowLatch.has(scope)) {
        try {
          const raw = db.prepare(`SELECT * FROM ${entityName} WHERE id = ?`).get(id);
          row = raw ? entity?.hydrate?.(raw, null) ?? raw : undefined;
        } catch {
          row = undefined;
        }
        rowLatch.set(scope, row);
      }
      app.live.emit(entity, id, row, ev, {
        hydrated: row !== undefined && typeof entity?.hydrate === 'function',
      });
    }
  };
}

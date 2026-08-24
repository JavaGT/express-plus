import { parseEventType } from './event-handle.ts';
import { sweepBehindCursor, upsertConsumerCursor } from './consumer-cursor.ts';
import { txn, type DbHandle } from './driver.ts';
import { getLog } from './log.ts';
import { compileBlobCensus, type BlobCensus } from './blob-census.ts';
import { declaredBlobField } from './pending-blob.ts';
import type { BlobStore } from './blob-store.ts';
import { decodeConsumerLogRowData, type LogRowLike } from './committed-log.ts';

// Durable, cursor-backed recovery for blob finalize — the same proven pattern
// as effect.durable (durable-effects.mjs) and projected.async (projected-
// async.mjs): the post-commit consumer advances a per-scope _ConsumerCursor
// atomically with its work, and a boot-time reconcile sweep replays any scope
// that fell behind (process died between COMMIT and the post-commit consumer
// running, or finalize threw). This retires blob-store.mjs reap()'s former
// "adopted + pending slot exists -> finalize" step: that scanned BlobStore
// directly with no notion of progress, so every reap re-checked every adopted
// row with no cursor to bound the work. The reaper now keeps only genuine
// orphan/dangler sweeps — those aren't replays of committed events and have
// no scope-cursor equivalent. The replacement finalize pass (S6/A5) is
// UNCURSORED by design — it replays the switch METADATA (BlobStore.replacedBy),
// so it runs for entity-field apps AND action-level-only apps alike.
const CONSUMER = 'blob.finalize';

interface BlobLifecycleEvent {
  handle?: { brand?: string; entity?: string } | null;
  type?: string | null;
  data?: Record<string, unknown> | null;
  scope?: string | null;
  seq?: number | null;
}

interface BlobLifecycleEntity {
  name: string;
  fields?: Readonly<Record<string, unknown>>;
}

export interface BlobLifecycle {
  blobAdapter: { adoptInTxn(txnDb: Pick<DbHandle, 'prepare'>, events: BlobLifecycleEvent[]): Promise<void> } | undefined;
  blobFinalizeConsumer: ((events: BlobLifecycleEvent[], context?: { db?: DbHandle }) => Promise<void>) | null;
  /** Compiled blob-reference census (S6/A3) — the reaper's and backup's column source. */
  census: BlobCensus;
  reconcileBlobFinalize: (db: DbHandle) => Promise<{ finalized: number }>;
}

export function createBlobLifecycle({ blobs, entities, declaredBlobFields = [] }: {
  blobs?: BlobStore | null;
  entities: ReadonlyMap<string, BlobLifecycleEntity>;
  declaredBlobFields?: readonly unknown[];
}): BlobLifecycle {
  // Compiled ONCE at prepare time from entity declarations + validated
  // action-level blob-field declarations (S6/A3). No runtime `blobColumns`
  // derivation or scan remains — the census is a pure, deterministic registry.
  const census = compileBlobCensus({
    entities,
    declaredBlobFields: declaredBlobFields.map(declaredBlobField),
  });

  if (!blobs) {
    return {
      blobAdapter: undefined,
      blobFinalizeConsumer: null,
      census,
      reconcileBlobFinalize: async () => ({ finalized: 0 }),
    };
  }

  // The framework blob pipeline (adopt-in-dispatch + blob.finalize consumer +
  // boot reconcile) resolves ids from the census's entity-derived references —
  // action-level declarations against non-entity tables are owned by the
  // pending-blob pipeline and finalize themselves.
  const blobFields = new Map<string, string[]>();
  for (const ref of census.entityReferences) {
    if (!blobFields.has(ref.table)) blobFields.set(ref.table, []);
    blobFields.get(ref.table)!.push(ref.column);
  }

  // With NO declared references at all (neither entity blob fields nor
  // action-level declarations) there is nothing to adopt, finalize, or recover
  // — the lifecycle is a no-op and never touches the (possibly absent)
  // BlobStore table. Action-level-only declarations still engage the
  // replacement finalize pass below (S6/A5): a generation switched in via
  // switchReplacement is finalized from the switch METADATA, independent of
  // entity events, so an action-owned replacement never stays pending forever.
  if (census.references.length === 0) {
    return {
      blobAdapter: undefined,
      blobFinalizeConsumer: null,
      census,
      reconcileBlobFinalize: async () => ({ finalized: 0 }),
    };
  }

  const resolveBlobIds = (event: BlobLifecycleEvent): string[] => {
    const entityName = event.handle?.brand === 'event-handle'
      ? event.handle.entity as string
      : (() => { try { return parseEventType(event.type as string).entity; } catch { return ''; } })();
    const fields = blobFields.get(entityName) ?? [];
    const ids: string[] = [];
    for (const fieldName of fields) {
      const value = event.data?.[fieldName];
      if (value) ids.push(value as string);
    }
    return ids;
  };

  // The adopt-in-dispatch adapter resolves ids from ENTITY-derived references
  // only (action-level declarations adopt through the pending-blob pipeline);
  // an action-level-only app has no entity ids to adopt and no adapter.
  const blobAdapter = blobFields.size > 0
    ? {
        async adoptInTxn(txnDb: Pick<DbHandle, 'prepare'>, events: BlobLifecycleEvent[]): Promise<void> {
          const blobIds = new Set<string>();
          for (const event of events) for (const id of resolveBlobIds(event)) blobIds.add(id);
          for (const id of blobIds) blobs.adopt(txnDb, id);
        },
      }
    : undefined;

  // finalize() renames bytes on the filesystem — it is NOT part of the SQL
  // transaction and cannot be rolled back by it, so this is deliberately
  // at-least-once, not exactly-once: if the cursor write that follows fails
  // or the process dies between the two, the byte-level finalize already
  // happened but the checkpoint stays behind. That is safe only because
  // finalize() is idempotent (blob-store.mjs: "the byte store swallows a
  // missing pending slot"), so a recovery-sweep replay of the same id is
  // always a no-op — the txn below makes the CHECKPOINT atomic with "finalize
  // was attempted for this scope's events," not the byte rename itself.
  const finalizeAndAdvance = async (db: DbHandle, { scope, seq }: { scope: string; seq: number }, ids: string[]): Promise<void> => {
    for (const id of ids) blobs.finalize(id);
    await txn(db, () => {
      upsertConsumerCursor(db, { consumer: CONSUMER, scope, lastSeq: seq });
    });
  };

  // Replacement finalize pass (S6/A5): a generation switched in via
  // switchReplacement has its bytes staged in the pending slot until finalize
  // promotes them. Replacements whose owning committed event carried the new
  // id are already finalized by the event sweep above; this pass covers the
  // replacements recorded only in the switch metadata (BlobStore.replacedBy) —
  // finalize each idempotently (a missing pending slot is a no-op, so every
  // re-run is safe and cheap). A persistent byte-store failure keeps the
  // replaced row's `replacedBy` recorded, so the next consumer batch or boot
  // reconcile retries it.
  async function finalizeReplacementGenerations(db: DbHandle): Promise<number> {
    if (!blobs) return 0;
    const replaced = db.prepare('SELECT replacedBy FROM BlobStore WHERE status = ? AND replacedBy IS NOT NULL').all('replaced') as Array<{ replacedBy: string }>;
    let finalized = 0;
    for (const row of replaced) {
      try {
        blobs.finalize(row.replacedBy);
        finalized++;
      } catch (err) {
        getLog().warn('system', 'blob replacement finalize failed', { err, id: row.replacedBy });
      }
    }
    return finalized;
  }

  const blobFinalizeConsumer: BlobLifecycle['blobFinalizeConsumer'] = async (events, { db } = {}) => {
    // Entity-event finalize applies only when the census has entity-derived
    // blob fields. An action-level-only app has no event ids to resolve here
    // (its bytes finalize through the pending-blob pipeline); the replacement
    // pass below still runs for it.
    if (blobFields.size > 0) {
      // Dedup across the WHOLE batch, not per event: two events in one
      // afterCommit call (e.g. created + updated referencing the same blob)
      // must finalize that id once, matching the pre-cursor behavior.
      const finalizedInBatch = new Set<string>();
      // Once a scope's cursor advance fails, stop advancing THAT scope's
      // cursor for the rest of this batch — even if a later same-scope event
      // would otherwise succeed. Events for one scope arrive in ascending seq
      // order; if a later event's cursor write "wins" after an earlier one
      // failed, the earlier failure is silently marked done (lastSeq only ever
      // goes up) and a boot-time reconcile would never retry it. Deferring the
      // rest of the scope to reconcile is simple and safe — a re-attempted
      // later finalize is a harmless no-op (finalize() is idempotent).
      const blockedScopes = new Set<string>();
      for (const event of events) {
        if (event.scope != null && blockedScopes.has(event.scope)) continue;
        const ids = resolveBlobIds(event);
        if (ids.length === 0) continue;
        const toFinalize = ids.filter((id) => !finalizedInBatch.has(id));
        for (const id of ids) finalizedInBatch.add(id);
        if (typeof event.seq !== 'number') {
          // No log seq to anchor a cursor to (a caller driving the consumer
          // outside the committed pipeline) — finalize best-effort, uncursored.
          for (const id of toFinalize) { try { blobs.finalize(id); } catch {} }
          continue;
        }
        try {
          await finalizeAndAdvance(db as DbHandle, { scope: event.scope as string, seq: event.seq }, toFinalize);
        } catch (err) {
          // The cursor did not advance — a failed finalize (or a blocked
          // cursor insert) leaves this scope behind, so the next reconcile
          // sweep retries it. The committed action/projection are unaffected:
          // this consumer runs strictly post-commit.
          if (event.scope != null) blockedScopes.add(event.scope);
          getLog().warn('system', 'blob finalize consumer failed', { err, scope: event.scope, seq: event.seq });
        }
      }
    }
    // Post-batch replacement finalize: isolated (a failure never undoes the
    // committed events) and best-effort — the boot reconcile sweeps any
    // replacement that still needs it.
    if (db) {
      try {
        await finalizeReplacementGenerations(db);
      } catch (err) {
        getLog().warn('system', 'blob replacement finalize sweep failed', { err });
      }
    }
  };

  async function reconcileBlobFinalize(db: DbHandle): Promise<{ finalized: number }> {
    let finalized = 0;
    // The cursor-backed event replay applies only to entity-derived references;
    // an action-level-only app has no blob events in its committed log to
    // replay (its bytes finalize through the pending-blob pipeline).
    if (blobFields.size > 0) {
      await sweepBehindCursor(db, CONSUMER, async (row) => {
        let data: Record<string, unknown>;
        // Strict log-row decode (round 3): tampered v16 rows BLOCK the cursor
        // (fail closed — nothing advances past a corrupt row); only malformed
        // legacy (non-v16) rows degrade to {} as before.
        try {
          data = decodeConsumerLogRowData(row as unknown as LogRowLike, {});
        } catch (err) {
          getLog().warn('system', 'blob finalize recovery blocked on tampered v16 event', { err, scope: row.scope, seq: row.seq });
          return 'block';
        }
        const ids = resolveBlobIds({ type: row.eventType, data });
        if (ids.length === 0) return 'skip';
        try {
          await finalizeAndAdvance(db, { scope: row.scope, seq: row.seq }, ids);
          finalized += ids.length;
          return 'done';
        } catch (err) {
          getLog().warn('system', 'blob finalize recovery failed', { err, scope: row.scope, seq: row.seq });
          return 'block';
        }
      });
    }
    // The replacement pass is uncursored (it replays the switch METADATA, not
    // committed events): finalize every switched-in replacement idempotently so
    // a crash between switch-commit and event-driven finalize is recovered
    // here. It runs even for action-level-only declarations — the replacement
    // metadata lives on the BlobStore row, not in entity events.
    finalized += await finalizeReplacementGenerations(db);
    return { finalized };
  }

  return { blobAdapter, blobFinalizeConsumer, census, reconcileBlobFinalize };
}

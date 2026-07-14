import { parseEventType } from './event-handle.mjs';
import { consumerCursorMap, upsertConsumerCursor } from './consumer-cursor.mjs';
import { txn } from './driver.mjs';
import { getLog } from './log.mjs';

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
// no scope-cursor equivalent.
const CONSUMER = 'blob.finalize';

export function createBlobLifecycle({ blobs, entities }) {
  if (!blobs) {
    return {
      blobAdapter: undefined,
      blobFinalizeConsumer: null,
      blobColumns: [],
      reconcileBlobFinalize: async () => ({ finalized: 0 }),
    };
  }

  const blobFields = new Map();
  const blobColumns = [];
  for (const [name, ent] of entities) {
    const fields = [];
    for (const [fname, descriptor] of Object.entries(ent.fields ?? {})) {
      if (descriptor && descriptor.blob === true) fields.push(fname);
    }
    if (fields.length > 0) {
      blobFields.set(name, fields);
      for (const fieldName of fields) blobColumns.push({ table: name, column: fieldName });
    }
  }

  if (blobFields.size === 0) {
    return {
      blobAdapter: undefined,
      blobFinalizeConsumer: null,
      blobColumns,
      reconcileBlobFinalize: async () => ({ finalized: 0 }),
    };
  }

  const resolveBlobIds = (event) => {
    const entityName = event.handle?.brand === 'event-handle'
      ? event.handle.entity
      : (() => { try { return parseEventType(event.type).entity; } catch { return ''; } })();
    const fields = blobFields.get(entityName) ?? [];
    const ids = [];
    for (const fieldName of fields) {
      const value = event.data?.[fieldName];
      if (value) ids.push(value);
    }
    return ids;
  };

  const blobAdapter = {
    async adoptInTxn(txnDb, events) {
      const blobIds = new Set();
      for (const event of events) for (const id of resolveBlobIds(event)) blobIds.add(id);
      for (const id of blobIds) blobs.adopt(txnDb, id);
    },
  };

  // finalize() renames bytes on the filesystem — it is NOT part of the SQL
  // transaction and cannot be rolled back by it, so this is deliberately
  // at-least-once, not exactly-once: if the cursor write that follows fails
  // or the process dies between the two, the byte-level finalize already
  // happened but the checkpoint stays behind. That is safe only because
  // finalize() is idempotent (blob-store.mjs: "the byte store swallows a
  // missing pending slot"), so a recovery-sweep replay of the same id is
  // always a no-op — the txn below makes the CHECKPOINT atomic with "finalize
  // was attempted for this scope's events," not the byte rename itself.
  async function finalizeAndAdvance(db, { scope, seq }, ids) {
    for (const id of ids) blobs.finalize(id);
    await txn(db, () => {
      upsertConsumerCursor(db, { consumer: CONSUMER, scope, lastSeq: seq });
    });
  }

  const blobFinalizeConsumer = async (events, { db } = {}) => {
    // Dedup across the WHOLE batch, not per event: two events in one
    // afterCommit call (e.g. created + updated referencing the same blob)
    // must finalize that id once, matching the pre-cursor behavior.
    const finalizedInBatch = new Set();
    // Once a scope's cursor advance fails, stop advancing THAT scope's
    // cursor for the rest of this batch — even if a later same-scope event
    // would otherwise succeed. Events for one scope arrive in ascending seq
    // order; if a later event's cursor write "wins" after an earlier one
    // failed, the earlier failure is silently marked done (lastSeq only ever
    // goes up) and a boot-time reconcile would never retry it. Deferring the
    // rest of the scope to reconcile is simple and safe — a re-attempted
    // later finalize is a harmless no-op (finalize() is idempotent).
    const blockedScopes = new Set();
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
        await finalizeAndAdvance(db, event, toFinalize);
      } catch (err) {
        // The cursor did not advance — a failed finalize (or a blocked
        // cursor insert) leaves this scope behind, so the next reconcile
        // sweep retries it. The committed action/projection are unaffected:
        // this consumer runs strictly post-commit.
        if (event.scope != null) blockedScopes.add(event.scope);
        getLog().warn('system', 'blob finalize consumer failed', { err, scope: event.scope, seq: event.seq });
      }
    }
  };

  async function reconcileBlobFinalize(db) {
    const recoveryByScope = consumerCursorMap(db, CONSUMER);
    const rows = db.prepare('SELECT * FROM _Log ORDER BY scope, seq').all();
    // Same per-scope blocking as the consumer above, for the same reason:
    // rows are ordered scope-then-seq, so a later same-scope row succeeding
    // after an earlier one failed must not advance the cursor past the
    // failure — that would permanently hide the earlier miss from every
    // future reconcile run, not just this one.
    const blockedScopes = new Set();
    let finalized = 0;
    for (const row of rows) {
      if (blockedScopes.has(row.scope)) continue;
      const applied = recoveryByScope.get(row.scope) ?? 0;
      if (applied >= row.seq) continue;
      let data;
      try { data = JSON.parse(row.eventData); } catch { data = {}; }
      const ids = resolveBlobIds({ type: row.eventType, data });
      if (ids.length === 0) {
        upsertConsumerCursor(db, { consumer: CONSUMER, scope: row.scope, lastSeq: row.seq });
        recoveryByScope.set(row.scope, row.seq);
        continue;
      }
      try {
        await finalizeAndAdvance(db, { scope: row.scope, seq: row.seq }, ids);
        recoveryByScope.set(row.scope, row.seq);
        finalized += ids.length;
      } catch (err) {
        blockedScopes.add(row.scope);
        getLog().warn('system', 'blob finalize recovery failed', { err, scope: row.scope, seq: row.seq });
      }
    }
    return { finalized };
  }

  return { blobAdapter, blobFinalizeConsumer, blobColumns, reconcileBlobFinalize };
}

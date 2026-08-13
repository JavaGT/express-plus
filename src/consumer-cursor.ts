import { upsert, type DbHandle } from './driver.ts';
import { getLog } from './log.ts';

export function upsertConsumerCursor(
  db: DbHandle,
  { consumer, scope, lastSeq }: { consumer: string; scope: string; lastSeq: number },
) {
  upsert(db, {
    table: '_ConsumerCursor',
    keyColumns: ['consumer', 'scope'],
    columns: ['lastSeq'],
    values: { consumer, scope, lastSeq },
  });
}

export function consumerCursorMap(db: DbHandle, consumer: string): Map<string, number> {
  return new Map(
    db
      .prepare(
        'SELECT scope, lastSeq FROM _ConsumerCursor WHERE consumer = :consumer',
      )
      .all({ consumer } as Record<string, unknown>)
      .map((r) => [r.scope as string, r.lastSeq as number]),
  );
}

export interface CursorSweepRow {
  scope: string;
  seq: number;
  eventType: string;
  eventData: string;
  actionId: string;
  committedAt: string;
}

export type CursorSweepVerdict = 'done' | 'skip' | 'block';

// Cursor-bounded reconcile sweep shared by every durable-projection consumer
// (blob finalize, email delivery, durable effects, operational consumers).
// Reads only _Log rows behind this consumer's per-scope _ConsumerCursor, so a
// sweep is proportional to the acknowledged gap, not to retained history. The
// sweep keeps one in-memory cursor map and one blocked-scope set so a failure
// can never be hidden by a later same-scope success; a throwing work function
// is treated as a block rather than crashing the sweep. Cursor advance
// atomicity is owned by the consumer's own *AndAdvance txn ('done'), never
// duplicated here.
export async function sweepBehindCursor(
  db: DbHandle,
  consumer: string,
  work: (row: CursorSweepRow, db: DbHandle) => Promise<CursorSweepVerdict>,
): Promise<{ handled: number; blocked: number }> {
  const rows = db.prepare(`SELECT log.* FROM _Log AS log
    LEFT JOIN _ConsumerCursor AS cursor
      ON cursor.consumer = :consumer AND cursor.scope = log.scope
    WHERE log.seq > COALESCE(cursor.lastSeq, 0)
    ORDER BY log.scope, log.seq`).all({ consumer } as Record<string, unknown>) as unknown as CursorSweepRow[];
  const cursors = consumerCursorMap(db, consumer);
  const blockedScopes = new Set<string>();
  let handled = 0;
  let blocked = 0;
  for (const row of rows) {
    if (blockedScopes.has(row.scope)) continue;
    if ((cursors.get(row.scope) ?? 0) >= row.seq) continue;
    let verdict: CursorSweepVerdict;
    try {
      verdict = await work(row, db);
    } catch (err) {
      getLog().warn('system', 'durable projection sweep failed', { err, consumer, scope: row.scope, seq: row.seq });
      verdict = 'block';
    }
    if (verdict === 'skip') {
      upsertConsumerCursor(db, { consumer, scope: row.scope, lastSeq: row.seq });
      cursors.set(row.scope, row.seq);
      handled += 1;
    } else if (verdict === 'done') {
      cursors.set(row.scope, row.seq);
      handled += 1;
    } else {
      blockedScopes.add(row.scope);
      blocked += 1;
    }
  }
  return { handled, blocked };
}

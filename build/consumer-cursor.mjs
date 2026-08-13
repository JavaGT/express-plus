import { upsert,               } from './driver.mjs';
import { getLog } from './log.mjs';

export function upsertConsumerCursor(
  db          ,
  { consumer, scope, lastSeq }                                                      ,
) {
  upsert(db, {
    table: '_ConsumerCursor',
    keyColumns: ['consumer', 'scope'],
    columns: ['lastSeq'],
    values: { consumer, scope, lastSeq },
  });
}

export function consumerCursorMap(db          , consumer        )                      {
  return new Map(
    db
      .prepare(
        'SELECT scope, lastSeq FROM _ConsumerCursor WHERE consumer = :consumer',
      )
      .all({ consumer }                           )
      .map((r) => [r.scope          , r.lastSeq          ]),
  );
}

                                 
                
              
                    
                    
                   
                      
 

                                                           

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
  db          ,
  consumer        ,
  work                                                                    ,
)                                                {
  const rows = db.prepare(`SELECT log.* FROM _Log AS log
    LEFT JOIN _ConsumerCursor AS cursor
      ON cursor.consumer = :consumer AND cursor.scope = log.scope
    WHERE log.seq > COALESCE(cursor.lastSeq, 0)
    ORDER BY log.scope, log.seq`).all({ consumer }                           )                               ;
  const cursors = consumerCursorMap(db, consumer);
  const blockedScopes = new Set        ();
  let handled = 0;
  let blocked = 0;
  for (const row of rows) {
    if (blockedScopes.has(row.scope)) continue;
    if ((cursors.get(row.scope) ?? 0) >= row.seq) continue;
    let verdict                    ;
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

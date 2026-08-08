import { upsert, type DbHandle } from './driver.ts';

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

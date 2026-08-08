import { upsert,               } from './driver.mjs';

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

export function upsertConsumerCursor(db, { consumer, scope, lastSeq }) {
  db.prepare(
    `INSERT INTO _ConsumerCursor (consumer, scope, lastSeq) VALUES (:consumer, :scope, :lastSeq)
     ON CONFLICT(consumer, scope) DO UPDATE SET lastSeq = excluded.lastSeq`,
  ).run({ consumer, scope, lastSeq });
}

export function consumerCursorMap(db, consumer) {
  return new Map(
    db.prepare('SELECT scope, lastSeq FROM _ConsumerCursor WHERE consumer = :consumer')
      .all({ consumer })
      .map((r) => [r.scope, r.lastSeq]),
  );
}

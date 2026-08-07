// The deleted-row history anchor (Wave 3.7 Contract 1 / Wave 4.10). When a row
// is removed, its last known state is captured into _DeletedRowAnchor in the
// SAME transaction as the DELETE — atomic, no window where a removal commits
// without an anchor. The anchor exists for exactly one purpose: letting a
// principal who held a grant on the row AT THE TIME OF DELETION continue to
// read that scope's committed event history after the row is gone. It is
// never a second source of "current" row state — CRUD and list continue to
// see the row as gone the instant it is deleted; only the explicit historical
// read path (authorizeRow's `allowDeletedAnchor` option) consults it.

type DeletedRowStatement = {
  run(params?: Record<string, unknown>): void;
  get<T = { row: string }>(params?: Record<string, unknown>): T | undefined;
};

type DeletedRowDb = {
  prepare(sql: string): DeletedRowStatement;
};

export function deletedRowAnchorTableDDL(): string {
  return `CREATE TABLE IF NOT EXISTS _DeletedRowAnchor (
  entity TEXT NOT NULL,
  id TEXT NOT NULL,
  row TEXT NOT NULL,
  deletedAt TEXT NOT NULL,
  PRIMARY KEY (entity, id)
);`;
}

// captureDeletedRowAnchor — record a row's last known state at the moment it
// is removed. Upserts: if the same id is created and deleted again, the
// anchor tracks the most recent deletion, matching the most recent grant a
// principal actually held.
export function captureDeletedRowAnchor(
  db: DeletedRowDb,
  entityName: string,
  id: string,
  row: unknown,
  deletedAt: string,
): void {
  db.prepare(
    'INSERT INTO _DeletedRowAnchor (entity, id, row, deletedAt) VALUES (:entity, :id, :row, :deletedAt) ' +
      'ON CONFLICT(entity, id) DO UPDATE SET row = excluded.row, deletedAt = excluded.deletedAt',
  ).run({ entity: entityName, id, row: JSON.stringify(row), deletedAt });
}

// readDeletedRowAnchor — the row's last known state, in the same raw
// (pre-deserializeRow) shape `readScopedRow`'s SQL read would have produced,
// or undefined if this id was never captured (including: never deleted).
export function readDeletedRowAnchor(db: DeletedRowDb, entityName: string, id: string): unknown {
  const stored = db
    .prepare('SELECT row FROM _DeletedRowAnchor WHERE entity = :entity AND id = :id')
    .get<{ row: string }>({ entity: entityName, id });
  return stored ? JSON.parse(stored.row) : undefined;
}

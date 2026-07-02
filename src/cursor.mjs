// Per-scope committed sequence number from the kernel's _Cursor table.
// Used by pipeline (nextSeq), live (subscribe-time currentSeq), and serve
// (snapshot route) — one canonical read, no duplicated SQL.

export function readSeq(db, scope) {
  if (!db) return 0;
  const row = db.prepare('SELECT lastSeq FROM _Cursor WHERE scope = ?').get(scope);
  return row ? row.lastSeq : 0;
}

// Per-scope committed sequence number from the kernel's _Cursor table.
// Used by pipeline (nextSeq), live (subscribe-time currentSeq), and serve
// (snapshot route) — one canonical read, no duplicated SQL.

import { prepareCached } from './driver.ts';

export interface CursorDatabase {
  prepare(sql: string): {
    get(scope: string): { lastSeq?: number } | undefined | null;
  };
}

export function readSeq(db: CursorDatabase | null | undefined, scope: string): number {
  if (!db) return 0;
  const row = prepareCached(db, 'SELECT lastSeq FROM _Cursor WHERE scope = ?').get(scope);
  return row ? row.lastSeq ?? 0 : 0;
}

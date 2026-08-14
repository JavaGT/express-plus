// Vector similarity functions — cosine similarity and nearest-neighbor
// search. Pure JS, zero runtime dependencies.

// cosineSimilarity(a, b) — the core vector comparator. Pure JS, zero runtime
// dependencies, matching Scope's approach (in-memory, brute-force). Returns a
// similarity score in [-1, 1]; 1 = identical, 0 = orthogonal, -1 = opposite.
// A zero-magnitude vector returns 0 to avoid division by zero.
export function cosineSimilarity(a: unknown, b: unknown): number {
  if (!a || !b || !Array.isArray(a) || !Array.isArray(b)) return 0;
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < len; i++) {
    const ai = Number(a[i]) || 0;
    const bi = Number(b[i]) || 0;
    dot += ai * bi;
    magA += ai * ai;
    magB += bi * bi;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

// Rank already-owned vector entries without coupling the comparator to storage.
// Equal scores use the stable entry id so results do not depend on insertion or
// database scan order.
export function nearestVectors<T extends { readonly id: string; readonly vector: unknown }>(
  entries: readonly T[],
  query: unknown,
  limit: number,
): readonly T[] {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError(`nearest vector limit must be a positive safe integer, got ${String(limit)}`);
  }
  return entries
    .map((entry) => ({ entry, score: cosineSimilarity(query, entry.vector) }))
    .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
    .slice(0, limit)
    .map(({ entry }) => entry);
}

// nearest(db, entityName, fieldName, queryVec, k) — a standalone helper for
// top-K nearest-neighbour search. Loads all rows from the entity table, computes
// cosine similarity for the named field, and returns the top-K rows (hydrated).
// Brute-force (fine for single-user-project scale); no SQL-level similarity op.
export function nearest(
  db: { prepare(sql: string): { all(): Record<string, unknown>[] } },
  entityName: string,
  fieldName: string,
  queryVec: unknown,
  k: number,
  hydrateFn?: (row: Record<string, unknown>) => unknown,
): unknown[] {
  const rows = db.prepare(`SELECT * FROM ${entityName} AS t0`).all();
  const scored = rows.map((row) => {
    let vec: unknown = row[fieldName];
    if (typeof vec === 'string') {
      try { vec = JSON.parse(vec); } catch { vec = null; }
    }
    const similarity = cosineSimilarity(queryVec, vec);
    return { row, similarity };
  });
  scored.sort((a, b) => b.similarity - a.similarity);
  const topK = scored.slice(0, k);
  return topK.map(({ row }) => (hydrateFn ? hydrateFn(row) : row));
}

export interface NearestSpec {
  field: string;
  query: unknown;
  k: number;
}

// applyNearest(rows, nearest, hydrate) — post-processes already-fetched rows
// by computing cosine similarity against the query vector and returning top-K.
// Used internally by the query builder for scope predicates containing .nearest().
export function applyNearest(rows: Record<string, unknown>[], nearest: NearestSpec, _hydrate?: unknown): Record<string, unknown>[] {
  const { field, query, k } = nearest;
  const scored = rows.map((row) => {
    let vec: unknown = row[field];
    if (typeof vec === 'string') {
      try { vec = JSON.parse(vec); } catch { vec = null; }
    }
    const similarity = cosineSimilarity(query, vec);
    return { row, similarity };
  });
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, k).map(({ row }) => row);
}

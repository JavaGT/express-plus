// Vector similarity functions — cosine similarity and nearest-neighbor
// search. Pure JS, zero runtime dependencies.

// cosineSimilarity(a, b) — the core vector comparator. Pure JS, zero runtime
// dependencies, matching Scope's approach (in-memory, brute-force). Returns a
// similarity score in [-1, 1]; 1 = identical, 0 = orthogonal, -1 = opposite.
// A zero-magnitude vector returns 0 to avoid division by zero.
export function cosineSimilarity(a         , b         )         {
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
export function nearestVectors                                                             (
  entries              ,
  query         ,
  limit        ,
)               {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError(`nearest vector limit must be a positive safe integer, got ${String(limit)}`);
  }
  return entries
    .map((entry) => ({ entry, score: cosineSimilarity(query, entry.vector) }))
    .sort(compareVectorCandidates)
    .slice(0, limit)
    .map(({ entry }) => entry);
}






function compareIds(a        , b        )         {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareVectorCandidates                                   (a                    , b                    )         {
  if (a.score > b.score) return -1;
  if (a.score < b.score) return 1;
  return compareIds(a.entry.id, b.entry.id);
}

// Ranks a large index without monopolizing the event loop. The heap retains only
// the requested top-K entries, and each batch yields so cancellation can stop it.
export async function nearestVectorsInterruptibly                                                             (
  entries              ,
  query         ,
  limit        ,
  signal              ,
)                        {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError(`nearest vector limit must be a positive safe integer, got ${String(limit)}`);
  }
  const heap                       = [];
  const push = (candidate                    )       => {
    heap.push(candidate);
    let child = heap.length - 1;
    while (child > 0) {
      const parent = Math.floor((child - 1) / 2);
      if (compareVectorCandidates(heap[child], heap[parent]) <= 0) break;
      [heap[child], heap[parent]] = [heap[parent], heap[child]];
      child = parent;
    }
  };
  const replaceWorst = (candidate                    )       => {
    heap[0] = candidate;
    let parent = 0;
    while (true) {
      const left = parent * 2 + 1;
      const right = left + 1;
      let worst = parent;
      if (left < heap.length && compareVectorCandidates(heap[left], heap[worst]) > 0) worst = left;
      if (right < heap.length && compareVectorCandidates(heap[right], heap[worst]) > 0) worst = right;
      if (worst === parent) return;
      [heap[parent], heap[worst]] = [heap[worst], heap[parent]];
      parent = worst;
    }
  };

  for (let index = 0; index < entries.length; index += 1) {
    if (signal?.aborted) return [];
    const entry = entries[index];
    const candidate = { entry, score: cosineSimilarity(query, entry.vector) };
    if (heap.length < limit) push(candidate);
    else if (compareVectorCandidates(candidate, heap[0]) < 0) replaceWorst(candidate);
    if ((index + 1) % 128 === 0) {
      await new Promise      ((resolve) => setTimeout(resolve, 0));
      if (signal?.aborted) return [];
    }
  }
  return heap.sort(compareVectorCandidates).map(({ entry }) => entry);
}

// nearest(db, entityName, fieldName, queryVec, k) — a standalone helper for
// top-K nearest-neighbour search. Loads all rows from the entity table, computes
// cosine similarity for the named field, and returns the top-K rows (hydrated).
// Brute-force (fine for single-user-project scale); no SQL-level similarity op.
export function nearest(
  db                                                                ,
  entityName        ,
  fieldName        ,
  queryVec         ,
  k        ,
  hydrateFn                                            ,
)            {
  const rows = db.prepare(`SELECT * FROM ${entityName} AS t0`).all();
  const scored = rows.map((row) => {
    let vec          = row[fieldName];
    if (typeof vec === 'string') {
      try { vec = JSON.parse(vec); } catch { vec = null; }
    }
    const similarity = cosineSimilarity(queryVec, vec);
    return { row, similarity };
  });
  scored.sort((a, b) => {
    if (a.similarity > b.similarity) return -1;
    if (a.similarity < b.similarity) return 1;
    return compareIds(String(a.row.id ?? ''), String(b.row.id ?? ''));
  });
  const topK = scored.slice(0, k);
  return topK.map(({ row }) => (hydrateFn ? hydrateFn(row) : row));
}







// applyNearest(rows, nearest, hydrate) — post-processes already-fetched rows
// by computing cosine similarity against the query vector and returning top-K.
// Used internally by the query builder for scope predicates containing .nearest().
export function applyNearest(rows                           , nearest             , _hydrate          )                            {
  const { field, query, k } = nearest;
  const scored = rows.map((row) => {
    let vec          = row[field];
    if (typeof vec === 'string') {
      try { vec = JSON.parse(vec); } catch { vec = null; }
    }
    const similarity = cosineSimilarity(query, vec);
    return { row, similarity };
  });
  scored.sort((a, b) => {
    if (a.similarity > b.similarity) return -1;
    if (a.similarity < b.similarity) return 1;
    return compareIds(String(a.row.id ?? ''), String(b.row.id ?? ''));
  });
  return scored.slice(0, k).map(({ row }) => row);
}

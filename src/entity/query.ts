import { lowerToSql } from '../scope-sql.ts';
import { cosineSimilarity, applyNearest, type NearestSpec } from '../vector.ts';

type Row = Record<string, unknown>;
type HydrateFn = (row: Row, principal?: unknown, dispatch?: unknown) => Row;
type DeserializeFn = (row: Row) => Row;

type Statement = {
  run(...args: unknown[]): { changes: number };
  get(...args: unknown[]): Row | undefined;
  all(...args: unknown[]): Row[];
};

type Db = {
  prepare(sql: string): Statement;
};

type CompiledScope = {
  sql: string;
  params: Record<string, unknown>;
  nearest: NearestSpec | null;
};

type FieldHandle = { fieldName: string };

// The one shape every caller's db satisfies: only `get` on a prepared statement
// is used, so a driver or app handle returning `unknown` from `get` still works.
type RawRowDb = {
  prepare(sql: string): { get(...args: unknown[]): unknown };
};

// One shared raw-stored-row read: `SELECT * FROM <entity> WHERE id = ?` exactly
// as the inline sites wrote it. Returns the stored cells as they are — no
// hydration, no authorization. The permission-checked, hydrated read is
// findById; a raw read never replaces it.
export function rawRow(
  db: RawRowDb | null | undefined,
  entity: { name: string } | string,
  id: unknown,
): Row | undefined {
  if (!db) return undefined;
  const name = typeof entity === 'string' ? entity : entity.name;
  return db.prepare(`SELECT * FROM ${name} WHERE id = ?`).get(id) as Row | undefined;
}

export function makeQueryBuilder({ name, predicate, hydrate, defaultLimit = null, db }: {
  name: string;
  predicate: unknown;
  hydrate: HydrateFn;
  defaultLimit?: number | null;
  db: Db;
}) {
  const where = lowerToSql(predicate as Parameters<typeof lowerToSql>[0]) as CompiledScope;
  const state: { orderBy: string | null; limit: number | null; selectCols: string[] | null } = {
    orderBy: null,
    limit: null,
    selectCols: null,
  };
  const builder = {
    sort(field: FieldHandle, dir = 'asc') {
      const direction = String(dir).toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
      state.orderBy = `${field.fieldName} ${direction}`;
      return builder;
    },
    limit(n: number) {
      state.limit = Number(n);
      return builder;
    },
    select(...handles: FieldHandle[]) {
      state.selectCols = handles.map((h) => h.fieldName);
      return builder;
    },
    then(resolve: (rows: Row[]) => unknown, reject: (err: unknown) => unknown) {
      try {
        const cols = state.selectCols ? state.selectCols.join(', ') : '*';
        let sql = `SELECT ${cols} FROM ${name} AS t0 WHERE ${where.sql}`;
        const params = { ...where.params };
        if (state.orderBy) sql += ` ORDER BY ${state.orderBy}`;
        const limit = state.limit !== null ? state.limit : defaultLimit;
        if (limit !== null) {
          sql += ` LIMIT :limit`;
          params.limit = limit;
        }
        let rows = db.prepare(sql).all(params).map(hydrate);
        if (where.nearest) {
          rows = applyNearest(rows, where.nearest, hydrate);
        }
        resolve(rows);
      } catch (err) {
        reject(err);
      }
    },
  };
  return builder;
}

export function installEntityQueries(
  record: { [key: string]: unknown },
  { name, hydrate, deserializeStoredCells, db }: {
    name: string;
    hydrate: HydrateFn;
    deserializeStoredCells: DeserializeFn;
    db: Db;
  },
) {
  record.findOne = (predicate: unknown) => {
    const { sql, params } = lowerToSql(predicate as Parameters<typeof lowerToSql>[0]) as CompiledScope;
    const row = db
      .prepare(`SELECT * FROM ${name} AS t0 WHERE ${sql} LIMIT 1`)
      .get(params);
    return row ? hydrate(row) : null;
  };

  record.findAll = (predicate?: unknown) => {
    if (predicate === undefined) {
      const rows = db.prepare(`SELECT * FROM ${name} AS t0`).all().map(hydrate) as Row[] & {
        select: (...handles: FieldHandle[]) => Row[];
      };
      rows.select = (...handles: FieldHandle[]) => {
        const cols = handles.map((h) => h.fieldName);
        return db.prepare(`SELECT ${cols.join(', ')} FROM ${name} AS t0`).all().map(hydrate);
      };
      return rows;
    }
    return makeQueryBuilder({ name, predicate, hydrate, defaultLimit: 1000, db });
  };

  record.findById = (id: string, principal: unknown = null) => {
    const row = db.prepare(`SELECT * FROM ${name} AS t0 WHERE t0.id = :id`).get({ id });
    return row ? hydrate(row, principal) : null;
  };

  record.hydrate = (row: Row, principal: unknown = null, dispatch: unknown = null) =>
    hydrate(row, principal, dispatch);
  record.deserializeRow = (row: Row) => deserializeStoredCells(row);

  record.getOrFail = (id: string) => {
    const row = (record.findById as (id: string) => Row | null)(id);
    if (!row) {
      const err = new Error(`${name} ${id} not found`);
      (err as unknown as { status: number }).status = 404;
      throw err;
    }
    return row;
  };

  record.nearest = (fieldName: string, queryVec: unknown, k: number) => {
    if (typeof fieldName !== 'string') {
      throw new Error(`nearest() requires a field name (string), got ${typeof fieldName}`);
    }
    if (!Array.isArray(queryVec)) {
      throw new Error(`nearest() requires a query vector (number[]), got ${typeof queryVec}`);
    }
    if (typeof k !== 'number' || k < 1) {
      throw new Error(`nearest() requires a positive integer k, got ${k}`);
    }
    const rows = db.prepare(`SELECT * FROM ${name} AS t0`).all().map(deserializeStoredCells);
    const scored = rows.map((row) => {
      let vec: unknown = row[fieldName];
      if (typeof vec === 'string') {
        try { vec = JSON.parse(vec); } catch { vec = null; }
      }
      return { row, similarity: cosineSimilarity(queryVec, vec) };
    });
    scored.sort((a, b) => b.similarity - a.similarity);
    const topK = scored.slice(0, k);
    return topK.map(({ row }) => hydrate(row));
  };
}

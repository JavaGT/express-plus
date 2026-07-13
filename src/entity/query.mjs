import { lowerToSql, cosineSimilarity } from '../scope-sql.mjs';

function applyNearest(rows, nearest, hydrate) {
  const { field, query, k } = nearest;
  const scored = rows.map((row) => {
    let vec = row[field];
    if (typeof vec === 'string') {
      try { vec = JSON.parse(vec); } catch { vec = null; }
    }
    const similarity = cosineSimilarity(query, vec);
    return { row, similarity };
  });
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, k).map(({ row }) => row);
}

export function makeQueryBuilder({ name, predicate, hydrate, defaultLimit = null, db }) {
  const where = lowerToSql(predicate);
  const state = { orderBy: null, limit: null, selectCols: null };
  const builder = {
    sort(field, dir = 'asc') {
      const direction = String(dir).toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
      state.orderBy = `${field.fieldName} ${direction}`;
      return builder;
    },
    limit(n) {
      state.limit = Number(n);
      return builder;
    },
    select(...handles) {
      state.selectCols = handles.map((h) => h.fieldName);
      return builder;
    },
    then(resolve, reject) {
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

export function installEntityQueries(record, { name, hydrate, deserializeStoredCells, db }) {
  record.findOne = (predicate) => {
    const { sql, params } = lowerToSql(predicate);
    const row = db
      .prepare(`SELECT * FROM ${name} AS t0 WHERE ${sql} LIMIT 1`)
      .get(params);
    return row ? hydrate(row) : null;
  };

  record.findAll = (predicate) => {
    if (predicate === undefined) {
      const rows = db.prepare(`SELECT * FROM ${name} AS t0`).all().map(hydrate);
      rows.select = (...handles) => {
        const cols = handles.map((h) => h.fieldName);
        return db.prepare(`SELECT ${cols.join(', ')} FROM ${name} AS t0`).all().map(hydrate);
      };
      return rows;
    }
    return makeQueryBuilder({ name, predicate, hydrate, defaultLimit: 1000, db });
  };

  record.findById = (id, principal = null) => {
    const row = db.prepare(`SELECT * FROM ${name} AS t0 WHERE t0.id = :id`).get({ id });
    return row ? hydrate(row, principal) : null;
  };

  record.hydrate = (row, principal = null, dispatch = null) => hydrate(row, principal, dispatch);
  record.deserializeRow = (row) => deserializeStoredCells(row);

  record.getOrFail = (id) => {
    const row = record.findById(id);
    if (!row) {
      const err = new Error(`${name} ${id} not found`);
      err.status = 404;
      throw err;
    }
    return row;
  };

  record.nearest = (fieldName, queryVec, k) => {
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
      let vec = row[fieldName];
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

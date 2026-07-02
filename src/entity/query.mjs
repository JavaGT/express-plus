import { getActiveDb } from '../db.mjs';
import { lowerToSql } from '../scope-sql.mjs';

export function makeQueryBuilder({ name, predicate, hydrate, defaultLimit = null }) {
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
        const rows = getActiveDb().prepare(sql).all(params).map(hydrate);
        resolve(rows);
      } catch (err) {
        reject(err);
      }
    },
  };
  return builder;
}

export function installEntityQueries(record, { name, hydrate, deserializeStoredCells }) {
  record.findOne = (predicate) => {
    const { sql, params } = lowerToSql(predicate);
    const row = getActiveDb()
      .prepare(`SELECT * FROM ${name} AS t0 WHERE ${sql} LIMIT 1`)
      .get(params);
    return row ? hydrate(row) : null;
  };

  record.findAll = (predicate) => {
    if (predicate === undefined) {
      const rows = getActiveDb().prepare(`SELECT * FROM ${name} AS t0`).all().map(hydrate);
      rows.select = (...handles) => {
        const cols = handles.map((h) => h.fieldName);
        return getActiveDb().prepare(`SELECT ${cols.join(', ')} FROM ${name} AS t0`).all().map(hydrate);
      };
      return rows;
    }
    return makeQueryBuilder({ name, predicate, hydrate, defaultLimit: 1000 });
  };

  record.findById = (id, principal = null) => {
    const row = getActiveDb().prepare(`SELECT * FROM ${name} AS t0 WHERE t0.id = :id`).get({ id });
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
}

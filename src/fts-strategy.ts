// @ts-nocheck
// FTS (full-text search) side-table strategy.
//
// A field declared with `text({ indexed: 'fts' })` gets an FTS5 virtual table
// that is automatically synced on insert, update, and delete. The scope
// predicate `.matches(query)` lowers to a correlated EXISTS MATCH over the
// FTS table, so it participates in the read-scope WHERE clause.
//
// Zero runtime dependencies — FTS5 is a built-in SQLite extension.

import * as eventHandle from './event-handle.ts';

function ftsTableName(entityName, fieldName) {
  return `${entityName}_${fieldName}_fts`;
}

function ftsOwnerCol(entityName) {
  return `${entityName}_id`;
}

function ftsDDL(entityName, fieldName) {
  const table = ftsTableName(entityName, fieldName);
  const ownerCol = ftsOwnerCol(entityName);
  return `CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING fts5(${fieldName}, ${ownerCol} UNINDEXED);`;
}

function ftsProjectionApply({ entityName, fieldEntries, handle, event, db }) {
  const id = event.data?.id;
  if (id === undefined || id === null) return false;

  if (handle.kind === eventHandle.EventKind.created) {
    let applied = false;
    for (const [fieldName] of fieldEntries) {
      const value = event.data[fieldName];
      if (value === undefined) continue;
      const table = ftsTableName(entityName, fieldName);
      const ownerCol = ftsOwnerCol(entityName);
      db.prepare(`INSERT INTO ${table} (${fieldName}, ${ownerCol}) VALUES (:field_val, :entity_id)`)
        .run({ field_val: value, entity_id: String(id) });
      applied = true;
    }
    return applied;
  }

  if (handle.kind === eventHandle.EventKind.updated) {
    let applied = false;
    for (const [fieldName] of fieldEntries) {
      if (!Object.prototype.hasOwnProperty.call(event.data ?? {}, fieldName)) continue;
      const table = ftsTableName(entityName, fieldName);
      const ownerCol = ftsOwnerCol(entityName);
      // Delete existing FTS rows for this entity row (there should be at most one),
      // then insert the new value if it's non-null.
      db.prepare(`DELETE FROM ${table} WHERE ${ownerCol} = :entity_id`).run({ entity_id: String(id) });
      const value = event.data[fieldName];
      if (value !== null && value !== undefined && value !== '') {
        db.prepare(`INSERT INTO ${table} (${fieldName}, ${ownerCol}) VALUES (:field_val, :entity_id)`)
          .run({ field_val: value, entity_id: String(id) });
      }
      applied = true;
    }
    return applied;
  }

  if (handle.kind === eventHandle.EventKind.removed) {
    for (const [fieldName] of fieldEntries) {
      const table = ftsTableName(entityName, fieldName);
      const ownerCol = ftsOwnerCol(entityName);
      db.prepare(`DELETE FROM ${table} WHERE ${ownerCol} = :entity_id`).run({ entity_id: String(id) });
    }
    // Don't claim the event — let the CRUD handler still delete the main row.
    return false;
  }

  return false;
}

const FTS_STRATEGY = Object.freeze({
  matches: (descriptor) => descriptor.indexed === 'fts',
  eventTypes: () => [], // no additional event types — piggybacks on main CRUD events
  mutateHandlers: () => ({}), // no dispatch-level mutations — FTS is synced in projection
  projectionApply: ftsProjectionApply,
  ddl: ftsDDL,
});

export { FTS_STRATEGY };

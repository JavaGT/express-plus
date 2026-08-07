import { randomUUID } from 'node:crypto';

import { read, write } from '../grant.mjs';
import { membershipTable, membershipOwnerCol } from '../scope-sql.mjs';
import * as eventHandles from '../event-handle.mjs';
import { scopeOf } from '../scope-handle.mjs';
import { authorizeFieldOp, dispatchFieldMutation } from './shared.mjs';

function orderedHandle({ record, entityName, fieldName, row, principal, dispatch, db }) {
  const table = membershipTable(entityName, fieldName);
  const ownerCol = membershipOwnerCol(entityName);
  const oid = String(row.id);

  const rowsOrdered = () =>
    db
      .prepare(`SELECT id, key, item FROM ${table} WHERE ${ownerCol} = :owner ORDER BY key`)
      .all({ owner: oid });

  const keyBetween = (low, high) => {
    if (low == null && high == null) return 0;
    if (low == null) return high - 1;
    if (high == null) return low + 1;
    return (low + high) / 2;
  };

  return {
    insertAt: async (index, value) => {
      await authorizeFieldOp(record, fieldName, write, row, principal);
      const rows = rowsOrdered();
      const low = index > 0 ? rows[index - 1].key : null;
      const high = index < rows.length ? rows[index].key : null;
      const key = keyBetween(low, high);
      const result = await dispatchFieldMutation({
        entityName, fieldName, dispatch, principal,
        type: `${entityName}.${fieldName}.insert`,
        payload: { owner: oid, key, value },
      });
      return result.events?.find((e) => e.type === `${entityName}.${fieldName}.inserted`)?.data?.id;
    },
    move: async (id, index) => {
      await authorizeFieldOp(record, fieldName, write, row, principal);
      const sid = String(id);
      const others = rowsOrdered().filter((r) => r.id !== sid);
      const low = index > 0 ? others[index - 1].key : null;
      const high = index < others.length ? others[index].key : null;
      const key = keyBetween(low, high);
      await dispatchFieldMutation({
        entityName, fieldName, dispatch, principal,
        type: `${entityName}.${fieldName}.move`,
        payload: { owner: oid, id: sid, key },
      });
    },
    reorder: async (ids) => {
      await authorizeFieldOp(record, fieldName, write, row, principal);
      const entries = ids.map((entryId, i) => ({ id: String(entryId), key: i }));
      await dispatchFieldMutation({
        entityName, fieldName, dispatch, principal,
        type: `${entityName}.${fieldName}.reorder`,
        payload: { owner: oid, entries },
      });
    },
    remove: async (id) => {
      await authorizeFieldOp(record, fieldName, write, row, principal);
      await dispatchFieldMutation({
        entityName, fieldName, dispatch, principal,
        type: `${entityName}.${fieldName}.remove`,
        payload: { owner: oid, id: String(id) },
      });
    },
    has: (id) =>
      db
        .prepare(`SELECT 1 FROM ${table} WHERE ${ownerCol} = :owner AND id = :id`)
        .get({ owner: oid, id: String(id) }) !== undefined,
    get: (id) => {
      const r = db
        .prepare(`SELECT item FROM ${table} WHERE ${ownerCol} = :owner AND id = :id`)
        .get({ owner: oid, id: String(id) });
      return r ? JSON.parse(r.item) : undefined;
    },
    toArray: async () => {
      await authorizeFieldOp(record, fieldName, read, row, principal);
      return rowsOrdered().map((r) => JSON.parse(r.item));
    },
  };
}

function orderedMutateHandlers(entityName, fieldEntries) {
  const handlers = {};
  for (const [ordField] of fieldEntries) {
    const requireOwner = (payload) => {
      const { owner } = payload ?? {};
      if (owner == null) {
        throw Object.assign(new Error(`${entityName}.${ordField} action requires an owner`), { status: 400 });
      }
      return String(owner);
    };
    handlers[`${entityName}.${ordField}.insert`] = ({ payload }) => {
      const owner = requireOwner(payload);
      if (payload.key == null) {
        throw Object.assign(new Error(`${entityName}.${ordField}.insert requires a key`), { status: 400 });
      }
      const id = randomUUID();
      const handle = eventHandles.native(entityName, ordField, 'inserted');
      return [{
        handle,
        type: handle.type,
        scope: scopeOf(entityName, owner).key,
        data: { owner, id, key: payload.key, value: payload.value },
      }];
    };
    handlers[`${entityName}.${ordField}.move`] = ({ payload }) => {
      const owner = requireOwner(payload);
      if (payload.id == null || payload.key == null) {
        throw Object.assign(new Error(`${entityName}.${ordField}.move requires an id + key`), { status: 400 });
      }
      const handle = eventHandles.native(entityName, ordField, 'moved');
      return [{
        handle,
        type: handle.type,
        scope: scopeOf(entityName, owner).key,
        data: { owner, id: String(payload.id), key: payload.key },
      }];
    };
    handlers[`${entityName}.${ordField}.reorder`] = ({ payload }) => {
      const owner = requireOwner(payload);
      const entries = Array.isArray(payload.entries) ? payload.entries : [];
      const handle = eventHandles.native(entityName, ordField, 'reordered');
      return [{
        handle,
        type: handle.type,
        scope: scopeOf(entityName, owner).key,
        data: { owner, entries: entries.map((e) => ({ id: String(e.id), key: e.key })) },
      }];
    };
    handlers[`${entityName}.${ordField}.remove`] = ({ payload }) => {
      const owner = requireOwner(payload);
      if (payload.id == null) {
        throw Object.assign(new Error(`${entityName}.${ordField}.remove requires an id`), { status: 400 });
      }
      const handle = eventHandles.native(entityName, ordField, 'removed');
      return [{
        handle,
        type: handle.type,
        scope: scopeOf(entityName, owner).key,
        data: { owner, id: String(payload.id) },
      }];
    };
  }
  return handlers;
}

function orderedProjectionApply({ entityName, fieldEntries, handle, event, db }) {
  for (const [ordField] of fieldEntries) {
    if (handle.field !== ordField || handle.kind !== eventHandles.EventKind.native) continue;
    const sideTable = membershipTable(entityName, ordField);
    const ownerCol = membershipOwnerCol(entityName);
    if (handle.nativeName === 'inserted') {
      db.prepare(`INSERT INTO ${sideTable} (${ownerCol}, id, key, item) VALUES (:owner, :id, :key, :item)`)
        .run({ owner: String(event.data?.owner), id: event.data?.id, key: event.data?.key, item: JSON.stringify(event.data?.value) });
      return true;
    }
    if (handle.nativeName === 'moved') {
      db.prepare(`UPDATE ${sideTable} SET key = :key WHERE ${ownerCol} = :owner AND id = :id`)
        .run({ owner: String(event.data?.owner), id: event.data?.id, key: event.data?.key });
      return true;
    }
    if (handle.nativeName === 'reordered') {
      const stmt = db.prepare(`UPDATE ${sideTable} SET key = :key WHERE ${ownerCol} = :owner AND id = :id`);
      for (const e of (event.data?.entries ?? [])) {
        stmt.run({ owner: String(event.data?.owner), id: e.id, key: e.key });
      }
      return true;
    }
    if (handle.nativeName === 'removed') {
      db.prepare(`DELETE FROM ${sideTable} WHERE ${ownerCol} = :owner AND id = :id`)
        .run({ owner: String(event.data?.owner), id: event.data?.id });
      return true;
    }
  }
  return false;
}

function orderedDDL(entityName, fieldName) {
  const tableName = `${entityName}_${fieldName}`;
  const ownerCol = `${entityName}_id`;
  const cols = [
    `${ownerCol} TEXT NOT NULL`,
    'id TEXT NOT NULL',
    'key REAL NOT NULL',
    'item TEXT',
    `PRIMARY KEY (${ownerCol}, id)`,
  ];
  return `CREATE TABLE IF NOT EXISTS ${tableName} (\n  ${cols.join(',\n  ')}\n);`;
}

const ORDERED_SIDE_TABLE_STRATEGY = Object.freeze({
  matches: (descriptor) => descriptor.kind === 'ordered',
  handle: orderedHandle,
  eventTypes: (entityName, fieldEntries) => fieldEntries.flatMap(([fieldName]) => [
    eventHandles.native(entityName, fieldName, 'inserted').type,
    eventHandles.native(entityName, fieldName, 'moved').type,
    eventHandles.native(entityName, fieldName, 'reordered').type,
    eventHandles.native(entityName, fieldName, 'removed').type,
  ]),
  mutateHandlers: orderedMutateHandlers,
  projectionApply: orderedProjectionApply,
  ddl: orderedDDL,
});

export {
  ORDERED_SIDE_TABLE_STRATEGY,
};

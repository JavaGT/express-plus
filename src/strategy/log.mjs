// @ts-nocheck
import { randomUUID } from 'node:crypto';

import { read, write } from '../grant.mjs';
import { serializeField } from '../field-strategy.mjs';
import { membershipTable, membershipOwnerCol } from '../scope-sql.mjs';
import * as eventHandles from '../event-handle.mjs';
import { scopeOf } from '../scope-handle.mjs';
import { authorizeFieldOp, dispatchFieldMutation } from './shared.mjs';

function logHandle({ record, entityName, fieldName, row, principal, dispatch, db }) {
  const table = membershipTable(entityName, fieldName);
  const ownerCol = membershipOwnerCol(entityName);
  const oid = String(row.id);
  return {
    append: async (entry) => {
      await authorizeFieldOp(record, fieldName, write, row, principal);
      const result = await dispatchFieldMutation({
        entityName, fieldName, dispatch, principal,
        type: `${entityName}.${fieldName}.append`,
        payload: { owner: oid, ...(entry ?? {}) },
      });
      const appended = result.events?.find((e) => e.type === `${entityName}.${fieldName}.appended`);
      return appended?.data?.id;
    },
    entries: async () => {
      await authorizeFieldOp(record, fieldName, read, row, principal);
      const rows = db
        .prepare(`SELECT * FROM ${table} WHERE ${ownerCol} = :owner ORDER BY rowid`)
        .all({ owner: oid });
      return rows.map((r) => {
        const rest = { ...r };
        delete rest[ownerCol];
        return rest;
      });
    },
  };
}

function logMutateHandlers(entityName, fieldEntries) {
  const handlers = {};
  for (const [logField, descriptor] of fieldEntries) {
    const entryDescriptor = descriptor.entry ?? {};
    handlers[`${entityName}.${logField}.append`] = ({ payload }) => {
      const { owner, ...entry } = payload ?? {};
      if (owner == null) {
        throw Object.assign(new Error(`${entityName}.${logField}.append requires an owner`), { status: 400 });
      }
      for (const key of Object.keys(entry)) {
        if (!Object.prototype.hasOwnProperty.call(entryDescriptor, key)) {
          throw Object.assign(new Error(`unknown entry field: ${key}`), { status: 400 });
        }
      }
      const id = randomUUID();
      const handle = eventHandles.native(entityName, logField, 'appended');
      return [{
        handle,
        type: handle.type,
        scope: scopeOf(entityName, owner).key,
        data: { owner, id, ...entry },
      }];
    };
  }
  return handlers;
}

function logProjectionApply({ entityName, fieldEntries, handle, event, db }) {
  for (const [logField, descriptor] of fieldEntries) {
    if (handle.field !== logField || handle.kind !== eventHandles.EventKind.native || handle.nativeName !== 'appended') continue;
    const entryDescriptor = descriptor.entry ?? {};
    const sideTable = membershipTable(entityName, logField);
    const ownerCol = membershipOwnerCol(entityName);
    const cols = [ownerCol, 'id'];
    const vals = [':owner', ':id'];
    const params = { owner: event.data?.owner != null ? String(event.data.owner) : null, id: event.data?.id };
    for (const [subField, entryDescriptorField] of Object.entries(entryDescriptor)) {
      if (Object.prototype.hasOwnProperty.call(event.data ?? {}, subField)) {
        cols.push(subField);
        vals.push(`:${subField}`);
        params[subField] = serializeField(entryDescriptorField, event.data[subField]);
      }
    }
    db.prepare(
      `INSERT INTO ${sideTable} (${cols.join(', ')}) VALUES (${vals.join(', ')})`,
    ).run(params);
    return true;
  }
  return false;
}

function logDDL(entityName, fieldName, descriptor) {
  const tableName = `${entityName}_${fieldName}`;
  const ownerCol = `${entityName}_id`;
  const entryCols = Object.keys(descriptor.entry ?? {});
  const cols = [`${ownerCol} TEXT NOT NULL`, 'id TEXT NOT NULL'];
  for (const subField of entryCols) {
    cols.push(`${subField} TEXT`);
  }
  cols.push(`PRIMARY KEY (${ownerCol}, id)`);
  return `CREATE TABLE IF NOT EXISTS ${tableName} (\n  ${cols.join(',\n  ')}\n);`;
}

const LOG_SIDE_TABLE_STRATEGY = Object.freeze({
  matches: (descriptor) => descriptor.kind === 'store' && descriptor.type === 'log',
  handle: logHandle,
  eventTypes: (entityName, fieldEntries) => fieldEntries.map(([fieldName]) =>
    eventHandles.native(entityName, fieldName, 'appended').type),
  mutateHandlers: logMutateHandlers,
  projectionApply: logProjectionApply,
  ddl: logDDL,
});

export {
  LOG_SIDE_TABLE_STRATEGY,
};

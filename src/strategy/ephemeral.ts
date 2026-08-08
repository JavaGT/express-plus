// @ts-nocheck
import { write } from '../grant.ts';
import { membershipTable, membershipOwnerCol } from '../scope-sql.ts';
import * as eventHandles from '../event-handle.ts';
import { scopeOf } from '../scope-handle.ts';
import { upsert } from '../driver.ts';
import { authorizeFieldOp, dispatchFieldMutation } from './shared.ts';

function ephemeralHandle({ record, entityName, fieldName, row, principal, dispatch, db }) {
  const table = membershipTable(entityName, fieldName);
  const ownerCol = membershipOwnerCol(entityName);
  const oid = String(row.id);
  const clientId = String(principal?.id ?? 'anonymous');

  return {
    set: async (cells) => {
      await authorizeFieldOp(record, fieldName, write, row, principal);
      await dispatchFieldMutation({
        entityName, fieldName, dispatch, principal,
        type: `${entityName}.${fieldName}.set`,
        payload: { owner: oid, client: clientId, cells: cells ?? {} },
      });
    },
    get: () => {
      const r = db
        .prepare(`SELECT cells FROM ${table} WHERE ${ownerCol} = :owner AND client_id = :client`)
        .get({ owner: oid, client: clientId });
      return r ? JSON.parse(r.cells ?? '{}') : {};
    },
  };
}

function ephemeralMutateHandlers(entityName, fieldEntries) {
  const handlers = {};
  for (const [ephField] of fieldEntries) {
    const requireOwnerClient = (payload) => {
      const { owner, client } = payload ?? {};
      if (owner == null || client == null) {
        throw Object.assign(
          new Error(`${entityName}.${ephField}.set requires an owner + client`),
          { status: 400 },
        );
      }
      return { owner: String(owner), client: String(client) };
    };
    handlers[`${entityName}.${ephField}.set`] = ({ payload }) => {
      const { owner, client } = requireOwnerClient(payload);
      const handle = eventHandles.fieldSet(entityName, ephField);
      return [{
        handle,
        type: handle.type,
        scope: scopeOf(entityName, owner).key,
        data: { owner, client, cells: payload.cells ?? {} },
      }];
    };
  }
  return handlers;
}

function ephemeralProjectionApply({ entityName, fieldEntries, handle, event, db }) {
  for (const [ephField] of fieldEntries) {
    if (handle.field !== ephField || handle.kind !== eventHandles.EventKind.fieldSet) continue;
    const sideTable = membershipTable(entityName, ephField);
    const ownerCol = membershipOwnerCol(entityName);
    upsert(db, {
      table: sideTable,
      keyColumns: [ownerCol, 'client_id'],
      columns: ['cells'],
      values: {
        [ownerCol]: String(event.data?.owner),
        client_id: String(event.data?.client),
        cells: JSON.stringify(event.data?.cells ?? {}),
      },
    });
    return true;
  }
  return false;
}

function ephemeralDDL(entityName, fieldName) {
  const tableName = `${entityName}_${fieldName}`;
  const ownerCol = `${entityName}_id`;
  const cols = [`${ownerCol} TEXT NOT NULL`, 'client_id TEXT NOT NULL', 'cells TEXT', `PRIMARY KEY (${ownerCol}, client_id)`];
  return `CREATE TABLE IF NOT EXISTS ${tableName} (\n  ${cols.join(',\n  ')}\n);`;
}

const EPHEMERAL_SIDE_TABLE_STRATEGY = Object.freeze({
  matches: (descriptor) => descriptor.kind === 'ephemeral',
  handle: ephemeralHandle,
  eventTypes: (entityName, fieldEntries) => fieldEntries.map(([fieldName]) =>
    eventHandles.fieldSet(entityName, fieldName).type),
  mutateHandlers: ephemeralMutateHandlers,
  projectionApply: ephemeralProjectionApply,
  ddl: ephemeralDDL,
});

export {
  EPHEMERAL_SIDE_TABLE_STRATEGY,
};

import type { Capability } from '../grant.ts';
import { write } from '../grant.ts';
import { membershipTable, membershipOwnerCol } from '../scope-sql.ts';
import * as eventHandles from '../event-handle.ts';
import { scopeOf } from '../scope-handle.ts';
import { upsert } from '../driver.ts';
import { authorizeFieldOp, dispatchFieldMutation } from './shared.ts';
import type {
  FieldDescriptor,
  FieldEntries,
  MutateHandlerInput,
  SideTableHandleInput,
  SideTableProjectionInput,
  SideTableStrategy,
} from './index.ts';

// authorizeFieldOp types its capability param as string, but the row-grant
// engine compares capability tokens by identity (read/write are frozen
// Capability singletons). Forward the token through the narrower seam.
function authorizeField(
  record: unknown,
  fieldName: string,
  capability: Capability,
  row: unknown,
  principal: unknown,
): Promise<void> {
  return authorizeFieldOp(record, fieldName, capability as unknown as string, row, principal);
}

function ephemeralHandle({ record, entityName, fieldName, row, principal, dispatch, db }: SideTableHandleInput) {
  const table = membershipTable(entityName, fieldName);
  const ownerCol = membershipOwnerCol(entityName);
  const oid = String(row.id);
  const clientId = String(principal?.id ?? 'anonymous');

  return {
    set: async (cells: Record<string, unknown> | null | undefined) => {
      await authorizeField(record, fieldName, write, row, principal);
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
      return r ? JSON.parse((r.cells ?? '{}') as string) : {};
    },
  };
}

function ephemeralMutateHandlers(entityName: string, fieldEntries: FieldEntries): Record<string, (input: MutateHandlerInput) => unknown> {
  const handlers: Record<string, (input: MutateHandlerInput) => unknown> = {};
  for (const [ephField] of fieldEntries) {
    const requireOwnerClient = (payload: Record<string, unknown> | null | undefined) => {
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
        data: { owner, client, cells: payload?.cells ?? {} },
      }];
    };
  }
  return handlers;
}

function ephemeralProjectionApply({ entityName, fieldEntries, handle, event, db }: SideTableProjectionInput): boolean {
  for (const [ephField] of fieldEntries) {
    if (handle.kind !== eventHandles.EventKind.fieldSet) continue;
    if (handle.field !== ephField) continue;
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

function ephemeralDDL(entityName: string, fieldName: string): string {
  const tableName = `${entityName}_${fieldName}`;
  const ownerCol = `${entityName}_id`;
  const cols = [`${ownerCol} TEXT NOT NULL`, 'client_id TEXT NOT NULL', 'cells TEXT', `PRIMARY KEY (${ownerCol}, client_id)`];
  return `CREATE TABLE IF NOT EXISTS ${tableName} (\n  ${cols.join(',\n  ')}\n);`;
}

const EPHEMERAL_SIDE_TABLE_STRATEGY: SideTableStrategy = Object.freeze({
  matches: (descriptor: FieldDescriptor) => descriptor.kind === 'ephemeral',
  handle: ephemeralHandle,
  eventTypes: (entityName: string, fieldEntries: FieldEntries) => fieldEntries.map(([fieldName]) =>
    eventHandles.fieldSet(entityName, fieldName).type),
  mutateHandlers: ephemeralMutateHandlers,
  projectionApply: ephemeralProjectionApply,
  ddl: ephemeralDDL,
});

export {
  EPHEMERAL_SIDE_TABLE_STRATEGY,
};

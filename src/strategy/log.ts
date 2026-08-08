import { randomUUID } from 'node:crypto';

import type { Capability } from '../grant.ts';
import { read, write } from '../grant.ts';
import { serializeField } from '../field-strategy.ts';
import { membershipTable, membershipOwnerCol } from '../scope-sql.ts';
import * as eventHandles from '../event-handle.ts';
import { scopeOf } from '../scope-handle.ts';
import { authorizeFieldOp, dispatchFieldMutation } from './shared.ts';
import type {
  DispatchResult,
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

function logHandle({ record, entityName, fieldName, row, principal, dispatch, db }: SideTableHandleInput) {
  const table = membershipTable(entityName, fieldName);
  const ownerCol = membershipOwnerCol(entityName);
  const oid = String(row.id);
  return {
    append: async (entry: Record<string, unknown> | null | undefined) => {
      await authorizeField(record, fieldName, write, row, principal);
      const result = (await dispatchFieldMutation({
        entityName, fieldName, dispatch, principal,
        type: `${entityName}.${fieldName}.append`,
        payload: { owner: oid, ...(entry ?? {}) },
      })) as DispatchResult;
      const appended = result.events?.find((e) => e.type === `${entityName}.${fieldName}.appended`);
      return appended?.data?.id;
    },
    entries: async () => {
      await authorizeField(record, fieldName, read, row, principal);
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

function logMutateHandlers(entityName: string, fieldEntries: FieldEntries): Record<string, (input: MutateHandlerInput) => unknown> {
  const handlers: Record<string, (input: MutateHandlerInput) => unknown> = {};
  for (const [logField, descriptor] of fieldEntries) {
    const entryDescriptor: Readonly<Record<string, FieldDescriptor>> = descriptor.entry ?? {};
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

function logProjectionApply({ entityName, fieldEntries, handle, event, db }: SideTableProjectionInput): boolean {
  for (const [logField, descriptor] of fieldEntries) {
    if (handle.kind !== eventHandles.EventKind.native) continue;
    if (handle.field !== logField || handle.nativeName !== 'appended') continue;
    const entryDescriptor: Readonly<Record<string, FieldDescriptor>> = descriptor.entry ?? {};
    const sideTable = membershipTable(entityName, logField);
    const ownerCol = membershipOwnerCol(entityName);
    const cols = [ownerCol, 'id'];
    const vals = [':owner', ':id'];
    const params: Record<string, unknown> = { owner: event.data?.owner != null ? String(event.data.owner) : null, id: event.data?.id };
    const data = event.data ?? {};
    for (const [subField, entryDescriptorField] of Object.entries(entryDescriptor)) {
      if (Object.prototype.hasOwnProperty.call(data, subField)) {
        cols.push(subField);
        vals.push(`:${subField}`);
        params[subField] = serializeField(entryDescriptorField, data[subField]);
      }
    }
    db.prepare(
      `INSERT INTO ${sideTable} (${cols.join(', ')}) VALUES (${vals.join(', ')})`,
    ).run(params);
    return true;
  }
  return false;
}

function logDDL(entityName: string, fieldName: string, descriptor: FieldDescriptor): string {
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

const LOG_SIDE_TABLE_STRATEGY: SideTableStrategy = Object.freeze({
  matches: (descriptor: FieldDescriptor) => descriptor.kind === 'store' && descriptor.type === 'log',
  handle: logHandle,
  eventTypes: (entityName: string, fieldEntries: FieldEntries) => fieldEntries.map(([fieldName]) =>
    eventHandles.native(entityName, fieldName, 'appended').type),
  mutateHandlers: logMutateHandlers,
  projectionApply: logProjectionApply,
  ddl: logDDL,
});

export {
  LOG_SIDE_TABLE_STRATEGY,
};

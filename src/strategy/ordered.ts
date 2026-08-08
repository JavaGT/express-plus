import { randomUUID } from 'node:crypto';

import type { Capability } from '../grant.ts';
import { read, write } from '../grant.ts';
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

function orderedHandle({ record, entityName, fieldName, row, principal, dispatch, db }: SideTableHandleInput) {
  const table = membershipTable(entityName, fieldName);
  const ownerCol = membershipOwnerCol(entityName);
  const oid = String(row.id);

  const rowsOrdered = () =>
    db
      .prepare(`SELECT id, key, item FROM ${table} WHERE ${ownerCol} = :owner ORDER BY key`)
      .all({ owner: oid });

  const keyBetween = (low: number | null, high: number | null): number => {
    if (high == null) return low == null ? 0 : low + 1;
    if (low == null) return high - 1;
    return (low + high) / 2;
  };

  return {
    insertAt: async (index: number, value: unknown) => {
      await authorizeField(record, fieldName, write, row, principal);
      const rows = rowsOrdered();
      const low = index > 0 ? rows[index - 1].key as number : null;
      const high = index < rows.length ? rows[index].key as number : null;
      const key = keyBetween(low, high);
      const result = (await dispatchFieldMutation({
        entityName, fieldName, dispatch, principal,
        type: `${entityName}.${fieldName}.insert`,
        payload: { owner: oid, key, value },
      })) as DispatchResult;
      return result.events?.find((e) => e.type === `${entityName}.${fieldName}.inserted`)?.data?.id;
    },
    move: async (id: unknown, index: number) => {
      await authorizeField(record, fieldName, write, row, principal);
      const sid = String(id);
      const others = rowsOrdered().filter((r) => r.id !== sid);
      const low = index > 0 ? others[index - 1].key as number : null;
      const high = index < others.length ? others[index].key as number : null;
      const key = keyBetween(low, high);
      await dispatchFieldMutation({
        entityName, fieldName, dispatch, principal,
        type: `${entityName}.${fieldName}.move`,
        payload: { owner: oid, id: sid, key },
      });
    },
    reorder: async (ids: unknown[]) => {
      await authorizeField(record, fieldName, write, row, principal);
      const entries = ids.map((entryId, i) => ({ id: String(entryId), key: i }));
      await dispatchFieldMutation({
        entityName, fieldName, dispatch, principal,
        type: `${entityName}.${fieldName}.reorder`,
        payload: { owner: oid, entries },
      });
    },
    remove: async (id: unknown) => {
      await authorizeField(record, fieldName, write, row, principal);
      await dispatchFieldMutation({
        entityName, fieldName, dispatch, principal,
        type: `${entityName}.${fieldName}.remove`,
        payload: { owner: oid, id: String(id) },
      });
    },
    has: (id: unknown) =>
      db
        .prepare(`SELECT 1 FROM ${table} WHERE ${ownerCol} = :owner AND id = :id`)
        .get({ owner: oid, id: String(id) }) !== undefined,
    get: (id: unknown) => {
      const r = db
        .prepare(`SELECT item FROM ${table} WHERE ${ownerCol} = :owner AND id = :id`)
        .get({ owner: oid, id: String(id) });
      return r ? JSON.parse(r.item as string) : undefined;
    },
    toArray: async () => {
      await authorizeField(record, fieldName, read, row, principal);
      return rowsOrdered().map((r) => JSON.parse(r.item as string));
    },
  };
}

function orderedMutateHandlers(entityName: string, fieldEntries: FieldEntries): Record<string, (input: MutateHandlerInput) => unknown> {
  const handlers: Record<string, (input: MutateHandlerInput) => unknown> = {};
  for (const [ordField] of fieldEntries) {
    const requireOwner = (payload: Record<string, unknown> | null | undefined) => {
      const { owner } = payload ?? {};
      if (owner == null) {
        throw Object.assign(new Error(`${entityName}.${ordField} action requires an owner`), { status: 400 });
      }
      return String(owner);
    };
    handlers[`${entityName}.${ordField}.insert`] = ({ payload }) => {
      const owner = requireOwner(payload);
      if (payload?.key == null) {
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
      if (payload?.id == null || payload?.key == null) {
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
      const entries = Array.isArray(payload?.entries)
        ? (payload.entries as Array<{ id: unknown; key: unknown }>)
        : [];
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
      if (payload?.id == null) {
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

function orderedProjectionApply({ entityName, fieldEntries, handle, event, db }: SideTableProjectionInput): boolean {
  for (const [ordField] of fieldEntries) {
    if (handle.kind !== eventHandles.EventKind.native) continue;
    if (handle.field !== ordField) continue;
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
      for (const e of (event.data?.entries ?? []) as Array<{ id: unknown; key: unknown }>) {
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

function orderedDDL(entityName: string, fieldName: string): string {
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

const ORDERED_SIDE_TABLE_STRATEGY: SideTableStrategy = Object.freeze({
  matches: (descriptor: FieldDescriptor) => descriptor.kind === 'ordered',
  handle: orderedHandle,
  eventTypes: (entityName: string, fieldEntries: FieldEntries) => fieldEntries.flatMap(([fieldName]) => [
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

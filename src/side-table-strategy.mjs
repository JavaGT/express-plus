import { randomUUID } from 'node:crypto';

import { read, write } from './grant.mjs';
import { serializeField } from './field-strategy.mjs';
import { mayFieldOp } from './row-grant.mjs';
import { membershipTable, membershipOwnerCol, MEMBER_COLUMN } from './scope-sql.mjs';
import { getActiveDb, getActiveEntity } from './db.mjs';
import * as eventHandles from './event-handle.mjs';
import { upsert } from './driver.mjs';

async function authorizeFieldOp(record, fieldName, capability, row, principal) {
  if (principal && !(await mayFieldOp(record, fieldName, capability, row, principal))) {
    throw { status: 403, message: 'forbidden' };
  }
}

function requireFieldDispatch(entityName, fieldName, dispatch) {
  if (!dispatch) {
    throw new Error(
      `cannot mutate ${entityName}.${fieldName} without a dispatch ref ` +
        `(hydrate with dispatch inside a handler/route)`,
    );
  }
}

// The shared tail of every side-table write: require a dispatch ref, dispatch
// the field action, fail closed on deny. Callers authorize BEFORE their
// payload prep so an unauthorized principal gets 403 even when the write would
// be a no-op. Returns the dispatch result for handles that read emitted events.
async function dispatchFieldMutation({ entityName, fieldName, dispatch, type, payload, principal }) {
  requireFieldDispatch(entityName, fieldName, dispatch);
  const result = await dispatch({ actionId: randomUUID(), type, payload, principal });
  if (!result.granted) throw { status: 403, message: 'forbidden' };
  return result;
}

function mapHandle({ record, entityName, fieldName, descriptor, row, principal, dispatch }) {
  const table = membershipTable(entityName, fieldName);
  const ownerCol = membershipOwnerCol(entityName);
  const oid = String(row.id);
  const ofDescriptor = descriptor.of;
  const targetName = ofDescriptor && ofDescriptor.kind === 'value' && ofDescriptor.type === 'ref'
    ? ofDescriptor.target
    : null;
  const hasRole = Array.isArray(descriptor.roles) && descriptor.roles.length > 0;

  const probe = (memberId) =>
    getActiveDb()
      .prepare(`SELECT 1 FROM ${table} WHERE ${ownerCol} = :owner AND ${MEMBER_COLUMN} = :member`)
      .get({ owner: oid, member: String(memberId) });

  const probeRow = (memberId) =>
    getActiveDb()
      .prepare(`SELECT * FROM ${table} WHERE ${ownerCol} = :owner AND ${MEMBER_COLUMN} = :member`)
      .get({ owner: oid, member: String(memberId) });

  return {
    set: async (memberId, { role } = {}) => {
      await authorizeFieldOp(record, fieldName, write, row, principal);
      const mid = String(memberId);
      const existing = probeRow(memberId);
      const actionType =
        !existing ? `${entityName}.${fieldName}.add`
        : hasRole && existing.role !== (role ?? null) ? `${entityName}.${fieldName}.setRole`
        : null;
      if (actionType === null) return;
      await dispatchFieldMutation({
        entityName, fieldName, dispatch, principal,
        type: actionType,
        payload: { owner: oid, member: mid, role },
      });
    },
    remove: async (memberId) => {
      await authorizeFieldOp(record, fieldName, write, row, principal);
      const mid = String(memberId);
      if (!probe(memberId)) return;
      await dispatchFieldMutation({
        entityName, fieldName, dispatch, principal,
        type: `${entityName}.${fieldName}.remove`,
        payload: { owner: oid, member: mid },
      });
    },
    has: (memberId) => probe(memberId) !== undefined,
    get: (memberId) => {
      const mid = String(memberId);
      return getActiveDb()
        .prepare(`SELECT * FROM ${table} WHERE ${ownerCol} = :owner AND ${MEMBER_COLUMN} = :member`)
        .get({ owner: oid, member: mid }) ?? undefined;
    },
    toArray: async () => {
      await authorizeFieldOp(record, fieldName, read, row, principal);
      const db = getActiveDb();
      const selectCols = hasRole ? `${MEMBER_COLUMN} AS member_id, role` : `${MEMBER_COLUMN} AS member_id`;
      const rows = db
        .prepare(`SELECT ${selectCols} FROM ${table} WHERE ${ownerCol} = :owner`)
        .all({ owner: oid });
      const target = targetName ? getActiveEntity(targetName) : null;
      if (!target) return rows.map((r) => [null, hasRole ? r.role : null]);
      const memberIds = rows.map((r) => r.member_id);
      const members = [];
      for (let i = 0; i < memberIds.length; i += 500) {
        const batch = memberIds.slice(i, i + 500);
        const placeholders = batch.map(() => '?').join(',');
        members.push(...db.prepare(
          `SELECT * FROM ${targetName} WHERE id IN (${placeholders})`,
        ).all(...batch));
      }
      for (const m of members) target.hydrate(m, principal);
      const memberMap = Object.fromEntries(members.map((m) => [m.id, m]));
      return rows.map((r) => [memberMap[r.member_id] ?? null, hasRole ? r.role : null]);
    },
  };
}

function mapMutateHandlers(entityName, fieldEntries) {
  const handlers = {};
  for (const [mapField, descriptor] of fieldEntries) {
    const hasRole = Array.isArray(descriptor.roles) && descriptor.roles.length > 0;
    const requireOwnerMember = (payload) => {
      const { owner, member } = payload ?? {};
      if (owner == null || member == null) {
        throw Object.assign(
          new Error(`${entityName}.${mapField} action requires owner + member`),
          { status: 400 },
        );
      }
      return { owner: String(owner), member: String(member) };
    };
    handlers[`${entityName}.${mapField}.add`] = ({ payload }) => {
      const { owner, member } = requireOwnerMember(payload);
      const handle = eventHandles.native(entityName, mapField, 'added');
      return [{
        handle,
        type: handle.type,
        scope: `${entityName}:${owner}`,
        data: { owner, member, role: hasRole ? (payload.role ?? null) : undefined },
      }];
    };
    handlers[`${entityName}.${mapField}.setRole`] = ({ payload }) => {
      const { owner, member } = requireOwnerMember(payload);
      if (!hasRole) {
        throw Object.assign(new Error(`${entityName}.${mapField}.setRole on a role-less map`), { status: 400 });
      }
      const handle = eventHandles.native(entityName, mapField, 'roleChanged');
      return [{
        handle,
        type: handle.type,
        scope: `${entityName}:${owner}`,
        data: { owner, member, role: payload.role ?? null },
      }];
    };
    handlers[`${entityName}.${mapField}.remove`] = ({ payload }) => {
      const { owner, member } = requireOwnerMember(payload);
      const handle = eventHandles.native(entityName, mapField, 'removed');
      return [{
        handle,
        type: handle.type,
        scope: `${entityName}:${owner}`,
        data: { owner, member },
      }];
    };
  }
  return handlers;
}

function mapProjectionApply({ entityName, fieldEntries, handle, event, db }) {
  for (const [mapField, descriptor] of fieldEntries) {
    if (handle.field !== mapField || handle.kind !== eventHandles.EventKind.native) continue;
    const sideTable = membershipTable(entityName, mapField);
    const ownerCol = membershipOwnerCol(entityName);
    const hasRole = Array.isArray(descriptor.roles) && descriptor.roles.length > 0;
    if (handle.nativeName === 'added') {
      const cols = [ownerCol, MEMBER_COLUMN];
      const vals = [':owner', ':member'];
      const params = { owner: String(event.data?.owner), member: String(event.data?.member) };
      if (hasRole) { cols.push('role'); vals.push(':role'); params.role = event.data?.role ?? null; }
      db.prepare(`INSERT INTO ${sideTable} (${cols.join(', ')}) VALUES (${vals.join(', ')})`).run(params);
      return true;
    }
    if (handle.nativeName === 'roleChanged' && hasRole) {
      db.prepare(`UPDATE ${sideTable} SET role = :role WHERE ${ownerCol} = :owner AND ${MEMBER_COLUMN} = :member`)
        .run({ owner: String(event.data?.owner), member: String(event.data?.member), role: event.data?.role ?? null });
      return true;
    }
    if (handle.nativeName === 'removed') {
      db.prepare(`DELETE FROM ${sideTable} WHERE ${ownerCol} = :owner AND ${MEMBER_COLUMN} = :member`)
        .run({ owner: String(event.data?.owner), member: String(event.data?.member) });
      return true;
    }
  }
  return false;
}

function mapDDL(entityName, fieldName, descriptor) {
  const tableName = `${entityName}_${fieldName}`;
  const ownerCol = `${entityName}_id`;
  const cols = [`${ownerCol} TEXT NOT NULL`, 'member_id TEXT NOT NULL'];
  if (Array.isArray(descriptor.roles) && descriptor.roles.length > 0) {
    cols.push('role TEXT NOT NULL');
  }
  cols.push(`PRIMARY KEY (${ownerCol}, member_id)`);
  return `CREATE TABLE IF NOT EXISTS ${tableName} (\n  ${cols.join(',\n  ')}\n);`;
}

function orderedHandle({ record, entityName, fieldName, row, principal, dispatch }) {
  const table = membershipTable(entityName, fieldName);
  const ownerCol = membershipOwnerCol(entityName);
  const oid = String(row.id);

  const rowsOrdered = () =>
    getActiveDb()
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
      getActiveDb()
        .prepare(`SELECT 1 FROM ${table} WHERE ${ownerCol} = :owner AND id = :id`)
        .get({ owner: oid, id: String(id) }) !== undefined,
    get: (id) => {
      const r = getActiveDb()
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
        scope: `${entityName}:${owner}`,
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
        scope: `${entityName}:${owner}`,
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
        scope: `${entityName}:${owner}`,
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
        scope: `${entityName}:${owner}`,
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

function logHandle({ record, entityName, fieldName, descriptor, row, principal, dispatch }) {
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
      const rows = getActiveDb()
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
        scope: `${entityName}:${owner}`,
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

function ephemeralHandle({ record, entityName, fieldName, row, principal, dispatch }) {
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
      const r = getActiveDb()
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
        scope: `${entityName}:${owner}`,
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

const MAP_SIDE_TABLE_STRATEGY = Object.freeze({
  matches: (descriptor) => descriptor.kind === 'store' && descriptor.type === 'map',
  handle: mapHandle,
  eventTypes: (entityName, fieldEntries) => fieldEntries.flatMap(([fieldName]) => [
    eventHandles.native(entityName, fieldName, 'added').type,
    eventHandles.native(entityName, fieldName, 'roleChanged').type,
    eventHandles.native(entityName, fieldName, 'removed').type,
  ]),
  mutateHandlers: mapMutateHandlers,
  projectionApply: mapProjectionApply,
  ddl: mapDDL,
});

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

const LOG_SIDE_TABLE_STRATEGY = Object.freeze({
  matches: (descriptor) => descriptor.kind === 'store' && descriptor.type === 'log',
  handle: logHandle,
  eventTypes: (entityName, fieldEntries) => fieldEntries.map(([fieldName]) =>
    eventHandles.native(entityName, fieldName, 'appended').type),
  mutateHandlers: logMutateHandlers,
  projectionApply: logProjectionApply,
  ddl: logDDL,
});

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
  MAP_SIDE_TABLE_STRATEGY,
  ORDERED_SIDE_TABLE_STRATEGY,
  LOG_SIDE_TABLE_STRATEGY,
  EPHEMERAL_SIDE_TABLE_STRATEGY,
};

const SIDE_TABLE_STRATEGIES = Object.freeze([
  MAP_SIDE_TABLE_STRATEGY,
  ORDERED_SIDE_TABLE_STRATEGY,
  LOG_SIDE_TABLE_STRATEGY,
  EPHEMERAL_SIDE_TABLE_STRATEGY,
]);

export function collectSideTableStrategies(fields) {
  return SIDE_TABLE_STRATEGIES
    .map((strategy) => ({
      strategy,
      fields: Object.entries(fields).filter(([, descriptor]) => strategy.matches(descriptor)),
    }))
    .filter((entry) => entry.fields.length > 0);
}

export function sideTableDDL(entity, fieldName, descriptor) {
  const strategy = SIDE_TABLE_STRATEGIES.find((candidate) => candidate.matches(descriptor));
  return strategy ? strategy.ddl(entity.name, fieldName, descriptor) : null;
}

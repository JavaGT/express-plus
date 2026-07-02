import { randomUUID } from 'node:crypto';

import { read, write } from './grant.mjs';
import { mayFieldOp } from './row-grant.mjs';
import { membershipTable, membershipOwnerCol, MEMBER_COLUMN } from './scope-sql.mjs';
import { getActiveDb, getActiveEntity } from './db.mjs';
import * as eventHandles from './event-handle.mjs';

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
      requireFieldDispatch(entityName, fieldName, dispatch);
      const result = await dispatch({
        actionId: randomUUID(),
        type: actionType,
        payload: { owner: oid, member: mid, role },
        principal,
      });
      if (!result.granted) throw { status: 403, message: 'forbidden' };
    },
    remove: async (memberId) => {
      await authorizeFieldOp(record, fieldName, write, row, principal);
      const mid = String(memberId);
      if (!probe(memberId)) return;
      requireFieldDispatch(entityName, fieldName, dispatch);
      const result = await dispatch({
        actionId: randomUUID(),
        type: `${entityName}.${fieldName}.remove`,
        payload: { owner: oid, member: mid },
        principal,
      });
      if (!result.granted) throw { status: 403, message: 'forbidden' };
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

const SIDE_TABLE_STRATEGIES = Object.freeze([MAP_SIDE_TABLE_STRATEGY]);

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

import { randomUUID } from 'node:crypto';

import { read, write } from '../grant.mjs';
import { mayFieldOp } from '../row-grant.mjs';

import { MAP_SIDE_TABLE_STRATEGY } from './map.mjs';
import { ORDERED_SIDE_TABLE_STRATEGY } from './ordered.mjs';
import { LOG_SIDE_TABLE_STRATEGY } from './log.mjs';
import { EPHEMERAL_SIDE_TABLE_STRATEGY } from './ephemeral.mjs';
import { FTS_STRATEGY } from '../fts-strategy.mjs';

// ---------------------------------------------------------------------------
// Shared helpers used across multiple strategy implementations
// ---------------------------------------------------------------------------
// These are exported so per-strategy modules can import them; they are NOT
// part of the public API surface (not re-exported from the barrel).

export async function authorizeFieldOp(record, fieldName, capability, row, principal) {
  if (principal && !(await mayFieldOp(record, fieldName, capability, row, principal))) {
    throw { status: 403, message: 'forbidden' };
  }
}

export function requireFieldDispatch(entityName, fieldName, dispatch) {
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
export async function dispatchFieldMutation({ entityName, fieldName, dispatch, type, payload, principal }) {
  requireFieldDispatch(entityName, fieldName, dispatch);
  const result = await dispatch({ actionId: randomUUID(), type, payload, principal });
  if (!result.ok) throw { failure: result.failure };
  return result;
}

export function mapMutationAction({ entityName, fieldName, operation, owner, member, role }) {
  if (!['add', 'setRole', 'remove'].includes(operation)) {
    throw new Error(`unknown map mutation operation '${String(operation)}'`);
  }
  const payload = { owner: String(owner), member: String(member) };
  if (operation !== 'remove') payload.role = role;
  return Object.freeze({
    type: `${entityName}.${fieldName}.${operation}`,
    payload: Object.freeze(payload),
  });
}

// ---------------------------------------------------------------------------
// Strategy collection
// ---------------------------------------------------------------------------

const SIDE_TABLE_STRATEGIES = Object.freeze([
  FTS_STRATEGY,
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

// ---------------------------------------------------------------------------
// Re-exports from per-strategy modules
// ---------------------------------------------------------------------------

export { MAP_SIDE_TABLE_STRATEGY, mapHandle, mapMutateHandlers, mapProjectionApply, mapDDL } from './map.mjs';
export { ORDERED_SIDE_TABLE_STRATEGY, orderedHandle, orderedMutateHandlers, orderedProjectionApply, orderedDDL } from './ordered.mjs';
export { LOG_SIDE_TABLE_STRATEGY, logHandle, logMutateHandlers, logProjectionApply, logDDL } from './log.mjs';
export { EPHEMERAL_SIDE_TABLE_STRATEGY, ephemeralHandle, ephemeralMutateHandlers, ephemeralProjectionApply, ephemeralDDL } from './ephemeral.mjs';
export { FTS_STRATEGY } from '../fts-strategy.mjs';

// @ts-nocheck
import { MAP_SIDE_TABLE_STRATEGY } from './map.ts';
import { ORDERED_SIDE_TABLE_STRATEGY } from './ordered.ts';
import { LOG_SIDE_TABLE_STRATEGY } from './log.ts';
import { EPHEMERAL_SIDE_TABLE_STRATEGY } from './ephemeral.ts';
import { FTS_STRATEGY } from '../fts-strategy.ts';

// Shared strategy helpers. Re-exported here so consumers that import from the
// strategy barrel (annotated-text-admit, auth/invitation via side-table-strategy)
// keep working; the per-strategy modules import them from ./shared.mjs directly.
export {
  authorizeFieldOp,
  mapMutationAction,
} from './shared.ts';

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
// Strategy constants
// ---------------------------------------------------------------------------

export { MAP_SIDE_TABLE_STRATEGY, ORDERED_SIDE_TABLE_STRATEGY, LOG_SIDE_TABLE_STRATEGY, EPHEMERAL_SIDE_TABLE_STRATEGY, FTS_STRATEGY };

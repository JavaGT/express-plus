import type { EventIdentityHandle } from '../event-handle.ts';
import type { DbHandle } from '../driver.ts';
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
// Shared strategy types
// ---------------------------------------------------------------------------

// The declared shape of a field. Each side-table strategy reads only the
// sub-shape it owns (kind/type/entry/of/roles); the index signature keeps
// unknown declared keys from closing the type to specific stores.
export interface FieldDescriptor {
  kind: string;
  type?: string;
  indexed?: string;
  roles?: readonly string[];
  entry?: Readonly<Record<string, FieldDescriptor>>;
  of?: Readonly<{ kind?: string; type?: string; target?: unknown }>;
  [key: string]: unknown;
}

// [string, FieldDescriptor] pairs — the fieldEntries shape every strategy
// receives for its matched fields.
export type FieldEntries = [string, FieldDescriptor][];

// The minimal principal handle a strategy reads: just the requesting identity.
export interface StrategyPrincipal {
  id?: unknown;
  [key: string]: unknown;
}

// A hydrated target entity: the map strategy's toArray resolves a ref's target
// through entityOf and hydrates each member row with the requesting principal.
export interface EntityHandle {
  name: string;
  hydrate(row: Record<string, unknown>, principal?: unknown): unknown;
}

// A committed field event as seen by a projection consumer. Strategies read
// only data; identity is concentrated in the event handle.
export interface FieldEvent {
  type: string;
  scope?: string;
  seq?: number;
  data?: Record<string, unknown> | null;
}

// The dispatch result side-table handles read emitted events from.
export interface DispatchResult {
  ok: boolean;
  failure?: unknown;
  events?: readonly FieldEvent[];
}

// The dispatch function a handle must forward its field mutation to.
export interface Dispatch {
  (input: {
    actionId: string;
    type: string;
    payload: unknown;
    principal?: unknown;
    scope?: string;
  }): Promise<DispatchResult>;
}

// The input a strategy's handle factory receives from the entity hydrator.
export interface SideTableHandleInput {
  record: unknown;
  entityName: string;
  fieldName: string;
  descriptor: FieldDescriptor;
  row: Readonly<Record<string, unknown>>;
  principal: StrategyPrincipal | null | undefined;
  dispatch: Dispatch;
  db: DbHandle;
  entityOf: (value: unknown) => EntityHandle | null | undefined;
}

// The event/handle subset a strategy projection reader needs. `handle` is the
// full event handle — narrowing it by kind (as the projections do) exposes the
// field/nativeName variants — and `event` carries only the committed data.
export interface ProjectionEvent {
  data?: Record<string, unknown>;
}

// The input a strategy's projectionApply receives.
export interface SideTableProjectionInput {
  entityName: string;
  fieldEntries: FieldEntries;
  handle: EventIdentityHandle;
  event: ProjectionEvent;
  db: DbHandle;
}

// The input a strategy's generated mutate handler receives.
export type MutateHandlerInput = {
  payload: Record<string, unknown> | null | undefined;
};

// The one shape every side-table strategy implements. Matches decides whether a
// declared field belongs to the strategy; the rest derives DDL, event types,
// dispatch-level handlers, and the row projection from declared field entries.
export interface SideTableStrategy {
  matches(descriptor: FieldDescriptor): boolean;
  handle?(input: SideTableHandleInput): unknown;
  eventTypes(entityName: string, fieldEntries: FieldEntries): string[];
  mutateHandlers(
    entityName: string,
    fieldEntries: FieldEntries,
  ): Record<string, (input: MutateHandlerInput) => unknown>;
  projectionApply(input: SideTableProjectionInput): boolean;
  ddl(entityName: string, fieldName: string, descriptor: FieldDescriptor): string | null;
}

// ---------------------------------------------------------------------------
// Strategy collection
// ---------------------------------------------------------------------------

const SIDE_TABLE_STRATEGIES: readonly SideTableStrategy[] = Object.freeze([
  FTS_STRATEGY,
  MAP_SIDE_TABLE_STRATEGY,
  ORDERED_SIDE_TABLE_STRATEGY,
  LOG_SIDE_TABLE_STRATEGY,
  EPHEMERAL_SIDE_TABLE_STRATEGY,
]);

export interface SideTableStrategyEntry {
  strategy: SideTableStrategy;
  fields: FieldEntries;
}

export function collectSideTableStrategies(fields: Record<string, FieldDescriptor>): SideTableStrategyEntry[] {
  return SIDE_TABLE_STRATEGIES
    .map((strategy) => ({
      strategy,
      fields: Object.entries(fields).filter(([, descriptor]) => strategy.matches(descriptor)),
    }))
    .filter((entry) => entry.fields.length > 0);
}

export function sideTableDDL(entity: { name: string }, fieldName: string, descriptor: FieldDescriptor): string | null {
  const strategy = SIDE_TABLE_STRATEGIES.find((candidate) => candidate.matches(descriptor));
  return strategy ? strategy.ddl(entity.name, fieldName, descriptor) : null;
}

// ---------------------------------------------------------------------------
// Strategy constants
// ---------------------------------------------------------------------------

export { MAP_SIDE_TABLE_STRATEGY, ORDERED_SIDE_TABLE_STRATEGY, LOG_SIDE_TABLE_STRATEGY, EPHEMERAL_SIDE_TABLE_STRATEGY, FTS_STRATEGY };

// Shared helpers used across multiple side-table strategy implementations.
//
// These live in their own module so the per-strategy modules (map/log/ordered/
// ephemeral) can import them without importing the strategy barrel — that
// back-edge was the cycle: strategy/index.mjs imported the strategy modules
// while they imported their shared helpers back from it.

import { randomUUID } from 'node:crypto';

import { mayFieldOp } from '../row-grant.mjs';

export async function authorizeFieldOp(record: unknown, fieldName: string, capability: string, row: unknown, principal: unknown): Promise<void> {
  if (principal && !(await mayFieldOp(record, fieldName, capability, row, principal))) {
    throw { status: 403, message: 'forbidden' };
  }
}

export function requireFieldDispatch(entityName: string, fieldName: string, dispatch: unknown): void {
  if (!dispatch) {
    throw new Error(
      `cannot mutate ${entityName}.${fieldName} without a dispatch ref ` +
        `(hydrate with dispatch inside a handler/route)`,
    );
  }
}

interface DispatchInput {
  actionId: string;
  type: string;
  payload: unknown;
  principal?: unknown;
}

interface DispatchResult {
  ok: boolean;
  failure?: unknown;
}

// The shared tail of every side-table write: require a dispatch ref, dispatch
// the field action, fail closed on deny. Callers authorize BEFORE their
// payload prep so an unauthorized principal gets 403 even when the write would
// be a no-op. Returns the dispatch result for handles that read emitted events.
export async function dispatchFieldMutation({ entityName, fieldName, dispatch, type, payload, principal }: {
  entityName: string;
  fieldName: string;
  dispatch: (input: DispatchInput) => Promise<DispatchResult>;
  type: string;
  payload: unknown;
  principal?: unknown;
}): Promise<DispatchResult> {
  requireFieldDispatch(entityName, fieldName, dispatch);
  const result = await dispatch({ actionId: randomUUID(), type, payload, principal });
  if (!result.ok) throw { failure: result.failure };
  return result;
}

export interface MapMutationPayload {
  owner: string;
  member: string;
  role?: unknown;
}

export function mapMutationAction({ entityName, fieldName, operation, owner, member, role }: {
  entityName: string;
  fieldName: string;
  operation: string;
  owner: unknown;
  member: unknown;
  role?: unknown;
}): Readonly<{ type: string; payload: Readonly<MapMutationPayload> }> {
  if (!['add', 'setRole', 'remove'].includes(operation)) {
    throw new Error(`unknown map mutation operation '${String(operation)}'`);
  }
  const payload: MapMutationPayload = { owner: String(owner), member: String(member) };
  if (operation !== 'remove') payload.role = role;
  return Object.freeze({
    type: `${entityName}.${fieldName}.${operation}`,
    payload: Object.freeze(payload),
  });
}

// Atomic live-field operations. These are deliberately target-state operations:
// callers can request a known result, never an ambiguous "invert" of a value
// observed outside the write coordinator.

import { ValidationError } from './field-strategy.ts';
import { frozenJsonSnapshot } from './frozen-json.ts';
import type { EntityRecord } from './row-grant.ts';

export type AtomicOperation =
  | Readonly<{ kind: 'setAdd'; field: string; value: unknown }>
  | Readonly<{ kind: 'setRemove'; field: string; value: unknown }>
  | Readonly<{ kind: 'increment'; field: string; by: number }>
  | Readonly<{ kind: 'claim'; field: string; value: unknown }>
  | Readonly<{ kind: 'acknowledge'; field: string }>
  | Readonly<{ kind: 'toggleTo'; field: string; value: boolean }>;

export const ATOMIC_OPERATION_KINDS = Object.freeze([
  'setAdd', 'setRemove', 'increment', 'claim', 'acknowledge', 'toggleTo',
] as const);

function fieldName(field: string): string {
  if (typeof field !== 'string' || field.length === 0) {
    throw new ValidationError('atomic operation field must be a non-empty string');
  }
  return field;
}

function jsonValue(value: unknown): unknown {
  try {
    return frozenJsonSnapshot(value);
  } catch {
    throw new ValidationError('atomic operation value must be JSON-safe');
  }
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function setAdd(field: string, value: unknown): AtomicOperation {
  return Object.freeze({ kind: 'setAdd', field: fieldName(field), value: jsonValue(value) });
}

export function setRemove(field: string, value: unknown): AtomicOperation {
  return Object.freeze({ kind: 'setRemove', field: fieldName(field), value: jsonValue(value) });
}

export function increment(field: string, by = 1): AtomicOperation {
  if (!Number.isFinite(by)) throw new ValidationError('increment amount must be a finite number');
  return Object.freeze({ kind: 'increment', field: fieldName(field), by });
}

export function claim(field: string, value: unknown): AtomicOperation {
  return Object.freeze({ kind: 'claim', field: fieldName(field), value: jsonValue(value) });
}

export function acknowledge(field: string): AtomicOperation {
  return Object.freeze({ kind: 'acknowledge', field: fieldName(field) });
}

export function toggleTo(field: string, value: boolean): AtomicOperation {
  if (typeof value !== 'boolean') throw new ValidationError('toggleTo value must be boolean');
  return Object.freeze({ kind: 'toggleTo', field: fieldName(field), value });
}

export function isAtomicOperation(value: unknown): value is AtomicOperation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const operation = value as Record<string, unknown>;
  if (typeof operation.field !== 'string' || operation.field.length === 0) return false;
  const hasKeys = (...keys: string[]) => Object.keys(operation).length === keys.length
    && keys.every((key) => Object.hasOwn(operation, key));
  switch (operation.kind) {
    case 'setAdd':
    case 'setRemove':
    case 'claim': return hasKeys('kind', 'field', 'value') && isJsonValue(operation.value);
    case 'increment': return hasKeys('kind', 'field', 'by') && typeof operation.by === 'number' && Number.isFinite(operation.by);
    case 'acknowledge': return hasKeys('kind', 'field');
    case 'toggleTo': return hasKeys('kind', 'field', 'value') && typeof operation.value === 'boolean';
    default: return false;
  }
}

function isJsonValue(value: unknown, seen = new Set<unknown>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) return false;
    seen.add(value);
    return value.every((item) => isJsonValue(item, seen));
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype || seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).every((item) => isJsonValue(item, seen));
}

export interface AtomicExecution {
  readonly row: Readonly<Record<string, unknown>>;
  readonly applied: boolean;
}

export interface AtomicOperationContext {
  readonly payload: unknown;
  readonly principal: unknown;
  readonly db: unknown;
  readonly now: string;
  readonly scope: string;
  readonly actionId: string;
}

export interface AtomicOperationRegistration {
  readonly entity: EntityRecord;
  readonly read: (context: AtomicOperationContext) => Readonly<Record<string, unknown>> | Promise<Readonly<Record<string, unknown>>>;
}

export type AtomicOperationHandler = ((context: AtomicOperationContext & { readonly atomic: AtomicExecution }) => unknown) & {
  readonly inTransaction?: boolean;
  readonly atomicOperation?: AtomicOperationRegistration;
};

// Marks a handler as an atomic operation. The pipeline owns the in-transaction
// read, resolution, field admission, and subsequent handler call.
export function atomicOperation(
  registration: AtomicOperationRegistration,
  handler: AtomicOperationHandler,
): AtomicOperationHandler {
  if (!registration?.entity || typeof registration.read !== 'function') {
    throw new TypeError('atomic operation requires an entity and current-row reader');
  }
  Object.defineProperties(handler, {
    atomicOperation: { value: Object.freeze(registration) },
    inTransaction: { value: true },
  });
  return handler;
}

// Resolve one operation against the row read inside the write-coordinator
// transaction. A no-op is successful and retry-safe; a claim by another actor
// is the one operation-level conflict.
export function executeAtomicOperation(row: Readonly<Record<string, unknown>>, operation: AtomicOperation): AtomicExecution {
  if (!isAtomicOperation(operation)) throw new ValidationError('invalid atomic operation');
  const current = row[operation.field];
  let next: unknown;

  switch (operation.kind) {
    case 'setAdd':
      if (!Array.isArray(current)) throw new ValidationError(`atomic setAdd requires '${operation.field}' to be an array`);
      next = current.some((member) => equal(member, operation.value)) ? current : [...current, operation.value];
      break;
    case 'setRemove':
      if (!Array.isArray(current)) throw new ValidationError(`atomic setRemove requires '${operation.field}' to be an array`);
      next = current.filter((member) => !equal(member, operation.value));
      break;
    case 'increment':
      if (typeof current !== 'number' || !Number.isFinite(current)) throw new ValidationError(`atomic increment requires '${operation.field}' to be a finite number`);
      next = current + operation.by;
      if (!Number.isFinite(next)) throw new ValidationError('atomic increment result must be a finite number');
      break;
    case 'claim':
      if (current !== null && current !== undefined && !equal(current, operation.value)) {
        throw Object.assign(new Error('atomic claim conflicts with an existing claim'), { status: 409 });
      }
      next = operation.value;
      break;
    case 'acknowledge':
      if (typeof current !== 'boolean') throw new ValidationError(`atomic acknowledge requires '${operation.field}' to be boolean`);
      next = true;
      break;
    case 'toggleTo':
      if (typeof current !== 'boolean') throw new ValidationError(`atomic toggleTo requires '${operation.field}' to be boolean`);
      next = operation.value;
      break;
  }
  return Object.freeze({ row: Object.freeze({ ...row, [operation.field]: next }), applied: !equal(current, next) });
}

export function executeAtomicOperations(row: Readonly<Record<string, unknown>>, operations: readonly AtomicOperation[]): AtomicExecution {
  let result: AtomicExecution = Object.freeze({ row: Object.freeze({ ...row }), applied: false });
  for (const operation of operations) {
    const next = executeAtomicOperation(result.row, operation);
    result = Object.freeze({ row: next.row, applied: result.applied || next.applied });
  }
  return result;
}

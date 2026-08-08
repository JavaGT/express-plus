// @ts-nocheck
// Schedule module — time-driven sources (ADR #10, ADR-0002) and constructor
// declarations. Runtime functions (discovery, admission, clock dispatch, receipt
// management) live in schedule-runtime.mjs and are re-exported here.
//
// Tick triggers (tick.hz / tick.every) are row-set intervals: fire `update`
// against EVERY row matching `while` per interval. An EMPTY `while` is
// forbidden (the "run on ALL rows forever" foot-gun) — enforced at
// entity-load-time in entity compile.

const MS: Record<'d' | 'h' | 'm' | 's', number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 };

type TriggerFunction = ((...args: unknown[]) => unknown) | undefined;
type WithPayload = undefined | null | ((...args: unknown[]) => unknown) | Record<string, unknown>;

function parseDelay(delay: number | string): number {
  if (typeof delay === 'number' && Number.isFinite(delay) && delay >= 0) return delay;
  if (typeof delay === 'string') {
    const m = /^(\d+)([dhms])$/.exec(delay.trim());
    if (m) return Number(m[1]) * MS[m[2] as 'd' | 'h' | 'm' | 's'];
  }
  throw new Error(`schedule.after: invalid delay ${JSON.stringify(delay)} (expected a non-negative number ms or a '<n><d|h|m|s>' string)`);
}

// validateWith — fail-closed guard for the 'with' payload option.
// with must be absent (undefined), an object literal, or a function ({row}) => obj.
// Booleans, arrays, strings, numbers (other than omitted) are rejected.
function isDeclaredAsync(value: unknown): boolean {
  return typeof value === 'function' && (value as { constructor?: { name?: string } }).constructor?.name === 'AsyncFunction';
}

function validateWith(withValue: unknown, context: string): WithPayload {
  if (withValue === undefined) return undefined;
  if (withValue === null) return null;
  if (typeof withValue === 'function') {
    if (isDeclaredAsync(withValue)) throw new Error(`${context}: with must be synchronous`);
    return withValue;
  }
  if (typeof withValue === 'object' && !Array.isArray(withValue)) return withValue;
  throw new Error(`${context}: 'with' must be an object or a function ({row}) => obj`);
}

function validateOptionalFunction(value: unknown, context: string, option: string, signature: string): TriggerFunction {
  if (value === undefined) return undefined;
  if (typeof value !== 'function') {
    throw new Error(`${context}: ${option} must be a function ${signature}`);
  }
  if (isDeclaredAsync(value)) throw new Error(`${context}: ${option} must be synchronous`);
  return value;
}

function validateTriggerKey(value: unknown, context: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(
      `${context}: key must be a non-empty string containing only letters, numbers, '.', '_' or '-'`,
    );
  }
  return value;
}

interface ScheduleOptions {
  key?: string;
  while?: unknown;
  with?: unknown;
  when?: unknown;
}

interface ScheduleAtDescriptor {
  kind: 'schedule.at';
  key: string | undefined;
  field: unknown;
  when: TriggerFunction;
  while: TriggerFunction;
  with: WithPayload;
}

interface ScheduleAfterDescriptor extends ScheduleAtDescriptor {
  kind: 'schedule.after';
  delay: number;
}

export const schedule: {
  at(field: unknown, options?: ScheduleOptions): ScheduleAtDescriptor;
  after(field: unknown, delay: number | string, options?: ScheduleOptions): ScheduleAfterDescriptor;
} = Object.freeze({
  at(field: unknown, options: ScheduleOptions = {}) {
    if (!field || typeof field !== 'object') throw new Error('schedule.at: field must be a field descriptor');
    const { key, while: whilePredicate, with: withPayload, when } = options;
    const validatedKey = validateTriggerKey(key, 'schedule.at');
    const validatedWhile = validateOptionalFunction(whilePredicate, 'schedule.at', 'while', '({fields}) => predicate');
    const validatedWith = validateWith(withPayload, 'schedule.at');
    const validatedWhen = validateOptionalFunction(when, 'schedule.at', 'when', '({row}) => boolean');
    return Object.freeze({ kind: 'schedule.at', key: validatedKey, field, when: validatedWhen, while: validatedWhile, with: validatedWith });
  },
  after(field: unknown, delay: number | string, options: ScheduleOptions = {}) {
    if (!field || typeof field !== 'object') throw new Error('schedule.after: field must be a field descriptor');
    const { key, while: whilePredicate, with: withPayload, when } = options;
    const validatedKey = validateTriggerKey(key, 'schedule.after');
    const validatedWhile = validateOptionalFunction(whilePredicate, 'schedule.after', 'while', '({fields}) => predicate');
    const validatedWith = validateWith(withPayload, 'schedule.after');
    const validatedWhen = validateOptionalFunction(when, 'schedule.after', 'when', '({row}) => boolean');
    return Object.freeze({ kind: 'schedule.after', key: validatedKey, field, delay: parseDelay(delay), when: validatedWhen, while: validatedWhile, with: validatedWith });
  },
});

// A verb's schedule slot accepts one trigger or an array; normalize to an array.
export function triggerList<T>(triggerOrTriggers: T | T[] | null | undefined): T[] {
  if (triggerOrTriggers == null) return [];
  return Array.isArray(triggerOrTriggers) ? triggerOrTriggers : [triggerOrTriggers];
}

// The expected scheduler source for a declared schedule. DERIVED from declared
// shape (entity name + verb + trigger identity) — never an author magic string. A
// reaper minting a scheduler principal MUST use this same derivation so the
// principal binds to exactly ONE declared schedule (a Blog.update source cannot
// admit a Doc.update dispatch). This is the binding that makes a system
// principal's authority equal to the entity's DECLARED will (not a free grant).
export function schedulerSource(entityName: string, verb: string, triggerId: string): string {
  if (typeof triggerId !== 'string' || triggerId === '') {
    throw new Error('schedulerSource: triggerId must be a non-empty string');
  }
  return `${entityName}.${verb}.${triggerId}`;
}

// tick — interval trigger constructors for row-set ticks.
// A tick fires `update` against EVERY row matching `while` per interval.
// No singleton/cron shape. An EMPTY `while` is FORBIDDEN at load-time.
export const tick: {
  hz(n: number, options?: ScheduleOptions): { kind: 'tick.hz'; key: string | undefined; hertz: number; when: TriggerFunction; while: TriggerFunction; with: WithPayload };
  every(duration: number | string, options?: ScheduleOptions): { kind: 'tick.every'; key: string | undefined; intervalMs: number; when: TriggerFunction; while: TriggerFunction; with: WithPayload };
} = Object.freeze({
  hz(n: number, options: ScheduleOptions = {}) {
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
      throw new Error('tick.hz: n must be a finite positive number');
    }
    const { key, while: whilePredicate, with: withPayload, when } = options;
    const validatedKey = validateTriggerKey(key, 'tick.hz');
    const validatedWhile = validateOptionalFunction(whilePredicate, 'tick.hz', 'while', '({fields}) => predicate');
    const validatedWith = validateWith(withPayload, 'tick.hz');
    const validatedWhen = validateOptionalFunction(when, 'tick.hz', 'when', '({row}) => boolean');
    return Object.freeze({ kind: 'tick.hz', key: validatedKey, hertz: n, when: validatedWhen, while: validatedWhile, with: validatedWith });
  },
  every(duration: number | string, options: ScheduleOptions = {}) {
    const { key, while: whilePredicate, with: withPayload, when } = options;
    const validatedKey = validateTriggerKey(key, 'tick.every');
    const validatedWhile = validateOptionalFunction(whilePredicate, 'tick.every', 'while', '({fields}) => predicate');
    const validatedWith = validateWith(withPayload, 'tick.every');
    const validatedWhen = validateOptionalFunction(when, 'tick.every', 'when', '({row}) => boolean');
    return Object.freeze({ kind: 'tick.every', key: validatedKey, intervalMs: parseDelay(duration), when: validatedWhen, while: validatedWhile, with: validatedWith });
  },
});

// simulate — simulation declaration. A simulation runs an `hz`-rate loop
// holding ephemeral working state in memory (never per-tick DB writes).
// `step({state, dt, row})` → {state, events} returns the next working state
// plus optional events to persist. Events are dispatched through the normal
// pipeline (in-transaction), so checkpoint writes are framework-owned.
// `when` is an optional lifecycle guard — the simulation only runs while it
// returns true per scope.
export function simulate({ hz, step, when }: SimulateOptions = {}): SimulateDescriptor {
  if (typeof hz !== 'number' || !Number.isFinite(hz) || hz <= 0) {
    throw new Error('simulate: hz must be a finite positive number');
  }
  if (typeof step !== 'function') {
    throw new Error('simulate: step must be a function ({state, dt, row}) => ({state, events})');
  }
  return Object.freeze({ kind: 'simulate', hz, step, when: when ?? undefined });
}

interface SimulateOptions {
  hz?: number;
  step?: unknown;
  when?: unknown;
}

interface SimulateDescriptor {
  kind: 'simulate';
  hz: number;
  step: (...args: unknown[]) => unknown;
  when: ((...args: unknown[]) => unknown) | undefined;
}

// tickSource — derives the identity for a tick principal, mirroring the
// schedulerSource pattern (entity + verb + trigger identity). No fieldName —
// a tick has no field; the identity is derived, never a magic authority string.
export function tickSource(entityName: string, verb: string, triggerId = 'tick'): string {
  if (typeof triggerId !== 'string' || triggerId === '') {
    throw new Error('tickSource: triggerId must be a non-empty string');
  }
  return `${entityName}.${verb}.${triggerId}`;
}

// Re-export runtime functions from schedule-runtime.mjs.
// Importers that only need constructors can keep importing from schedule.mjs.
export {
  discoverDueSchedules,
  discoverTickedRows,
  admitSystemMutation,
  startClockTriggers,
  rearmChangedScheduleReceipts,
  clearRemovedScheduleReceipts,
  pruneInactiveScheduleReceipts,
} from './schedule-runtime.mjs';

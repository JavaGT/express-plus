import { createHash } from 'node:crypto';
import { type DbHandle } from './driver.ts';
import { applicationTable as resolveApplicationTable } from './application-table-guard.ts';
import { invalidateDependencies } from './private-action-fact-dependency.ts';

const TOMBSTONE_TYPE = '$workbench.erased';
const TOMBSTONE_ACTION_ID = '$workbench.erased';
const TOMBSTONE_DATA = JSON.stringify({ version: 1 });

interface ErasureCensusRule {
  readonly kind: 'action' | 'event';
  readonly type: string;
  readonly disposition: 'target' | 'retain';
  readonly identityPointers: readonly string[];
}

interface ErasureCensus {
  readonly version: 1;
  readonly rules: readonly ErasureCensusRule[];
}

interface ErasureEventTarget {
  readonly scope: string;
  readonly seq: number;
  readonly actionId: string;
  readonly eventType: string;
  readonly committedAt: string;
  readonly eventDataDigest: string;
}

interface ErasureActionTarget {
  readonly scope: string;
  readonly actionId: string;
  readonly historyOrder: number;
  readonly committedAt: string;
  readonly receiptDigest: string;
  readonly events: readonly ErasureEventTarget[];
}

interface ErasureDirective {
  readonly kind: 'workbench.erasure';
  readonly version: 1;
  readonly owningScope: string;
  readonly subject: string;
  /**
   * v2 typed erasure subject (design §5): the entity kind and row id the
   * directive erases. Present when authored with `erasureSubject`; absent for
   * legacy v1 callers, which cannot certify dependency invalidation.
   */
  readonly erased?: Readonly<{ entity: string; id: string }>;
  readonly actions: readonly ErasureActionTarget[];
  readonly census: ErasureCensus;
}

interface ErasurePreparation {
  readonly owningScope: string;
  readonly subject: string;
  /** Typed subject carried through preparation so the manifest inherits it. */
  readonly erasureSubject?: Readonly<{ entity: string; id: string }>;
  readonly census: ErasureCensus;
}

interface ErasurePreparationWritesCapability {
  insert(table: string, values: Readonly<Record<string, unknown>>): number;
  update(table: string, values: Readonly<Record<string, unknown>>, where: Readonly<Record<string, unknown>>): number;
  delete(table: string, where: Readonly<Record<string, unknown>>): number;
}

interface ErasurePreparationReadsCapability {
  find(table: string, where: Readonly<Record<string, unknown>>): readonly Readonly<Record<string, unknown>>[];
}

interface ReceiptRow {
  scope: string;
  actionId: string;
  actionType: string;
  actionData: string;
  historyOrder: number;
  committedAt: string;
  eventRefs: string;
  principalKey: string;
  sessionId: string;
  operation: string;
  [key: string]: unknown;
}

interface LogRow {
  scope: string;
  seq: number;
  actionId: string;
  eventType: string;
  eventData: string;
  committedAt: string;
  [key: string]: unknown;
}

function fail(message: string): never { throw new TypeError(`invalid erasure directive: ${message}`); }
function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(`${name} must be a non-empty string`);
  return value;
}
function integer(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) fail(`${name} must be a positive safe integer`);
  return value;
}
function keys(value: unknown, allowed: ReadonlySet<string>, name: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${name}.${key} is not allowed`);
}
function digest(value: unknown): string {
  return createHash('sha256').update(value as string).digest('hex');
}
function json(value: unknown, name: string): unknown {
  try { return JSON.parse(value as string); } catch { fail(`${name} must contain JSON`); }
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    if (!Object.isFrozen(value)) Object.freeze(value);
  }
  return value;
}
function expiringView<T>(value: T, open: () => void, revoke: Array<() => void>, seen = new WeakMap<object, unknown>()): T {
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value) as T;
  const source = value as unknown as Record<string, unknown>;
  const target: Record<string, unknown> = {};
  seen.set(value, target);
  for (const key of Object.keys(source)) {
    Object.defineProperty(target, key, {
      enumerable: true,
      get() { open(); return expiringView(source[key], open, revoke, seen); },
    });
  }
  if (Array.isArray(source)) {
    Object.defineProperties(target, {
      length: { get() { open(); return source.length; } },
      [Symbol.iterator]: { get() {
        open();
        return function* iterator() { for (const item of source) yield expiringView(item, open, revoke, seen); };
      } },
    });
  }
  const { proxy: view, revoke: revokeView } = Proxy.revocable(Object.freeze(target), {
    get(target, key, receiver) { open(); return Reflect.get(target, key, receiver); },
  });
  revoke.push(revokeView);
  seen.set(value, view);
  return view as T;
}
function identifier(name: string, label = 'identifier'): string {
  text(name, label);
  return `"${name.replaceAll('"', '""')}"`;
}
function columns(record: unknown, name: string): Array<[string, unknown]> {
  if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).length === 0) {
    fail(`${name} must be a non-empty record`);
  }
  return Object.entries(record as Record<string, unknown>);
}
function identifiers(entries: Array<[string, unknown]>): string { return entries.map(([name]) => identifier(name, 'column')).join(', '); }
function predicate(entries: Array<[string, unknown]>): string { return entries.map(([name]) => `${identifier(name, 'column')} = ?`).join(' AND '); }

/** Transaction-bound authority over explicitly declared application tables. */
function erasurePreparationCapabilities(db: DbHandle, writeTables: string[], readTables: string[]) {
  const allowedWriteTables = new Set(writeTables);
  const allowedReadTables = new Set(readTables);
  let active = true;
  const revoke: Array<() => void> = [];
  const open = (operation: string) => { if (!active) fail(`application ${operation} are available only during erasure preparation`); };
  const safeTable = (table: string, allowedTables: ReadonlySet<string>, operation: 'reads' | 'writes') =>
    resolveApplicationTable(db, table, allowedTables, operation, fail);
  const writes: ErasurePreparationWritesCapability = Object.freeze({
    insert(table: string, values: Readonly<Record<string, unknown>>) {
      open('writes');
      const entries = columns(values, 'values');
      return db.prepare(`INSERT INTO ${safeTable(table, allowedWriteTables, 'writes')} (${identifiers(entries)}) VALUES (${entries.map(() => '?').join(', ')})`)
        .run(...entries.map(([, value]) => value)).changes;
    },
    update(table: string, values: Readonly<Record<string, unknown>>, where: Readonly<Record<string, unknown>>) {
      open('writes');
      const changes = columns(values, 'values'); const filters = columns(where, 'where');
      return db.prepare(`UPDATE ${safeTable(table, allowedWriteTables, 'writes')} SET ${changes.map(([name]) => `${identifier(name, 'column')} = ?`).join(', ')} WHERE ${predicate(filters)}`)
        .run(...changes.map(([, value]) => value), ...filters.map(([, value]) => value)).changes;
    },
    delete(table: string, where: Readonly<Record<string, unknown>>) {
      open('writes');
      const filters = columns(where, 'where');
      return db.prepare(`DELETE FROM ${safeTable(table, allowedWriteTables, 'writes')} WHERE ${predicate(filters)}`)
        .run(...filters.map(([, value]) => value)).changes;
    },
  });
  const reads: ErasurePreparationReadsCapability = Object.freeze({
    find(table: string, where: Readonly<Record<string, unknown>>) {
      open('reads');
      const filters = columns(where, 'where');
      const rows = db.prepare(`SELECT * FROM ${safeTable(table, allowedReadTables, 'reads')} WHERE ${predicate(filters)}`)
        .all(...filters.map(([, value]) => value));
      return Object.freeze(rows.map((row) => expiringView(Object.freeze({ ...row }), () => open('reads'), revoke)));
    },
  });
  return {
    writes, reads,
    view<T>(value: T): T { return expiringView(value, () => open('metadata'), revoke); },
    close() { active = false; for (const revokeView of revoke) revokeView(); },
  };
}
function pointer(value: unknown, path: string): unknown {
  if (path === '') return value;
  if (!path.startsWith('/')) fail(`identity pointer '${path}' must be RFC 6901`);
  let current: unknown = value;
  for (const part of path.slice(1).split('/')) {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function validateRule(rule: unknown, name: string): void {
  keys(rule, new Set(['kind', 'type', 'disposition', 'identityPointers']), name);
  const value = rule as { kind?: unknown; type?: unknown; disposition?: unknown; identityPointers?: unknown };
  if (value.kind !== 'action' && value.kind !== 'event') fail(`${name}.kind must be action or event`);
  text(value.type, `${name}.type`);
  if (value.disposition !== 'target' && value.disposition !== 'retain') fail(`${name}.disposition must be target or retain`);
  if (!Array.isArray(value.identityPointers)) fail(`${name}.identityPointers must be an array`);
  for (const path of value.identityPointers) text(path, `${name}.identityPointers[]`);
}

const ENTITY_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Canonical shape of a typed erasure subject: `{ entity, id }`, identities only. */
export type ErasureSubject = Readonly<{ entity: string; id: string }>;

function validateErasureSubject(subject: unknown, name: string): ErasureSubject {
  keys(subject, new Set(['entity', 'id']), name);
  const value = subject as { entity?: unknown; id?: unknown };
  if (typeof value.entity !== 'string' || !ENTITY_NAME.test(value.entity)) fail(`${name}.entity must be an identifier`);
  if (typeof value.id !== 'string' || value.id.length === 0) fail(`${name}.id must be a non-empty string`);
  return freeze({ entity: value.entity, id: value.id });
}

/** Create a closed, inert declaration for a package-owned transaction erasure. */
export function erasureDirective(input: unknown): Readonly<ErasureDirective> {
  keys(input, new Set(['kind', 'version', 'owningScope', 'subject', 'erased', 'actions', 'census']), 'directive');
  const directive = input as {
    kind?: unknown; version?: unknown; owningScope?: unknown; subject?: unknown; erased?: unknown;
    actions?: unknown; census?: unknown;
  };
  if (directive.kind !== 'workbench.erasure' || directive.version !== 1) fail('kind/version must be workbench.erasure/1');
  text(directive.owningScope, 'owningScope');
  text(directive.subject, 'subject');
  // v2 typed subject is optional for legacy v1 authors; when present it is
  // validated exactly and re-frozen so downstream consumers see canonical shape.
  const erased = directive.erased === undefined ? undefined : validateErasureSubject(directive.erased, 'erased');
  if (!Array.isArray(directive.actions) || directive.actions.length === 0) fail('actions must be a non-empty array');
  const census = directive.census as { version?: unknown; rules?: unknown };
  if (!directive.census || census.version !== 1 || !Array.isArray(census.rules)) fail('census must be version 1 with rules');
  const actions = directive.actions as ErasureActionTarget[];
  for (const [index, action] of actions.entries()) {
    keys(action, new Set(['scope', 'actionId', 'historyOrder', 'committedAt', 'receiptDigest', 'events']), `actions[${index}]`);
    text(action.scope, `actions[${index}].scope`); text(action.actionId, `actions[${index}].actionId`);
    integer(action.historyOrder, `actions[${index}].historyOrder`); text(action.committedAt, `actions[${index}].committedAt`);
    if (!/^[a-f0-9]{64}$/.test(action.receiptDigest)) fail(`actions[${index}].receiptDigest must be SHA-256 hex`);
    if (!Array.isArray(action.events)) fail(`actions[${index}].events must be an array`);
    for (const [eventIndex, event] of action.events.entries()) {
      keys(event, new Set(['scope', 'seq', 'actionId', 'eventType', 'committedAt', 'eventDataDigest']), `actions[${index}].events[${eventIndex}]`);
      text(event.scope, 'event.scope'); integer(event.seq, 'event.seq'); text(event.actionId, 'event.actionId');
      text(event.eventType, 'event.eventType'); text(event.committedAt, 'event.committedAt');
      if (!/^[a-f0-9]{64}$/.test(event.eventDataDigest)) fail('event.eventDataDigest must be SHA-256 hex');
    }
  }
  for (const [index, rule] of (census.rules as readonly ErasureCensusRule[]).entries()) validateRule(rule, `census.rules[${index}]`);
  return freeze({ ...(input as Record<string, unknown>), ...(erased === undefined ? {} : { erased }) }) as Readonly<ErasureDirective>;
}

export function isErasureDirective(value: unknown): value is ErasureDirective {
  return (value as { kind?: unknown } | null | undefined)?.kind === 'workbench.erasure'
    && (value as { version?: unknown } | null | undefined)?.version === 1;
}

/** Declare census inputs without exposing the prepared target manifest to the handler. */
export function erasureDirectivePreparation(input: unknown): Readonly<ErasurePreparation> {
  keys(input, new Set(['owningScope', 'subject', 'erasureSubject', 'census']), 'preparation');
  const preparation = input as ErasurePreparation;
  text(preparation.owningScope, 'owningScope'); text(preparation.subject, 'subject');
  const erasureSubject = preparation.erasureSubject === undefined ? undefined : validateErasureSubject(preparation.erasureSubject, 'erasureSubject');
  const census = preparation.census as { version?: unknown; rules?: unknown };
  if (preparation.census == null || census.version !== 1 || !Array.isArray(census.rules)) fail('census must be version 1 with rules');
  for (const [index, rule] of (census.rules as readonly ErasureCensusRule[]).entries()) validateRule(rule, `census.rules[${index}]`);
  return freeze({ kind: 'workbench.erasure.preparation', version: 1, ...preparation, ...(erasureSubject === undefined ? {} : { erasureSubject }) }) as Readonly<ErasurePreparation>;
}

export function isErasureDirectivePreparation(value: unknown): value is ErasurePreparation {
  return (value as { kind?: unknown } | null | undefined)?.kind === 'workbench.erasure.preparation'
    && (value as { version?: unknown } | null | undefined)?.version === 1;
}

function receiptDigest(row: Record<string, unknown>): string {
  return digest(JSON.stringify({
    actionType: row.actionType, actionData: row.actionData, principalKey: row.principalKey,
    sessionId: row.sessionId, operation: row.operation,
    eventRefs: Array.isArray(row.eventRefs) ? row.eventRefs : json(row.eventRefs, 'receipt event refs'),
  }));
}

function ruleMap(rules: readonly ErasureCensusRule[], kind: 'action' | 'event'): Map<string, ErasureCensusRule> {
  const map = new Map<string, ErasureCensusRule>();
  for (const rule of rules.filter((candidate) => candidate.kind === kind)) {
    if (map.has(rule.type)) fail(`duplicate ${kind} census rule '${rule.type}'`);
    map.set(rule.type, rule);
  }
  return map;
}

function matchesSubject(data: unknown, rule: ErasureCensusRule, subject: string): boolean {
  const values = rule.identityPointers.map((path) => pointer(data, path));
  const matches = values.some((value) => value === subject);
  if (rule.disposition === 'target' && !matches) return false;
  if (rule.disposition === 'retain' && matches) fail(`retain ${rule.kind} '${rule.type}' references the erasure subject`);
  return matches;
}

function censusTargets(db: DbHandle, { owningScope, subject, census }: ErasurePreparation, excludeActionId: string | null): { receipts: ReceiptRow[]; rows: LogRow[]; targetIds: Set<string> } {
  const actionRules = ruleMap(census.rules, 'action');
  const eventRules = ruleMap(census.rules, 'event');
  const receipts = db.prepare('SELECT * FROM _ActionReceipt WHERE scope = ? ORDER BY historyOrder').all(owningScope).filter((receipt) => receipt.actionId !== excludeActionId) as ReceiptRow[];
  const rows = db.prepare('SELECT * FROM _Log WHERE scope = ? ORDER BY seq').all(owningScope).filter((row) => row.actionId !== excludeActionId) as LogRow[];
  const targetIds = new Set<string>();
  for (const receipt of receipts) {
    const rule = actionRules.get(receipt.actionType);
    if (!rule) fail(`missing action census rule '${receipt.actionType}'`);
    if (matchesSubject(json(receipt.actionData, `action '${receipt.actionId}' data`), rule, subject)) targetIds.add(receipt.actionId);
  }
  for (const row of rows) {
    const rule = eventRules.get(row.eventType);
    if (!rule) fail(`missing event census rule '${row.eventType}'`);
    if (matchesSubject(json(row.eventData, `event ${row.scope}/${row.seq} data`), rule, subject)) targetIds.add(row.actionId);
  }
  return { receipts, rows, targetIds };
}

/** Prepare an exact package-owned manifest from the current transaction snapshot. */
export function prepareErasureDirective(db: DbHandle, input: unknown, { excludeActionId = null }: { excludeActionId?: string | null } = {}): Readonly<ErasureDirective> {
  const declared: ErasurePreparation = isErasureDirectivePreparation(input)
    ? { owningScope: input.owningScope, subject: input.subject, census: input.census, ...(input.erasureSubject === undefined ? {} : { erasureSubject: input.erasureSubject }) }
    : (input as ErasurePreparation);
  erasureDirectivePreparation(declared);
  const { receipts, rows, targetIds } = censusTargets(db, declared, excludeActionId);
  if (targetIds.size === 0) fail('structural census found no targets');
  const rowByKey = new Map(rows.map((row) => [`${row.scope}:${row.seq}`, row]));
  const actions: ErasureActionTarget[] = receipts.filter((receipt) => targetIds.has(receipt.actionId)).map((receipt) => {
    const refs = json(receipt.eventRefs, `receipt '${receipt.actionId}' refs`);
    if (!Array.isArray(refs)) fail(`receipt '${receipt.actionId}' refs must be an array`);
    return {
      scope: receipt.scope, actionId: receipt.actionId, historyOrder: receipt.historyOrder,
      committedAt: receipt.committedAt, receiptDigest: receiptDigest(receipt),
      events: refs.map((ref, index): ErasureEventTarget => {
        const reference = ref as { scope?: unknown; seq?: unknown } | null;
        const row = rowByKey.get(`${reference?.scope}:${reference?.seq}`);
        if (!row || row.actionId !== receipt.actionId) fail(`receipt '${receipt.actionId}' has stale event ref at index ${index}`);
        return {
          scope: row.scope, seq: row.seq, actionId: row.actionId, eventType: row.eventType,
          committedAt: row.committedAt, eventDataDigest: digest(row.eventData),
        };
      }),
    };
  });
  if (actions.length !== targetIds.size) fail('structural census target has no owning receipt');
  const { owningScope, subject, census, erasureSubject } = declared;
  return erasureDirective({
    kind: 'workbench.erasure', version: 1, owningScope, subject, census,
    ...(erasureSubject === undefined ? {} : { erased: erasureSubject }),
    actions,
  });
}

/** Apply a validated directive inside an already-open durable transaction. */
export async function applyErasureDirective(db: DbHandle, directive: ErasureDirective, {
  scope, actionId, actionContext, prepare, tables = [], readTables = [],
}: {
  scope: string;
  actionId: string;
  actionContext: unknown;
  prepare?: (context: Readonly<{
    writes: ErasurePreparationWritesCapability;
    reads: ErasurePreparationReadsCapability;
    manifest: Readonly<ErasureDirective>;
    context: Readonly<{ action: unknown; subject: Readonly<{ owningScope: string; id: string }> }>;
  }>) => void | Promise<void>;
  tables?: string[];
  readTables?: string[];
}): Promise<void> {
  erasureDirective(directive);
  if (directive.owningScope !== scope) fail('owningScope must equal request scope');
  if (directive.actions.some((target) => target.scope !== scope || target.actionId === actionId)) {
    fail('targets must remain in the owning scope and cannot include the purge action');
  }

  // The retiring action's events are in this transaction but deliberately not
  // part of its historical erasure manifest.
  const { receipts, rows, targetIds: computedTargets } = censusTargets(db, directive, actionId);
  const targetById = new Map<string, ErasureActionTarget>();
  for (const target of directive.actions) {
    if (targetById.has(target.actionId)) fail(`duplicate target action '${target.actionId}'`);
    targetById.set(target.actionId, target);
  }

  if (computedTargets.size !== targetById.size || [...computedTargets].some((id) => !targetById.has(id))) {
    fail('manifest does not exactly match the structural census target set');
  }

  const receiptById = new Map(receipts.map((receipt) => [receipt.actionId, receipt]));
  const rowByKey = new Map(rows.map((row) => [`${row.scope}:${row.seq}`, row]));
  for (const target of directive.actions) {
    const receipt = receiptById.get(target.actionId);
    if (!receipt || receipt.historyOrder !== target.historyOrder || receipt.committedAt !== target.committedAt || receiptDigest(receipt) !== target.receiptDigest) {
      fail(`stale receipt target '${target.actionId}'`);
    }
    const refs = json(receipt.eventRefs, `receipt '${target.actionId}' refs`);
    if (!Array.isArray(refs) || refs.length !== target.events.length) fail(`event refs differ for '${target.actionId}'`);
    for (let index = 0; index < refs.length; index += 1) {
      const expected = target.events[index];
      const reference = refs[index] as { scope?: unknown; seq?: unknown } | null;
      const row = rowByKey.get(`${reference?.scope}:${reference?.seq}`);
      if (!row || row.scope !== expected.scope || row.seq !== expected.seq || row.actionId !== expected.actionId || row.eventType !== expected.eventType || row.committedAt !== expected.committedAt || digest(row.eventData) !== expected.eventDataDigest) {
        fail(`stale event target '${target.actionId}' at index ${index}`);
      }
    }
  }

  if (prepare !== undefined) {
    const capability = erasurePreparationCapabilities(db, tables, readTables);
    const context = freeze({
      action: actionContext,
      subject: { owningScope: directive.owningScope, id: directive.subject },
    });
    try {
      try {
        await prepare(Object.freeze({
          writes: capability.writes, reads: capability.reads,
          manifest: capability.view(directive), context: capability.view(context),
        }));
      }
      catch { throw new TypeError('erasure preparation failed'); }
    }
    finally { capability.close(); }
  }

  const ids = [...targetById.keys()];
  const tombstone = db.prepare('UPDATE _Log SET eventType = ?, eventData = ?, actionId = ? WHERE scope = ? AND actionId = ?');
  const deleteReceipt = db.prepare('DELETE FROM _ActionReceipt WHERE scope = ? AND actionId = ?');
  const deletePrivateFact = db.prepare('DELETE FROM _PrivateActionFact WHERE scope = ? AND actionId = ?');
  for (const id of ids) {
    tombstone.run(TOMBSTONE_TYPE, TOMBSTONE_DATA, TOMBSTONE_ACTION_ID, scope, id);
    deleteReceipt.run(scope, id);
    deletePrivateFact.run(scope, id);
  }

  // Directive-time prerequisite invalidation (design §5): when the directive
  // carries a v2 typed subject, dependent private facts die BEFORE tombstoning
  // completes so no resurrection capability outlives the erasure. Dependency
  // rows cascade with their facts; the returned rows prune every cursor frame
  // that would still reference an unrestorable contribution — including frames
  // in other scopes whose sessions depended on the erased entity. A legacy
  // directive without a typed subject cannot certify this invalidation and
  // leaves the index alone.
  const invalidated = directive.erased === undefined
    ? []
    : invalidateDependencies(db, { entity: directive.erased.entity, entityId: directive.erased.id });
  const prunedInvalidated = new Set(invalidated.map((row) => `${row.scope}\u0000${row.actionId}`));

  const cursors = db.prepare('SELECT * FROM _HistoryCursor WHERE scope = ?').all(scope);
  const retired = new Set(ids);
  // Invalidation can reach facts outside the erasure scope (the dependency
  // index is global), so prune every affected scope's cursors too.
  const cursorScopes = [...new Set([scope, ...invalidated.map((row) => row.scope)])];
  const updateCursor = db.prepare('UPDATE _HistoryCursor SET past = ?, future = ? WHERE principalKey = ? AND sessionId = ? AND scope = ?');
  const retiredFrame = (cursorScope: string, frame: unknown): boolean => {
    if (typeof frame === 'string') return retired.has(frame);
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return false;
    const entry = frame as Record<string, unknown>;
    // A frame is pruned when its root OR head references a retired action or
    // an invalidated (erasure-dependent) fact — otherwise reconstruction could
    // still offer an Undo whose compensation fact no longer exists. Invalidation
    // keys are scoped to the CURSOR's own scope, never the directive's.
    const rootRetired = typeof entry.rootActionId === 'string'
      && (retired.has(entry.rootActionId) || prunedInvalidated.has(`${cursorScope}\u0000${entry.rootActionId}`));
    const headRetired = typeof entry.headActionId === 'string'
      && (retired.has(entry.headActionId) || prunedInvalidated.has(`${cursorScope}\u0000${entry.headActionId}`));
    return rootRetired || headRetired;
  };
  for (const cursorScope of cursorScopes) {
    const cursorsInScope = cursorScope === scope
      ? cursors
      : db.prepare('SELECT * FROM _HistoryCursor WHERE scope = ?').all(cursorScope);
    for (const cursor of cursorsInScope) {
      const past = (json(cursor.past, 'history cursor past') as unknown[]).filter((frame) => !retiredFrame(cursorScope, frame));
      const future = (json(cursor.future, 'history cursor future') as unknown[]).filter((frame) => !retiredFrame(cursorScope, frame));
      updateCursor.run(JSON.stringify(past), JSON.stringify(future), cursor.principalKey, cursor.sessionId, cursorScope);
    }
  }
}

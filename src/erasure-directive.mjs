import { createHash } from 'node:crypto';
import { frameworkTableNamesWithoutAuthCompile } from './framework-table-names.mjs';

const TOMBSTONE_TYPE = '$workbench.erased';
const TOMBSTONE_ACTION_ID = '$workbench.erased';
const TOMBSTONE_DATA = JSON.stringify({ version: 1 });
const PACKAGE_TABLES = new Set(frameworkTableNamesWithoutAuthCompile.map((name) => name.toLowerCase()));

function fail(message) { throw new TypeError(`invalid erasure directive: ${message}`); }
function text(value, name) {
  if (typeof value !== 'string' || value.length === 0) fail(`${name} must be a non-empty string`);
  return value;
}
function integer(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${name} must be a positive safe integer`);
  return value;
}
function keys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${name}.${key} is not allowed`);
}
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function json(value, name) {
  try { return JSON.parse(value); } catch { fail(`${name} must contain JSON`); }
}
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    if (!Object.isFrozen(value)) Object.freeze(value);
  }
  return value;
}
function expiringView(value, open, revoke, seen = new WeakMap()) {
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  const target = {};
  seen.set(value, target);
  for (const key of Object.keys(value)) {
    Object.defineProperty(target, key, {
      enumerable: true,
      get() { open(); return expiringView(value[key], open, revoke, seen); },
    });
  }
  if (Array.isArray(value)) {
    Object.defineProperties(target, {
      length: { get() { open(); return value.length; } },
      [Symbol.iterator]: { get() {
        open();
        return function* iterator() { for (const item of value) yield expiringView(item, open, revoke, seen); };
      } },
    });
  }
  const { proxy: view, revoke: revokeView } = Proxy.revocable(Object.freeze(target), {
    get(target, key, receiver) { open(); return Reflect.get(target, key, receiver); },
  });
  revoke.push(revokeView);
  seen.set(value, view);
  return view;
}
function identifier(name, label = 'identifier') {
  text(name, label);
  return `"${name.replaceAll('"', '""')}"`;
}
function applicationTable(name, allowedTables, operation) {
  text(name, 'table');
  if (!allowedTables.has(name)) {
    fail(`application ${operation} cannot access undeclared table '${name}'`);
  }
  return identifier(name);
}
function columns(record, name) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).length === 0) {
    fail(`${name} must be a non-empty record`);
  }
  return Object.entries(record);
}
function identifiers(entries) { return entries.map(([name]) => identifier(name, 'column')).join(', '); }
function predicate(entries) { return entries.map(([name]) => `${identifier(name, 'column')} = ?`).join(' AND '); }

/** Transaction-bound authority over explicitly declared application tables. */
function erasurePreparationCapabilities(db, writeTables, readTables) {
  const allowedWriteTables = new Set(writeTables);
  const allowedReadTables = new Set(readTables);
  let active = true;
  const revoke = [];
  const open = (operation) => { if (!active) fail(`application ${operation} are available only during erasure preparation`); };
  const safeTable = (table, allowedTables, operation) => {
    applicationTable(table, allowedTables, operation);
    if (db.prepare('SELECT 1 FROM sqlite_temp_master WHERE lower(name) = lower(?)').get(table)) {
      fail(`application ${operation} cannot access shadowed table '${table}'`);
    }
    const stored = db.prepare("SELECT type FROM sqlite_master WHERE name = ? COLLATE NOCASE AND type IN ('table', 'view')").get(table);
    if (stored?.type !== 'table') fail(`application ${operation} require table '${table}'`);
    const canonical = db.prepare("SELECT name FROM sqlite_master WHERE name = ? COLLATE NOCASE AND type = 'table'").get(table).name;
    if (canonical !== table
      || (canonical.startsWith('_') && !/^_[A-Za-z][A-Za-z0-9_]*$/.test(canonical))
      || canonical.toLowerCase().startsWith('sqlite_')
      || PACKAGE_TABLES.has(canonical.toLowerCase())) {
      fail(`application ${operation} cannot access undeclared table '${table}'`);
    }
    const name = identifier(canonical);
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? COLLATE NOCASE").get(canonical)
      || db.prepare("SELECT 1 FROM sqlite_temp_master WHERE type = 'trigger' AND tbl_name = ? COLLATE NOCASE").get(canonical)) {
      fail(`application ${operation} cannot access triggered table '${table}'`);
    }
    if (operation === 'writes') {
      if (db.prepare(`PRAGMA foreign_key_list(${name})`).get()) {
        fail(`application writes cannot access foreign-key table '${table}'`);
      }
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
      for (const candidate of tables) {
        if (db.prepare(`PRAGMA foreign_key_list(${identifier(candidate.name)})`).all().some((fk) => fk.table.toLowerCase() === canonical.toLowerCase())) {
          fail(`application writes cannot access referenced table '${table}'`);
        }
      }
    }
    return `main.${name}`;
  };
  const writes = Object.freeze({
    insert(table, values) {
      open('writes');
      const entries = columns(values, 'values');
      return db.prepare(`INSERT INTO ${safeTable(table, allowedWriteTables, 'writes')} (${identifiers(entries)}) VALUES (${entries.map(() => '?').join(', ')})`)
        .run(...entries.map(([, value]) => value)).changes;
    },
    update(table, values, where) {
      open('writes');
      const changes = columns(values, 'values'); const filters = columns(where, 'where');
      return db.prepare(`UPDATE ${safeTable(table, allowedWriteTables, 'writes')} SET ${changes.map(([name]) => `${identifier(name, 'column')} = ?`).join(', ')} WHERE ${predicate(filters)}`)
        .run(...changes.map(([, value]) => value), ...filters.map(([, value]) => value)).changes;
    },
    delete(table, where) {
      open('writes');
      const filters = columns(where, 'where');
      return db.prepare(`DELETE FROM ${safeTable(table, allowedWriteTables, 'writes')} WHERE ${predicate(filters)}`)
        .run(...filters.map(([, value]) => value)).changes;
    },
  });
  const reads = Object.freeze({
    find(table, where) {
      open('reads');
      const filters = columns(where, 'where');
      const rows = db.prepare(`SELECT * FROM ${safeTable(table, allowedReadTables, 'reads')} WHERE ${predicate(filters)}`)
        .all(...filters.map(([, value]) => value));
      return Object.freeze(rows.map((row) => expiringView(Object.freeze({ ...row }), () => open('reads'), revoke)));
    },
  });
  return {
    writes, reads,
    view(value) { return expiringView(value, () => open('metadata'), revoke); },
    close() { active = false; for (const revokeView of revoke) revokeView(); },
  };
}
function pointer(value, path) {
  if (path === '') return value;
  if (!path.startsWith('/')) fail(`identity pointer '${path}' must be RFC 6901`);
  let current = value;
  for (const part of path.slice(1).split('/')) {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

function validateRule(rule, name) {
  keys(rule, new Set(['kind', 'type', 'disposition', 'identityPointers']), name);
  if (rule.kind !== 'action' && rule.kind !== 'event') fail(`${name}.kind must be action or event`);
  text(rule.type, `${name}.type`);
  if (rule.disposition !== 'target' && rule.disposition !== 'retain') fail(`${name}.disposition must be target or retain`);
  if (!Array.isArray(rule.identityPointers)) fail(`${name}.identityPointers must be an array`);
  for (const path of rule.identityPointers) text(path, `${name}.identityPointers[]`);
}

/** Create a closed, inert declaration for a package-owned transaction erasure. */
export function erasureDirective(input) {
  keys(input, new Set(['kind', 'version', 'owningScope', 'subject', 'actions', 'census']), 'directive');
  if (input.kind !== 'workbench.erasure' || input.version !== 1) fail('kind/version must be workbench.erasure/1');
  text(input.owningScope, 'owningScope');
  text(input.subject, 'subject');
  if (!Array.isArray(input.actions) || input.actions.length === 0) fail('actions must be a non-empty array');
  if (!input.census || input.census.version !== 1 || !Array.isArray(input.census.rules)) fail('census must be version 1 with rules');
  for (const [index, action] of input.actions.entries()) {
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
  for (const [index, rule] of input.census.rules.entries()) validateRule(rule, `census.rules[${index}]`);
  return freeze(input);
}

export function isErasureDirective(value) { return value?.kind === 'workbench.erasure' && value?.version === 1; }

/** Declare census inputs without exposing the prepared target manifest to the handler. */
export function erasureDirectivePreparation(input) {
  keys(input, new Set(['owningScope', 'subject', 'census']), 'preparation');
  text(input.owningScope, 'owningScope'); text(input.subject, 'subject');
  if (!input.census || input.census.version !== 1 || !Array.isArray(input.census.rules)) fail('census must be version 1 with rules');
  for (const [index, rule] of input.census.rules.entries()) validateRule(rule, `census.rules[${index}]`);
  return freeze({ kind: 'workbench.erasure.preparation', version: 1, ...input });
}

export function isErasureDirectivePreparation(value) {
  return value?.kind === 'workbench.erasure.preparation' && value?.version === 1;
}

function receiptDigest(row) {
  return digest(JSON.stringify({
    actionType: row.actionType, actionData: row.actionData, principalKey: row.principalKey,
    sessionId: row.sessionId, operation: row.operation,
    eventRefs: Array.isArray(row.eventRefs) ? row.eventRefs : json(row.eventRefs, 'receipt event refs'),
  }));
}

function ruleMap(rules, kind) {
  const map = new Map();
  for (const rule of rules.filter((candidate) => candidate.kind === kind)) {
    if (map.has(rule.type)) fail(`duplicate ${kind} census rule '${rule.type}'`);
    map.set(rule.type, rule);
  }
  return map;
}

function matchesSubject(data, rule, subject) {
  const values = rule.identityPointers.map((path) => pointer(data, path));
  const matches = values.some((value) => value === subject);
  if (rule.disposition === 'target' && !matches) return false;
  if (rule.disposition === 'retain' && matches) fail(`retain ${rule.kind} '${rule.type}' references the erasure subject`);
  return matches;
}

function censusTargets(db, { owningScope, subject, census }) {
  const actionRules = ruleMap(census.rules, 'action');
  const eventRules = ruleMap(census.rules, 'event');
  const receipts = db.prepare('SELECT * FROM _ActionReceipt WHERE scope = ? ORDER BY historyOrder').all(owningScope);
  const rows = db.prepare('SELECT * FROM _Log WHERE scope = ? ORDER BY seq').all(owningScope);
  const targetIds = new Set();
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
export function prepareErasureDirective(db, input) {
  const declared = isErasureDirectivePreparation(input)
    ? { owningScope: input.owningScope, subject: input.subject, census: input.census }
    : input;
  erasureDirectivePreparation(declared);
  const { receipts, rows, targetIds } = censusTargets(db, declared);
  if (targetIds.size === 0) fail('structural census found no targets');
  const rowByKey = new Map(rows.map((row) => [`${row.scope}:${row.seq}`, row]));
  const actions = receipts.filter((receipt) => targetIds.has(receipt.actionId)).map((receipt) => {
    const refs = json(receipt.eventRefs, `receipt '${receipt.actionId}' refs`);
    if (!Array.isArray(refs)) fail(`receipt '${receipt.actionId}' refs must be an array`);
    return {
      scope: receipt.scope, actionId: receipt.actionId, historyOrder: receipt.historyOrder,
      committedAt: receipt.committedAt, receiptDigest: receiptDigest(receipt),
      events: refs.map((ref, index) => {
        const row = rowByKey.get(`${ref?.scope}:${ref?.seq}`);
        if (!row || row.actionId !== receipt.actionId) fail(`receipt '${receipt.actionId}' has stale event ref at index ${index}`);
        return {
          scope: row.scope, seq: row.seq, actionId: row.actionId, eventType: row.eventType,
          committedAt: row.committedAt, eventDataDigest: digest(row.eventData),
        };
      }),
    };
  });
  if (actions.length !== targetIds.size) fail('structural census target has no owning receipt');
  return erasureDirective({ kind: 'workbench.erasure', version: 1, ...declared, actions });
}

/** Apply a validated directive inside an already-open durable transaction. */
export async function applyErasureDirective(db, directive, {
  scope, actionId, actionContext, prepare, tables = [], readTables = [],
}) {
  erasureDirective(directive);
  if (directive.owningScope !== scope) fail('owningScope must equal request scope');
  if (directive.actions.some((target) => target.scope !== scope || target.actionId === actionId)) {
    fail('targets must remain in the owning scope and cannot include the purge action');
  }

  const { receipts, rows, targetIds: computedTargets } = censusTargets(db, directive);
  const targetById = new Map();
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
      const expected = target.events[index]; const ref = refs[index]; const row = rowByKey.get(`${ref?.scope}:${ref?.seq}`);
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
  for (const id of ids) { tombstone.run(TOMBSTONE_TYPE, TOMBSTONE_DATA, TOMBSTONE_ACTION_ID, scope, id); deleteReceipt.run(scope, id); }

  const cursors = db.prepare('SELECT * FROM _HistoryCursor WHERE scope = ?').all(scope);
  const retired = new Set(ids);
  const updateCursor = db.prepare('UPDATE _HistoryCursor SET past = ?, future = ? WHERE principalKey = ? AND sessionId = ? AND scope = ?');
  for (const cursor of cursors) {
    const past = json(cursor.past, 'history cursor past').filter((id) => !retired.has(id));
    const future = json(cursor.future, 'history cursor future').filter((id) => !retired.has(id));
    updateCursor.run(JSON.stringify(past), JSON.stringify(future), cursor.principalKey, cursor.sessionId, scope);
  }
}

import { createHash } from 'node:crypto';

const TOMBSTONE_TYPE = '$workbench.erased';
const TOMBSTONE_ACTION_ID = '$workbench.erased';
const TOMBSTONE_DATA = JSON.stringify({ version: 1 });

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
  return Object.freeze(input);
}

export function isErasureDirective(value) { return value?.kind === 'workbench.erasure' && value?.version === 1; }

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

/** Apply a validated directive inside an already-open durable transaction. */
export function applyErasureDirective(db, directive, { scope, actionId }) {
  erasureDirective(directive);
  if (directive.owningScope !== scope) fail('owningScope must equal request scope');
  if (directive.actions.some((target) => target.scope !== scope || target.actionId === actionId)) {
    fail('targets must remain in the owning scope and cannot include the purge action');
  }

  const actionRules = ruleMap(directive.census.rules, 'action');
  const eventRules = ruleMap(directive.census.rules, 'event');
  const receipts = db.prepare('SELECT * FROM _ActionReceipt WHERE scope = ? ORDER BY historyOrder').all(scope);
  const rows = db.prepare('SELECT * FROM _Log WHERE scope = ? ORDER BY seq').all(scope);
  const targetById = new Map();
  for (const target of directive.actions) {
    if (targetById.has(target.actionId)) fail(`duplicate target action '${target.actionId}'`);
    targetById.set(target.actionId, target);
  }

  const computedTargets = new Set();
  for (const receipt of receipts) {
    const rule = actionRules.get(receipt.actionType);
    if (!rule) fail(`missing action census rule '${receipt.actionType}'`);
    if (matchesSubject(json(receipt.actionData, `action '${receipt.actionId}' data`), rule, directive.subject)) computedTargets.add(receipt.actionId);
  }
  for (const row of rows) {
    const rule = eventRules.get(row.eventType);
    if (!rule) fail(`missing event census rule '${row.eventType}'`);
    const matches = matchesSubject(json(row.eventData, `event ${row.scope}/${row.seq} data`), rule, directive.subject);
    if (matches) computedTargets.add(row.actionId);
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

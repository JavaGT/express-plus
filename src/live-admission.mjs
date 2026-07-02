// Subscribe-time admission: validate the subscribe message, bind read scope,
// run mayVerb('subscribe') authorization, and return an admission decision.
//
// Pure authorization logic — no socket I/O, no subscription side effects.
// The caller applies the subscribe confirmation (addSubscription + send).
//
// Exported for use by live-connection.mjs only.

import { anonymous } from './principal.mjs';
import { bindReadScope } from './scope-sql.mjs';
import { mayRow } from './row-grant.mjs';
import { validatePaceSelection } from './field-pace.mjs';

const MAX_SUBS_PER_CONN = 256;
const MAX_ID_LEN = 256;

export async function authorizeSubscription(msg, conn, {
  resolveEntity,
  mayVerb,
  db,
  fanout,
}) {
  if (typeof msg.entity !== 'string' || msg.id === undefined) {
    return { admitted: false, reason: 'subscribe requires entity (string) and id' };
  }
  const idStr = String(msg.id);
  if (idStr.length > MAX_ID_LEN) {
    return { admitted: false, reason: 'subscribe id too long' };
  }
  if (fanout.subscriptionCount(conn) >= MAX_SUBS_PER_CONN && !fanout.hasSubscription(conn, msg.entity, idStr)) {
    return { admitted: false, reason: 'too many subscriptions' };
  }
  if (!resolveEntity || !mayVerb || !db) {
    return { admitted: false, reason: 'forbidden' };
  }
  const entity = resolveEntity(msg.entity);
  if (!entity) {
    return { admitted: false, reason: 'forbidden' };
  }

  let fields = null;
  if (msg.fields !== undefined && msg.fields !== null) {
    if (typeof msg.fields !== 'object' || msg.fields === null || Array.isArray(msg.fields)) {
      return { admitted: false, reason: 'invalid fields interest' };
    }
    if (typeof msg.fields === 'function') {
      return { admitted: false, reason: 'fields interest must be data, not a closure' };
    }
    for (const [key, value] of Object.entries(msg.fields)) {
      if (typeof value === 'function') {
        return { admitted: false, reason: 'fields interest must be data, not a closure' };
      }
      if (!entity.fields || !(key in entity.fields)) {
        return { admitted: false, reason: `unknown field ${key} in interest` };
      }
      if (value !== true) {
        return { admitted: false, reason: 'coordinate narrowing not yet supported' };
      }
    }
    fields = msg.fields;
  }

  let pace = null;
  if (msg.pace !== undefined && msg.pace !== null) {
    try {
      pace = validatePaceSelection('ephemeral', msg.pace);
    } catch (err) {
      return { admitted: false, reason: err.message };
    }
  }

  const principal = conn.principal ?? anonymous;
  const bound = bindReadScope(entity.readScope, principal);
  const where = bound ? bound.sql : '1=1';
  const scopeParams = bound ? bound.params : {};
  let row;
  try {
    row = db
      .prepare(`SELECT * FROM ${entity.name} AS t0 WHERE ${where} AND t0.id = :id`)
      .get({ ...scopeParams, id: idStr });
  } catch {
    return { admitted: false, reason: 'forbidden' };
  }
  if (!row) {
    return { admitted: false, reason: 'forbidden' };
  }
  {
    const hydrated = entity.hydrate ? entity.hydrate(row, principal) : row;
    if (!(await mayRow(entity, 'subscribe', hydrated, principal, mayVerb))) {
      return { admitted: false, reason: 'forbidden' };
    }
  }

  return { admitted: true, entityName: msg.entity, id: msg.id, idStr, fields, pace };
}

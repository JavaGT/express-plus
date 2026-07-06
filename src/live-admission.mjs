// Subscribe-time admission: validate the subscribe message, bind read scope,
// run mayVerb('subscribe') authorization, and return an admission decision.
//
// Pure authorization logic — no socket I/O, no subscription side effects.
// The caller applies the subscribe confirmation (addSubscription + send).
//
// Exported for use by live-connection.mjs only.

import { anonymous } from './principal.mjs';
import { mayRow } from './row-grant.mjs';
import { validatePaceSelection } from './field-pace.mjs';

const MAX_SUBS_PER_CONN = 256;
const MAX_ID_LEN = 256;

export function normalizeSubscribeMsg(msg) {
  if (typeof msg !== 'object' || msg === null) return null;

  if (typeof msg.scope === 'string' && msg.scope.length > 0) {
    const scope = msg.scope;
    const hasExplicitInterest = msg.interest && typeof msg.interest === 'object' && !Array.isArray(msg.interest);
    const interest = hasExplicitInterest ? { ...msg.interest } : {};

    if (!hasExplicitInterest) {
      const colon = scope.indexOf(':');
      if (colon > 0 && colon < scope.length - 1) {
        interest.entity = scope.slice(0, colon);
        interest.id = scope.slice(colon + 1);
      }
    }

    if (interest.fields !== undefined && interest.fields !== null) {
      if (typeof interest.fields !== 'object' || interest.fields === null || Array.isArray(interest.fields) || typeof interest.fields === 'function') {
        interest.fields = null;
      } else {
        for (const [, value] of Object.entries(interest.fields)) {
          if (typeof value === 'function') { interest.fields = null; break; }
        }
      }
    }

    return { scope, interest };
  }

  if (typeof msg.entity === 'string' && msg.id !== undefined) {
    const idStr = String(msg.id);
    const scope = `${msg.entity}:${idStr}`;
    const interest = { entity: msg.entity, id: msg.id };
    if (msg.fields !== undefined && msg.fields !== null) interest.fields = msg.fields;
    if (msg.pace !== undefined && msg.pace !== null) interest.pace = msg.pace;
    return { scope, interest };
  }

  return null;
}

export async function authorizeSubscription(msg, conn, {
  resolveEntity,
  mayVerb,
  db,
  fanout,
}) {
  const normalized = normalizeSubscribeMsg(msg);
  if (!normalized) {
    return { admitted: false, reason: 'subscribe requires entity+id or scope' };
  }

  const { scope, interest } = normalized;
  const entityName = interest.entity;
  const id = interest.id;

  if (typeof entityName !== 'string' || id === undefined) {
    return { admitted: false, reason: 'scope-level subscriptions not yet configured (use entity+id)' };
  }

  const idStr = String(id);
  if (idStr.length > MAX_ID_LEN) {
    return { admitted: false, reason: 'subscribe id too long' };
  }
  if (fanout.subscriptionCount(conn) >= MAX_SUBS_PER_CONN && !fanout.hasSubscription(conn, entityName, idStr)) {
    return { admitted: false, reason: 'too many subscriptions' };
  }
  if (!resolveEntity || !mayVerb || !db) {
    return { admitted: false, reason: 'forbidden' };
  }
  const entity = resolveEntity(entityName);
  if (!entity) {
    return { admitted: false, reason: 'forbidden' };
  }

  let fields = null;
  if (interest.fields !== undefined && interest.fields !== null) {
    if (typeof interest.fields !== 'object' || interest.fields === null || Array.isArray(interest.fields)) {
      return { admitted: false, reason: 'invalid fields interest' };
    }
    if (typeof interest.fields === 'function') {
      return { admitted: false, reason: 'fields interest must be data, not a closure' };
    }
    for (const [key, value] of Object.entries(interest.fields)) {
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
    fields = interest.fields;
  }

  let pace = null;
  if (interest.pace !== undefined && interest.pace !== null) {
    try {
      pace = validatePaceSelection('ephemeral', interest.pace);
    } catch (err) {
      return { admitted: false, reason: err.message };
    }
  }

  const principal = conn.principal ?? anonymous;
  const { sql: where, params: scopeParams } = entity.scopeFilter(principal);
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

  return { admitted: true, scope, entityName, id, idStr, fields, pace, interest };
}

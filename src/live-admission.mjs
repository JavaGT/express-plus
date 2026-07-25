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
import { scopeOf, tryParseScopeKey } from './scope-handle.mjs';
import { failure } from './outcome.mjs';

const MAX_SUBS_PER_CONN = 256;
const MAX_ID_LEN = 256;

function hasAnnotatedText(entity) {
  return Object.values(entity.fields ?? {}).some((field) => field?.kind === 'annotatedText');
}

export function parseSubscribeMsg(msg) {
  if (typeof msg !== 'object' || msg === null) return null;

  if (typeof msg.scope === 'string' && msg.scope.length > 0) {
    const scope = msg.scope;
    const hasExplicitInterest = msg.interest && typeof msg.interest === 'object' && !Array.isArray(msg.interest);
    const interest = hasExplicitInterest ? { ...msg.interest } : {};

    if (!hasExplicitInterest) {
      const handle = tryParseScopeKey(scope);
      if (handle) {
        interest.entity = handle.entity;
        interest.id = handle.id;
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
    const handle = scopeOf(msg.entity, msg.id);
    const interest = { entity: handle.entity, id: handle.id };
    if (msg.fields !== undefined && msg.fields !== null) interest.fields = msg.fields;
    if (msg.pace !== undefined && msg.pace !== null) interest.pace = msg.pace;
    return { scope: handle.key, interest };
  }

  return null;
}

// Validate interest fields and pace against the resolved entity schema.
// Returns { fields, pace } or throws on invalid input.
function buildInterest(interest, entity) {
  let fields = null;
  if (interest.fields !== undefined && interest.fields !== null) {
    if (typeof interest.fields !== 'object' || interest.fields === null || Array.isArray(interest.fields)) {
      throw new Error('Invalid fields interest.');
    }
    if (typeof interest.fields === 'function') {
      throw new Error('Fields interest must be data, not a closure.');
    }
    for (const [key, value] of Object.entries(interest.fields)) {
      if (typeof value === 'function') {
        throw new Error('Fields interest must be data, not a closure.');
      }
      if (!entity.fields || !(key in entity.fields)) {
        throw new Error(`Unknown field ${key} in interest.`);
      }
      if (hasAnnotatedText(entity) && entity.fields[key]?.kind === 'ephemeral') {
        throw new Error('Ephemeral interest is unavailable for annotated-text entities.');
      }
      if (value !== true) {
        throw new Error('Coordinate narrowing is not supported.');
      }
    }
    fields = interest.fields;
  }

  let pace = null;
  if (interest.pace !== undefined && interest.pace !== null) {
    pace = validatePaceSelection('ephemeral', interest.pace);
  }

  return { fields, pace };
}

export async function authorizeSubscription(msg, conn, {
  resolveEntity,
  mayVerb,
  db,
  fanout,
}) {
  const normalized = parseSubscribeMsg(msg);
  if (!normalized) {
    return { admitted: false, failure: failure('invalid-input', 'Subscribe requires entity and id, or a scope.') };
  }

  const { scope, interest } = normalized;
  const entityName = interest.entity;
  const id = interest.id;

  if (typeof entityName !== 'string' || id === undefined) {
    return { admitted: false, failure: failure('invalid-input', 'Scope-level subscriptions are not configured; use entity and id.') };
  }

  const idStr = String(id);
  if (idStr.length > MAX_ID_LEN) {
    return { admitted: false, failure: failure('invalid-input', 'Subscribe id is too long.') };
  }
  if (fanout.subscriptionCount(conn) >= MAX_SUBS_PER_CONN && !fanout.hasSubscription(conn, entityName, idStr)) {
    return { admitted: false, failure: failure('conflict', 'Too many subscriptions are active.') };
  }
  if (!resolveEntity || !mayVerb || !db) {
    throw new Error('Live subscription admission dependencies are unavailable.');
  }
  const entity = resolveEntity(entityName);
  if (!entity) {
    return { admitted: false, failure: failure('denied', 'Forbidden.') };
  }

  const principal = conn.principal ?? anonymous;
  const { sql: where, params: scopeParams } = entity.scopeFilter(principal);
  const row = db
    .prepare(`SELECT * FROM ${entity.name} AS t0 WHERE ${where} AND t0.id = :id`)
    .get({ ...scopeParams, id: idStr });
  if (!row) {
    return { admitted: false, failure: failure('denied', 'Forbidden.') };
  }
  {
    const hydrated = entity.hydrate ? entity.hydrate(row, principal) : row;
    if (!(await mayRow(entity, 'subscribe', hydrated, principal, mayVerb))) {
      return { admitted: false, failure: failure('denied', 'Forbidden.') };
    }
  }

  // Entity-specific validation happens only after row authorization. Otherwise
  // different validation errors reveal which entity names and fields exist.
  let fields, pace;
  try {
    ({ fields, pace } = buildInterest(interest, entity));
  } catch (err) {
    return { admitted: false, failure: failure('invalid-input', err.message || 'Invalid fields or pace selection.') };
  }

  return { admitted: true, scope, entityName, id, idStr, fields, pace, interest };
}

export const normalizeSubscribeMsg = parseSubscribeMsg;

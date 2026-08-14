// Effect runtime — in-transaction effect execution (ADR #6, #22, P6b/P6c).
//
// Effects are declared on entities and compiled by effect-compiler.mjs. This
// module executes them at runtime: resolving target rows, applying `with`
// templates (function or operator-object form), handling `self` and `many`
// targets, and returning target events for the in-txn mutation path.
//
// For P6b Part 1: CRUD-trigger effects only (Note.created/updated/removed). The effect
// fires on the COMMITTED event, re-entering the SAME in-txn event-application path
// as the outer dispatch — NOT via direct mutate.create() (that's the old P6c path).
//
// The effect re-enters as a BOUNDED EFFECT PRINCIPAL:
//   principal({ type: 'system', attributes: { effect: '<sourceEntityName>' } })
//
// The TARGET entity must ADMIT this principal via its grant — a missing admit is a
// LOAD-TIME error (static cycle detection + admission handshake). At RUNTIME, a
// target grant DENY rolls back the ORIGIN (in-txn atomic).

import { principal,                } from './principal.mjs';
import { randomUUID } from 'node:crypto';
import { membershipTable, membershipOwnerCol, MEMBER_COLUMN } from './scope-sql.mjs';
import { scopeOf, tryParseScopeKey } from './scope-handle.mjs';


// ---- Field-plugin operators for `with` templates (P6b Part 1) ----

// inc(n) — read-modify-write: target's own current value + n.
// dec(n) — read-modify-write: target's own current value - n.
// These operators reference ONLY the target's own field value, which the effect
// principal already has authority to mutate. NOT arbitrary cross-entity reads.





export function inc(n        )              {
  return Object.freeze({ kind: 'inc', value: n });
}

export function dec(n        )              {
  return Object.freeze({ kind: 'dec', value: n });
}

// self — target-identity sentinel for in-place mutation (P6c-C).
// When an effect declares `mutate: self`, the effect mutates the origin entity
// itself (emits `:updated`), rather than creating a fresh row in a target entity.


export const self               = Object.freeze({ kind: 'self' });

// The typed entity handle an effect mutates (e.g. `Inbox`). Optional `kind`
// exists only so the `self`/`many` sentinels form one discriminated union.











// many — fan-out effect constructor (P6c-C step 2).
// When an effect declares `mutate: many(Target, { over })`, the effect creates
// one target row per member in the `over` collection (e.g. one Inbox per collaborator).
// Each member gets a fresh UUID targetId (create-only, no upsert).






export function many(target              , { over }                   )               {
  return Object.freeze({ kind: 'many', target, overField: over });
}
















































// ---- Runtime effect execution ----

// Resolve the membership rows for a `many` fan-out effect.
// Returns an array of {id, member} where `id` is a fresh UUID (create-only)
// and `member` carries the member data {id, ...otherCells}.
function resolveManyMembers({ originId, sourceEntityName, db, overFieldName }




 )                  {
  if (!overFieldName || !db) return [];

  const table = membershipTable(sourceEntityName, overFieldName);
  const ownerCol = membershipOwnerCol(sourceEntityName);

  // Select all members for this origin entity
  const rows = db.prepare(`SELECT ${MEMBER_COLUMN} AS member_id, * FROM ${table} WHERE ${ownerCol} = ?`).all(originId);

  // Strip the internal membership columns (member_id, owner FK) from memberData
  return rows.map((r) => {
    const memberData                          = { id: r.member_id };
    for (const [key, val] of Object.entries(r)) {
      if (key !== MEMBER_COLUMN && key !== ownerCol) {
        memberData[key] = val;
      }
    }
    return { id: randomUUID(), member: memberData };
  });
}

// Execute a single effect, creating target entity events.
// Supports effects with mutate: TargetEntity/self and with: function/object.
// Returns array of target events to apply through the in-txn path. Each target
// event carries its EFFECT PRINCIPAL (gap #2: effects run as
// `principal({type:'system', attributes:{effect:<sourceEntityName>}})`, NOT the
// triggering user) so the recursive durable variant authorizes the target event
// against the effect principal. The target's `admitsEffects` is the RUNTIME
// admission gate (gap #3): a deny throws 403 → rolls back the origin (in-txn
// atomic, ADR #6/#22).
//
// P6c-C: inc/dec operators perform read-modify-write using the in-txn db handle.
// P6c-C: self target mutates the origin row (emits :updated) rather than creating fresh.
// P6c-C step 2: `many(Target, {over})` fan-out creates one target row per collection member.








export function executeEffect(effect                   , { triggerEvent, actionId, sourceEntityName, db, overFieldName }                      )                {
  const mutate = effect.mutate;
  const kind = mutate?.kind; // 'self' | 'many' | undefined (plain create)

  // Resolve the REAL target entity:
  // - self: no real target (origin entity itself)
  // - many: target is effect.mutate.target
  // - plain: target is effect.mutate
  const realTarget                                  = mutate && mutate.kind === 'many' ? mutate.target : (mutate && mutate.kind === 'self' ? null : mutate);

  // Extract delta and origin from the trigger event
  const delta = triggerEvent.data || {};
  const originId = tryParseScopeKey(triggerEvent.scope)?.id;
  const origin = { id: originId };

  // Target name: self uses source entity, others use real target's name
  const targetName         = kind === 'self' ? sourceEntityName : (realTarget                ).name          ;

  // The effect principal — a bounded system principal tagged with its source
  // entity. NOT the triggering user, NOT a SYSTEM god-principal (ADR #6).
  const effectPrincipal = principal({
    type: 'system',
    attributes: { effect: sourceEntityName },
  });

  // Runtime admission handshake (gap #3). For self-targets, skip; for others
  // (many + plain create), check admission with realTarget.
  if (kind !== 'self' && realTarget && typeof realTarget.admitsEffects === 'function') {
    const admitted = realTarget.admitsEffects({
      effect: sourceEntityName,
      principal: effectPrincipal,
      delta,
      origin,
    });
    if (!admitted) {
      throw Object.assign(
        new Error(`effect admission denied: target '${targetName}' rejects effect principal from '${sourceEntityName}'`),
        { status: 403 },
      );
    }
  }

  // Resolve target rows to a list:
  // - self: [{id: originId, member: undefined}] (one row, origin exists)
  // - plain create: [{id: randomUUID(), member: undefined}] (one row, does not exist yet)
  // - many: N rows from membership table, each with fresh UUID
  let targetRows                                         ;
  if (kind === 'many') {
    targetRows = resolveManyMembers({ originId, sourceEntityName, db, overFieldName });
  } else if (kind === 'self') {
    targetRows = [{ id: originId          , member: undefined }];
  } else {
    targetRows = [{ id: randomUUID(), member: undefined }];
  }

  // For each resolved target row, resolve `with` + existence probe + emit event
  const events                = [];
  for (const row of targetRows) {
    const { id: rowId, member } = row;

    // Existence probe: does this row already exist?
    // For self, origin exists; for plain create, fresh UUID doesn't exist;
    // for many, each member gets a fresh UUID (create-only, no upsert).
    const existing = db
      ? db.prepare(`SELECT 1 AS hit FROM ${targetName} WHERE id = ?`).get(rowId)
      : null;
    const exists = !!existing?.hit;

    // Resolve the `with` template
    let payload                         ;
    if (typeof effect.with === 'function') {
      // Function form: pass {delta, origin, member} (member is undefined for self/create)
      payload = effect.with({ delta, origin, member });
    } else if (typeof effect.with === 'object') {
      // Operator-interpretation pass for inc/dec RMW
      const isOperatorMarker = (v         )                     =>
        !!v && typeof v === 'object' && ((v                      ).kind === 'inc' || (v                      ).kind === 'dec');
      payload = {};
      for (const [fieldName, value] of Object.entries(effect.with)) {
        if (!isOperatorMarker(value)) {
          payload[fieldName] = value;
          continue;
        }
        // RMW: read current cell in-txn for this specific row
        const currentRowExisting = db
          ? db.prepare(`SELECT ${fieldName} FROM ${targetName} WHERE id = ?`).get(rowId)
          : null;
        const current = Number(currentRowExisting?.[fieldName] ?? 0);
        payload[fieldName] = value.kind === 'inc' ? current + value.value : current - value.value;
      }
    } else {
      payload = {};
    }

    // Determine event type based on existence
    const eventType = exists ? `${targetName}.updated` : `${targetName}.created`;
    const scope = scopeOf(targetName, rowId).key;

    events.push({
      type: eventType,
      scope,
      data: { id: rowId, ...payload },
      _effectSource: sourceEntityName,
      _effectPrincipal: effectPrincipal,
      _parentActionId: actionId,
    });
  }

  return events;
}

// Execute effects for a committed event.
// Returns an array of target events to apply through the caller's durable variant.
// db: the in-txn database handle for RMW reads (P6c-C).






export function executeEffectsForEvent(
  event                    ,
  effectsRegistry                                    ,
  { actionId, db }                                            ,
)                {
  // Find effects registered for this event type
  const eventEffects = effectsRegistry.get(event.type);
  if (!eventEffects || eventEffects.length === 0) {
    return [];
  }

  const allTargetEvents                = [];

  for (const { sourceEntity, effect, overFieldName } of eventEffects) {
    if (effect._stateTransition) {
      const stateTransition = effect._stateTransition;
      const matched = event._stateTransitions?.some((transition) =>
        transition.fieldName === stateTransition.fieldName
        && transition.from === stateTransition.from
        && transition.to === stateTransition.to);
      if (!matched) continue;
    }
    // Check the `when` guard if present
    if (effect.when) {
      try {
        const delta = event.data || {};
        const origin = { id: tryParseScopeKey(event.scope)?.id };
        if (!effect.when({ delta, origin })) {
          continue; // Guard rejected - skip this effect
        }
      } catch {
        continue; // Guard error - skip this effect (fail-not-open)
      }
    }

    // Execute the effect and create target events. `sourceEntity` is the name of
    // the entity whose effect is firing — it becomes the effect principal's
    // `attributes.effect` tag (gap #2) and the source tag for admission (gap #3).
    const targetEvents = executeEffect(effect, {
      triggerEvent: event,
      actionId,
      sourceEntityName: sourceEntity,
      db,
      overFieldName,
    });
    allTargetEvents.push(...targetEvents);
  }

  return allTargetEvents;
}

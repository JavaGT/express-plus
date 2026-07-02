// Effect compiler and runtime — declarative in-transaction effects (ADR #6, #22).
//
// Effects are declared on an entity as a map from trigger handles to `{ mutate, with, when }`:
//   effects: {
//     [Note.created]: { mutate: Inbox, with: ({ delta, origin }) => ({...}) },
//     [native('Doc', 'collaborators', 'added')]: { mutate: Counter, with: { count: inc(1) } },
//   }
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

import { principal } from './principal.mjs';
import { randomUUID } from 'node:crypto';
import { membershipTable, membershipOwnerCol, MEMBER_COLUMN } from './scope-sql.mjs';

// ---- Field-plugin operators for `with` templates (P6b Part 1) ----

// inc(n) — read-modify-write: target's own current value + n.
// dec(n) — read-modify-write: target's own current value - n.
// These operators reference ONLY the target's own field value, which the effect
// principal already has authority to mutate. NOT arbitrary cross-entity reads.

export function inc(n) {
  return Object.freeze({ kind: 'inc', value: n });
}

export function dec(n) {
  return Object.freeze({ kind: 'dec', value: n });
}

// self — target-identity sentinel for in-place mutation (P6c-C).
// When an effect declares `mutate: self`, the effect mutates the origin entity
// itself (emits `:updated`), rather than creating a fresh row in a target entity.

export const self = Object.freeze({ kind: 'self' });

// many — fan-out effect constructor (P6c-C step 2).
// When an effect declares `mutate: many(Target, { over })`, the effect creates
// one target row per member in the `over` collection (e.g. one Inbox per collaborator).
// Each member gets a fresh UUID targetId (create-only, no upsert).
export function many(target, { over }) {
  return Object.freeze({ kind: 'many', target, overField: over });
}

// ---- effect namespace — compound trigger combinators (P6c-C step 3) ----

// Backing store for anyOf symbol → original handles (module lifetime).
const anyOfTriggers = new Map();

// effect.anyOf(...triggers) — mints a Symbol key for compound fan-IN.
// The N original triggers are stored keyed by the symbol, and fanned out
// at registry-build time to N event-type slots.
// VALIDATION: throws if triggers.length <= 0 (fail-closed).
export const effect = Object.freeze({
  anyOf(...triggers) {
    if (triggers.length === 0) {
      throw new Error(
        'effect.anyOf() requires at least one trigger handle — ' +
        'a compound trigger with zero members is meaningless.',
      );
    }
    const sym = Symbol('effect.anyOf');
    anyOfTriggers.set(sym, Object.freeze([...triggers]));
    return sym;
  },
});

// ---- Compile-time validation ----

// Validate an effect declaration at load time.
// Returns { valid: true } or throws a load-time error.
// For Part 1, validates: mutate (typed entity handle), with (fn or object), when? (fn)
export function validateEffectDeclaration(effect, { triggerHandle, sourceEntityName }) {
  if (!effect || typeof effect !== 'object') {
    throw new Error(
      `effect for trigger '${stringifyTrigger(triggerHandle)}' on entity '${sourceEntityName}' ` +
      `must be an object with { mutate, with, when? }.`,
    );
  }

  // mutate: must be a typed entity handle (e.g. Inbox) OR the `self` sentinel OR `many` fan-out
  const isSelf = effect.mutate && typeof effect.mutate === 'object' && effect.mutate.kind === 'self';
  const isMany = effect.mutate && typeof effect.mutate === 'object' && effect.mutate.kind === 'many';
  if (!effect.mutate || typeof effect.mutate !== 'object' || (!effect.mutate.name && !isSelf && !isMany)) {
    throw new Error(
      `effect for trigger '${stringifyTrigger(triggerHandle)}' on entity '${sourceEntityName}' ` +
      `must have 'mutate' as a typed entity handle (e.g. mutate: Inbox), the 'self' sentinel, or 'many' fan-out.`,
    );
  }

  // Validate `many` sentinel: requires target entity with .name and overField descriptor
  if (isMany) {
    if (!effect.mutate.target || !effect.mutate.target.name) {
      throw new Error(
        `effect for trigger '${stringifyTrigger(triggerHandle)}' on entity '${sourceEntityName}' ` +
        `uses 'many' but target entity is missing or has no .name.`,
      );
    }
    if (!effect.mutate.overField || typeof effect.mutate.overField !== 'object') {
      throw new Error(
        `effect for trigger '${stringifyTrigger(triggerHandle)}' on entity '${sourceEntityName}' ` +
        `uses 'many' but 'over' field descriptor is missing or not an object.`,
      );
    }
  }

  // with: must be a function ({delta, origin}) => {...} OR an object with field operators
  if (!effect.with || (typeof effect.with !== 'function' && typeof effect.with !== 'object')) {
    throw new Error(
      `effect for trigger '${stringifyTrigger(triggerHandle)}' on entity '${sourceEntityName}' ` +
      `must have 'with' as a function or object template.`,
    );
  }

  // when (optional): must be a function ({delta, origin}) => boolean
  if (effect.when !== undefined && typeof effect.when !== 'function') {
    throw new Error(
      `effect for trigger '${stringifyTrigger(triggerHandle)}' on entity '${sourceEntityName}' ` +
      `'when' must be a function ({delta, origin}) => boolean.`,
    );
  }

  // Validate the `when` predicate is compilable (only references delta+origin)
  // A non-compilable when (references I/O, external state) is a LOAD-TIME error.
  if (effect.when) {
    validateWhenPredicate(effect.when, { triggerHandle, sourceEntityName });
  }

  return { valid: true, targetEntity: effect.mutate };
}

// Validate a when predicate — developer guardrail, not a security boundary.
// Effect bodies are app-developer code registered at entity declaration time, not
// runtime user input. An attacker who can inject code into the entity declaration
// already controls the process. The regex check is a best-effort lint to catch
// accidental I/O or external state access in a when clause.
function validateWhenPredicate(fn, { triggerHandle, sourceEntityName }) {
  const fnStr = fn.toString();
  // Forbidden patterns: anything that suggests I/O or external scope access
  const forbidden = [
    /\bfetch\s*\(/,
    /\bdb\b(?![_\.])/,  // bare 'db' but not 'db_' or 'db.'
    /\brequire\s*\(/,
    /\bimport\s*\(/,
    /\bprocess\./,
    /\bglobal\./,
  ];
  for (const pattern of forbidden) {
    if (pattern.test(fnStr)) {
      throw new Error(
        `effect 'when' predicate for trigger '${stringifyTrigger(triggerHandle)}' on entity '${sourceEntityName}' ` +
        `references forbidden scope (I/O or external state). 'when' may only reference delta and origin.`,
      );
    }
  }
}

// ---- Runtime depth cap backstop ----

const DEFAULT_MAX_EFFECT_DEPTH = 8;

// Context for effect execution — threads the depth counter.
export function createEffectContext({ maxDepth = DEFAULT_MAX_EFFECT_DEPTH } = {}) {
  return {
    depth: 0,
    maxDepth,
  };
}

// Check if we've exceeded the effect depth cap.
export function checkEffectDepth(context) {
  if (context.depth >= context.maxDepth) {
    throw new Error(
      `Effect reentrancy depth limit exceeded (max: ${context.maxDepth}).\n` +
      `This is a runtime backstop against runaway effect chains (ADR #22).`,
    );
  }
}

// Compile all declared effects for an entity at load time.
// Returns a compiled effects map or null if no effects declared.
export function compileEntityEffects(entityRecord, allEntities) {
  const { name, effects } = entityRecord;
  if (!effects) return null;

  const compiledEffects = new Map();
  const effectGraphEntry = new Set(); // target entities for cycle detection

  // P6c-C step 3: iterate over symbol-keyed effects too (Object.entries skips symbols)
  for (const key of Reflect.ownKeys(effects)) {
    const effect = effects[key];
    // Validate the effect declaration
    const validation = validateEffectDeclaration(effect, {
      triggerHandle: key,
      sourceEntityName: name,
    });

    if (validation.valid) {
      compiledEffects.set(key, effect);

      // Graph edge: self has no edge, many uses .target.name, plain uses .name
      let edgeName;
      if (validation.targetEntity?.kind === 'many') {
        edgeName = validation.targetEntity.target?.name;
      } else if (validation.targetEntity?.name) {
        edgeName = validation.targetEntity.name;
      }
      if (edgeName) {
        effectGraphEntry.add(edgeName);
      }
    }
  }

  return {
    compiledEffects,
    effectGraphEntry,
  };
}

// ---- Runtime effect execution ----

// Resolve the membership rows for a `many` fan-out effect.
// Returns an array of {id, member} where `id` is a fresh UUID (create-only)
// and `member` carries the member data {id, ...otherCells}.
function resolveManyMembers(effect, { originId, sourceEntityName, db, overFieldName }) {
  if (!overFieldName || !db) return [];

  const table = membershipTable(sourceEntityName, overFieldName);
  const ownerCol = membershipOwnerCol(sourceEntityName);

  // Select all members for this origin entity
  const rows = db.prepare(`SELECT ${MEMBER_COLUMN} AS member_id, * FROM ${table} WHERE ${ownerCol} = ?`).all(originId);

  // Strip the internal membership columns (member_id, owner FK) from memberData
  return rows.map((r) => {
    const memberData = { id: r.member_id };
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
function executeEffect(effect, { triggerEvent, now, actionId, sourceEntityName, db, overFieldName }) {
  const kind = effect.mutate?.kind; // 'self' | 'many' | undefined (plain create)

  // Resolve the REAL target entity:
  // - self: no real target (origin entity itself)
  // - many: target is effect.mutate.target
  // - plain: target is effect.mutate
  const realTarget = kind === 'many' ? effect.mutate.target : (kind === 'self' ? null : effect.mutate);

  // Extract delta and origin from the trigger event
  const delta = triggerEvent.data || {};
  const originId = triggerEvent.scope.split(':')[1];
  const origin = { id: originId };

  // Target name: self uses source entity, others use real target's name
  const targetName = kind === 'self' ? sourceEntityName : realTarget.name;

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
  let targetRows;
  if (kind === 'many') {
    targetRows = resolveManyMembers(effect, { originId, sourceEntityName, db, overFieldName });
  } else if (kind === 'self') {
    targetRows = [{ id: originId, member: undefined }];
  } else {
    targetRows = [{ id: randomUUID(), member: undefined }];
  }

  // For each resolved target row, resolve `with` + existence probe + emit event
  const events = [];
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
    let payload;
    if (typeof effect.with === 'function') {
      // Function form: pass {delta, origin, member} (member is undefined for self/create)
      payload = effect.with({ delta, origin, member });
    } else if (typeof effect.with === 'object') {
      // Operator-interpretation pass for inc/dec RMW
      const isOperatorMarker = (v) => v && typeof v === 'object' && (v.kind === 'inc' || v.kind === 'dec');
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
    const scope = `${targetName}:${rowId}`;

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
// depth/maxDepth: recursion tracking to cap runaway chains (ADR #22 runtime backstop).
// db: the in-txn database handle for RMW reads (P6c-C).
export function executeEffectsForEvent(event, effectsRegistry, { now, actionId, depth = 0, maxDepth = 8, db }) {
  // Check depth cap
  if (depth >= maxDepth) {
    throw new Error(
      `Effect reentrancy depth limit exceeded (max: ${maxDepth}). ` +
      `This is a runtime backstop against runaway effect chains (ADR #22).`,
    );
  }

  // Find effects registered for this event type
  const eventEffects = effectsRegistry.get(event.type);
  if (!eventEffects || eventEffects.length === 0) {
    return [];
  }

  const allTargetEvents = [];

  for (const { sourceEntity, effect, overFieldName } of eventEffects) {
    // Check the `when` guard if present
    if (effect.when) {
      try {
        const delta = event.data || {};
        const origin = { id: event.scope.split(':')[1] };
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
      now,
      actionId,
      sourceEntityName: sourceEntity,
      db,
      overFieldName,
    });
    allTargetEvents.push(...targetEvents);
  }

  return allTargetEvents;
}

// Resolve a trigger handle to an event-type string.
// - string → as-is
// - object with .toString → .toString()
// - then :→. normalization iff : present and . absent
function resolveTriggerEventType(handle, { entityRecord }) {
  let eventType;
  if (typeof handle === 'string') {
    eventType = handle;
  } else if (handle && typeof handle.toString === 'function') {
    eventType = handle.toString();
  } else {
    throw new Error(
      `effect trigger handle on entity '${entityRecord.name}' is not a string ` +
      `and has no .toString() — cannot resolve to event type.`,
    );
  }

  // Normalize: some handles use colon form, convert to dot form for matching
  if (eventType.includes(':') && !eventType.includes('.')) {
    eventType = eventType.replace(':', '.');
  }

  return eventType;
}

// Build an effects registry from compiled entities.
// Returns Map<eventType, Array<{sourceEntity, effect}>>
export function buildEffectsRegistry(entities) {
  const registry = new Map();

  for (const entityRecord of entities) {
    const { name, effects } = entityRecord;
    if (!effects) continue;

    // Iterate over BOTH string keys and symbol keys (P6c-C step 3: anyOf)
    for (const key of Reflect.ownKeys(effects)) {
      const effect = effects[key];
      const isSymbol = typeof key === 'symbol';

      // Resolve triggers to event types:
      // - string key: single trigger (existing path)
      // - symbol key: fan-out to N triggers from anyOfTriggers
      const triggerHandles = isSymbol
        ? (anyOfTriggers.has(key) ? anyOfTriggers.get(key) : (() => {
            throw new Error(
              `Effect declaration on entity '${name}' uses an unknown symbol trigger key ` +
              `(did you mean effect.anyOf(...)?).`,
            );
          })())
        : [key];

      // Dedupe resolved event types (so anyOf(X.updated, X.updated) fires once)
      const resolvedEventTypes = new Set();
      for (const handle of triggerHandles) {
        resolvedEventTypes.add(resolveTriggerEventType(handle, { entityRecord }));
      }

      // Resolve overFieldName for `many` effects (shared logic for string + symbol paths)
      let overFieldName = null;
      if (effect.mutate?.kind === 'many') {
        overFieldName = entityRecord.fields
          ? Object.keys(entityRecord.fields).find(
              (k) => entityRecord.fields[k] === effect.mutate.overField,
            )
          : null;
        if (!overFieldName) {
          throw new Error(
            `effect for trigger '${isSymbol ? String(key) : stringifyTrigger(key)}' on entity '${name}' ` +
              `uses 'many' but 'over' does not resolve to a declared field on '${name}'.`,
          );
        }
      }

      // Build the entry ONCE, push to each resolved event-type slot
      const entry = { sourceEntity: name, effect };
      if (overFieldName) entry.overFieldName = overFieldName;

      for (const eventType of resolvedEventTypes) {
        if (!registry.has(eventType)) {
          registry.set(eventType, []);
        }
        registry.get(eventType).push(entry);
      }
    }
  }

  return registry;
}

// Detect structural cycles across all entities' effects.
// effectsGraph: Map<sourceEntityName, Set<targetEntityName>>
export function detectCrossEntityCycles(effectsGraph) {
  const graph = new Map();

  for (const [source, targets] of effectsGraph) {
    if (!graph.has(source)) graph.set(source, new Set());
    for (const target of targets) {
      graph.get(source).add(target);
    }
  }

  // DFS-based cycle detection
  const visited = new Set();
  const recStack = new Set();
  const cyclePath = [];

  function dfs(node) {
    visited.add(node);
    recStack.add(node);
    cyclePath.push(node);

    const neighbors = graph.get(node) || new Set();
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        const cycle = dfs(neighbor);
        if (cycle) return cycle;
      } else if (recStack.has(neighbor)) {
        const cycleStart = cyclePath.indexOf(neighbor);
        return cyclePath.slice(cycleStart).concat([neighbor]);
      }
    }

    cyclePath.pop();
    recStack.delete(node);
    return null;
  }

  for (const node of graph.keys()) {
    if (!visited.has(node)) {
      const cycle = dfs(node);
      if (cycle) {
        throw new Error(
          `Structural cycle detected in effect graph: ${cycle.join(' → ')}. ` +
          `Effects form a directed graph where A→B means A's effect mutates B. ` +
          `A cycle is a load-time error (ADR #22). Break the cycle by removing one effect.`,
        );
      }
    }
  }

  return true;
}

// Verify admission handshake: each effect target must admit effects from its sources.
export function verifyAdmissionHandshake(effectsGraph, allEntities) {
  const errors = [];
  const entityMap = new Map(allEntities.map(e => [e.name, e]));

  for (const [sourceName, targets] of effectsGraph) {
    for (const targetName of targets) {
      const targetEntity = entityMap.get(targetName);
      if (!targetEntity) {
        errors.push(`Target entity '${targetName}' not found for effect from '${sourceName}'`);
        continue;
      }

      const admitsFn = targetEntity.admitsEffects;
      if (!admitsFn) {
        errors.push(
          `entity '${targetName}' has no 'admitsEffects' declaration, but is the target of ` +
          `an effect from '${sourceName}'. Add admitsEffects: ({ effect }) => is.<check>() to the target entity.`,
        );
        continue;
      }

      // Verify the admits function is callable
      if (typeof admitsFn !== 'function') {
        errors.push(
          `entity '${targetName}' admitsEffects is not a function (got ${typeof admitsFn})`,
        );
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Effect admission errors:\n${errors.join('\n')}`);
  }
}

// Build the cross-entity effects graph from a set of entities.
// Returns Map<sourceEntityName, Set<targetEntityName>> — the input shape for
// detectCrossEntityCycles + verifyAdmissionHandshake. A node with no effects (or
// an entity whose effects all use `when` false) still appears as a source if it
// declares effects, so its targets are admitted. Entities without effects are
// absent (a no-op graph → validateEffects is a no-op for an app with no effects,
// zero blast radius for the existing suite).
export function buildEffectsGraph(entities) {
  const graph = new Map();
  for (const entityRecord of entities) {
    const { name, effects } = entityRecord;
    if (!effects) continue;
    const targets = new Set();
    // P6c-C step 3: iterate over symbol-keyed effects too (Object.values skips symbols)
    for (const effect of Reflect.ownKeys(effects).map(k => effects[k])) {
      const tgt = effect && effect.mutate;
      if (tgt) {
        // self: skip (no edge), many: use .target.name, plain: use .name
        if (tgt.name) {
          targets.add(tgt.name);
        } else if (tgt.kind === 'many' && tgt.target?.name) {
          targets.add(tgt.target.name);
        }
      }
    }
    if (targets.size > 0) graph.set(name, targets);
  }
  return graph;
}

// Global validation pass (gap #4). Runs at app boot, AFTER every entity is known,
// to make effect safety load-time-enforced rather than exported-but-uncalled.
// Builds the effects graph, detects structural cycles (A→B→A), and verifies the
// admission handshake (every target declares admitsEffects). A failure throws —
// the app fails to boot, fail-closed (ADR #22). No-op when no effects declared.
export function validateEffects(entities) {
  const graph = buildEffectsGraph(entities);
  if (graph.size === 0) return;
  detectCrossEntityCycles(graph);
  verifyAdmissionHandshake(graph, entities);
}

// ---- Helpers ----

function stringifyTrigger(handle) {
  if (typeof handle === 'string') return handle;
  if (typeof handle === 'symbol') return handle.toString();
  if (handle && typeof handle.toString === 'function') {
    return handle.toString();
  }
  return String(handle);
}

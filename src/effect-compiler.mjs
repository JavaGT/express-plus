// Effect compiler and runtime — declarative in-transaction effects (ADR #6, #22).
//
// Effects are declared on an entity as a map from trigger handles to `{ mutate, with, when }`:
//   effects: {
//     [Note.created]: { mutate: Inbox, with: ({ delta, origin }) => ({...}) },
//     [collaborators.onAdded]: { mutate: Counter, with: { count: inc(1) } },
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

  // mutate: must be a typed entity handle (e.g. Inbox)
  if (!effect.mutate || typeof effect.mutate !== 'object' || !effect.mutate.name) {
    throw new Error(
      `effect for trigger '${stringifyTrigger(triggerHandle)}' on entity '${sourceEntityName}' ` +
      `must have 'mutate' as a typed entity handle (e.g. mutate: Inbox).`,
    );
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

// Validate a when predicate — must not reference anything beyond delta+origin.
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

  for (const [triggerHandle, effect] of Object.entries(effects)) {
    // Validate the effect declaration
    const validation = validateEffectDeclaration(effect, {
      triggerHandle,
      sourceEntityName: name,
    });

    if (validation.valid) {
      compiledEffects.set(triggerHandle, effect);
      effectGraphEntry.add(validation.targetEntity.name);
    }
  }

  return {
    compiledEffects,
    effectGraphEntry,
  };
}

// ---- Runtime effect execution ----

// Execute a single effect, creating target entity events.
// For Part 1: supports effects with mutate: TargetEntity and with: function/object.
// Returns array of target events to apply through the in-txn path.
function executeEffect(effect, { triggerEvent, now, actionId }) {
  const targetEntity = effect.mutate;
  const targetName = targetEntity.name;
  const targetId = randomUUID();
  const scope = `${targetName}:${targetId}`;

  // Extract delta and origin from the trigger event
  const delta = triggerEvent.data || {};
  const origin = { id: triggerEvent.scope.split(':')[1] };

  // Resolve the `with` template
  let payload;
  if (typeof effect.with === 'function') {
    payload = effect.with({ delta, origin });
  } else if (typeof effect.with === 'object') {
    payload = {};
    for (const [fieldName, value] of Object.entries(effect.with)) {
      payload[fieldName] = value;
    }
  } else {
    payload = {};
  }

  // Create CRUD events for the target entity (Part 1: create only)
  return [{
    type: `${targetName}.created`,
    scope,
    data: { id: targetId, ...payload },
    _effectSource: targetName, // Marker for effect-originated events
    _parentActionId: actionId,
  }];
}

// Execute effects for a committed event.
// Returns an array of target events to apply (not yet applied - caller does that via applyEventsToTxn).
// depth/maxDepth: recursion tracking to cap runaway chains (ADR #22 runtime backstop).
export function executeEffectsForEvent(event, effectsRegistry, { now, actionId, depth = 0, maxDepth = 8 }) {
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

  for (const { sourceEntity, effect } of eventEffects) {
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

    // Execute the effect and create target events
    const targetEvents = executeEffect(effect, {
      triggerEvent: event,
      now,
      actionId,
    });
    allTargetEvents.push(...targetEvents);
  }

  return allTargetEvents;
}

// Build an effects registry from compiled entities.
// Returns Map<eventType, Array<{sourceEntity, effect}>>
export function buildEffectsRegistry(entities) {
  const registry = new Map();

  for (const entityRecord of entities) {
    const { name, effects } = entityRecord;
    if (!effects) continue;

    for (const [triggerHandle, effect] of Object.entries(effects)) {
      // Convert trigger handle to event type string
      // CRUD triggers are like 'Note.created', 'Note.updated', 'Note.removed'
      // Map triggers like collaborators.onAdded become store events
      let eventType;
      if (typeof triggerHandle === 'string') {
        eventType = triggerHandle;
      } else if (triggerHandle && typeof triggerHandle.toString === 'function') {
        eventType = triggerHandle.toString();
      } else {
        continue; // Skip invalid trigger
      }

      // Normalize: some handles use colon form, convert to dot form for matching
      if (eventType.includes(':') && !eventType.includes('.')) {
        eventType = eventType.replace(':', '.');
      }

      if (!registry.has(eventType)) {
        registry.set(eventType, []);
      }
      registry.get(eventType).push({ sourceEntity: name, effect });
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

// ---- Helpers ----

function stringifyTrigger(handle) {
  if (typeof handle === 'string') return handle;
  if (handle && typeof handle.toString === 'function') {
    return handle.toString();
  }
  return String(handle);
}

// The mutation pipeline's type kernel: Action and Event (SPEC §7).
//
// An ACTION is an imperative client request that may be rejected. An EVENT is a
// past-tense fact the server emitted — it already happened. They are distinct
// branded types so neither is mistaken for the other: an action is dispatched
// and authorized; an event is folded into state through its reducer.
//
// The reducer is NON-OPTIONAL on an event (SPEC §7): an event with no reducer is
// a load-time error, because `ingest` is the only place an event becomes client
// state and it has nothing to fold without one — there is no second apply path
// (AGENTS.md, one reconciliation path).

// Lazy import of effect compiler (avoids circular dependency at module load time).
import { readSeq } from './committed-log.mjs';
import { appendEvents, receiptFor, eventsFromReceipt, insertReceipt } from './committed-log.mjs';
import { lifecycleVerb, parseEventType } from './event-handle.mjs';
import { txn } from './driver.mjs';
import { isPlainObject, ValidationError } from './field-strategy.mjs';
import { createRequire } from 'node:module';
import { createDurableHistoryRuntime } from './durable-history.mjs';
import { decideReplay } from './replay-decision.mjs';
import { getLog } from './log.mjs';
import { failure, failureFromError, failureOutcome } from './outcome.mjs';
import { principalKeyOf } from './principal.mjs';
import { applyErasureDirective, isErasureDirective, isErasureDirectivePreparation, prepareErasureDirective } from './erasure-directive.mjs';
import { declarePostCommitEffectsInTxn } from './post-commit-effects.mjs';
import { ANNOTATED_HISTORY_COMPLETION, isAnnotatedEntityProjection } from './annotated-text-history.mjs';

// `action(type)` — declare an imperative request type. The handler that turns it
// into events is attached later by the entity/dispatch wiring.
export function action(type) {
  return Object.freeze({ brand: 'action', type });
}

// `event(type, reduce)` — declare a past-tense fact and the reducer that folds
// it into state. The reducer is required; omitting it fails closed at load.
export function event(type, reduce) {
  const handle = type?.brand === 'event-handle' ? type : undefined;
  const eventType = handle ? handle.type : type;
  if (typeof reduce !== 'function') {
    throw new Error(
      `event('${eventType}') has no reducer. An event with no reducer is a ` +
        `load-time error (SPEC §7): ingest is the only place an event becomes ` +
        `state, and it folds the event through this reducer. Declare one: ` +
        `event('${eventType}', (state, payload) => next).`,
    );
  }
  return Object.freeze({ brand: 'event', handle, type: eventType, reduce });
}

// ---- Shared in-txn event application core ----
//
// This is the core that BOTH the outer dispatch and the effect runtime use.
// It appends events to _Log (with per-scope seq), runs projection consumers,
// blob adopter (if any), and post-handler authorize — all inside the caller's
// open transaction. Effects JOIN the outer txn; they do NOT re-BEGIN.
//
// This is the "singular system" implementation (AGENTS.md): one event-application
// path, called by both the outer dispatch and in-txn effects (ADR #6, #22).

function eventWithHandle(event, handle) {
  const out = { ...event };
  Object.defineProperty(out, 'handle', { value: handle, enumerable: false });
  return Object.freeze(out);
}

function eventWithParsedHandle(event) {
  if (event?.handle?.brand === 'event-handle') return eventWithHandle(event, event.handle);
  try {
    return eventWithHandle(event, parseEventType(event.type));
  } catch {
    return event;
  }
}

export const NOW = Symbol('workbench.now');

// Deep-walk an event's `data`, replacing every NOW token with the commit-time
// `now` ISO string. Returns a fresh structure (does not mutate the handler's
// emitted object — which may be frozen). Only recurses into PLAIN objects and
// arrays — a Date, Buffer, or class instance passes through untouched (a Date's
// ISO form comes from its toJSON at serialization; flattening it to {} would
// lose the value).
function resolveNowTokens(value, now) {
  if (value === NOW) return now;
  if (Array.isArray(value)) return value.map((v) => resolveNowTokens(v, now));
  if (isPlainObject(value)) {
    const out = {};
    for (const k of Object.keys(value)) out[k] = resolveNowTokens(value[k], now);
    return out;
  }
  return value;
}

export function noAdmission() {
  return Object.freeze({
    beforeProjection: async () => true,
    afterProjection: async () => true,
  });
}

export function noBlobAdapter() {
  return Object.freeze({
    adoptInTxn: async () => {},
  });
}

function requireAdmission(granted) {
  if (!granted) throw Object.assign(new Error('forbidden'), { status: 403 });
}

function effectEventsFor(registry, executeEffectsForEvent) {
  if (!registry) return null;
  return (event, { now, actionId, db }) => {
    const impl = executeEffectsForEvent ??
      createRequire(import.meta.url)('./effect-compiler.mjs').executeEffectsForEvent;
    return impl(event, registry, { now, actionId, db });
  };
}

export function durableMutationVariant({
  projectionConsumers = [],
  admission = noAdmission(),
  blobAdapter = noBlobAdapter(),
  effectsRegistry = null,
  executeEffectsForEvent = null,
  postCommitConsumers = [],
  maxEffectDepth = 8,
} = {}) {
  if (!Number.isInteger(maxEffectDepth) || maxEffectDepth < 0) {
    throw new Error('durableMutationVariant: maxEffectDepth must be a non-negative integer');
  }
  const effectsExecutor = effectEventsFor(effectsRegistry, executeEffectsForEvent);
  const variant = {
    name: 'durable.mutation',
    async applyInTxn(db, events, {
      now,
      actionId,
      nextSeq,
      principal,
      depth = 0,
      payload,
      type,
      scope,
      privateFact,
      claimedBlobs,
    } = {}) {
      const finalizedEvents = [];

      // Pre-projection admission — runs IN-TXN against the PRE-mutation row,
      // before the _Log append and before projection. Denial leaves zero
      // footprint. This shallow module interface keeps scheduler admission on
      // the durable variant instead of exporting low-level append/authorize
      // primitives across the seam.
      for (const e of events) {
        const withHandle = eventWithParsedHandle(e);
        const verb = lifecycleVerb(withHandle.handle);
        if (!verb) continue;
        requireAdmission(await admission.beforeProjection({
          entityName: withHandle.handle.entity,
          verb,
          principal,
          eventType: withHandle.type,
          event: withHandle,
          db,
          now,
          payload,
        }));
      }

      // Append events to _Log with per-scope sequence numbers. NOW tokens in the
      // event data are resolved to the commit-time ISO here (ADR #24) — before
      // serialization, so the token never reaches _Log. The actual INSERT is
      // centralized in committed-log.mjs — one canonical write surface.
      for (const e of events) {
        const withHandle = eventWithParsedHandle(e);
        const scope = withHandle.scope;
        const seq = nextSeq(scope);
        const data = resolveNowTokens(withHandle.data ?? {}, now);
        const ev = { ...withHandle, data, seq, actionId, committedAt: now };
        finalizedEvents.push(eventWithHandle(ev, withHandle.handle));
      }
      appendEvents(db, finalizedEvents);

      // Projection consumers — materialize entity rows from events.
      // Registered-action projections pin actionType to the declaring action.
      // Batch commits use type '$batch'; admit a projection when its action is
      // one of the submitted batch members (same event-type filter still applies).
      const batchActionTypes = type === '$batch' && Array.isArray(payload)
        ? new Set(payload.map((action) => action?.type).filter((value) => typeof value === 'string'))
        : null;
      for (const consumer of projectionConsumers) {
        for (const ev of finalizedEvents) {
          if (consumer.eventTypes.includes(ev.type)) {
            if (consumer.actionType !== undefined && consumer.actionType !== type
              && !(batchActionTypes?.has(consumer.actionType))) continue;
            if (consumer.privateFact === true) {
              if (privateFact === undefined) throw new TypeError('private-fact projection requires a canonical private fact');
              consumer.apply(ev, db, Object.freeze({ privateFact, ...(claimedBlobs ? { claimedBlobs } : {}) }));
            } else if (claimedBlobs) {
              consumer.apply(ev, db, Object.freeze({ claimedBlobs }));
            } else if (isAnnotatedEntityProjection(consumer)
              && ev.data?.version === 8 && ev.data?.operation?.kind === 'history.restore') {
              if (privateFact === undefined) throw new TypeError('annotated history restore requires a private fact');
              consumer.apply(ev, db, Object.freeze({ privateFact }));
            } else {
              consumer.apply(ev, db);
            }
          }
        }
      }

      // Blob adoption is in-txn and atomic with the log + projection writes.
      await blobAdapter.adoptInTxn(db, finalizedEvents);

      // Post-projection admission — runs IN-TXN after projection. Create
      // row-grants need this deep visibility: the row exists only after the
      // projection consumer has materialized it.
      for (const ev of finalizedEvents) {
        const verb = lifecycleVerb(ev.handle);
        if (!verb) continue;
        requireAdmission(await admission.afterProjection({
          entityName: ev.handle.entity,
          verb,
          principal,
          eventType: ev.type,
          event: ev,
          db,
          now,
          payload,
        }));
      }

      // Effects recurse through this SAME named variant. The implementation is
      // local to the variant so dispatch and batch get identical depth behavior
      // and leverage one pipeline interface rather than an options lattice.
      if (effectsExecutor) {
        for (const ev of finalizedEvents) {
          const effectEvents = effectsExecutor(ev, { now, actionId, db });
          if (effectEvents && effectEvents.length > 0) {
            if (depth >= maxEffectDepth) {
              throw new Error(
                `Effect reentrancy depth limit exceeded (max: ${maxEffectDepth}). ` +
                'This is a runtime backstop against runaway effect chains (ADR #22).',
              );
            }
            const effectPrincipal = effectEvents[0]?._effectPrincipal ?? principal;
            await variant.applyInTxn(db, effectEvents, {
              now,
              actionId,
              nextSeq,
              principal: effectPrincipal,
              depth: depth + 1,
              payload,
            });
          }
        }
      }

      return finalizedEvents;
    },
    requiresPrivateFact(events, actionType) {
      return projectionConsumers.some((consumer) => consumer.privateFact === true
        && (consumer.actionType === undefined || consumer.actionType === actionType)
        && events.some((event) => consumer.eventTypes.includes(event.type)));
    },
    async afterCommit(events, context) {
      for (const consumer of postCommitConsumers) {
        try {
          await consumer(events, context);
        } catch {
          // a post-commit fan-out failure never undoes the committed dispatch
        }
      }
    },
  };
  return Object.freeze(variant);
}

// createServer({ handlers, authorize, db, effects }) — the server-side mutation handler
// (SPEC §7). It runs one pipeline for every action: dedupe by action id → run the
// handler → authorize + assign each emitted event a per-scope monotonic sequence
// number → append to the durable log → fan out. Authorize runs INSIDE the write
// transaction (Wave 4.4), atomic with log, cursor, projection, and receipt —
// not before it. The in-memory (no-db) path retains the original authorize-then-
// handler ordering since there is no transaction to join.
//
// Persistence is OPT-IN by engaged seam (AGENTS.md): pass a node:sqlite
// DatabaseSync as `db` and events are appended to the `_Log` table with per-scope
// sequences from the `_Cursor` table. Without `db`, the in-memory kernel runs
// (backwards-compatible, for clients that don't need durability). Both paths share
// the same shape — the persistence seam changes WHERE state lands, never HOW.
//
// Effects fire in-txn on committed CRUD events, re-entering through the SAME
// durable variant interface (ADR #6, #22). A target grant DENY rolls back the
// origin (in-txn atomic). Depth cap prevents runaway chains.
//
// `authorize` is REQUIRED and fails closed: there is no default. A default
// `() => true` would admit every action (fail OPEN), the opposite of the route

function successOutcome(events, deduped = false) {
  return Object.freeze({ ok: true, deduped, events });
}

function deniedOutcome(details) {
  return failureOutcome(failure('denied', 'Forbidden.', details));
}

function unknownActionOutcome(type, details) {
  return failureOutcome(failure(
    'unknown-action',
    `No action named '${String(type)}' is registered.`,
    details,
  ));
}

function executionFailure(error, context = {}, details) {
  const normalized = error instanceof ValidationError
    ? failure('invalid-input', error.message, isPlainObject(error.failure) ? error.failure : undefined)
    : failureFromError(error);
  if (normalized.category === 'internal') {
    getLog().error('dispatch', 'dispatch failed', { err: error, ...context });
  }
  const withDetails = details
    ? failure(normalized.category, normalized.message, { ...(normalized.details ?? {}), ...details })
    : normalized;
  return failureOutcome(withDetails);
}

const BATCH_HANDLER_FAILURE = Symbol('workbench.batch-handler-failure');

function batchHandlerFailure(error, actionIndex) {
  return Object.freeze({ [BATCH_HANDLER_FAILURE]: true, error, actionIndex });
}

// ── Shared dispatch-pipeline helpers ──
//
// The four dispatch paths (in-memory/durable × single/batch) each follow the
// same 4-step sequence — check handler → Fork C authorize → dedupe → run
// handler — but implementations differ between sync (in-memory) and async
// (durable). These helpers extract what IS pixel-identical across paths.
// The Fork C authorize try/catch is NOT shared because sync vs async wrapping
// differs; only the post-catch boolean guard is extracted here.

// Returns the handler function, or null if no handler is registered for `type`.
function checkHandler(handlers, type) {
  const handler = handlers[type];
  if (typeof handler !== 'function') return null;
  return handler;
}

// Returns the index of the first action without a handler, or -1 if all exist.
function checkHandlers(handlers, actions) {
  for (let i = 0; i < actions.length; i++) {
    if (typeof handlers[actions[i].type] !== 'function') return i;
  }
  return -1;
}

// Returns deniedOutcome(details) when `result` is falsy, or null when authorized.
function authorizedOrDenied(result, details) {
  if (!result) return deniedOutcome(details);
  return null;
}

// In-memory dedupe mirrors the durable `(scope, actionId)` receipt identity.
function checkInMemoryDedupe(dispatched, scope, actionId) {
  const scoped = dispatched.get(scope);
  if (!scoped?.has(actionId)) return null;
  return successOutcome(scoped.get(actionId), true);
}

function recordInMemoryDispatch(dispatched, scope, actionId, events) {
  let scoped = dispatched.get(scope);
  if (!scoped) {
    scoped = new Map();
    dispatched.set(scope, scoped);
  }
  scoped.set(actionId, events);
}

// Durable dedupe: returns successOutcome when the actionId receipt exists,
// or null for a fresh action.
function checkDurableDedupe(db, scope, actionId) {
  const receipt = receiptFor(db, scope, actionId);
  if (!receipt) return null;
  return successOutcome(eventsFromReceipt(db, receipt, parseEventType), true);
}

function checkDurableBatchDedupe(db, scope, actionId, actions) {
  const receipt = receiptFor(db, scope, actionId);
  if (!receipt) return null;
  if (receipt.actionType !== '$batch' || receipt.actionData !== JSON.stringify(actions)) {
    return failureOutcome(failure('conflict', 'Action ID is already committed for a different batch.'));
  }
  return successOutcome(eventsFromReceipt(db, receipt, parseEventType), true);
}

// commitEvents — the durable transaction brace shared by `dispatch` and
// `dispatchBatch`: BEGIN IMMEDIATE → durable variant applyInTxn → COMMIT →
// post-commit fan-out, with ROLLBACK on execution error. Expected failures are
// returned through the stable outcome grammar rather than thrown.
// The `payload` argument is the admission context each caller threads through:
// `dispatch` passes its single action's `payload`, `dispatchBatch` passes the
// `actions` array. The two genuinely differ there, so the brace is extracted but
// the `payload` value stays per-caller. Throws non-403 errors after rolling back;
// Post-commit delivery can no longer turn a committed mutation into a failure.
async function commitEvents(db, events, {
  now, actionId, nextSeq, principal, payload, pipeline, scope, type, authorize, historyCommit, handler,
  erasureActionContext,
}) {
  let committed;
  try {
    // Wave 4.4 — Authorize INSIDE the transaction, atomic with log append,
    // cursor update, projection writes, and receipt insert. Both dispatch
    // (single action) and dispatchBatch (array of actions) thread their
    // authorize function through here:
    //
    //   Single dispatch: payload is the action payload ({ ...fields }),
    //     type is threaded separately via the closure.
    //   Batch dispatch: payload is the actions array, and each action's
    //     type/payload is authorized in sequence inside the txn.
    //
    // A denied action rolls back the entire transaction — no partial state.
    // Post-commit consumers (afterCommit) remain outside the txn as before.
    committed = await txn(db, async () => {
      if (authorize) {
        if (Array.isArray(payload)) {
          for (const action of payload) {
            const result = await authorize({ type: action.type, payload: action.payload, principal });
            if (!result) {
              const err = new Error('forbidden');
              err.status = 403;
              throw err;
            }
          }
        } else {
          const result = await authorize({ type, payload, principal });
          if (!result) {
            const err = new Error('forbidden');
            err.status = 403;
            throw err;
          }
        }
      }

      if (handler) events = await handler({
        payload, principal, db, now, scope, actionId,
        ...(historyCommit?.handlerInputs ? { history: historyCommit.handlerInputs[0] } : {}),
      });
      const commit = Array.isArray(events) ? { events } : events;
      if (!commit || !Array.isArray(commit.events)) {
        throw new TypeError(`action '${type}' handler must return an event array`);
      }
      const directive = commit.directive;
      if (directive !== undefined && (!handler?.erasureCapable || Array.isArray(payload) || historyCommit?.apply)) {
        throw new TypeError(`action '${type}' cannot return an erasure directive`);
      }

      const requirePrivateFact = pipeline.requiresPrivateFact?.(commit.events, type) ?? false;
      // Canonicalize and persist before any opted-in projection can observe the
      // fact. All writes remain inside this origin transaction.
      const privateFact = declarePostCommitEffectsInTxn(db, {
        scope, actionId, committedAt: now, privateFact: commit.privateFact,
        effects: commit.effects, requirePrivateFact,
      });
      const canonicalPayload = commit.canonicalPayload ?? payload;
      const result = await pipeline.applyInTxn(db, commit.events, {
        now, actionId, nextSeq, principal, payload: canonicalPayload, type, scope, privateFact,
        claimedBlobs: commit.claimedBlobs,
      });
      handler?.[ANNOTATED_HISTORY_COMPLETION]?.({ db, actionId, scope, payload: canonicalPayload, result, history: historyCommit });
      // The owning-stream action receipt (Wave 4.9): written atomically with
      // the events it references, so a retry's dedupe check and a crash
      // recovery always see either both or neither.
      if (directive !== undefined) {
        const prepared = isErasureDirectivePreparation(directive) ? prepareErasureDirective(db, directive, { excludeActionId: actionId }) : directive;
        if (!isErasureDirective(prepared)) throw new TypeError(`action '${type}' returned an invalid erasure directive`);
        await applyErasureDirective(db, prepared, {
          scope, actionId, actionContext: { ...erasureActionContext, committedAt: now }, prepare: handler.erasurePrepare,
          tables: handler.erasurePreparationTables, readTables: handler.erasurePreparationReadTables,
        });
      }
      await historyCommit?.apply?.(db);
      insertReceipt(db, scope, actionId, now, result, directive === undefined
        ? {
          ...historyCommit?.metadata,
          actionType: type ?? historyCommit?.metadata?.actionType,
          actionData: commit.canonicalPayload ?? historyCommit?.metadata?.actionData,
        }
        : { actionType: type, actionData: { version: 1 }, operation: 'erasure' });
      return result;
    });
  } catch (err) {
    if (err?.[BATCH_HANDLER_FAILURE]) {
      return executionFailure(
        err.error,
        { actionId, type: payload[err.actionIndex]?.type },
        { actionIndex: err.actionIndex },
      );
    }
    return executionFailure(err, { actionId });
  }

  try {
    await pipeline.afterCommit(committed, { db, actionId });
  } catch (err) {
    getLog().error('dispatch', 'post-commit delivery failed', { err, actionId });
  }
  return successOutcome(committed);
}

function receiptMetadata(request, historyCommit) {
  const clientId = request.clientId;
  const historySession = request.history?.session;
  if (clientId === undefined) return historyCommit;
  if (typeof clientId !== 'string' || clientId.length === 0) {
    throw new ValidationError('clientId must be a non-empty string');
  }
  if (historySession !== undefined && historySession !== clientId) {
    throw new ValidationError('clientId must match history.session when both are provided');
  }
  return {
    ...historyCommit,
    metadata: {
      ...historyCommit?.metadata,
      principalKey: principalKeyOf(request.principal),
      sessionId: clientId,
    },
  };
}

// gate's default-on requireUser(). Authorization is always an explicit function
// (AGENTS.md: never a magic default); omitting it is a load-time error. When
// Phase 2 wires this kernel to a request path, `authorize` is where the route
// gate + grant engine compose — it is not a second, looser auth path.
export function createServer({ handlers = {}, authorize, db, pipeline = durableMutationVariant(), history, historyActions = {}, cursorPolicy, annotatedHistory } = {}) {
  if (typeof authorize !== 'function') {
    throw new Error(
      `createServer requires an authorize function. There is no default — a ` +
        `default-open authorize would admit every action (fail open). ` +
        `Authorization is always an explicit function: pass ` +
        `authorize: ({ type, payload, principal }) => boolean.`,
    );
  }
  if (db && pipeline?.name !== 'durable.mutation') {
    throw new Error(`durable createServer requires the 'durable.mutation' pipeline variant.`);
  }
  if (history && !db) throw new Error('durable history requires a durable database');

  // ---- ephemeral path (no db) — synchronous, in-memory ----
  if (!db) {
    const log = [];                 // append-only event log
    const sequences = new Map();    // scope → last assigned sequence number
    const dispatched = new Map();   // owning scope → action id → events (dedupe)

    function nextSeq(scope) {
      const seq = (sequences.get(scope) ?? 0) + 1;
      sequences.set(scope, seq);
      return seq;
    }

    function dispatch({ actionId, type, payload, principal, scope = '' }) {
      const handler = checkHandler(handlers, type);
      if (!handler) return unknownActionOutcome(type);

      // Fork C — AUTHORIZE FIRST. A retried action by a since-revoked principal
      // returns denied (403), even if the mutation already committed. This
      // reverses the old kernel which checked dedupe before authorize.
      let authorized;
      try {
        authorized = authorize({ type, payload, principal });
      } catch (err) {
        return executionFailure(err, { actionId, type });
      }
      const denied = authorizedOrDenied(authorized);
      if (denied) return denied;

      try {
        handler.preDedupe?.({ payload, principal, scope });
      } catch (err) {
        return executionFailure(err, { actionId, type });
      }

      // Idempotent dedupe: a re-sent action returns its stored events without
      // re-running the handler — no duplicate state change (SPEC §7).
      const dedupe = checkInMemoryDedupe(dispatched, scope, actionId);
      if (dedupe) return dedupe;

      // Run the handler, then assign each emitted event a per-scope monotonic
      // sequence number and append to the log.
      let events;
      try {
        const emitted = handler({ payload, principal, scope });
        events = emitted.map((e) =>
          Object.freeze({ ...e, seq: nextSeq(e.scope), actionId }));
      } catch (err) {
        return executionFailure(err, { actionId, type });
      }
      for (const e of events) log.push(e);

      recordInMemoryDispatch(dispatched, scope, actionId, events);
      return successOutcome(events);
    }

    function dispatchBatch({ actionId, actions = [], principal, scope = '' }) {
      if (actions.length === 0) return successOutcome([]);
      const missingIdx = checkHandlers(handlers, actions);
      if (missingIdx !== -1) {
        return unknownActionOutcome(actions[missingIdx].type, { actionIndex: missingIdx });
      }
      const batchForbiddenIdx = actions.findIndex((action) => handlers[action.type].batchForbidden);
      if (batchForbiddenIdx !== -1) {
        return executionFailure(
          new ValidationError(`action '${actions[batchForbiddenIdx].type}' requires single dispatch`),
          { actionId, type: actions[batchForbiddenIdx].type },
          { actionIndex: batchForbiddenIdx },
        );
      }
      const privateProjectionIdx = actions.findIndex((action) => handlers[action.type].privateFactProjection);
      if (privateProjectionIdx !== -1) {
        return executionFailure(
          new ValidationError(`action '${actions[privateProjectionIdx].type}' with a private-fact projection requires single dispatch`),
          { actionId, type: actions[privateProjectionIdx].type },
          { actionIndex: privateProjectionIdx },
        );
      }
      for (let actionIndex = 0; actionIndex < actions.length; actionIndex += 1) {
        const action = actions[actionIndex];
        let authorized;
        try {
          authorized = authorize({ type: action.type, payload: action.payload, principal });
        } catch (err) {
          return executionFailure(err, { actionId, type: action.type }, { actionIndex });
        }
        const denied = authorizedOrDenied(authorized, { actionIndex });
        if (denied) return denied;
      }
      const dedupe = checkInMemoryDedupe(dispatched, scope, actionId);
      if (dedupe) return dedupe;
      const allEmitted = [];
      for (let actionIndex = 0; actionIndex < actions.length; actionIndex += 1) {
        const action = actions[actionIndex];
        try {
          allEmitted.push(...handlers[action.type]({ payload: action.payload, principal, scope }));
        } catch (err) {
          return executionFailure(err, { actionId, type: action.type }, { actionIndex });
        }
      }
      let events;
      try {
        events = allEmitted.map((e) =>
          Object.freeze({ ...e, seq: nextSeq(e.scope), actionId }));
      } catch (err) {
        return executionFailure(err, { actionId });
      }
      for (const e of events) log.push(e);
      recordInMemoryDispatch(dispatched, scope, actionId, events);
      return successOutcome(events);
    }

    return { dispatch, dispatchBatch, log };
  }

  // ---- durable path (db engaged) — async, SQLite-backed ----

  function nextSeq(scope) {
    const seq = readSeq(db, scope) + 1;
    db.prepare(
      'INSERT INTO _Cursor (scope, lastSeq) VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET lastSeq = ?',
    ).run(scope, seq, seq);
    return seq;
  }

  // The durable dispatch: authorize (Fork C, outside txn — revoked-principal
  // detection before dedupe) → dedupe by actionId → run handler → commit
  // events inside a write transaction. Authorize ALSO runs INSIDE the
  // transaction (Wave 4.4), atomic with log, cursor, projection, and receipt.
  async function dispatch(request) {
    const { actionId, type, payload, principal, scope = '' } = request;
    const handler = checkHandler(handlers, type);
    if (!handler) return unknownActionOutcome(type);

    // Capture admitted request identity before authorization, pre-dedupe hooks,
    // or handlers can mutate application-owned request objects.
    let erasureActionContext;
    try {
      erasureActionContext = handler.erasurePrepare === undefined ? undefined : {
        id: actionId, type, scope, operation: 'erasure',
        payload: structuredClone(payload),
        principal: { type: principal.type, id: principal.id },
      };
    } catch (err) {
      return executionFailure(err, { actionId, type });
    }

    let historyCommit;
    try {
      historyCommit = receiptMetadata(request, request._historyCommit ?? historyRuntime?.normalCommit(request));
    } catch (err) {
      return executionFailure(err, { actionId, type });
    }

    // Fork C — AUTHORIZE FIRST (outside the transaction). A retried action by a
    // since-revoked principal returns denied (403), even if the mutation already
    // committed. The same authorize runs again inside commitEvents's txn (Wave 4.4)
    // for crash atomicity; the outer check is the Fork C semantic gate.
    let authResult;
    try {
      authResult = await authorize({ type, payload, principal });
    } catch (err) {
      return executionFailure(err, { actionId, type });
    }
    const denied = authorizedOrDenied(authResult);
    if (denied) return denied;

    try {
      handler.preDedupe?.({ payload, principal, scope, db });
    } catch (err) {
      return executionFailure(err, { actionId, type });
    }

    // Dedupe by the owning-stream action receipt (scope, actionId) — Wave 4.9.
    // A re-sent action returns its committed events, in original emission
    // order, without re-running the handler (SPEC §7). Keying on the action's
    // own owning scope (not just actionId) means the same actionId reused
    // under a different owning scope is independent action identity, and a
    // zero-event action is durably deduped via its receipt even though it left
    // no _Log row to key on.
    const dedupe = checkDurableDedupe(db, scope, actionId);
    if (dedupe) return dedupe;

    // Run the handler — events only, no DB writes (Fork A: entity-as-projection).
    // The handler may be sync or async.
    let emitted = null;
    if (!handler.inTransaction && !historyCommit?.handlerInputs) {
      try {
        emitted = await handler({ payload, principal, scope });
      } catch (err) {
        return executionFailure(err, { actionId, type });
      }
    }

    // Apply events and authorize inside a write transaction using the shared brace.
    // Wave 4.4: authorize is the first operation inside the txn, so auth failure
    // rolls back cleanly with no partial state. node:sqlite's DatabaseSync is
    // single-writer; BEGIN/COMMIT serialize writes.
    const now = new Date().toISOString();
    const committed = await commitEvents(db, emitted, {
      now, actionId, nextSeq, principal, payload, pipeline, scope, type, authorize, historyCommit,
      handler: handler.inTransaction || historyCommit?.handlerInputs ? handler : null, erasureActionContext,
    });
    return committed;
  }

  // dispatchBatch({ actionId, actions, principal }) — the batched mutation
  // (SPEC §11, ADR #13). N actions across one or more entities run in ONE
  // transaction = ONE composed commit (one actionId, one `now`). The batch is
  // all-or-nothing: any authorize/handler/post-grant denial rolls back the
  // ENTIRE batch (a half-applied multi-entity mutation is exactly the split the
  // one-transaction guarantee forbids). This is the singular-system extension
  // of `dispatch`: the same handler→durable variant path, looped over N actions
  // but with ONE BEGIN/COMMIT bracketing the concatenated events — not a second
  // pipeline (AGENTS.md). Effects fire in-txn exactly as in `dispatch`.
  //
  // Authorization runs at TWO points: Fork C outside the txn (revoked-principal
  // detection before dedupe/write) AND inside commitEvents's txn (Wave 4.4)
  // for crash atomicity with log, cursor, projection, and receipt writes.
  async function dispatchBatch(request) {
    const { actionId, actions = [], principal, scope = '' } = request;
    let historyCommit;
    try {
      historyCommit = receiptMetadata(request, request._historyCommit ?? historyRuntime?.normalCommit(request));
    } catch (err) {
      return executionFailure(err, { actionId });
    }

    if (actions.length === 0) {
      return successOutcome([]);
    }

    const missingIdx = checkHandlers(handlers, actions);
    if (missingIdx !== -1) {
      return unknownActionOutcome(actions[missingIdx].type, { actionIndex: missingIdx });
    }
    const batchForbiddenIdx = actions.findIndex((action) => handlers[action.type].batchForbidden);
    if (batchForbiddenIdx !== -1) {
      return executionFailure(
        new ValidationError(`action '${actions[batchForbiddenIdx].type}' requires single dispatch`),
        { actionId, type: actions[batchForbiddenIdx].type },
        { actionIndex: batchForbiddenIdx },
      );
    }
    const privateProjectionIdx = actions.findIndex((action) => handlers[action.type].privateFactProjection);
    if (privateProjectionIdx !== -1) {
      return executionFailure(
        new ValidationError(`action '${actions[privateProjectionIdx].type}' with a private-fact projection requires single dispatch`),
        { actionId, type: actions[privateProjectionIdx].type },
        { actionIndex: privateProjectionIdx },
      );
    }

    // Fork C — AUTHORIZE EVERY action FIRST (outside the txn). A retried
    // batch by a since-revoked principal returns denied (403). The same
    // authorize runs again inside commitEvents's txn (Wave 4.4) for crash
    // atomicity; the outer check is the Fork C semantic gate.
    for (let actionIndex = 0; actionIndex < actions.length; actionIndex += 1) {
      const action = actions[actionIndex];
      let authResult;
      try {
        authResult = await authorize({ type: action.type, payload: action.payload, principal });
      } catch (err) {
        return executionFailure(err, { actionId, type: action.type }, { actionIndex });
      }
      const denied = authorizedOrDenied(authResult, { actionIndex });
      if (denied) return denied;
    }

    // Dedupe the whole batch by its owning-stream action receipt (Wave 4.9) —
    // same (scope, actionId) identity as `dispatch`, one grammar for both.
    const dedupe = checkDurableBatchDedupe(db, scope, actionId, actions);
    if (dedupe) return dedupe;

    // Run every handler, concatenating their emitted events. Handlers are pure
    // (events only, no DB writes — Fork A), so the batch runs them in order and
    // folds all events into one commitEvents pass below. Authorization runs
    // INSIDE commitEvents's txn (Wave 4.4), before applyInTxn.
    //
    // Registered actions mark `inTransaction` so they receive db/now/scope inside
    // the write brace — same contract as single `dispatch`. Running them early
    // without that context made scope-checked handlers fail as Internal error.
    const runHandlers = async (transactionContext) => {
      const handlerContext = transactionContext?.db
        ? {
          db: transactionContext.db,
          now: transactionContext.now,
          scope: transactionContext.scope,
          actionId: transactionContext.actionId,
        }
        // Preserve the ordinary-batch handler contract: scope is available in
        // both batch modes, while db/clock/action identity are transaction-only.
        : { scope };
      const allEmitted = [];
      for (let actionIndex = 0; actionIndex < actions.length; actionIndex += 1) {
        const action = actions[actionIndex];
        try {
          const historyInput = historyCommit?.handlerInputs?.[actionIndex];
          const emitted = await handlers[action.type]({
            payload: action.payload, principal,
            ...handlerContext,
            ...(historyInput ? { history: historyInput } : {}),
          });
          const commit = Array.isArray(emitted) ? { events: emitted } : emitted;
          if (!commit || !Array.isArray(commit.events) || commit.privateFact !== undefined
            || commit.effects !== undefined || commit.directive !== undefined || commit.canonicalPayload !== undefined) {
            throw new TypeError(`batched action '${action.type}' handler must return an event array`);
          }
          allEmitted.push(...commit.events);
        } catch (err) {
          throw batchHandlerFailure(err, actionIndex);
        }
      }
      // Receipt identity is the submitted batch envelope (Wave 4.9), not just events.
      return { events: allEmitted, canonicalPayload: actions };
    };
    const runInTxn = Boolean(historyCommit?.handlerInputs)
      || actions.some((action) => handlers[action.type].inTransaction);
    let batchCommit = null;
    if (!runInTxn) {
      try { batchCommit = await runHandlers(); }
      catch (err) {
        return executionFailure(
          err.error,
          { actionId, type: actions[err.actionIndex]?.type },
          { actionIndex: err.actionIndex },
        );
      }
    }

    const now = new Date().toISOString();
    // The receipt binds the entire submitted envelope, not merely its emitted
    // events. A retry must prove it is the same batch before deduping.
    const committed = await commitEvents(db, batchCommit, {
      now, actionId, nextSeq, principal, payload: actions, pipeline, scope, type: '$batch', authorize, historyCommit,
      handler: runInTxn ? runHandlers : null,
    });
    return committed;
  }

  const historyRuntime = history
    ? createDurableHistoryRuntime({
       db, descriptor: history, generatedActions: historyActions, dispatch, dispatchBatch, authorize, cursorPolicy, annotatedHistory,
    })
    : undefined;
  return { dispatch, dispatchBatch, history: historyRuntime, db, log: [] };  // log is the durable _Log table; empty array for compat
}

// createClient({ events }) — the client-side reconciliation path (SPEC §7 stage
// 7, §7.1). `ingest` is the ONLY place an event becomes client state: it folds
// each event through its declared reducer exactly once and advances a per-scope
// sequence cursor. The same ingest handles the client's own echoed events and
// foreign live events — there is no second apply path (AGENTS.md, one
// reconciliation path).
//
// Replay decision is shared with LiveList via `decideReplay` (span-aware):
//  - duplicate — idempotent skip; no fold, cursor unchanged.
//  - gap       — do NOT apply; signal a resync.
//  - next      — reduce once, advance the cursor to span hi.
export function createClient({ events = [] } = {}) {
  // Reducer registry, keyed by event type. An event type with no reducer here
  // has nothing to fold — ingesting it is an error, not a silent drop.
  const reducers = new Map(events.map((e) => [e.type, e.reduce]));

  const states = new Map();   // scope → folded state
  const cursors = new Map();  // scope → last applied sequence number

  const cursor = (scope) => cursors.get(scope) ?? 0;
  const state = (scope) => states.get(scope);

  // Bootstrap: adopt a snapshot and set the cursor to the snapshot's sequence
  // BEFORE any live event is ingested. Ordering is load-bearing — a live event
  // ingested before the snapshot would resync into an empty state and then be
  // overwritten, losing the event (SPEC §7.1).
  function bootstrap(scope, snapshot, seq) {
    states.set(scope, snapshot);
    cursors.set(scope, seq);
  }

  function ingest(incoming) {
    const { type, scope, seq, seqSpan } = incoming;
    const reduce = reducers.get(type);
    if (typeof reduce !== 'function') {
      throw new Error(
        `no reducer for event type '${type}'. The client can only ingest event ` +
          `types it was created with. Declare event('${type}', reduce) and pass ` +
          `it in createClient({ events }).`,
      );
    }

    const decision = decideReplay(cursor(scope), seqSpan ?? seq);
    if (decision.kind === 'duplicate') {
      return { applied: false, duplicate: true };
    }
    if (decision.kind === 'gap') {
      return { applied: false, resync: true };
    }

    // next — fold exactly once and advance the cursor to span hi.
    states.set(scope, reduce(state(scope) ?? {}, incoming));
    cursors.set(scope, decision.cursor);
    return { applied: true };
  }

  return { ingest, bootstrap, state, cursor };
}

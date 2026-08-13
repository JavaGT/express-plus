import { eventsFromReceipt, insertReceipt, receiptFor, rowToEvent,                                                                                         } from './committed-log.mjs';
import { readSeq } from './cursor.mjs';
import { parseEventType } from './event-handle.mjs';
import { txn, upsert,               } from './driver.mjs';
import { tryParseScopeKey } from './scope-handle.mjs';

const HISTORY_DESCRIPTOR                = Symbol('workbench.durable-history');

                        
                       
                       
 

                              
                       
                         
 

                      
                       
                    
                
 

                         
                         
                         
                            
                               
                            
                                    
                                  
                             
                               
                                       
 

                            
                        
                            
                         
                           
 

                            
                       
                    
                      
                     
                  
                    
                   
 

                                     
                              
                         
                         
                       
                         
                 
                      
                    
 

                       
                                                           
                                                        
 

                                           
                                         
                                                                                
                                                          
 

                                        
                                                                        
                                                  
 

                          
                
                   
                            
                            
                    
                                     
                                       
                         
 

                                   
                                 
                                    
                                        
                                                                                      
                                                                                                   
 

                          
                                                                                 
                                                                           
                                                                                                                  
                                                             
                                                             
                                                                    
                                                                                                                     
 

                               
                
                    
                                                                
                  
                                 
                                                      
                    
 

                        
                  
                    
                      
 

                                                
                 
                 
 

                                         
                     
                     
 

                                                
                     
                     
                
 

function forbidden()        {
  return Object.assign(new Error('forbidden'), { status: 403 });
}

function conflict(message        )        {
  return Object.assign(new Error(message), { status: 409 });
}

function requireText(value         , name        )         {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function principalKey(principal         )         {
  if (!principal || (principal                                       )?.id == null) throw forbidden();
  const p = principal                                    ;
  return `${p.type ?? 'principal'}:${String(p.id)}`;
}

function parseJson(value         , fallback         )          {
  return value == null ? fallback : typeof value === 'string' ? JSON.parse(value) : value;
}

function historyStack(value         , name        )                 {
  const stack = parseJson(value, []);
  if (!Array.isArray(stack) || stack.some((frame) => !frame || typeof frame !== 'object'
    || typeof frame.rootActionId !== 'string' || !frame.rootActionId
    || typeof frame.headActionId !== 'string' || !frame.headActionId)) {
    throw new TypeError(`malformed history cursor ${name}`);
  }
  return stack;
}

function actionFromRow(db          , row                                         )                {
  const r = row                                      ;
  const receipt = {
    ...r,
    eventRefs: (Array.isArray(r.eventRefs) ? r.eventRefs : parseJson(r.eventRefs, []))              ,
  }                 ;
  return Object.freeze({
    scope: r.scope,
    order: r.historyOrder,
    actionId: r.actionId,
    type: r.actionType,
    payload: parseJson(r.actionData, null),
    principal: r.principalKey,
    session: r.sessionId,
    operation: r.operation,
    committedAt: r.committedAt,
    events: Object.freeze(eventsFromReceipt(db, receipt, parseEventType)),
  })                 ;
}

function privateFactFromReceipt(db          , receipt               )                                    {
  const row = db.prepare(
    'SELECT committedAt, fact FROM _PrivateActionFact WHERE scope = :scope AND actionId = :actionId',
  ).get({ scope: receipt.scope, actionId: receipt.actionId });
  if (!row || row.committedAt !== receipt.committedAt) {
    throw new TypeError('history action private fact is missing or erased');
  }
  let fact         ;
  try { fact = JSON.parse(row.fact          ); } catch { throw new TypeError('history action private fact is malformed'); }
  if (!fact || typeof fact !== 'object' || Array.isArray(fact)) {
    throw new TypeError('history action private fact is malformed');
  }
  return Object.freeze(structuredClone(fact                           ));
}

function translatedActions(value         , operation                 , scope        )                              {
  const name = operation === 'undo' ? 'inverse' : 'redo';
  const wrapper = value && typeof value === 'object' && !Array.isArray(value) ? (value                           ) : null;
  const actions          = wrapper && Object.hasOwn(wrapper, 'actions') ? wrapper.actions : [value];
  const allowedWrapperKeys = wrapper && Object.hasOwn(wrapper, 'actions') ? ['actions'] : ['type', 'payload', 'scope', 'input'];
  if (!wrapper || Object.keys(wrapper).some((key) => !allowedWrapperKeys.includes(key))
    || !Array.isArray(actions) || actions.length === 0) {
    throw new TypeError(`durableHistory ${name} must return one action or a non-empty atomic batch`);
  }
  const normalized = actions.map((action, index) => {
    if (!action || typeof action !== 'object' || Array.isArray(action)
      || typeof action.type !== 'string' || action.type.length === 0
      || Object.keys(action).some((key) => !['type', 'payload', 'scope', 'input'].includes(key))) {
      throw new TypeError(`durableHistory ${name} action ${index} is malformed`);
    }
    if (action.scope !== undefined && action.scope !== scope) {
      throw new TypeError(`durableHistory ${name} must keep the original history scope`);
    }
    return Object.freeze({ type: action.type, payload: action.payload ?? {}, scope, input: action.input });
  });
  return Object.freeze(normalized);
}

function cursorRow(db          , key            , receiptIsEligible                                      , receiptIsBarrier                                      )                     {
  const row = db.prepare(
    `SELECT past, future FROM _HistoryCursor
     WHERE principalKey = :principalKey AND sessionId = :sessionId AND scope = :scope`,
  ).get(key);
  if (row) return { past: historyStack(row.past, 'past'), future: historyStack(row.future, 'future') };
  const receipts = db.prepare(
    `SELECT actionId, actionType, actionData, operation, historyRootActionId, historyTargetActionId FROM _ActionReceipt
     WHERE scope = :scope AND principalKey = :principalKey AND sessionId = :sessionId
     ORDER BY historyOrder`,
  ).all(key)                    ;
  const cursor                     = { past: [], future: [] };
  for (const receipt of receipts) {
      if (receipt.operation === 'action') {
       if (!receiptIsEligible(receipt)) {
         if (receiptIsBarrier(receipt)) cursor.past = [], cursor.future = [];
         continue;
       }
        if (receipt.historyRootActionId && receipt.historyTargetActionId) cursor.past.push({ rootActionId: receipt.historyRootActionId, headActionId: receipt.historyTargetActionId });
        else cursor.past.push({ rootActionId: receipt.actionId, headActionId: receipt.actionId });
       cursor.future = [];
    } else if (receipt.operation === 'undo') {
       const frame = cursor.past.pop();
       if (frame !== undefined) cursor.future.push({ rootActionId: frame.rootActionId, headActionId: receipt.actionId });
    } else if (receipt.operation === 'redo') {
       const frame = cursor.future.pop();
       if (frame !== undefined) cursor.past.push({ rootActionId: frame.rootActionId, headActionId: receipt.actionId });
    } else if (receipt.operation === 'undoToPoint') {
      const sourceActionIds = (parseJson(receipt.actionData, {})                                 ).sourceActionIds;
      if (!Array.isArray(sourceActionIds) || sourceActionIds.some((actionId) => typeof actionId !== 'string')) {
        throw new TypeError('malformed undoToPoint history receipt');
      }
      for (const actionId of sourceActionIds) {
        if (cursor.past.at(-1)?.rootActionId !== actionId) throw new TypeError('undoToPoint history receipt does not match cursor');
        cursor.future.push(cursor.past.pop()                );
      }
    }
  }
  return cursor;
}

function sameCursor(left                    , right                    )          {
  return JSON.stringify(left) === JSON.stringify(right);
}

function writeCursor(db          , key            , cursor                    )       {
  upsert(db, {
    table: '_HistoryCursor',
    keyColumns: ['principalKey', 'sessionId', 'scope'],
    columns: ['past', 'future'],
    values: { ...key, past: JSON.stringify(cursor.past), future: JSON.stringify(cursor.future) },
  });
}

async function admitted(config                                                                          , context                  )                {
  if (!await config.authorize(context)) throw forbidden();
}

export function durableHistory({ authorize, actions = {} }                        = {})                                     {
  if (typeof authorize !== 'function') {
    throw new TypeError('durableHistory requires an authorize function');
  }
  if (!actions || typeof actions !== 'object' || Array.isArray(actions)) {
    throw new TypeError('durableHistory actions must be an object');
  }
  for (const [type, rule] of Object.entries(actions)) {
    if (!rule || typeof rule !== 'object' || typeof rule.inverse !== 'function'
      || typeof rule.redo !== 'function' || Object.keys(rule).some((key) => key !== 'inverse' && key !== 'redo')) {
      throw new TypeError(`durableHistory action '${type}' requires explicit inverse and redo functions`);
    }
  }
  return Object.freeze({ [HISTORY_DESCRIPTOR]: true, authorize, actions: Object.freeze({ ...actions }) });
}

export function createDurableHistoryRuntime({
  db, descriptor, generatedActions = {}, dispatch, dispatchBatch, authorize, cursorPolicy, annotatedHistory = null,
}   
               
                                                          
                                                           
                                                          
                                                               
                                                                       
                                                              
                                                    
 )                 {
  if (!db) throw new Error('durable history requires a durable database');
  if (!descriptor?.[HISTORY_DESCRIPTOR]) {
    throw new TypeError('history must be created with durableHistory(...)');
  }
  const historyDescriptor = descriptor;
  if (cursorPolicy !== undefined) {
    if (!(cursorPolicy instanceof Map)) {
      throw new TypeError('cursorPolicy must be a Map if provided');
    }
    for (const [type, policy] of cursorPolicy) {
      if (typeof type !== 'string' || (policy !== 'eligible' && policy !== 'excluded')) {
        throw new TypeError(`cursorPolicy: invalid policy '${String(policy)}' for action '${type}'`);
      }
    }
  }
  if (!generatedActions || typeof generatedActions !== 'object' || Array.isArray(generatedActions)) {
    throw new TypeError('generated history actions must be an object');
  }
  for (const [type, rule] of Object.entries(generatedActions)) {
    if (!rule || typeof rule !== 'object' || typeof rule.inverse !== 'function' || typeof rule.redo !== 'function') {
      throw new TypeError(`generated history action '${type}' is invalid`);
    }
    if (descriptor.actions[type]) {
      throw new Error(`generated history action '${type}' cannot also declare a durableHistory rule`);
    }
  }
  const resolvedPolicy = cursorPolicy ?? new Map();
  const rules = Object.freeze({ ...generatedActions, ...descriptor.actions });
  const annotatedEntities = annotatedHistory?.entities ?? new Set        ();
  const annotatedActionTypes = annotatedHistory?.actionTypes ?? new Set        ();
  const annotatedMoveActionTypes = annotatedHistory?.moveActionTypes ?? new Set        ();
  const annotatedEligibleAction                                                                   = annotatedHistory?.isEligibleAction ?? (() => false);
  const annotatedCanonicalFact                                                                                 = annotatedHistory?.isCanonicalFact ?? (() => false);
  // Only the package-generated configuration may opt into the annotated move
  // path.  In particular, actionTypes/entities alone must not turn an
  // application-supplied history descriptor into an undo capability.
  const hasAnnotatedMoveCapability = annotatedHistory !== null
    && typeof annotatedHistory?.isEligibleAction === 'function'
    && typeof annotatedHistory?.isCanonicalFact === 'function';

  function isAnnotatedScope(scope        )          {
    return annotatedEntities.has(tryParseScopeKey(scope)?.entity ?? '');
  }

  function receiptContainsAnnotatedText(receipt                                                                                          )          {
    if (annotatedActionTypes.has(receipt.actionType          )) return true;
    if (receipt.actionType === '$batch') {
      let actions         ;
      try { actions = parseJson(receipt.actionData, null); } catch { return true; }
      if (receipt.operation === 'undoToPoint' || (!Array.isArray(actions) && Array.isArray((actions                                            )?.actions))) actions = (actions                                            )?.actions;
      if (!Array.isArray(actions) || actions.some((action) => !action || typeof action.type !== 'string')) return true;
      if (actions.some((action) => annotatedActionTypes.has(action.type))) return true;
    }
    let refs         ;
    try { refs = Array.isArray(receipt.eventRefs) ? receipt.eventRefs : parseJson(receipt.eventRefs, []); } catch { return true; }
    if (!Array.isArray(refs) || refs.some((ref) => !ref || typeof ref.scope !== 'string' || !Number.isSafeInteger(ref.seq) || ref.seq < 1)) return true;
    return refs.some((ref) => isAnnotatedScope(ref.scope));
  }

  function scopeContainsAnnotatedText(scope        )          {
    if (isAnnotatedScope(scope)) return true;
    const receipts = db.prepare('SELECT actionType, actionData, eventRefs FROM _ActionReceipt WHERE scope = :scope').all({ scope });
    return receipts.some(receiptContainsAnnotatedText);
  }

  function requireReadableHistory(scope        )       {
    if (scopeContainsAnnotatedText(scope)) throw forbidden();
  }

  function cursorPolicyFor(type        )                          {
    if (!rules[type]) return 'excluded';
    return resolvedPolicy.get(type) ?? 'eligible';
  }

  function receiptIsEligible(receipt                )          {
    if (receipt.operation !== 'action') return false;
    // Retention redacts actionData while retaining the receipt for dispatch
    // dedupe. A reconstructed cursor must not revive that retired target.
    if (receipt.actionData == null) return false;
     if (receipt.actionType === '$batch') {
       const actions = parseJson(receipt.actionData, null);
       return Array.isArray(actions) && actions.every((action) =>
         action && typeof action.type === 'string' && cursorPolicyFor(action.type) === 'eligible');
     }
     if (annotatedActionTypes.has(receipt.actionType ?? '')) {
       const payload = parseJson(receipt.actionData, null);
        return annotatedEligibleAction({ type: receipt.actionType, payload });
      }
    return typeof receipt.actionType === 'string' && cursorPolicyFor(receipt.actionType) === 'eligible';
  }

  function receiptIsBarrier(receipt                )          {
    if (receipt.operation !== 'action' || !annotatedActionTypes.has(receipt.actionType ?? '') || receipt.actionData == null) return false;
    try { return !annotatedEligibleAction({ type: receipt.actionType, payload: parseJson(receipt.actionData, null) }); } catch { return true; }
  }

  function currentCursor(dbInTxn          , key            )                     {
    return cursorRow(dbInTxn, key, receiptIsEligible, receiptIsBarrier);
  }

  function identity(args              )             {
    return {
      scope: requireText(args.scope, 'scope'),
      sessionId: requireText(args.session, 'session'),
      principalKey: principalKey(args.principal),
    };
  }

  function receiptMetadata(request                     , operation = 'action')                  {
    const session = request.history?.session;
    const historyIdentity = request.history?.identity ?? session;
    return {
      actionType: request.type ?? '$batch',
      actionData: request.type ? request.payload : request.actions,
      principalKey: principalKey(request.principal),
      sessionId: (historyIdentity ?? null)                 ,
      operation,
    };
  }

  function normalCommit(request                     )                                                                     {
    const metadata = receiptMetadata(request);
    if (!request.history?.session || request.principal?.type !== 'user') {
      return { metadata, apply: undefined };
    }
    // Batch: if any action is excluded, exclude cursor entry
    if (request.actions) {
       const allEligible = request.actions.every(
         (action) => annotatedActionTypes.has(action.type ?? '') ? annotatedEligibleAction(action) : cursorPolicyFor(action.type ?? '') === 'eligible',
       );
      if (!allEligible) return { metadata, apply: undefined };
     } else if (annotatedActionTypes.has(request.type ?? '') ? !annotatedEligibleAction(request) : cursorPolicyFor(request.type ?? '') === 'excluded') {
       if (annotatedActionTypes.has(request.type ?? '') && request.history?.session && request.principal?.type === 'user') {
         const key = identity({ scope: request.scope, session: request.history.identity ?? request.history.session, principal: request.principal });
         return { metadata, apply(dbInTxn          ) { writeCursor(dbInTxn, key, { past: [], future: [] }); } };
       }
       return { metadata, apply: undefined };
    }
    const key = identity({ scope: request.scope, session: request.history.identity ?? request.history.session, principal: request.principal });
    const expected = currentCursor(db, key);
    metadata.historyRootActionId = request.actionId;
    metadata.historyTargetActionId = request.actionId;
    return {
      metadata,
      apply(dbInTxn          ) {
        const current = currentCursor(dbInTxn, key);
        if (!sameCursor(current, expected)) throw new Error('history cursor changed during dispatch');
        writeCursor(dbInTxn, key, { past: [...current.past, { rootActionId: request.actionId ?? '', headActionId: request.actionId ?? '' }], future: [] });
      },
    };
  }

  async function actions(args                  = {})                                    {
    const { scope, principal, after = 0, limit = 100 } = args;
    const scopeText = requireText(scope, 'scope');
    await admitted(historyDescriptor, { operation: 'read', scope, principal });
    requireReadableHistory(scopeText);
    if (!Number.isInteger(after) || after < 0) throw new TypeError('after must be a non-negative integer');
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('limit must be an integer from 1 to 1000');
    return db.prepare(`SELECT * FROM _ActionReceipt WHERE scope = :scope AND historyOrder > :after ORDER BY historyOrder LIMIT :limit`)
      .all({ scope: scopeText, after, limit }).map((row) => actionFromRow(db, row));
  }

  async function events(args                  = {})                               {
    const { scope, principal, after = 0, limit = 100 } = args;
    const scopeText = requireText(scope, 'scope');
    await admitted(historyDescriptor, { operation: 'read', scope, principal });
    requireReadableHistory(scopeText);
    if (!Number.isInteger(after) || after < 0) throw new TypeError('after must be a non-negative integer');
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('limit must be an integer from 1 to 1000');
    return db.prepare('SELECT * FROM _Log WHERE scope = :scope AND seq > :after ORDER BY seq LIMIT :limit')
      .all({ scope: scopeText, after, limit }).map((row) => rowToEvent(row                         , parseEventType));
  }

  function revision(value                    )         {
  return JSON.stringify(value);
  }

  async function cursor(args               = {})                                                                      {
    const key = identity(args);
    await admitted(historyDescriptor, { operation: 'read', scope: key.scope, session: args.session, principal: args.principal });
    const value = currentCursor(db, key);
    const result                                                   = { undo: value.past.length, redo: value.future.length, revision: '' };
    Object.defineProperty(result, 'revision', { value: revision(value), enumerable: true });
    return Object.freeze(result);
  }

  async function move(operation                 , args           = {})                   {
    const key = identity(args);
    await admitted(historyDescriptor, { operation, scope: key.scope, session: args.session, principal: args.principal });
    const operationId = requireText(args.actionId, 'actionId');
    const expectedRevision = requireText(args.revision, 'revision');
    const retry = receiptFor(db, key.scope, operationId);
    if (retry) {
      if (retry.operation !== operation || retry.principalKey !== key.principalKey || retry.sessionId !== key.sessionId) {
        throw conflict('history action id is already bound to another operation');
      }
      // A package-owned annotated v8 move must still pass the ordinary action
      // authorization on retry.  Do this before resolving or returning events;
      // generic receipt retries retain their existing behavior.
      if (hasAnnotatedMoveCapability && annotatedMoveActionTypes.has(retry.actionType          )) {
        let payload         ;
        try { payload = parseJson(retry.actionData, null); } catch { throw forbidden(); }
        const action = { type: retry.actionType, payload };
        if (!await authorize({ ...action, principal: args.principal })) throw forbidden();
      }
      const retried                                                                                  = { ok: true, deduped: true, events: Object.freeze(eventsFromReceipt(db, retry, parseEventType)) };
      if (retry.actionType === '$history.empty') retried.empty = true;
      return Object.freeze(retried);
    }
    const expected = currentCursor(db, key);
    if (expectedRevision !== revision(expected)) throw conflict('history cursor is stale');
    if (scopeContainsAnnotatedText(key.scope) && !hasAnnotatedMoveCapability) throw forbidden();
    // Annotated text has one narrow package-owned move path.  Public history
    // reads and all other annotated scopes remain forbidden.
    const source = operation === 'undo' ? expected.past : expected.future;
    const targetFrame = source[source.length - 1];
    const targetId = targetFrame?.headActionId;
    if (!targetFrame) {
      const now = new Date().toISOString();
      await txn(db, async () => {
        await admitted(historyDescriptor, { operation, scope: key.scope, session: args.session, principal: args.principal });
        const current = currentCursor(db, key);
        if (!sameCursor(current, expected)) throw conflict('history cursor changed during dispatch');
        insertReceipt(db, key.scope, operationId, now, [], {
          actionType: '$history.empty', actionData: { version: 1 }, principalKey: key.principalKey,
          sessionId: key.sessionId, operation,
        });
      });
      return Object.freeze({ ok: true, deduped: false, events: [], empty: true });
    }
    const originReceipt = receiptFor(db, key.scope, targetFrame.rootActionId);
    const receipt = receiptFor(db, key.scope, targetId ?? '');
    if (!originReceipt || !receipt) throw new Error(`history action '${targetId}' is no longer retained`);
    const origin = actionFromRow(db, originReceipt);
    const action = actionFromRow(db, receipt);
    const annotatedMove = hasAnnotatedMoveCapability && annotatedMoveActionTypes.has(origin.type ?? '');
    if (annotatedMove && (!annotatedEligibleAction(origin))) throw forbidden();
    if (scopeContainsAnnotatedText(key.scope) && !annotatedMove) throw forbidden();
    if (receiptContainsAnnotatedText(receipt) && !annotatedMove) throw forbidden();
    const rule = rules[origin.type ?? ''];
    if (!rule) throw conflict(`history action '${origin.type}' is not undoable`);
    // Re-authorize the original canonical action before private material is
    // loaded or supplied to application translation code.
    if (!await authorize({ type: origin.type, payload: origin.payload, principal: args.principal })) throw forbidden();
    const originFact = privateFactFromReceipt(db, originReceipt);
    const targetFact = originReceipt.actionId === receipt.actionId ? originFact : annotatedMove ? privateFactFromReceipt(db, receipt) : originFact;
    if (!annotatedMove && (!Object.hasOwn(originFact, 'before') || !Object.hasOwn(originFact, 'after'))) {
      throw new TypeError('history action private fact is malformed');
    }
    if (annotatedMove && !annotatedCanonicalFact({ type: origin.type, payload: origin.payload, fact: originFact })) throw forbidden();
    if (annotatedMove && originReceipt.actionId !== receipt.actionId) {
      const linkage = (targetFact?.linkage ?? null)                                                                                                       ;
      if (targetFact?.version !== 2 || targetFact.kind !== 'annotated-text.compensation'
        || targetFact.documentId !== (origin.payload                                       )?.id
        || linkage?.rootActionId !== targetFrame.rootActionId
        || linkage?.targetActionId !== receipt.historyTargetActionId
        || linkage?.direction !== receipt.operation
        || !['applied', 'noop'].includes(linkage?.outcome          )) throw forbidden();
    }
    const translate = operation === 'undo' ? rule.inverse : rule.redo;
    const translated = translatedActions(
      await translate({ operation, origin, target: action, targetFact, action: origin, fact: annotatedMove ? (operation === 'undo' ? originFact : targetFact) : originFact, principal: args.principal, session: args.session }), operation, key.scope,
    );
    if (translated.some((child) => annotatedActionTypes.has(child.type)) && !annotatedMove) throw forbidden();
    const receiptAction = translated.length === 1 ? translated[0] : null;
    const transition = {
      handlerInputs: Object.freeze(translated.map((child) => Object.freeze({
        operation,
        input: child.input,
      }))),
      metadata: {
        actionType: receiptAction?.type ?? '$batch',
        actionData: receiptAction?.payload ?? translated.map(({ type, payload }) => ({ type, payload })),
        principalKey: key.principalKey,
        sessionId: key.sessionId,
        operation,
        historyRootActionId: targetFrame.rootActionId,
        historyTargetActionId: targetFrame.headActionId,
        historyOutcome: 'pending',
      },
      async apply(dbInTxn          )                {
        await admitted(historyDescriptor, { operation, scope: key.scope, session: args.session, principal: args.principal, action });
        if (!await authorize({ type: action.type, payload: action.payload, principal: args.principal })) throw forbidden();
        privateFactFromReceipt(dbInTxn, annotatedMove ? receipt : originReceipt);
        const current = currentCursor(dbInTxn, key);
        if (!sameCursor(current, expected)) throw new Error('history cursor changed during dispatch');
        const past = [...current.past];
        const future = [...current.future];
        if (operation === 'undo') {
          const frame = past.pop()                ;
          future.push({ rootActionId: frame.rootActionId, headActionId: operationId });
        } else {
          const frame = future.pop()                ;
          past.push({ rootActionId: frame.rootActionId, headActionId: operationId });
        }
        writeCursor(dbInTxn, key, { past, future });
      },
    };
    const request = {
      actionId: operationId,
      principal: args.principal,
      scope: key.scope,
      _historyCommit: transition,
    };
    return receiptAction
      ? dispatch({ ...request, type: receiptAction.type, payload: receiptAction.payload })
      : dispatchBatch({ ...request, actions: translated.map(({ type, payload }) => ({ type, payload })) });
  }

  async function undoToPoint(args                  = {})                   {
    const key = identity(args);
    await admitted(historyDescriptor, { operation: 'undo', scope: key.scope, session: args.session, principal: args.principal });
    const operationId = requireText(args.actionId, 'actionId');
    const revisionArg = requireText(args.revision, 'revision');
    const seq = args.seq          ;
    if (!Number.isSafeInteger(seq) || seq < 0) throw new TypeError('seq must be a non-negative safe integer');
    if (seq > readSeq(db, key.scope)) throw conflict('history sequence boundary is beyond the scope cursor');
    const retry = receiptFor(db, key.scope, operationId);
    if (retry) {
      if (retry.operation !== 'undoToPoint' || retry.principalKey !== key.principalKey || retry.sessionId !== key.sessionId) {
        throw conflict('history action id is already bound to another operation');
      }
      return Object.freeze({ ok: true, deduped: true, events: Object.freeze(eventsFromReceipt(db, retry, parseEventType)) });
    }
    const expected = currentCursor(db, key);
    if (revisionArg !== revision(expected)) throw conflict('history cursor is stale');
    if (scopeContainsAnnotatedText(key.scope)) throw forbidden();
    const sourceActionIds           = [];
    for (let index = expected.past.length - 1; index >= 0; index -= 1) {
      const rootActionId = expected.past[index].rootActionId;
      const receipt = receiptFor(db, key.scope, rootActionId);
      if (!receipt) throw new Error(`history action '${rootActionId}' is no longer retained`);
      const refs = parseJson(receipt.eventRefs, [])              ;
      if (refs.some((ref) => ref.scope === key.scope && ref.seq > seq)) sourceActionIds.push(receipt.actionId);
      else break;
    }
    if (sourceActionIds.length === 0) {
      const now = new Date().toISOString();
      await txn(db, async () => {
        await admitted(historyDescriptor, { operation: 'undo', scope: key.scope, session: args.session, principal: args.principal });
        if (!sameCursor(currentCursor(db, key), expected)) throw conflict('history cursor changed during dispatch');
        insertReceipt(db, key.scope, operationId, now, [], {
          actionType: '$history.empty', actionData: { version: 1, boundarySeq: seq, sourceActionIds }, principalKey: key.principalKey,
          sessionId: key.sessionId, operation: 'undoToPoint',
        });
      });
      return Object.freeze({ ok: true, deduped: false, events: [], empty: true });
    }
    const translated                     = [];
    for (const sourceActionId of sourceActionIds) {
      const receipt = receiptFor(db, key.scope, sourceActionId);
      if (!receipt) throw new Error(`history action '${sourceActionId}' is no longer retained`);
      if (receiptContainsAnnotatedText(receipt)) throw forbidden();
      const action = actionFromRow(db, receipt);
      const rule = historyDescriptor.actions[action.type ?? ''];
      if (!rule) throw conflict(`history action '${action.type}' is not undoable`);
      if (!await authorize({ type: action.type, payload: action.payload, principal: args.principal })) throw forbidden();
      const fact = privateFactFromReceipt(db, receipt);
      const inverse = await rule.inverse({ action, fact, principal: args.principal, session: args.session });
      translated.push(...translatedActions(inverse, 'undo', key.scope));
    }
    if (translated.some((child) => annotatedActionTypes.has(child.type))) throw forbidden();
    const transition = {
      handlerInputs: Object.freeze(translated.map((child) => Object.freeze({ operation: 'undo', input: child.input }))),
      metadata: {
        actionType: '$batch', actionData: { version: 1, boundarySeq: seq, sourceActionIds, actions: translated.map(({ type, payload }) => ({ type, payload })) },
        principalKey: key.principalKey, sessionId: key.sessionId, operation: 'undoToPoint',
      },
      async apply(dbInTxn          )                {
        await admitted(historyDescriptor, { operation: 'undo', scope: key.scope, session: args.session, principal: args.principal });
        for (const sourceActionId of sourceActionIds) {
          const receipt = receiptFor(dbInTxn, key.scope, sourceActionId);
          if (!receipt) throw new Error(`history action '${sourceActionId}' is no longer retained`);
          const action = actionFromRow(dbInTxn, receipt);
          if (!await authorize({ type: action.type, payload: action.payload, principal: args.principal })) throw forbidden();
          privateFactFromReceipt(dbInTxn, receipt);
        }
        const current = currentCursor(dbInTxn, key);
        if (!sameCursor(current, expected)) throw new Error('history cursor changed during dispatch');
        writeCursor(dbInTxn, key, { past: current.past.slice(0, -sourceActionIds.length), future: [...current.future, ...current.past.slice(-sourceActionIds.length)] });
      },
    };
    return dispatchBatch({ actionId: operationId, principal: args.principal, scope: key.scope,
      actions: translated.map(({ type, payload }) => ({ type, payload })), _historyCommit: transition });
  }

  return Object.freeze({
    // Internal diagnostics only. The public application surface deliberately
    // exposes cursor/move operations, not canonical payload materialization.
    actions,
    events,
    cursor,
    undo: (args           ) => move('undo', args),
    redo: (args           ) => move('redo', args),
    undoToPoint,
    normalCommit,
  });
}

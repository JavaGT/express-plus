// search-staleness.ts — the S4/A2 staleness + invalidation bridge.
//
// The plugin contract (S4/A1, search-plugin.ts) declares source interests and
// staleness keys but nothing turns a committed source change into durable,
// coalescible, priority-ordered invalidation. This module is that bridge
// (considerations #3/#4/#5/#6/#7):
//
//   1. POST-COMMIT NOTIFICATIONS — registered source changes from BOTH history
//      and no-history tiers yield a coalescible staleness record keyed by
//      (sourceResource, sourceKey). A notification MUST carry a committedAt
//      proof; without one the record is refused (a staleness record never
//      references uncommitted state). Drain reconciles from the COMMITTED
//      source only (the scoped reader reads committed rows), so a plugin can
//      never index uncommitted state.
//   2. DURABILITY — the ledger is a SQLite table (_SearchStaleness) created by
//      the bridge when engaged. It is operational, plugin-owned state, not
//      domain history: it survives restart and a pending set is re-processable
//      by a fresh bridge over the same database.
//   3. COALESCING — the primary key is (sourceResource, sourceKey). Every
//      notification for one source key UPSERTs the same row (collapsing to the
//      newest notification with the highest priority seen), and a drain
//      reconciles each source key exactly once.
//   4. REVOCATION/ERASURE PRIORITY — erasure and access-revocation
//      invalidations are a HIGH-priority channel (S5/A5 onRevocation). Drain
//      orders high-priority records before ordinary reconciliation, and a
//      revocation/erasure record triggers a FULL rebuild (re-reading committed
//      scoped source) so protected content disappears before 'ready' is
//      claimed. The fence bump at notification time marks the plugin stale
//      immediately, so a pending revocation can never sit behind a 'fresh'
//      disclosure.
//   5. WORKBENCH-ISSUED INVALIDATIONS OVER TRIGGERS — the bridge installs NO
//      triggers and mutates no source table. Invalidation is delivered through
//      this seam (S3's post-commit plumbing calls notifySourceChange /
//      registers onRevocation). Any FTS-maintenance trigger on a source table
//      is plugin-declared and plugin-owned (declared in the plugin's
//      ownedObjects; the bridge reports them through triggerCensus()).
//
// SEAM: S3 owns the post-commit plumbing that FEEDS this bridge (kernel.ts /
// app.ts post-commit consumers). The bridge is the S4-side consumer of that
// seam: `app.searchStaleness.notifySourceChange(change)` for source changes
// (history-tier commits AND no-history-tier live writes) and
// `app.searchStaleness.onRevocation(principal, resourceScope)` as the S5/A5
// revocation listener. A3 (JavaGT/workbench#107) owns the reconcile engine and
// its scheduling; this module owns the durable ledger, the dispatch priority,
// and the drain loop it exposes.

                                            
                                                                                               
                                                
import { normalizeRevocationScope,                              } from './live-fanout.mjs';

// The closed vocabulary of a staleness record's cause. A source change is
// ordinary reconciliation input; a revocation or erasure is a HIGH-priority
// rebuild directive (protected content must leave the index before 'ready').
                                                                             

// The two priority channels. Ordinary source changes reconcile at 0; erasure
// and access-revocation invalidations land at 1 and drain first.
export const SEARCH_STALENESS_PRIORITY_ORDINARY = 0;
export const SEARCH_STALENESS_PRIORITY_HIGH = 1;

                                                          

// A post-commit source change offered to the bridge. `entity`/`rowId` are the
// coalescing key; `kind` is the change verb; `committedAt` is REQUIRED — it is
// the proof the notification fires post-commit, so no staleness record can
// reference uncommitted state. `tier` names which tier produced the change
// (informational; both history and no-history tiers flow through the same
// seam). `priority: 'high'` (or `erasure: true`) marks an erasure-class source
// change so it drains ahead of ordinary reconciliation.
                                          
                          
                         
                                  
                                                    
                               
                                     
                                              
                             
 

                                        
                             
                                             
                            
 

// One affected plugin inside a staleness record: the plugin to reconcile/
// rebuild plus the staleness key A1's registry assigned at notification time.
                                          
                            
                                
 

// A pending staleness record as disclosed by pending(). The durable row's
// JSON columns are parsed back into this shape.
                                        
                                  
                             
                                     
                            
                                                        
                                           
                             
                               
 

                                     
                             
                              
                           
                            
                               
                                    
                               
                              
                           
      
 

// One plugin-declared trigger (ownedObject kind 'trigger'), disclosed so the
// trigger census proves any FTS-maintenance trigger is plugin-declared and
// plugin-owned rather than framework-installed.
                                         
                            
                           
                        
                                  
 

                                        
                             
                             
                                                                                            
                                              
                                                                            
                                                                                   
                                       
                                                     
                         
 

                                               
                                          
                              
                              
                                                                                
 

const BARE_SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_TABLE_NAME = '_SearchStaleness';
// A pseudo source resource for principal-scope revocations. Real source
// entities are bare SQL identifiers, so '$principal' can never collide.
const PRINCIPAL_RESOURCE = '$principal';

function fail(message        )        {
  throw new TypeError(`search staleness bridge: ${message}`);
}

function requireText(value         , label        )         {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

function assertCommitted(input                         )       {
  // The post-commit guard: a change without a committedAt proof is refused.
  // The bridge NEVER records a staleness record for state that may not have
  // committed — the caller (S3's post-commit plumbing) fires post-commit only,
  // and this check makes that contract explicit and enforceable.
  if (typeof input.committedAt !== 'string' || input.committedAt.length === 0) {
    throw new TypeError(
      'search staleness bridge: a source change must carry committedAt (post-commit proof) — ' +
        'a staleness record never references uncommitted state',
    );
  }
}

function normalizeSourceChange(input                         )                                                                                       {
  if (input === null || typeof input !== 'object') {
    fail('notifySourceChange requires a source change object');
  }
  assertCommitted(input);
  const entity = requireText(input.entity, 'entity');
  if (!BARE_SQL_IDENTIFIER.test(entity)) {
    fail(`entity '${entity}' must be a bare SQL identifier`);
  }
  const rowId = requireText(input.rowId, 'rowId');
  if (!['created', 'updated', 'removed'].includes(input.kind)) {
    fail(`kind must be 'created' | 'updated' | 'removed', got '${String(input.kind)}'`);
  }
  if (input.tier !== undefined && input.tier !== 'history' && input.tier !== 'live') {
    fail(`tier must be 'history' | 'live' | undefined, got '${String(input.tier)}'`);
  }
  if (input.priority !== undefined && input.priority !== 'ordinary' && input.priority !== 'high') {
    fail(`priority must be 'ordinary' | 'high' | undefined, got '${String(input.priority)}'`);
  }
  return { entity, rowId, kind: input.kind, committedAt: input.committedAt };
}

function kindOf(input                         )                      {
  if (input.erasure === true) return 'erasure';
  return 'source-change';
}

function priorityOf(input                         )         {
  return input.priority === 'high' || input.erasure === true
    ? SEARCH_STALENESS_PRIORITY_HIGH
    : SEARCH_STALENESS_PRIORITY_ORDINARY;
}

function priorityLabel(priority        )                          {
  return priority >= SEARCH_STALENESS_PRIORITY_HIGH ? 'high' : 'ordinary';
}

// The durable ledger DDL. Plugin-owned operational state: created by the
// bridge when engaged, never by the framework DDL generators (the census test
// owns the framework table list), and carrying no triggers on source tables.
export function searchStalenessDdl(tableName         = DEFAULT_TABLE_NAME)         {
  return `CREATE TABLE IF NOT EXISTS ${tableName} (
  sourceResource TEXT NOT NULL,
  sourceKey TEXT NOT NULL,
  kind TEXT NOT NULL,
  priority INTEGER NOT NULL,
  affected TEXT NOT NULL,
  payload TEXT NOT NULL,
  tier TEXT,
  changedAt TEXT NOT NULL,
  committedAt TEXT NOT NULL,
  PRIMARY KEY (sourceResource, sourceKey)
);`;
}

                        
                         
                    
               
                   
                   
                      
                    
                      
 

function parseRecord(row              )                        {
  let affected                           ;
  try {
    const parsed = JSON.parse(row.affected);
    if (!Array.isArray(parsed)) throw new Error('not an array');
    affected = parsed.map((entry         ) => {
      const record = entry                                                         ;
      if (!record || typeof record.pluginId !== 'string' || typeof record.stalenessKey !== 'string') {
        throw new Error('malformed affected entry');
      }
      return { pluginId: record.pluginId, stalenessKey: record.stalenessKey };
    });
  } catch {
    throw new Error(`search staleness ledger has a corrupt affected column for '${row.sourceResource}:${row.sourceKey}'`);
  }
  return Object.freeze({
    sourceResource: row.sourceResource,
    sourceKey: row.sourceKey,
    kind: row.kind                       ,
    priority: row.priority,
    affected,
    tier: row.tier === 'history' || row.tier === 'live' ? row.tier : null,
    changedAt: row.changedAt,
    committedAt: row.committedAt,
  });
}

export function createSearchStalenessBridge(options                              )                        {
  const registry = options.registry;
  const now = options.now ?? (() => new Date().toISOString());
  const tableName = options.tableName ?? DEFAULT_TABLE_NAME;
  let db                  = null;
  let writeQueue = options.writeQueue ?? null;

  function requireDb()           {
    if (db === null) {
      throw new Error('search staleness bridge has no engaged database; call engage(db) before use');
    }
    return db;
  }

  // The ledger table is created lazily on first ledger use (CREATE TABLE IF NOT
  // EXISTS via prepare().run()), so engaging an app whose db handle is a test
  // fake (prepare that throws on use) never touches the database at
  // construction — the table only materializes when a notification or drain
  // actually needs it.
  function ensureTable()       {
    requireDb().prepare(searchStalenessDdl(tableName)).run();
  }

  function upsert(row   
                           
                      
                              
                     
                                                 
                    
                                    
                        
   )       {
    const connection = requireDb();
    ensureTable();
    const at = now();
    connection.prepare(
      `INSERT INTO ${tableName}
         (sourceResource, sourceKey, kind, priority, affected, payload, tier, changedAt, committedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(sourceResource, sourceKey) DO UPDATE SET
         kind = excluded.kind,
         priority = MAX(priority, excluded.priority),
         affected = excluded.affected,
         payload = excluded.payload,
         tier = excluded.tier,
         changedAt = excluded.changedAt,
         committedAt = excluded.committedAt`,
    ).run(row.sourceResource, row.sourceKey, row.kind, row.priority,
      JSON.stringify(row.affected), row.payload, row.tier, at, row.committedAt);
  }

  function readAll()                 {
    ensureTable();
    return requireDb().prepare(
      `SELECT sourceResource, sourceKey, kind, priority, affected, tier, changedAt, committedAt
       FROM ${tableName}
       ORDER BY priority DESC, changedAt ASC`,
    ).all()                             ;
  }

  function deleteRecord(record                       )       {
    requireDb().prepare(
      `DELETE FROM ${tableName} WHERE sourceResource = ? AND sourceKey = ?`,
    ).run(record.sourceResource, record.sourceKey);
  }

  // Affected plugins for a change: every registered plugin whose A1
  // stalenessKey accepts the change (fence bump + staleness key returned).
  function affectedPluginsForChange(change              )                            {
    const affected                            = [];
    for (const id of registry.ids()) {
      const notification = registry.notifyChange(id, change);
      if (notification.invalidated && notification.stalenessKey !== null) {
        affected.push({ pluginId: id, stalenessKey: notification.stalenessKey });
      }
    }
    return affected;
  }

  // Affected plugins for a revocation: every plugin that could have indexed
  // content under the revoked scope. For an entity scope the synthetic removal
  // change both bumps the fence (immediate 'stale' — a pending revocation can
  // never sit behind a 'fresh' disclosure) and yields the affected set. For a
  // principal scope every registered plugin is affected (any of them may have
  // indexed content the principal could see) — over-invalidate, drain rebuilds
  // against the CURRENT scoped source, so protected content leaves the index
  // before ready is claimed. The synthetic principal bump maps through each
  // plugin's OWN stalenessKey (A1 contract); a plugin that refuses the
  // synthetic key is simply not fence-bumped.
  function affectedPluginsForRevocation(resourceScope                         )                            {
    if (resourceScope.category === 'entity') {
      const [entity, rowId] = splitScopeKey(resourceScope.key);
      if (entity !== null && rowId !== null) {
        return affectedPluginsForChange({ entity, rowId, kind: 'removed' });
      }
      return registry.ids().map((pluginId) => ({ pluginId, stalenessKey: resourceScope.key }));
    }
    for (const id of registry.ids()) {
      const plugin = registry.get(id);
      if (!plugin) continue;
      for (const interest of plugin.sourceInterests) {
        registry.notifyChange(id, { entity: interest.entity, rowId: '*', kind: 'removed' });
      }
    }
    return registry.ids().map((pluginId) => ({ pluginId, stalenessKey: resourceScope.key }));
  }

  function splitScopeKey(key        )                          {
    const index = key.indexOf(':');
    if (index === -1) return [key, null];
    return [key.slice(0, index), key.slice(index + 1)];
  }

  async function processRecord(record                       )                                             {
    const run = (fn                                  ) => (writeQueue ? writeQueue.run(fn) : Promise.resolve().then(fn));
    if (record.kind === 'source-change') {
      let change              ;
      try {
        const payload = requireDb().prepare(
          `SELECT payload FROM ${tableName} WHERE sourceResource = ? AND sourceKey = ?`,
        ).get(record.sourceResource, record.sourceKey)                                   ;
        const parsed = JSON.parse(payload?.payload ?? '{}');
        const candidate = parsed.change                            ;
        if (!candidate || typeof candidate.entity !== 'string' || typeof candidate.rowId !== 'string') {
          throw new Error('malformed payload');
        }
        change = candidate;
      } catch {
        // A corrupt payload must not silently drop the invalidation: retain the
        // record (the failure surfaces in the drain summary) rather than
        // reconcile with an empty change.
        throw new Error(`staleness record '${record.sourceResource}:${record.sourceKey}' has a corrupt change payload`);
      }
      for (const affected of record.affected) {
        const outcome = await run(() => registry.reconcile(affected.pluginId, [change]))                   ;
        if (!outcome.ok) {
          const state = registry.stateOf(affected.pluginId);
          throw new Error(state.lastError ? state.lastError.message : `reconcile failed for '${affected.pluginId}'`);
        }
      }
      return { kind: 'reconcile' };
    }
    // Revocation / erasure: rebuild from the COMMITTED scoped source. Erased or
    // newly-unauthorized rows are absent (or out of the plugin's scope) in
    // committed state, so a successful rebuild cannot contain them.
    for (const affected of record.affected) {
      const outcome = await run(() => registry.rebuild(affected.pluginId))                   ;
      if (!outcome.ok) {
        const state = registry.stateOf(affected.pluginId);
        throw new Error(state.lastError ? state.lastError.message : `rebuild failed for '${affected.pluginId}'`);
      }
    }
    return { kind: 'rebuild' };
  }

  function engage(handle          )       {
    if (handle === null || typeof handle !== 'object' || typeof handle.prepare !== 'function') {
      fail('engage requires a DbHandle');
    }
    db = handle;
  }

  function bindWriteQueue(next                                                         )       {
    writeQueue = next ?? null;
  }

  function pending()                                   {
    return Object.freeze(readAll().map(parseRecord));
  }

  function notifySourceChange(input                         )                        {
    const normalized = normalizeSourceChange(input);
    const change               = {
      entity: normalized.entity,
      rowId: normalized.rowId,
      kind: normalized.kind,
      ...(input.data !== undefined ? { data: { ...input.data } } : {}),
    };
    const affected = affectedPluginsForChange(change);
    const priority = priorityOf(input);
    if (affected.length === 0) {
      return { recorded: false, priority: priorityLabel(priority), affected: 0 };
    }
    upsert({
      sourceResource: normalized.entity,
      sourceKey: normalized.rowId,
      kind: kindOf(input),
      priority,
      affected,
      payload: JSON.stringify({ change }),
      tier: input.tier ?? null,
      committedAt: normalized.committedAt,
    });
    return { recorded: true, priority: priorityLabel(priority), affected: affected.length };
  }

  function onRevocation(principal           , resourceScope                         )       {
    // Reuse the S5/A5 normalization seam: a malformed descriptor is rejected
    // deterministically before any record is touched (fail closed).
    const scope = normalizeRevocationScope(principal, resourceScope);
    const affected = affectedPluginsForRevocation(scope);
    if (affected.length === 0) return;
    const resource = scope.category === 'entity'
      ? (splitScopeKey(scope.key)[0] ?? scope.key)
      : PRINCIPAL_RESOURCE;
    const key = scope.category === 'entity'
      ? (splitScopeKey(scope.key)[1] ?? scope.key)
      : scope.key;
    upsert({
      sourceResource: resource,
      sourceKey: key,
      kind: 'revocation',
      priority: SEARCH_STALENESS_PRIORITY_HIGH,
      affected,
      payload: JSON.stringify({ scope, principalKey: principal === null ? null : String((principal                    ).id ?? '') }),
      tier: null,
      committedAt: now(),
    });
  }

  async function drain()                              {
    const failures                                                                                                                       = [];
    let reconciled = 0;
    let rebuilt = 0;
    let retained = 0;
    for (const record of pending()) {
      try {
        const outcome = await processRecord(record);
        deleteRecord(record);
        if (outcome.kind === 'reconcile') reconciled += 1;
        else rebuilt += 1;
      } catch (err) {
        retained += 1;
        const message = err instanceof Error ? err.message : String(err);
        for (const affected of record.affected) {
          failures.push({
            sourceResource: record.sourceResource,
            sourceKey: record.sourceKey,
            pluginId: affected.pluginId,
            error: message,
          });
        }
      }
    }
    return Object.freeze({
      processed: reconciled + rebuilt,
      reconciled,
      rebuilt,
      retained,
      failures: Object.freeze(failures),
    });
  }

  function triggerCensus()                                    {
    const triggers                           = [];
    for (const object of registry.census().objects) {
      if (object.kind !== 'trigger') continue;
      triggers.push(Object.freeze({
        pluginId: object.owner,
        version: object.version,
        name: object.name,
        ddl: Object.freeze([...object.ddl]),
      }));
    }
    return Object.freeze(triggers);
  }

  return Object.freeze({
    get tableName() {
      return tableName;
    },
    engage,
    bindWriteQueue,
    pending,
    notifySourceChange,
    onRevocation,
    drain,
    triggerCensus,
    stalenessDdl: () => searchStalenessDdl(tableName),
  });
}

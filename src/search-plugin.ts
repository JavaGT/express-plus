// search-plugin.ts — the search plugin contract (epic scope#23, S4/A1).
//
// The generic plugin contract the S4 search section is built on. Workbench has
// field-level search primitives (fts-strategy.ts, vector.ts) but no way for a
// plugin to declare stable identity, owned DB objects, source interests,
// staleness keys, prepare/validate, reconcile/rebuild, search, or health and
// generation state. This module declares that contract and the registration
// seam:
//
//   1. DECLARATION — a SearchPlugin declares a stable id + version, the DB
//      objects it owns (tables / indexes / triggers / virtual tables, with the
//      DDL entries that create them), the source resources it indexes, the
//      staleness-key format, prepare/validate, reconcile (incremental), rebuild
//      (full), search, and health/generation state.
//   2. REGISTRY — createSearchPluginRegistry() validates every declaration at
//      registration (duplicate id, unknown owned-object kind, non-compilable
//      source scope, unsupported contract version) mirroring the S5/A2
//      registration-time-fail rule, and owns the health/generation state
//      machine below.
//   3. SCOPED SOURCE READERS — a plugin NEVER receives the raw DbHandle. It
//      receives a SearchSourceReader scoped to exactly its declared
//      sourceInterests: only the declared source tables are reachable, and the
//      reader has no write verbs at all (writeCapable is a literal `false`).
//   4. FAILURE ISOLATION — an index failure marks that plugin failed (fence+1,
//      state 'failed') with retained retry info (message, at, attempt,
//      retryable); it never propagates as an authoritative-write error. The
//      write coordinator's `owned` plugin-index-write category (S1/A5) is where
//      a later wave materializes plugin-owned objects; this wave only declares
//      and orchestrates.
//   5. HEALTH + GENERATION — stateOf(id) / healthOf(id) disclose the shape S8
//      and search responses carry: { generation, fence, state, counts,
//      lastError }.
//
// The registry never imports a Scope noun. It is a pure typed contract plus an
// in-memory registry; the only runtime dependencies are the scope-compile seam
// (registration-time source-scope compilation, mirroring the authorization
// adapter) and the check registry.

import { buildCheckRegistry } from './registry.ts';
import { compileReadScope, NonCompilableError } from './scope-sql.ts';

// The contract version this package's registry supports. A plugin declares the
// version it was built against; anything else fails registration (version
// compatibility — a declaration cannot silently bind to a contract it was not
// written for).
export const SUPPORTED_SEARCH_PLUGIN_CONTRACT_VERSION = 1;

// The closed plugin-state vocabulary. `building` = a materialization cycle is
// in progress (or nothing has materialized yet); `ready` = the index reflects
// the source up to the current fence; `stale` = a source change invalidated the
// index but reconciliation has not consumed it; `failed` = the last
// materialization attempt threw (retry info retained).
export type SearchPluginState = 'building' | 'ready' | 'stale' | 'failed';

// The kinds of DB object a plugin may declare ownership of. The S2 ownership
// census ingests these (table/index/trigger/virtual-table).
export type SearchOwnedObjectKind = 'table' | 'index' | 'trigger' | 'virtual-table';

// The plugin's own index statistics, folded into health after a successful
// materialization (e.g. { documents: 42, tokens: 1337 }).
export type SearchPluginCounts = Readonly<Record<string, number>>;

// A DB object the plugin owns: the object kind, its name, and the DDL
// statements that create it. `ddl` entries are census-ingestible in the
// framework's { source, sql } DdlEntry shape (schema-table-census.ts), and
// `metadata` rides along as census metadata.
export interface SearchOwnedObject {
  readonly kind: SearchOwnedObjectKind;
  readonly name: string;
  readonly ddl: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// A source resource the plugin indexes. `entity` names the source table; the
// optional `fields` supply the field descriptors a declared `scope` may
// reference; an optional `scope` predicate must compile to constrained SQL at
// registration (S5/A2 mirror) or the declaration is refused.
export interface SearchSourceInterest {
  readonly entity: string;
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly scope?: (ctx: { is: unknown; fields: unknown }) => unknown;
}

export type SearchChangeKind = 'created' | 'updated' | 'removed';

// A source change offered to a plugin. `stalenessKey(change)` maps it to the
// index partition it invalidates, or null when the change does not affect the
// plugin's index.
export interface SearchChange {
  readonly entity: string;
  readonly rowId: string;
  readonly kind: SearchChangeKind;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface SearchRequest {
  readonly query: unknown;
  readonly entity?: string;
  readonly principal?: unknown;
  readonly limit?: number;
  readonly offset?: number;
}

// The materialization summary a reconcile/rebuild reports; `counts` becomes the
// plugin's disclosed index statistics.
export interface SearchMaterializeResult {
  readonly counts?: SearchPluginCounts;
}

// The plugin-side search return: the hits. The registry stamps the
// authoritative generation/fence/state onto the disclosed SearchSearchOutcome —
// a plugin cannot spoof its own health.
export interface SearchPluginSearchResult {
  readonly hits: readonly unknown[];
}

// The minimal read handle the scoped source reader needs. Intentionally NOT the
// raw DbHandle type: the reader is built over a structurally read-only subset,
// so a plugin can never reach exec/run/transaction through it.
export interface SearchSourceHandle {
  prepare(sql: string): {
    all(...params: unknown[]): Record<string, unknown>[];
    get(...params: unknown[]): Record<string, unknown> | undefined;
  };
}

// Retained retry info for the last failure (spec 4: an index failure marks the
// plugin failed WITH retained retry info).
export interface SearchRetryInfo {
  readonly message: string;
  readonly at: string;
  readonly attempt: number;
  readonly retryable: boolean;
}

// The disclosed health/generation shape (spec 5). `generation` counts
// materialization cycles; `fence` counts source invalidations; a consumer
// holding results stamped with an older fence knows they are stale.
export interface SearchPluginHealth {
  readonly id: string;
  readonly version: string;
  readonly generation: number;
  readonly fence: number;
  readonly state: SearchPluginState;
  readonly counts: SearchPluginCounts;
  readonly lastError: SearchRetryInfo | null;
}

// The context every plugin lifecycle method receives. It carries ONLY the
// plugin's identity and its scoped source reader — never a raw handle.
export interface SearchPluginContext {
  readonly id: string;
  readonly version: string;
  readonly reader: SearchSourceReader;
  readonly generation: number;
  readonly fence: number;
}

// The scoped source reader handed to a plugin. Reachable sources are exactly
// the plugin's declared sourceInterests; the reader exposes no write verb and
// no raw handle (`writeCapable` is the literal `false` — the red-line proof).
export interface SearchSourceReader {
  readonly plugin: string;
  readonly writeCapable: false;
  readonly interests: readonly SearchSourceInterest[];
  sources(): readonly string[];
  rows(entity: string, options?: { readonly ids?: readonly string[]; readonly limit?: number }): readonly Record<string, unknown>[];
  row(entity: string, id: string): Record<string, unknown> | undefined;
}

export interface SearchLifecycleOutcome {
  readonly ok: boolean;
  readonly generation: number;
  readonly fence: number;
  readonly state: SearchPluginState;
  readonly counts: SearchPluginCounts;
  readonly lastError: SearchRetryInfo | null;
  readonly result: SearchMaterializeResult | null;
}

export interface SearchSearchOutcome {
  readonly ok: boolean;
  readonly generation: number;
  readonly fence: number;
  readonly state: SearchPluginState;
  readonly counts: SearchPluginCounts;
  readonly result: { readonly hits: readonly unknown[]; readonly generation: number; readonly fence: number; readonly state: SearchPluginState } | null;
  readonly lastError: SearchRetryInfo | null;
}

export interface SearchNotification {
  readonly invalidated: boolean;
  readonly stalenessKey: string | null;
}

// Census-ingestible DDL entry — the same { source, sql } shape the framework's
// table census consumes (schema-table-census.ts / framework-table-names.ts).
export interface SearchPluginCensusEntry {
  readonly source: string;
  readonly sql: string;
}

export interface SearchPluginCensusObject extends SearchOwnedObject {
  readonly owner: string;
  readonly version: string;
}

export interface SearchPluginCensus {
  readonly entries: readonly SearchPluginCensusEntry[];
  readonly objects: readonly SearchPluginCensusObject[];
}

// The plugin declaration (spec 1). `contractVersion` is the S4/A1 contract
// version the plugin targets; `version` is the plugin's own release version.
// `health()` and `generation()` are OPTIONAL advisory hooks — the registry owns
// the authoritative generation/fence/state and folds their reports into the
// disclosed health (healthOf). `stalenessKey` decides which changes invalidate
// the index (spec: stalenessKey(change) format).
export interface SearchPlugin {
  readonly contractVersion: number;
  readonly id: string;
  readonly version: string;
  readonly ownedObjects: readonly SearchOwnedObject[];
  readonly sourceInterests: readonly SearchSourceInterest[];
  stalenessKey(change: SearchChange): string | null;
  prepare(ctx: SearchPluginContext): void | Promise<void>;
  validate(ctx: SearchPluginContext): void | Promise<void>;
  reconcile(ctx: SearchPluginContext, changes: readonly SearchChange[]): SearchMaterializeResult | Promise<SearchMaterializeResult>;
  rebuild(ctx: SearchPluginContext): SearchMaterializeResult | Promise<SearchMaterializeResult>;
  search(ctx: SearchPluginContext, request: SearchRequest): SearchPluginSearchResult | Promise<SearchPluginSearchResult>;
  health?(ctx: SearchPluginContext): unknown;
  generation?(): number;
}

export interface SearchPluginRegistryOptions {
  now?: () => string;
}

export interface SearchPluginRegistry {
  readonly size: number;
  register(plugin: SearchPlugin): void;
  has(id: string): boolean;
  get(id: string): SearchPlugin | undefined;
  ids(): readonly string[];
  census(): SearchPluginCensus;
  stateOf(id: string): SearchPluginHealth;
  healthOf(id: string): SearchPluginHealth & { readonly plugin: unknown };
  bindSource(handle: SearchSourceHandle | null): void;
  sourceReader(id: string): SearchSourceReader;
  notifyChange(id: string, change: SearchChange): SearchNotification;
  prepare(id: string): Promise<SearchLifecycleOutcome>;
  validate(id: string): Promise<SearchLifecycleOutcome>;
  reconcile(id: string, changes: readonly SearchChange[]): Promise<SearchLifecycleOutcome>;
  rebuild(id: string): Promise<SearchLifecycleOutcome>;
  search(id: string, request: SearchRequest): Promise<SearchSearchOutcome>;
}

// A bare SQL identifier: letters, digits, underscores, no leading digit. Owned
// object names and source-interest entities are validated against this, so the
// scoped reader's `SELECT * FROM <name>` interpolation is safe (fail closed —
// a plugin needing an exotic identifier is refused rather than interpolated).
const BARE_SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

const OWNED_OBJECT_KINDS: ReadonlySet<SearchOwnedObjectKind> = new Set([
  'table',
  'index',
  'trigger',
  'virtual-table',
]);

function assertId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || id.length === 0 || id.includes('\0')) {
    throw new Error('search plugin registration requires a non-empty id without NUL bytes');
  }
}

function assertVersion(version: unknown): asserts version is string {
  if (typeof version !== 'string' || version.length === 0 || version.includes('\0')) {
    throw new Error('search plugin registration requires a non-empty version string');
  }
}

function assertFunction(value: unknown, label: string, pluginId: string): void {
  if (typeof value !== 'function') {
    throw new Error(`search plugin '${pluginId}' ${label} must be a function`);
  }
}

function assertIdentifierName(name: unknown, label: string, pluginId: string): void {
  if (typeof name !== 'string' || !BARE_SQL_IDENTIFIER.test(name)) {
    throw new Error(
      `search plugin '${pluginId}' ${label} must be a bare SQL identifier ` +
        `(letters, digits, underscores, no leading digit) — got ${String(name)}`,
    );
  }
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

// Build the scoped source reader for ONE plugin over a concrete read handle.
// `interests` must be the plugin's DECLARED sourceInterests (the registry
// passes exactly those); an entity outside the declared set is refused with a
// scoping error. The returned reader exposes no write verb and no raw handle.
export function createSearchSourceReader(
  handle: SearchSourceHandle | null,
  { plugin, interests }: { plugin: string; interests: readonly SearchSourceInterest[] },
): SearchSourceReader {
  const frozenInterests = Object.freeze([...interests].map((interest) => Object.freeze({
    ...interest,
    fields: interest.fields ? Object.freeze({ ...interest.fields }) : undefined,
  })));
  const entities = new Set(frozenInterests.map((interest) => interest.entity));

  function requireEntity(entity: string): void {
    if (typeof entity !== 'string' || !BARE_SQL_IDENTIFIER.test(entity) || !entities.has(entity)) {
      throw new Error(
        `search plugin '${plugin}' source reader refused '${String(entity)}' — ` +
          `it is not a declared source interest (scoped reader; raw access is not available)`,
      );
    }
  }

  function requireHandle(): SearchSourceHandle {
    if (handle === null) {
      throw new Error(`search plugin '${plugin}' source reader has no bound source handle`);
    }
    return handle;
  }

  function rows(entity: string, options: { readonly ids?: readonly string[]; readonly limit?: number } = {}): readonly Record<string, unknown>[] {
    requireEntity(entity);
    const connection = requireHandle();
    let sql = `SELECT * FROM ${quoteIdentifier(entity)}`;
    const params: unknown[] = [];
    const ids = options.ids;
    if (ids !== undefined && ids.length > 0) {
      sql += ` WHERE ${quoteIdentifier('id')} IN (${ids.map(() => '?').join(', ')})`;
      params.push(...ids);
    }
    if (typeof options.limit === 'number' && Number.isFinite(options.limit)) {
      sql += ` LIMIT ${Math.max(0, Math.floor(options.limit))}`;
    }
    return connection.prepare(sql).all(...params);
  }

  function row(entity: string, id: string): Record<string, unknown> | undefined {
    requireEntity(entity);
    const connection = requireHandle();
    return connection
      .prepare(`SELECT * FROM ${quoteIdentifier(entity)} WHERE ${quoteIdentifier('id')} = ?`)
      .get(id);
  }

  return Object.freeze({
    plugin,
    writeCapable: false,
    interests: frozenInterests,
    sources: () => Object.freeze([...entities]),
    rows,
    row,
  });
}

// Per-plugin health ledger: the registry's authoritative state plus retry
// accounting. A successful materialization folds result counts; a failure bumps
// fence (the index no longer matches the source) and records retry info.
interface PluginLedger {
  plugin: SearchPlugin;
  generation: number;
  fence: number;
  state: SearchPluginState;
  counts: SearchPluginCounts;
  lastError: SearchRetryInfo | null;
  attempts: number;
}

function retryableOf(err: unknown): boolean {
  return !(err instanceof NonCompilableError);
}

export function createSearchPluginRegistry(options: SearchPluginRegistryOptions = {}): SearchPluginRegistry {
  const now = options.now ?? (() => new Date().toISOString());
  const plugins = new Map<string, SearchPlugin>();
  const ledger = new Map<string, PluginLedger>();
  const ownedNames = new Set<string>();
  let source: SearchSourceHandle | null = null;

  function ledgerOf(id: string): PluginLedger {
    const entry = ledger.get(id);
    if (!entry) {
      throw new Error(`search plugin '${id}' is not registered with this registry`);
    }
    return entry;
  }

  function stateOf(id: string): SearchPluginHealth {
    const entry = ledgerOf(id);
    return {
      id,
      version: entry.plugin.version,
      generation: entry.generation,
      fence: entry.fence,
      state: entry.state,
      counts: entry.counts,
      lastError: entry.lastError,
    };
  }

  function contextOf(id: string): SearchPluginContext {
    const entry = ledgerOf(id);
    return {
      id,
      version: entry.plugin.version,
      reader: createSearchSourceReader(source, {
        plugin: id,
        interests: entry.plugin.sourceInterests,
      }),
      generation: entry.generation,
      fence: entry.fence,
    };
  }

  function recordFailure(id: string, message: string, retryable: boolean): void {
    const entry = ledgerOf(id);
    entry.attempts += 1;
    entry.fence += 1;
    entry.state = 'failed';
    entry.lastError = Object.freeze({
      message,
      at: now(),
      attempt: entry.attempts,
      retryable,
    });
  }

  function register(plugin: SearchPlugin): void {
    if (plugin === null || typeof plugin !== 'object') {
      throw new Error('search plugin registration requires a declaration object');
    }
    if (plugin.contractVersion !== SUPPORTED_SEARCH_PLUGIN_CONTRACT_VERSION) {
      throw new Error(
        `search plugin '${String(plugin.id)}' declares contract version ${String(plugin.contractVersion)} — ` +
          `this registry supports ${SUPPORTED_SEARCH_PLUGIN_CONTRACT_VERSION} (version compatibility: ` +
          'a declaration cannot bind to a contract it was not written for)',
      );
    }
    assertId(plugin.id);
    assertVersion(plugin.version);
    if (plugins.has(plugin.id)) {
      throw new Error(`search plugin id '${plugin.id}' is already registered (duplicate id)`);
    }
    assertFunction(plugin.stalenessKey, 'stalenessKey', plugin.id);
    assertFunction(plugin.prepare, 'prepare', plugin.id);
    assertFunction(plugin.validate, 'validate', plugin.id);
    assertFunction(plugin.reconcile, 'reconcile', plugin.id);
    assertFunction(plugin.rebuild, 'rebuild', plugin.id);
    assertFunction(plugin.search, 'search', plugin.id);
    if (plugin.health !== undefined) assertFunction(plugin.health, 'health', plugin.id);
    if (plugin.generation !== undefined) assertFunction(plugin.generation, 'generation', plugin.id);

    if (!Array.isArray(plugin.ownedObjects)) {
      throw new Error(`search plugin '${plugin.id}' ownedObjects must be an array`);
    }
    for (const object of plugin.ownedObjects) {
      if (object === null || typeof object !== 'object') {
        throw new Error(`search plugin '${plugin.id}' ownedObjects entries must be objects`);
      }
      if (!OWNED_OBJECT_KINDS.has(object.kind)) {
        throw new Error(
          `search plugin '${plugin.id}' owns an object of unknown kind '${String(object.kind)}' ` +
            `(allowed: ${[...OWNED_OBJECT_KINDS].join(', ')})`,
        );
      }
      assertIdentifierName(object.name, `owned object name`, plugin.id);
      if (ownedNames.has(object.name)) {
        throw new Error(
          `search plugin '${plugin.id}' declares owned object '${object.name}' which is already owned by another plugin`,
        );
      }
      if (!Array.isArray(object.ddl) || object.ddl.length === 0 || object.ddl.some((sql: string) => typeof sql !== 'string' || sql.length === 0)) {
        throw new Error(
          `search plugin '${plugin.id}' owned object '${object.name}' must declare non-empty DDL statements`,
        );
      }
    }

    if (!Array.isArray(plugin.sourceInterests)) {
      throw new Error(`search plugin '${plugin.id}' sourceInterests must be an array`);
    }
    const interestEntities = new Set<string>();
    for (const interest of plugin.sourceInterests) {
      if (interest === null || typeof interest !== 'object') {
        throw new Error(`search plugin '${plugin.id}' sourceInterests entries must be objects`);
      }
      assertIdentifierName(interest.entity, 'source interest entity', plugin.id);
      if (interestEntities.has(interest.entity)) {
        throw new Error(
          `search plugin '${plugin.id}' declares source interest '${interest.entity}' more than once`,
        );
      }
      interestEntities.add(interest.entity);
      if (interest.scope !== undefined) {
        if (typeof interest.scope !== 'function') {
          throw new Error(
            `search plugin '${plugin.id}' source interest '${interest.entity}' scope must be a function`,
          );
        }
        // Registration-time compile (S5/A2 mirror): a scope that does not
        // compile to constrained SQL refuses the whole declaration.
        const fields = interest.fields ?? {};
        const checkRegistry = buildCheckRegistry({
          fields,
          entityName: interest.entity,
        });
        compileReadScope(interest.scope, {
          fields,
          where: `search plugin '${plugin.id}' source interest '${interest.entity}'`,
          registry: checkRegistry as unknown as Record<string, unknown>,
          entityName: interest.entity,
        });
      }
    }

    for (const object of plugin.ownedObjects) ownedNames.add(object.name);
    plugins.set(plugin.id, plugin);
    ledger.set(plugin.id, {
      plugin,
      generation: 0,
      fence: 0,
      state: 'building',
      counts: Object.freeze({}),
      lastError: null,
      attempts: 0,
    });
  }

  function census(): SearchPluginCensus {
    const entries: SearchPluginCensusEntry[] = [];
    const objects: SearchPluginCensusObject[] = [];
    for (const plugin of plugins.values()) {
      for (const object of plugin.ownedObjects) {
        for (const sql of object.ddl) {
          entries.push({ source: `search plugin '${plugin.id}' object '${object.name}'`, sql });
        }
        objects.push({ ...object, owner: plugin.id, version: plugin.version });
      }
    }
    return Object.freeze({ entries: Object.freeze(entries), objects: Object.freeze(objects) });
  }

  function bindSource(handle: SearchSourceHandle | null): void {
    source = handle;
  }

  function sourceReader(id: string): SearchSourceReader {
    const entry = ledgerOf(id);
    return createSearchSourceReader(source, {
      plugin: id,
      interests: entry.plugin.sourceInterests,
    });
  }

  function notifyChange(id: string, change: SearchChange): SearchNotification {
    const entry = ledgerOf(id);
    const key = entry.plugin.stalenessKey(change);
    if (key === null) {
      return { invalidated: false, stalenessKey: null };
    }
    entry.fence += 1;
    if (entry.state === 'ready') entry.state = 'stale';
    return { invalidated: true, stalenessKey: key };
  }

  // Shared failure-isolation wrapper for the materialization methods. A throw
  // marks the plugin failed with retained retry info and is RETURNED as an
  // outcome — never thrown through the authoritative write path.
  async function materialize(
    id: string,
    readyOnSuccess: boolean,
    run: (ctx: SearchPluginContext) => void | SearchMaterializeResult | Promise<void | SearchMaterializeResult>,
  ): Promise<SearchLifecycleOutcome> {
    const entry = ledgerOf(id);
    entry.generation += 1;
    const generation = entry.generation;
    const ctx = contextOf(id);
    try {
      const result = await run(ctx);
      // prepare success leaves the plugin building (owned objects exist, the
      // index is not materialized yet); validate/reconcile/rebuild success
      // makes the index ready.
      entry.state = readyOnSuccess ? 'ready' : 'building';
      entry.lastError = null;
      const counts = result && result.counts ? Object.freeze({ ...result.counts }) : entry.counts;
      entry.counts = counts;
      return {
        ok: true,
        generation,
        fence: entry.fence,
        state: entry.state,
        counts,
        lastError: null,
        result: result ?? null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      recordFailure(id, message, retryableOf(err));
      return {
        ok: false,
        generation,
        fence: entry.fence,
        state: entry.state,
        counts: entry.counts,
        lastError: entry.lastError,
        result: null,
      };
    }
  }

  function prepare(id: string): Promise<SearchLifecycleOutcome> {
    return materialize(id, false, (ctx) => ledgerOf(id).plugin.prepare(ctx));
  }

  function validate(id: string): Promise<SearchLifecycleOutcome> {
    return materialize(id, true, (ctx) => ledgerOf(id).plugin.validate(ctx));
  }

  function reconcile(id: string, changes: readonly SearchChange[]): Promise<SearchLifecycleOutcome> {
    return materialize(id, true, (ctx) => ledgerOf(id).plugin.reconcile(ctx, changes));
  }

  function rebuild(id: string): Promise<SearchLifecycleOutcome> {
    return materialize(id, true, (ctx) => ledgerOf(id).plugin.rebuild(ctx));
  }

  async function search(id: string, request: SearchRequest): Promise<SearchSearchOutcome> {
    const entry = ledgerOf(id);
    const ctx = contextOf(id);
    try {
      const result = await entry.plugin.search(ctx, request);
      return {
        ok: true,
        generation: entry.generation,
        fence: entry.fence,
        state: entry.state,
        counts: entry.counts,
        result: {
          hits: result.hits,
          generation: entry.generation,
          fence: entry.fence,
          state: entry.state,
        },
        lastError: null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      entry.attempts += 1;
      const lastError = Object.freeze({
        message,
        at: now(),
        attempt: entry.attempts,
        retryable: retryableOf(err),
      });
      entry.lastError = lastError;
      // A query-side failure does not invalidate the index: state/fence are
      // untouched, the failure is recorded for disclosure and retry accounting.
      return {
        ok: false,
        generation: entry.generation,
        fence: entry.fence,
        state: entry.state,
        counts: entry.counts,
        result: null,
        lastError,
      };
    }
  }

  function healthOf(id: string): SearchPluginHealth & { readonly plugin: unknown } {
    const entry = ledgerOf(id);
    let pluginHealth: unknown = null;
    try {
      pluginHealth = entry.plugin.health ? entry.plugin.health(contextOf(id)) : null;
    } catch {
      pluginHealth = null;
    }
    return { ...stateOf(id), plugin: pluginHealth };
  }

  return Object.freeze({
    register,
    has: (id: string) => plugins.has(id),
    get: (id: string) => plugins.get(id),
    ids: () => Object.freeze([...plugins.keys()]),
    get size() {
      return plugins.size;
    },
    census,
    stateOf,
    healthOf,
    bindSource,
    sourceReader,
    notifyChange,
    prepare,
    validate,
    reconcile,
    rebuild,
    search,
  });
}

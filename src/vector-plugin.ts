// vector-plugin.ts — model-space-aware, in-memory vector search plugin.
//
// Embeddings are supplied by the application's worker in source rows. This
// plugin stores and compares them; it deliberately has no model dependency.

import { nearestVectors } from './vector.ts';
import { SUPPORTED_SEARCH_PLUGIN_CONTRACT_VERSION, type SearchChange, type SearchMaterializeResult, type SearchPlugin, type SearchPluginContext, type SearchPluginSearchResult, type SearchRequest } from './search-plugin.ts';
import { censusOfRows, type SearchShadowCapabilities } from './search-reconcile.ts';

export type VectorPluginValidationCode =
  | 'dimension-mismatch'
  | 'non-finite-value'
  | 'model-space-mismatch'
  | 'unauthorized-source-ownership'
  | 'invalid-vector';

export class VectorPluginValidationError extends Error {
  readonly code: VectorPluginValidationCode;

  constructor(code: VectorPluginValidationCode, message: string) {
    super(message);
    this.name = 'VectorPluginValidationError';
    this.code = code;
  }
}

export interface VectorModelSpace {
  readonly model: string;
  readonly dimensions: number;
}

export interface VectorPluginSource {
  readonly entity: string;
  readonly vector: string;
  readonly model: string;
  // The source reader already enforces declared scopes. This optional predicate
  // narrows ownership further when a source table contains several owners.
  readonly owns?: (row: Readonly<Record<string, unknown>>) => boolean;
}

export interface VectorPluginOptions {
  readonly id: string;
  readonly version: string;
  readonly source: VectorPluginSource;
  readonly modelSpace: VectorModelSpace;
}

export interface VectorSearchQuery {
  readonly model: string;
  readonly vector: readonly number[];
}

export interface VectorPlugin extends SearchPlugin, SearchShadowCapabilities {
  readonly generationIdentity: string;
  readonly modelSpace: VectorModelSpace;
  validateSourceRow(row: Readonly<Record<string, unknown>>): void;
  setModelSpace(modelSpace: VectorModelSpace): void;
}

interface IndexedVector {
  readonly id: string;
  readonly vector: readonly number[];
  readonly source: Readonly<Record<string, unknown>>;
}

function assertModelSpace(modelSpace: VectorModelSpace): void {
  if (typeof modelSpace.model !== 'string' || modelSpace.model.length === 0) {
    throw new TypeError('vector model-space requires a non-empty model identity');
  }
  if (!Number.isSafeInteger(modelSpace.dimensions) || modelSpace.dimensions < 1) {
    throw new TypeError('vector model-space dimensions must be a positive safe integer');
  }
}

function generationIdentity(modelSpace: VectorModelSpace, sequence: number): string {
  return `${modelSpace.model}:${modelSpace.dimensions}:${sequence}`;
}

function validateVector(
  value: unknown,
  model: unknown,
  modelSpace: VectorModelSpace,
  sourceId: string,
): readonly number[] {
  if (model !== modelSpace.model) {
    throw new VectorPluginValidationError(
      'model-space-mismatch',
      `vector source '${sourceId}' has model '${String(model)}'; generation requires '${modelSpace.model}'`,
    );
  }
  if (!Array.isArray(value)) {
    throw new VectorPluginValidationError('invalid-vector', `vector source '${sourceId}' must contain a number array`);
  }
  if (value.length !== modelSpace.dimensions) {
    throw new VectorPluginValidationError(
      'dimension-mismatch',
      `vector source '${sourceId}' has ${value.length} dimensions; generation requires ${modelSpace.dimensions}`,
    );
  }
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isFinite(item)) {
      throw new VectorPluginValidationError('non-finite-value', `vector source '${sourceId}' contains a non-finite value`);
    }
  }
  return Object.freeze([...value]);
}

// Creates an in-memory index owned exclusively by this plugin. Lifecycle source
// reads happen through SearchPluginContext.reader, never through a raw database.
export function createVectorPlugin(options: VectorPluginOptions): VectorPlugin {
  let modelSpace = Object.freeze({ ...options.modelSpace });
  assertModelSpace(modelSpace);
  let sequence = 0;
  let active = new Map<string, IndexedVector>();
  let shadow: Map<string, IndexedVector> | null = null;

  function target(): Map<string, IndexedVector> {
    return shadow ?? active;
  }

  function ingest(targetIndex: Map<string, IndexedVector>, row: Readonly<Record<string, unknown>>): void {
    const id = row.id;
    if (typeof id !== 'string' || id.length === 0) {
      throw new VectorPluginValidationError('unauthorized-source-ownership', 'vector source row requires a non-empty id');
    }
    if (options.source.owns && !options.source.owns(row)) {
      throw new VectorPluginValidationError('unauthorized-source-ownership', `vector source '${id}' is not owned by this plugin`);
    }
    let sourceVector = row[options.source.vector];
    if (typeof sourceVector === 'string') {
      try {
        sourceVector = JSON.parse(sourceVector);
      } catch {
        throw new VectorPluginValidationError('invalid-vector', `vector source '${id}' contains invalid JSON`);
      }
    }
    const vector = validateVector(sourceVector, row[options.source.model], modelSpace, id);
    targetIndex.set(id, Object.freeze({ id, vector, source: Object.freeze({ ...row }) }));
  }

  function rebuild(ctx: SearchPluginContext): SearchMaterializeResult {
    const next = target();
    next.clear();
    for (const row of ctx.reader.rows(options.source.entity)) ingest(next, row);
    return { counts: { vectors: next.size } };
  }

  function reconcile(ctx: SearchPluginContext, changes: readonly SearchChange[]): SearchMaterializeResult {
    const next = target();
    for (const change of changes) {
      if (change.entity !== options.source.entity) continue;
      if (change.kind === 'removed') {
        next.delete(change.rowId);
        continue;
      }
      // A missing row is outside the scoped reader (or was concurrently removed),
      // so its prior indexed value must not remain searchable.
      const row = ctx.reader.row(options.source.entity, change.rowId);
      if (row === undefined) next.delete(change.rowId);
      else ingest(next, row);
    }
    return { counts: { vectors: next.size } };
  }

  function search(_ctx: SearchPluginContext, request: SearchRequest): SearchPluginSearchResult {
    if (request.signal?.aborted) return { hits: [] };
    const query = request.query as VectorSearchQuery;
    const vector = validateVector(query?.vector, query?.model, modelSpace, 'query');
    const limit = request.limit ?? active.size;
    const hits: Readonly<Record<string, unknown>>[] = [];
    for (const entry of nearestVectors([...active.values()], vector, Math.max(1, limit))) {
      if (request.signal?.aborted) break;
      hits.push(entry.source);
    }
    return { hits };
  }

  const plugin: VectorPlugin = {
    contractVersion: SUPPORTED_SEARCH_PLUGIN_CONTRACT_VERSION,
    id: options.id,
    version: options.version,
    ownedObjects: Object.freeze([]),
    sourceInterests: Object.freeze([{ entity: options.source.entity }]),
    get generationIdentity() {
      return generationIdentity(modelSpace, sequence);
    },
    get modelSpace() {
      return modelSpace;
    },
    validateSourceRow(row) {
      const scratch = new Map<string, IndexedVector>();
      ingest(scratch, row);
    },
    setModelSpace(nextModelSpace) {
      assertModelSpace(nextModelSpace);
      if (nextModelSpace.model === modelSpace.model && nextModelSpace.dimensions === modelSpace.dimensions) return;
      modelSpace = Object.freeze({ ...nextModelSpace });
      sequence += 1;
      active = new Map();
      shadow = null;
    },
    stalenessKey(change) {
      return change.entity === options.source.entity ? `${change.entity}:${change.rowId}` : null;
    },
    prepare() {},
    validate() {
      for (const entry of target().values()) validateVector(entry.vector, modelSpace.model, modelSpace, entry.id);
    },
    reconcile,
    rebuild,
    search,
    beginShadow() {
      shadow = new Map();
    },
    indexCensus() {
      const rows = [...target().values()].map((entry) => entry.source);
      return Object.freeze({ [options.source.entity]: censusOfRows(rows) });
    },
    commitShadow() {
      if (shadow === null) throw new Error('vector plugin has no shadow generation to commit');
      active = shadow;
      shadow = null;
    },
    rollbackShadow() {
      // The old active index remains intact until commitShadow succeeds.
    },
    abortShadow() {
      shadow = null;
    },
    health() {
      return Object.freeze({ generationIdentity: generationIdentity(modelSpace, sequence), modelSpace, vectors: active.size });
    },
  };
  return Object.freeze(plugin);
}

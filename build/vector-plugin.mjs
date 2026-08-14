// vector-plugin.ts — model-space-aware, in-memory vector search plugin.
//
// Embeddings are supplied by the application's worker in source rows. This
// plugin stores and compares them; it deliberately has no model dependency.

import { nearestVectorsInterruptibly } from './vector.mjs';
import { SUPPORTED_SEARCH_PLUGIN_CONTRACT_VERSION,                                                                                                                                                 } from './search-plugin.mjs';
import { censusOfRows,                               } from './search-reconcile.mjs';








export class VectorPluginValidationError extends Error {
           code                            ;

  constructor(code                            , message        ) {
    super(message);
    this.name = 'VectorPluginValidationError';
    this.code = code;
  }
}








































function assertModelSpace(modelSpace                  )       {
  if (typeof modelSpace.model !== 'string' || modelSpace.model.length === 0) {
    throw new TypeError('vector model-space requires a non-empty model identity');
  }
  if (!Number.isSafeInteger(modelSpace.dimensions) || modelSpace.dimensions < 1) {
    throw new TypeError('vector model-space dimensions must be a positive safe integer');
  }
}

function generationIdentity(modelSpace                  , sequence        )         {
  return `${modelSpace.model}:${modelSpace.dimensions}:${sequence}`;
}

function validateVector(
  value         ,
  model         ,
  modelSpace                  ,
  sourceId        ,
)                    {
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
export function createVectorPlugin(options                     )               {
  if (typeof options.source.owns !== 'function') {
    throw new TypeError('vector plugin source requires an ownership predicate');
  }
  let modelSpace = Object.freeze({ ...options.modelSpace });
  assertModelSpace(modelSpace);
  let sequence = 0;
  let active = new Map                       ();
  let shadow                                    = null;

  function target()                             {
    return shadow ?? active;
  }

  function ingest(targetIndex                            , row                                   )       {
    const id = row.id;
    if (typeof id !== 'string' || id.length === 0) {
      throw new VectorPluginValidationError('unauthorized-source-ownership', 'vector source row requires a non-empty id');
    }
    let owned         ;
    try {
      owned = options.source.owns(row) === true;
    } catch {
      throw new VectorPluginValidationError('unauthorized-source-ownership', `vector source '${id}' ownership could not be verified`);
    }
    if (!owned) {
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

  function rebuild(ctx                     )                          {
    const next = target();
    next.clear();
    for (const row of ctx.reader.rows(options.source.entity)) ingest(next, row);
    return { counts: { vectors: next.size } };
  }

  function reconcile(ctx                     , changes                         )                          {
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

  async function search(_ctx                     , request               )                                    {
    if (request.signal?.aborted) return { hits: [] };
    const query = request.query                     ;
    const vector = validateVector(query?.vector, query?.model, modelSpace, 'query');
    const limit = request.limit ?? active.size;
    const hits                                      = [];
    const entries = await nearestVectorsInterruptibly([...active.values()], vector, Math.max(1, limit), request.signal);
    if (request.signal?.aborted) return { hits: [] };
    for (const entry of entries) hits.push(entry.source);
    return { hits };
  }

  const plugin               = {
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
      const scratch = new Map                       ();
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

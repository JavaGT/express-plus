// fts5-plugin.ts — a declared, durable SQLite FTS5 search plugin.

import {
  SUPPORTED_SEARCH_PLUGIN_CONTRACT_VERSION,




} from './search-plugin.mjs';
import { censusOfRows,                                                  } from './search-reconcile.mjs';
import { admitSearchHits } from './search-auth.mjs';





export class Fts5QueryValidationError extends Error {
  constructor(message        ) {
    super(message);
    this.name = 'Fts5QueryValidationError';
  }
}

































const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TOKENIZERS = new Set               (['unicode61', 'porter', 'trigram']);
const MAX_WRITE_STATEMENTS = 128;

function assertIdentifier(value        , label        )       {
  if (!IDENTIFIER.test(value)) throw new TypeError(`FTS5 ${label} must be a SQLite identifier`);
}

function tableName(entity        , field        )         {
  return `${entity}_${field}_fts`;
}

function ownerColumn(entity        )         {
  return `${entity}_id`;
}

// Retained for the field strategy's scope-level FTS table declaration.
export function fts5TableDdl(entity        , field        , tokenizer                )         {
  assertIdentifier(entity, 'entity');
  assertIdentifier(field, 'field');
  if (tokenizer !== undefined && !TOKENIZERS.has(tokenizer)) throw new TypeError(`unsupported FTS5 tokenizer '${tokenizer}'`);
  const configuredTokenizer = tokenizer === undefined ? '' : `, tokenize='${tokenizer}'`;
  return `CREATE VIRTUAL TABLE IF NOT EXISTS ${tableName(entity, field)} USING fts5(${field}, ${ownerColumn(entity)} UNINDEXED${configuredTokenizer});`;
}

function pluginName(id        )         {
  return `SearchFts_${id.replaceAll(/[^A-Za-z0-9_]/g, '_')}`;
}

function rowId(row                                   )         {
  if (typeof row.id !== 'string' || row.id.length === 0) throw new TypeError('FTS5 source row requires a non-empty string id');
  return row.id;
}

function stringValues(row                                   , fields                   )                    {
  return fields.map((field) => typeof row[field] === 'string' ? row[field] : '');
}

function asNumber(value         )         {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function boundedExcerpt(value        , length        )         {
  if (value.length <= length) return value;
  if (length <= 3) return '.'.repeat(length);
  return `${value.slice(0, Math.max(0, length - 3))}...`;
}

function indexedRows(rows                                              , fields                   )                            {
  return rows.map((row) => Object.fromEntries([
    ['id', rowId(row)],
    ...fields.map((field) => [field, typeof row[field] === 'string' ? row[field] : '']),
  ]));
}

function countOf(ctx                     , table        )         {
  // count() is intentionally outside the owned-index SQL function allowlist.
  // The bounded capability already caps query rows, so count concrete rowids.
  return ctx.index.query({ sql: `SELECT rowid FROM ${table}` }).length;
}

function ftsShadowNames(table        )                    {
  return Object.freeze(['data', 'idx', 'content', 'docsize', 'config'].map((suffix) => `${table}_${suffix}`));
}

export function createFts5Plugin(options                   )             {
  assertIdentifier(options.source.entity, 'entity');
  if (!Array.isArray(options.source.fields) || options.source.fields.length === 0) throw new TypeError('FTS5 plugin requires at least one source field');
  for (const field of options.source.fields) assertIdentifier(field, 'field');
  const tokenizer = options.tokenizer ?? 'unicode61';
  if (!TOKENIZERS.has(tokenizer)) throw new TypeError(`unsupported FTS5 tokenizer '${tokenizer}'`);
  const snippetLength = options.snippetLength ?? 24;
  if (!Number.isSafeInteger(snippetLength) || snippetLength < 1) throw new TypeError('FTS5 snippetLength must be a positive safe integer');
  if (options.admission === null || typeof options.admission !== 'object') throw new TypeError('FTS5 plugin requires a search admission configuration');

  const base = pluginName(options.id);
  const stateTable = `${base}_state`;
  const tables = [`${base}_g0`, `${base}_g1`]         ;
  const idColumn = `${options.source.entity}_id`;
  let building               = null;
  let promoted               = null;

  function activeGeneration(ctx                     )        {
    const value = ctx.index.query({ sql: `SELECT active FROM ${stateTable} WHERE slot = 'active'` })[0]?.active;
    return value === 1 ? 1 : 0;
  }

  function targetTable(ctx                     )         {
    return tables[building ?? activeGeneration(ctx)];
  }

  async function writeRows(ctx                     , table        , rows                                              )                {
    const columns = [...options.source.fields, idColumn, 'payload'];
    const placeholders = columns.map(() => '?').join(', ');
    const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`;
    for (let offset = 0; offset < rows.length; offset += MAX_WRITE_STATEMENTS) {
      const statements = rows.slice(offset, offset + MAX_WRITE_STATEMENTS).map((row) => ({
        sql,
        params: [...stringValues(row, options.source.fields), rowId(row), JSON.stringify(row)],
      }));
      if (statements.length > 0) await ctx.index.write({ expectedFence: ctx.fence, statements });
    }
  }

  async function replaceRows(ctx                     , table        , changes                         )                {
    const statements                                                                   = [];
    for (const change of changes) {
      if (change.entity !== options.source.entity) continue;
      statements.push({ sql: `DELETE FROM ${table} WHERE ${idColumn} = ?`, params: [change.rowId] });
      if (change.kind !== 'removed') {
        const row = ctx.reader.row(options.source.entity, change.rowId);
        if (row !== undefined) {
          const columns = [...options.source.fields, idColumn, 'payload'];
          statements.push({
            sql: `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
            params: [...stringValues(row, options.source.fields), rowId(row), JSON.stringify(row)],
          });
        }
      }
    }
    for (let offset = 0; offset < statements.length; offset += MAX_WRITE_STATEMENTS) {
      await ctx.index.write({ expectedFence: ctx.fence, statements: statements.slice(offset, offset + MAX_WRITE_STATEMENTS) });
    }
  }

  const plugin             = {
    contractVersion: SUPPORTED_SEARCH_PLUGIN_CONTRACT_VERSION,
    id: options.id,
    version: options.version,
    tokenizer,
    ownedObjects: Object.freeze([
      { kind: 'table'         , name: stateTable, ddl: [`CREATE TABLE IF NOT EXISTS ${stateTable} (slot TEXT PRIMARY KEY CHECK (slot = 'active'), active INTEGER NOT NULL CHECK (active IN (0, 1)), previous INTEGER NOT NULL CHECK (previous IN (0, 1)));`] },
      ...tables.map((name) => ({
        kind: 'virtual-table'         ,
        name,
        // payload is retained only for exact index/source census comparison. Search
        // queries never select it, so indexed source data cannot leak in a hit.
        ddl: [`CREATE VIRTUAL TABLE IF NOT EXISTS ${name} USING fts5(${[...options.source.fields, `${idColumn} UNINDEXED`, 'payload UNINDEXED'].join(', ')}, tokenize='${tokenizer}');`],
      })),
      // FTS5 creates these physical tables with its virtual table. They are
      // declared individually so the census authorizes FTS's internal writes.
      // Lifecycle creation visits virtual tables first, making these fallback
      // DDL entries no-ops on every healthy boot.
      ...tables.flatMap((table) => ftsShadowNames(table).map((name) => ({
        kind: 'table'         ,
        name,
        ddl: [`-- ${name} is created by its declared FTS5 virtual table.`],
      }))),
    ]),
    sourceInterests: Object.freeze([{ entity: options.source.entity }]),
    stalenessKey: (change) => change.entity === options.source.entity ? `${change.entity}:${change.rowId}` : null,
    async prepare(ctx) {
      await ctx.index.write({
        expectedFence: ctx.fence,
        statements: [{ sql: `INSERT OR IGNORE INTO ${stateTable} (slot, active, previous) VALUES ('active', 0, 0)` }],
      });
    },
    validate(ctx) {
      // Read both FTS generations through the owned capability. This exercises
      // the real virtual tables before a generation is disclosed as ready.
      countOf(ctx, tables[0]);
      countOf(ctx, tables[1]);
    },
    async reconcile(ctx, changes) {
      await replaceRows(ctx, targetTable(ctx), changes);
      return { counts: { documents: countOf(ctx, targetTable(ctx)) } };
    },
    async rebuild(ctx) {
      const table = targetTable(ctx);
      await ctx.index.write({ expectedFence: ctx.fence, statements: [{ sql: `DELETE FROM ${table}` }] });
      const rows = ctx.reader.rows(options.source.entity);
      await writeRows(ctx, table, rows);
      return { counts: { documents: countOf(ctx, table) } };
    },
    async search(ctx, request)                                    {
      if (typeof request.query !== 'string' || request.query.trim().length === 0) {
        throw new Fts5QueryValidationError('FTS5 query must be a non-empty string');
      }
      if (request.principal === undefined) throw new Fts5QueryValidationError('FTS5 search requires a principal for result admission');
      const table = tables[activeGeneration(ctx)];
      try {
        // This deliberately uses the SQLite FTS5 parser. There is no parallel
        // JavaScript grammar whose acceptance could diverge from MATCH.
        ctx.index.query({ sql: `SELECT rowid FROM ${table} WHERE ${table} MATCH ? LIMIT 0`, params: [request.query] });
        const snippets = options.source.fields.map((_, index) => `snippet(${table}, ${index}, '[', ']', '...', ?) AS excerpt_${index}`).join(', ');
        const rows = ctx.index.query({
          sql: `SELECT ${idColumn} AS id, bm25(${table}) AS score, ${snippets} FROM ${table} WHERE ${table} MATCH ? ORDER BY score ASC, ${idColumn} ASC LIMIT ?`,
          params: [...options.source.fields.map(() => snippetLength), request.query, Math.max(0, Math.floor(request.limit ?? 100))],
        });
        const greatest = Math.max(0, ...rows.map((row) => -asNumber(row.score)));
        const candidates = rows.map((row) => {
          const id = String(row.id);
          // A snippet from an unmatched field may contain the highlight marker in
          // its source text. Ask FTS5 which fields matched instead. Cross-field
          // expressions are ambiguous, so never attribute an excerpt to one.
          const matchingFieldIndexes = options.source.fields.flatMap((field, index) =>
            ctx.index.query({
              sql: `SELECT rowid FROM ${table} WHERE ${idColumn} = ? AND ${table} MATCH ? LIMIT 1`,
              params: [id, `${field} : (${request.query})`],
            }).length > 0 ? [index] : [],
          );
          const fieldIndex = matchingFieldIndexes.length === 1 ? matchingFieldIndexes[0] : undefined;
          const excerpt = fieldIndex === undefined ? undefined : row[`excerpt_${fieldIndex}`];
          const hit = Object.freeze({
            id,
            rank: greatest === 0 ? 1 : Math.max(0, -asNumber(row.score) / greatest),
            ...(fieldIndex === undefined ? {} : { excerptField: options.source.fields[fieldIndex] }),
          });
          return {
            hit,
            key: id,
            rank: hit.rank,
            row: ctx.reader.row(options.source.entity, id) ?? null,
            ...(typeof excerpt === 'string' && hit.excerptField !== undefined ? {
              excerpt: {
                entity: options.admission.entity,
                fieldName: hit.excerptField,
                text: boundedExcerpt(excerpt, snippetLength),
              },
            } : {}),
          };
        });
        const admitted = await admitSearchHits(options.admission.adapter, {
          pluginId: options.id,
          generation: ctx.generation,
          staleness: 'stale',
          principal: request.principal,
          candidates,
        });
        return {
          hits: Object.freeze(admitted.hits.map(({ hit, excerpt }) => Object.freeze({
            ...hit,
            ...(excerpt !== undefined ? { excerpt } : {}),
          }))),
        };
      } catch (error) {
        if (error instanceof Fts5QueryValidationError) throw error;
        throw new Fts5QueryValidationError(`FTS5 query is malformed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    async beginShadow(ctx) {
      building = activeGeneration(ctx) === 0 ? 1 : 0;
      await ctx.index.write({ expectedFence: ctx.fence, statements: [{ sql: `DELETE FROM ${tables[building]}` }] });
    },
    indexCensus(ctx)               {
      const rows = ctx.index.query({ sql: `SELECT ${idColumn} AS id, ${options.source.fields.join(', ')} FROM ${targetTable(ctx)} ORDER BY ${idColumn} ASC` });
      return Object.freeze({ [options.source.entity]: censusOfRows(rows) });
    },
    sourceCensus(ctx)               {
      return Object.freeze({
        [options.source.entity]: censusOfRows(indexedRows(ctx.reader.rows(options.source.entity), options.source.fields)),
      });
    },
    async commitShadow(ctx) {
      if (building === null) throw new Error('FTS5 plugin has no shadow generation to commit');
      const next = building;
      await ctx.index.write({
        expectedFence: ctx.fence,
        statements: [{ sql: `UPDATE ${stateTable} SET previous = active, active = ? WHERE slot = 'active'`, params: [next] }],
      });
      promoted = next;
      building = null;
    },
    async rollbackShadow(ctx) {
      if (promoted === null) return;
      await ctx.index.write({ expectedFence: ctx.fence, statements: [{ sql: `UPDATE ${stateTable} SET active = previous WHERE slot = 'active'` }] });
      promoted = null;
    },
    async abortShadow(ctx) {
      if (building === null) return;
      const discarded = building;
      building = null;
      await ctx.index.write({ expectedFence: ctx.fence, statements: [{ sql: `DELETE FROM ${tables[discarded]}` }] });
    },
    health(ctx) {
      try {
        const source = indexedRows(ctx.reader.rows(options.source.entity), options.source.fields);
        const active = activeGeneration(ctx);
        const index = plugin.indexCensus(ctx)[options.source.entity];
        const sourceCensus = censusOfRows(source);
        const shadowCounts = tables.map((table) => countOf(ctx, table));
        return Object.freeze({
          tokenizer,
          integrity: Object.freeze({
            ok: sourceCensus.count === index.count && sourceCensus.digest === index.digest,
            source: sourceCensus,
            index,
            activeGeneration: active,
            shadowCounts: Object.freeze(shadowCounts),
            // FTS5 has no plugin-installed triggers: all maintenance is the
            // post-commit staleness ledger, so source-trigger drift is impossible.
            triggerDrift: false,
          }),
        });
      } catch (error) {
        return Object.freeze({ tokenizer, integrity: Object.freeze({ ok: false, error: error instanceof Error ? error.message : String(error) }) });
      }
    },
  };
  return Object.freeze(plugin);
}

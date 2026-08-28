// fts5-plugin.ts — a declared, durable SQLite FTS5 search plugin.

import {
  SUPPORTED_SEARCH_PLUGIN_CONTRACT_VERSION,
  type SearchChange,
  type SearchPlugin,
  type SearchPluginContext,
  type SearchPluginSearchResult,
} from './search-plugin.ts';
import { censusOfRows, type SearchCensus, type SearchShadowCapabilities } from './search-reconcile.ts';
import { admitSearchHits } from './search-auth.ts';
import type { AuthorizationAdapter } from './authorization-adapter.ts';
import type { EntityRecord } from './row-grant.ts';

export type Fts5Tokenizer = 'unicode61' | 'porter' | 'trigram';

export class Fts5QueryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Fts5QueryValidationError';
  }
}

export interface Fts5PluginSource {
  readonly entity: string;
  readonly fields: readonly string[];
}

export interface Fts5SearchAdmission {
  // The current entity declaration supplies field-level excerpt admission; the
  // adapter remains the sole authorization authority for the source row.
  readonly entity: EntityRecord;
  readonly adapter: AuthorizationAdapter;
}

export interface Fts5PluginOptions {
  readonly id: string;
  readonly version: string;
  readonly source: Fts5PluginSource;
  readonly tokenizer?: Fts5Tokenizer;
  readonly snippetLength?: number;
  readonly admission: Fts5SearchAdmission;
}

export interface Fts5SearchHit extends Readonly<Record<string, unknown>> {
  readonly id: string;
  readonly rank: number;
  readonly excerptField?: string;
  readonly excerpt?: string;
}

export interface Fts5Plugin extends SearchPlugin, SearchShadowCapabilities {
  readonly tokenizer: Fts5Tokenizer;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TOKENIZERS = new Set<Fts5Tokenizer>(['unicode61', 'porter', 'trigram']);
const MAX_WRITE_STATEMENTS = 128;

function assertIdentifier(value: string, label: string): void {
  if (!IDENTIFIER.test(value)) throw new TypeError(`FTS5 ${label} must be a SQLite identifier`);
}

function tableName(entity: string, field: string): string {
  return `${entity}_${field}_fts`;
}

function ownerColumn(entity: string): string {
  return `${entity}_id`;
}

// Retained for the field strategy's scope-level FTS table declaration.
export function fts5TableDdl(entity: string, field: string, tokenizer?: Fts5Tokenizer): string {
  assertIdentifier(entity, 'entity');
  assertIdentifier(field, 'field');
  if (tokenizer !== undefined && !TOKENIZERS.has(tokenizer)) throw new TypeError(`unsupported FTS5 tokenizer '${tokenizer}'`);
  const configuredTokenizer = tokenizer === undefined ? '' : `, tokenize='${tokenizer}'`;
  return `CREATE VIRTUAL TABLE IF NOT EXISTS ${tableName(entity, field)} USING fts5(${field}, ${ownerColumn(entity)} UNINDEXED${configuredTokenizer});`;
}

function pluginName(id: string): string {
  return `SearchFts_${id.replaceAll(/[^A-Za-z0-9_]/g, '_')}`;
}

function rowId(row: Readonly<Record<string, unknown>>): string {
  if (typeof row.id !== 'string' || row.id.length === 0) throw new TypeError('FTS5 source row requires a non-empty string id');
  return row.id;
}

function stringValues(row: Readonly<Record<string, unknown>>, fields: readonly string[]): readonly string[] {
  return fields.map((field) => typeof row[field] === 'string' ? row[field] : '');
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function boundedExcerpt(value: string, length: number): string {
  if (value.length <= length) return value;
  if (length <= 3) return '.'.repeat(length);
  return `${value.slice(0, Math.max(0, length - 3))}...`;
}

function indexedRows(rows: readonly Readonly<Record<string, unknown>>[], fields: readonly string[]): Record<string, unknown>[] {
  return rows.map((row) => Object.fromEntries([
    ['id', rowId(row)],
    ...fields.map((field) => [field, typeof row[field] === 'string' ? row[field] : '']),
  ]));
}

function countOf(ctx: SearchPluginContext, table: string): number {
  // count() is intentionally outside the owned-index SQL function allowlist.
  // The bounded capability already caps query rows, so count concrete rowids.
  return ctx.index.query({ sql: `SELECT rowid FROM ${table}` }).length;
}

function ftsShadowNames(table: string): readonly string[] {
  return Object.freeze(['data', 'idx', 'content', 'docsize', 'config'].map((suffix) => `${table}_${suffix}`));
}

export function createFts5Plugin(options: Fts5PluginOptions): Fts5Plugin {
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
  const tables = [`${base}_g0`, `${base}_g1`] as const;
  const idColumn = `${options.source.entity}_id`;
  let building: 0 | 1 | null = null;
  let promoted: 0 | 1 | null = null;

  function activeGeneration(ctx: SearchPluginContext): 0 | 1 {
    const value = ctx.index.query({ sql: `SELECT active FROM ${stateTable} WHERE slot = 'active'` })[0]?.active;
    return value === 1 ? 1 : 0;
  }

  function targetTable(ctx: SearchPluginContext): string {
    return tables[building ?? activeGeneration(ctx)];
  }

  async function writeRows(ctx: SearchPluginContext, table: string, rows: readonly Readonly<Record<string, unknown>>[]): Promise<void> {
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

  async function replaceRows(ctx: SearchPluginContext, table: string, changes: readonly SearchChange[]): Promise<void> {
    const statements: { readonly sql: string; readonly params?: readonly unknown[] }[] = [];
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

  const plugin: Fts5Plugin = {
    contractVersion: SUPPORTED_SEARCH_PLUGIN_CONTRACT_VERSION,
    id: options.id,
    version: options.version,
    tokenizer,
    ownedObjects: Object.freeze([
      { kind: 'table' as const, name: stateTable, disposition: { kind: 'retained' as const, reason: 'FTS generation state is rebuilt independently of project rows' }, ddl: [`CREATE TABLE IF NOT EXISTS ${stateTable} (slot TEXT PRIMARY KEY CHECK (slot = 'active'), active INTEGER NOT NULL CHECK (active IN (0, 1)), previous INTEGER NOT NULL CHECK (previous IN (0, 1)));`] },
      ...tables.map((name) => ({
        kind: 'virtual-table' as const,
        name,
        // payload is retained only for exact index/source census comparison. Search
        // queries never select it, so indexed source data cannot leak in a hit.
        disposition: { kind: 'retained' as const, reason: 'FTS index is derived and rebuilt from the source census' },
        ddl: [`CREATE VIRTUAL TABLE IF NOT EXISTS ${name} USING fts5(${[...options.source.fields, `${idColumn} UNINDEXED`, 'payload UNINDEXED'].join(', ')}, tokenize='${tokenizer}');`],
      })),
      // FTS5 creates these physical tables with its virtual table. They are
      // declared individually so the census authorizes FTS's internal writes.
      // Lifecycle creation visits virtual tables first, making these fallback
      // DDL entries no-ops on every healthy boot.
      ...tables.flatMap((table) => ftsShadowNames(table).map((name) => ({
        kind: 'table' as const,
        name,
        disposition: { kind: 'schema-only' as const }, ddl: [`-- ${name} is created by its declared FTS5 virtual table.`],
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
    async search(ctx, request): Promise<SearchPluginSearchResult> {
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
    indexCensus(ctx): SearchCensus {
      const rows = ctx.index.query({ sql: `SELECT ${idColumn} AS id, ${options.source.fields.join(', ')} FROM ${targetTable(ctx)} ORDER BY ${idColumn} ASC` });
      return Object.freeze({ [options.source.entity]: censusOfRows(rows) });
    },
    sourceCensus(ctx): SearchCensus {
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

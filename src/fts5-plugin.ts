// fts5-plugin.ts — declared FTS5 search plugin with deterministic in-memory
// materialization. SQLite owns the query-time virtual tables; the plugin owns
// lifecycle state, validation, snippets, ranking, and parity reporting.

import {
  SUPPORTED_SEARCH_PLUGIN_CONTRACT_VERSION,
  type SearchMaterializeResult,
  type SearchPlugin,
  type SearchPluginContext,
  type SearchPluginSearchResult,
} from './search-plugin.ts';
import { censusOfRows, type SearchShadowCapabilities } from './search-reconcile.ts';

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

export interface Fts5PluginOptions {
  readonly id: string;
  readonly version: string;
  readonly source: Fts5PluginSource;
  readonly tokenizer?: Fts5Tokenizer;
  readonly snippetLength?: number;
}

export interface Fts5SearchHit extends Readonly<Record<string, unknown>> {
  readonly id: string;
  readonly rank: number;
  readonly excerpt: string;
}

export interface Fts5Plugin extends SearchPlugin, SearchShadowCapabilities {
  readonly tokenizer: Fts5Tokenizer;
}

interface IndexedDocument {
  readonly id: string;
  readonly source: Readonly<Record<string, unknown>>;
  readonly text: string;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TOKENIZERS = new Set<Fts5Tokenizer>(['unicode61', 'porter', 'trigram']);

function assertIdentifier(value: string, label: string): void {
  if (!IDENTIFIER.test(value)) throw new TypeError(`FTS5 ${label} must be a SQLite identifier`);
}

function tableName(entity: string, field: string): string {
  return `${entity}_${field}_fts`;
}

function ownerColumn(entity: string): string {
  return `${entity}_id`;
}

// Shared with the legacy side-table strategy while it is migrated onto plugins.
export function fts5TableDdl(entity: string, field: string, tokenizer?: Fts5Tokenizer): string {
  assertIdentifier(entity, 'entity');
  assertIdentifier(field, 'field');
  if (tokenizer !== undefined && !TOKENIZERS.has(tokenizer)) throw new TypeError(`unsupported FTS5 tokenizer '${tokenizer}'`);
  const configuredTokenizer = tokenizer === undefined ? '' : `, tokenize='${tokenizer}'`;
  return `CREATE VIRTUAL TABLE IF NOT EXISTS ${tableName(entity, field)} USING fts5(${field}, ${ownerColumn(entity)} UNINDEXED${configuredTokenizer});`;
}

function tokens(query: string): readonly string[] {
  if (typeof query !== 'string' || query.trim().length === 0) {
    throw new Fts5QueryValidationError('FTS5 query must be a non-empty string');
  }
  let quoted = false;
  let depth = 0;
  for (let index = 0; index < query.length; index += 1) {
    const char = query[index];
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === '(') depth += 1;
    else if (!quoted && char === ')' && --depth < 0) throw new Fts5QueryValidationError('FTS5 query has an unmatched closing parenthesis');
  }
  if (quoted) throw new Fts5QueryValidationError('FTS5 query has an unterminated quoted phrase');
  if (depth !== 0) throw new Fts5QueryValidationError('FTS5 query has an unmatched opening parenthesis');
  const values = query
    .replace(/[():*]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((value) => !/^(AND|OR|NOT|NEAR)$/i.test(value));
  if (values.length === 0 || /(?:^|\s)(?:AND|OR|NOT|NEAR)\s*$/i.test(query)) {
    throw new Fts5QueryValidationError('FTS5 query has no searchable terms');
  }
  return Object.freeze(values.map((value) => value.toLocaleLowerCase()));
}

function snippet(text: string, terms: readonly string[], length: number): string {
  const lower = text.toLocaleLowerCase();
  const found = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0);
  const at = found.length === 0 ? 0 : Math.min(...found);
  const start = Math.max(0, at - Math.floor(length / 2));
  const end = Math.min(text.length, start + length);
  return `${start > 0 ? '...' : ''}${text.slice(start, end)}${end < text.length ? '...' : ''}`;
}

function documentOf(row: Readonly<Record<string, unknown>>, fields: readonly string[]): IndexedDocument {
  const id = row.id;
  if (typeof id !== 'string' || id.length === 0) throw new TypeError('FTS5 source row requires a non-empty string id');
  const source = Object.freeze({ ...row });
  return Object.freeze({
    id,
    source,
    text: fields.map((field) => typeof row[field] === 'string' ? row[field] : '').join('\n'),
  });
}

export function createFts5Plugin(options: Fts5PluginOptions): Fts5Plugin {
  assertIdentifier(options.source.entity, 'entity');
  if (options.source.fields.length === 0) throw new TypeError('FTS5 plugin requires at least one source field');
  for (const field of options.source.fields) assertIdentifier(field, 'field');
  const tokenizer = options.tokenizer ?? 'unicode61';
  if (!TOKENIZERS.has(tokenizer)) throw new TypeError(`unsupported FTS5 tokenizer '${tokenizer}'`);
  const snippetLength = options.snippetLength ?? 120;
  if (!Number.isSafeInteger(snippetLength) || snippetLength < 1) throw new TypeError('FTS5 snippetLength must be a positive safe integer');

  let active = new Map<string, IndexedDocument>();
  let shadow: Map<string, IndexedDocument> | null = null;
  const target = () => shadow ?? active;
  const rebuild = (ctx: SearchPluginContext): SearchMaterializeResult => {
    const next = target();
    next.clear();
    for (const row of ctx.reader.rows(options.source.entity)) {
      const document = documentOf(row, options.source.fields);
      next.set(document.id, document);
    }
    return { counts: { documents: next.size } };
  };

  const plugin: Fts5Plugin = {
    contractVersion: SUPPORTED_SEARCH_PLUGIN_CONTRACT_VERSION,
    id: options.id,
    version: options.version,
    tokenizer,
    ownedObjects: Object.freeze(options.source.fields.flatMap((field) => {
      const table = tableName(options.source.entity, field);
      const owner = ownerColumn(options.source.entity);
      return [
        { kind: 'virtual-table' as const, name: table, ddl: [fts5TableDdl(options.source.entity, field, tokenizer)] },
        { kind: 'trigger' as const, name: `${table}_insert`, ddl: [`CREATE TRIGGER IF NOT EXISTS ${table}_insert AFTER INSERT ON ${options.source.entity} BEGIN INSERT INTO ${table} (${field}, ${owner}) VALUES (NEW.${field}, NEW.id); END;`] },
        { kind: 'trigger' as const, name: `${table}_update`, ddl: [`CREATE TRIGGER IF NOT EXISTS ${table}_update AFTER UPDATE OF ${field} ON ${options.source.entity} BEGIN DELETE FROM ${table} WHERE ${owner} = OLD.id; INSERT INTO ${table} (${field}, ${owner}) SELECT NEW.${field}, NEW.id WHERE NEW.${field} IS NOT NULL AND NEW.${field} != ''; END;`] },
        { kind: 'trigger' as const, name: `${table}_delete`, ddl: [`CREATE TRIGGER IF NOT EXISTS ${table}_delete AFTER DELETE ON ${options.source.entity} BEGIN DELETE FROM ${table} WHERE ${owner} = OLD.id; END;`] },
      ];
    })),
    sourceInterests: Object.freeze([{ entity: options.source.entity }]),
    stalenessKey(change) {
      return change.entity === options.source.entity ? `${change.entity}:${change.rowId}` : null;
    },
    prepare() {},
    validate(ctx) {
      for (const row of ctx.reader.rows(options.source.entity)) documentOf(row, options.source.fields);
    },
    reconcile(ctx, changes) {
      const next = target();
      for (const change of changes) {
        if (change.entity !== options.source.entity) continue;
        const row = change.kind === 'removed' ? undefined : ctx.reader.row(change.entity, change.rowId);
        if (row === undefined) next.delete(change.rowId);
        else {
          const document = documentOf(row, options.source.fields);
          next.set(document.id, document);
        }
      }
      return { counts: { documents: next.size } };
    },
    rebuild,
    search(_ctx, request): SearchPluginSearchResult {
      const queryTerms = tokens(request.query as string);
      const scored = [...active.values()].flatMap((document) => {
        const text = document.text.toLocaleLowerCase();
        const score = queryTerms.reduce((total, term) => total + (text.split(term).length - 1), 0);
        return score === 0 ? [] : [{ document, score }];
      });
      const maximum = Math.max(1, ...scored.map((entry) => entry.score));
      const limit = request.limit ?? scored.length;
      const hits = scored
        .sort((left, right) => right.score - left.score || left.document.id.localeCompare(right.document.id))
        .slice(0, Math.max(0, limit))
        .map(({ document, score }) => Object.freeze({ ...document.source, id: document.id, rank: score / maximum, excerpt: snippet(document.text, queryTerms, snippetLength) }));
      return { hits };
    },
    beginShadow() { shadow = new Map(); },
    indexCensus() {
      return Object.freeze({ [options.source.entity]: censusOfRows([...target().values()].map((document) => document.source)) });
    },
    commitShadow() {
      if (shadow === null) throw new Error('FTS5 plugin has no shadow generation to commit');
      active = shadow;
      shadow = null;
    },
    rollbackShadow() {},
    abortShadow() { shadow = null; },
    health(ctx) {
      const source = ctx.reader.rows(options.source.entity).map((row) => Object.freeze({ ...row }));
      const index = [...active.values()].map((document) => document.source);
      const sourceCensus = censusOfRows(source);
      const indexCensus = censusOfRows(index);
      return Object.freeze({ tokenizer, integrity: Object.freeze({ ok: sourceCensus.count === indexCensus.count && sourceCensus.digest === indexCensus.digest, source: sourceCensus, index: indexCensus }) });
    },
  };
  return Object.freeze(plugin);
}

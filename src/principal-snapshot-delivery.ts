import { principalSnapshotScope, parsePrincipalSnapshotScope } from './principal-snapshot-scope.ts';
import { isPrincipalSnapshotDeclaration, type PrincipalSnapshotDeclaration } from './principal-snapshot-declaration.ts';
import type { DbHandle } from './driver.ts';

const PRINCIPAL_PREFIX = 'PrincipalSnapshot:';

export function isPrincipalSnapshotScope(scope: unknown): boolean {
  return typeof scope === 'string' && scope.startsWith(PRINCIPAL_PREFIX);
}

export function validatePrincipalSnapshotDeclarations(
  declarations: PrincipalSnapshotDeclaration[] | undefined,
  schema: { tables: { name: string; columns: { name: string }[] }[] } | null | undefined,
): void {
  if (declarations === undefined) return;
  if (!Array.isArray(declarations)) throw new TypeError('principalSnapshots must be an array');
  if (!schema || !Array.isArray(schema.tables)) throw new Error('principal snapshots require an application schema');
  const names = new Set<string>();
  const tables = new Map<string, Set<string>>(schema.tables.map((table) => [table.name, new Set(table.columns.map((column) => column.name))]));
  for (const declaration of declarations) {
    if (!isPrincipalSnapshotDeclaration(declaration)) throw new TypeError('principalSnapshots accepts only principalSnapshot(...) declarations');
    if (names.has(declaration.name)) throw new Error(`principal snapshot '${declaration.name}' is declared more than once`);
    names.add(declaration.name);
    for (const collection of Object.values(declaration.fields)) {
      if (collection.source!.schema !== schema) throw new Error(`principal snapshot source '${collection.source!.table}' must use the application schema`);
      const columns = tables.get(collection.source!.table);
      if (!columns) throw new Error(`principal snapshot source table '${collection.source!.table}' must be declared in the application schema`);
      for (const field of [collection.via, collection.key, ...(collection.select ?? []), ...(collection.orderBy ?? [])]) {
        if (!columns.has(field!.column)) throw new Error(`principal snapshot source column '${field!.column}' must be declared on '${collection.source!.table}'`);
      }
    }
  }
}

function quote(name: string) {
  return `"${name.replace(/"/g, '""')}"`;
}

function jsonValue(value: unknown, path: string): string | boolean | number | null {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new TypeError(`${path} is not a JSON value`);
}

export interface PrincipalSnapshotPrincipal {
  type: string;
  id: string;
}

export type PrincipalSnapshotOutput = Readonly<Record<string, readonly Readonly<Record<string, unknown>>[]>>;

export interface PrincipalSnapshotResyncEnvelope {
  type: 'resync';
  seq: number;
  reason: string;
}

export interface PrincipalSnapshotSnapshotResult {
  kind: 'snapshot';
  snapshot: PrincipalSnapshotOutput;
  cursor: number;
}

export interface PrincipalSnapshotRetryResult {
  kind: 'retry';
}

export interface PrincipalSnapshotRevokedResult {
  kind: 'revoked';
}

export interface PrincipalSnapshotCatchupResult {
  kind: 'catchup';
  envelopes: readonly PrincipalSnapshotResyncEnvelope[];
  cursor: number;
}

export type PrincipalSnapshotBootstrapResult =
  | PrincipalSnapshotSnapshotResult
  | PrincipalSnapshotRetryResult
  | PrincipalSnapshotRevokedResult;

export type PrincipalSnapshotSubscribeResult =
  | PrincipalSnapshotCatchupResult
  | PrincipalSnapshotSnapshotResult
  | PrincipalSnapshotRetryResult
  | PrincipalSnapshotRevokedResult;

export interface PrincipalSnapshotSubscribeInput {
  principal: PrincipalSnapshotPrincipal | null | undefined;
  scope: string;
  after: number;
  signal?: AbortSignal | null;
  deliver(envelopes: readonly PrincipalSnapshotResyncEnvelope[]): Promise<void> | void;
  revoke?: (() => void) | null;
}

export interface PrincipalSnapshotActivation {
  activate(): Promise<number | undefined>;
}

export interface PrincipalSnapshotDelivery {
  bootstrap(options: { principal: PrincipalSnapshotPrincipal | null | undefined; scope: string }): Promise<PrincipalSnapshotBootstrapResult>;
  catchup(options: { principal: PrincipalSnapshotPrincipal | null | undefined; scope: string; after: number }): Promise<PrincipalSnapshotSubscribeResult>;
  subscribe(options: PrincipalSnapshotSubscribeInput): Promise<PrincipalSnapshotActivation>;
  wake(declaration: PrincipalSnapshotDeclaration | string, principal: PrincipalSnapshotPrincipal): void;
  close(): void;
}

interface ResolvedPrincipalSnapshot {
  declaration: PrincipalSnapshotDeclaration;
  principal: PrincipalSnapshotPrincipal;
}

interface PrincipalSnapshotSubscriptionEntry {
  declaration: PrincipalSnapshotDeclaration;
  principal: PrincipalSnapshotPrincipal;
  scope: string;
  cursor: number;
  deliver(envelopes: readonly PrincipalSnapshotResyncEnvelope[]): Promise<void> | void;
  revoke?: (() => void) | null;
  signal?: AbortSignal | null;
  active: boolean;
  pending: boolean;
  dirty: boolean;
  abort: () => void;
}

function revisionFor(db: DbHandle, declaration: PrincipalSnapshotDeclaration, principal: PrincipalSnapshotPrincipal): number {
  const row = db.prepare(
    'SELECT revision FROM _PrincipalSnapshotRevision WHERE declaration = ? AND principalType = ? AND principalId = ?',
  ).get(declaration.name, principal.type, principal.id) as { revision?: unknown } | undefined;
  return Number(row?.revision ?? 0);
}

function project(db: DbHandle, declaration: PrincipalSnapshotDeclaration, principal: PrincipalSnapshotPrincipal): PrincipalSnapshotOutput {
  const output: Record<string, readonly Readonly<Record<string, unknown>>[]> = {};
  for (const [name, collection] of Object.entries(declaration.fields)) {
    const selected = collection.select!.map((field) => field.column);
    const columns = selected.includes(collection.key!.column) ? selected : [...selected, collection.key!.column];
    const ordering = collection.orderBy?.length
      ? collection.orderBy.map((field) => `${quote(field.column)} ${field.direction === 'desc' ? 'DESC' : 'ASC'}`).join(', ')
      : `${quote(collection.key!.column)} ASC`;
    const sql = `SELECT ${columns.map(quote).join(', ')} FROM ${quote(collection.source!.table)} WHERE ${quote(collection.via!.column)} = ? ORDER BY ${ordering}`;
    const rows = db.prepare(sql).all(principal.id).map((raw, rowIndex) => {
      const row: Record<string, unknown> = {};
      for (const column of columns) row[column] = jsonValue(raw[column], `${name}[${rowIndex}].${column}`);
      return Object.freeze(row);
    });
    output[name] = Object.freeze(rows);
  }
  return Object.freeze(output);
}

function resolution(
  declarations: Map<string, PrincipalSnapshotDeclaration>,
  principal: PrincipalSnapshotPrincipal | null | undefined,
  scope: string,
): ResolvedPrincipalSnapshot | null {
  let parsed;
  try {
    parsed = parsePrincipalSnapshotScope(scope);
  } catch {
    return null;
  }
  const declaration = declarations.get(parsed.declaration);
  if (!declaration || principal?.type !== parsed.type || principal?.id !== parsed.id || declaration.principalType !== parsed.type) return null;
  return Object.freeze({ declaration, principal: Object.freeze({ type: parsed.type, id: parsed.id }) });
}

export function createPrincipalSnapshotDelivery({ db, declarations }: {
  db: DbHandle | null | undefined;
  declarations?: readonly PrincipalSnapshotDeclaration[] | null;
}): PrincipalSnapshotDelivery {
  if (!db) throw new TypeError('principal snapshot delivery requires a database');
  const database = db;
  const byName = new Map<string, PrincipalSnapshotDeclaration>();
  for (const declaration of declarations ?? []) {
    if (!isPrincipalSnapshotDeclaration(declaration) || byName.has(declaration.name)) {
      throw new TypeError('principal snapshot delivery requires unique valid declarations');
    }
    byName.set(declaration.name, declaration);
  }
  const subs = new Map<number, PrincipalSnapshotSubscriptionEntry>();
  const byScope = new Map<string, Set<number>>();
  let nextId = 1;
  let closed = false;

  function pairedSnapshot(resolved: ResolvedPrincipalSnapshot): PrincipalSnapshotSnapshotResult | PrincipalSnapshotRetryResult {
    // Both reads are synchronous. The fence prevents returning source rows from a
    // different recipient revision if a host transaction interleaves between them.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = revisionFor(database, resolved.declaration, resolved.principal);
      const snapshot = project(database, resolved.declaration, resolved.principal);
      const after = revisionFor(database, resolved.declaration, resolved.principal);
      if (before === after) return Object.freeze({ kind: 'snapshot', snapshot, cursor: after });
    }
    return Object.freeze({ kind: 'retry' });
  }

  // Singular lifecycle: every removal path (abort signal, drain failure, close)
  // flows through here. It marks the subscription inactive, detaches its abort
  // listener, removes it from the registries, then invokes the transport revoke
  // exactly once so the SSE stream ends and its capacity is released. The
  // subs.get guard makes later removals, aborts, and close() calls no-ops, so
  // nothing double-releases.
  function remove(id: number) {
    const sub = subs.get(id);
    if (!sub) return;
    sub.active = false;
    if (sub.signal && sub.abort) sub.signal.removeEventListener('abort', sub.abort);
    subs.delete(id);
    const scopeSubs = byScope.get(sub.scope);
    scopeSubs?.delete(id);
    if (scopeSubs?.size === 0) byScope.delete(sub.scope);
    try {
      sub.revoke?.();
    } catch {
      // Transport lifecycle callbacks are isolated.
    }
  }

  async function drain(id: number) {
    const sub = subs.get(id);
    if (!sub || !sub.active || sub.pending) return;
    sub.pending = true;
    try {
      while (sub.active) {
        sub.dirty = false;
        const revision = revisionFor(database, sub.declaration, sub.principal);
        if (revision > sub.cursor) {
          await sub.deliver([{ type: 'resync', seq: revision, reason: 'recipient-snapshot-required' }]);
          if (!sub.active) return;
          sub.cursor = revision;
        }
        if (!sub.dirty) return;
      }
    } catch (error) {
      remove(id);
      throw error;
    } finally {
      const current = subs.get(id);
      if (current) {
        current.pending = false;
        if (current.active && current.dirty) void drain(id).catch(() => {});
      }
    }
  }

  return Object.freeze({
    async bootstrap({ principal, scope }: { principal: PrincipalSnapshotPrincipal | null | undefined; scope: string }): Promise<PrincipalSnapshotBootstrapResult> {
      if (closed) throw new Error('principal snapshot delivery is closed');
      const resolved = resolution(byName, principal, scope);
      return resolved ? pairedSnapshot(resolved) : Object.freeze({ kind: 'revoked' });
    },
    async catchup({ principal, scope, after }: { principal: PrincipalSnapshotPrincipal | null | undefined; scope: string; after: number }): Promise<PrincipalSnapshotSubscribeResult> {
      if (closed) throw new Error('principal snapshot delivery is closed');
      const resolved = resolution(byName, principal, scope);
      if (!resolved) return Object.freeze({ kind: 'revoked' });
      if (!Number.isSafeInteger(after) || after < 0) throw new Error('after must be a nonnegative safe integer');
      const revision = revisionFor(database, resolved.declaration, resolved.principal);
      return after === revision
        ? Object.freeze({ kind: 'catchup', envelopes: Object.freeze([]), cursor: revision })
        : pairedSnapshot(resolved);
    },
    async subscribe({ principal, scope, after, signal, deliver, revoke }: PrincipalSnapshotSubscribeInput): Promise<PrincipalSnapshotActivation> {
      if (closed) throw new Error('principal snapshot delivery is closed');
      const resolved = resolution(byName, principal, scope);
      if (!resolved) {
        const error: Error & { code?: string } = new Error('principal snapshot subscription denied');
        error.code = 'live-delivery-revoked';
        throw error;
      }
      if (!Number.isSafeInteger(after) || after < 0 || typeof deliver !== 'function') throw new Error('invalid principal snapshot subscription');
      if (signal?.aborted) return { activate: async () => undefined };
      const id = nextId++;
      const sub: PrincipalSnapshotSubscriptionEntry = {
        ...resolved,
        scope,
        cursor: after,
        deliver,
        revoke,
        signal,
        active: true,
        pending: false,
        dirty: false,
        abort: () => remove(id),
      };
      subs.set(id, sub);
      const scopeSubs = byScope.get(scope) ?? new Set();
      scopeSubs.add(id);
      byScope.set(scope, scopeSubs);
      signal?.addEventListener('abort', sub.abort, { once: true });
      return Object.freeze({ activate: async () => { await drain(id); return subs.get(id)?.cursor; } });
    },
    wake(declaration: PrincipalSnapshotDeclaration | string, principal: PrincipalSnapshotPrincipal) {
      if (closed) return;
      const scope = typeof declaration === 'string' ? declaration : principalSnapshotScope({ declaration: declaration.name, principal });
      for (const id of [...(byScope.get(scope) ?? [])]) {
        const sub = subs.get(id);
        if (!sub || !sub.active) continue;
        sub.dirty = true;
        void drain(id).catch(() => {});
      }
    },
    close() {
      closed = true;
      for (const id of [...subs.keys()]) remove(id);
    },
  });
}

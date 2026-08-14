// Transport-neutral collection delivery. A refresh materializes the current
// bounded, admitted result then reports membership/order changes as one delta.

import { mayRow } from './row-grant.ts';
import { projectRowForRecipient } from './entity/projection.ts';
import type { AuthorizationAdapter } from './authorization-adapter.ts';
import type { Principal } from './principal.ts';
import type { LiveDatabase, LiveEntityRecord, MayVerb } from './live-fanout.ts';
import { compileSubscriptionRule } from './subscription-rule.ts';
import type { CompiledSubscriptionRule, SubscriptionRule } from './subscription-rule.ts';

export class CollectionSubscriptionBackpressureError extends Error {
  constructor(message: string) { super(message); this.name = 'CollectionSubscriptionBackpressureError'; }
}

export interface CollectionChange {
  readonly type: 'collection';
  readonly additions: readonly Record<string, unknown>[];
  readonly removals: readonly string[];
  readonly reorderings: readonly { id: string; from: number; to: number }[];
  readonly rows: readonly Record<string, unknown>[];
  readonly overflow: unknown | null;
}

export interface CollectionSubscription {
  refresh(): Promise<CollectionChange | null>;
  notify(): Promise<void>;
  close(): void;
  readonly pendingDeliveries: number;
}

export interface CollectionSubscriptionOptions {
  db: LiveDatabase;
  entity: LiveEntityRecord;
  principal: Principal;
  rule: SubscriptionRule | CompiledSubscriptionRule;
  mayVerb: MayVerb;
  authorization?: AuthorizationAdapter | null;
  deliver(change: CollectionChange): unknown | Promise<unknown>;
  maxPendingDeliveries?: number;
}

function isCompiled(rule: SubscriptionRule | CompiledSubscriptionRule): rule is CompiledSubscriptionRule {
  return 'sql' in rule && 'params' in rule;
}

export function createCollectionSubscription({ db, entity, principal, rule, mayVerb, authorization = null, deliver, maxPendingDeliveries = 16 }: CollectionSubscriptionOptions): CollectionSubscription {
  if (!Number.isSafeInteger(maxPendingDeliveries) || maxPendingDeliveries < 1) throw new Error('maxPendingDeliveries must be a positive integer.');
  if (typeof deliver !== 'function') throw new Error('collection subscription deliver must be a function.');
  const compiled = isCompiled(rule) ? rule : compileSubscriptionRule(rule, entity);
  let previous: Record<string, unknown>[] = [];
  let closed = false;
  let pending = 0;
  let tail = Promise.resolve();

  async function admittedRows(): Promise<{ rows: Record<string, unknown>[]; overflow: unknown | null }> {
    const { sql: scopeSql, params: scopeParams } = entity.scopeFilter(principal);
    // The compiled rule is server-produced and the scope predicate is framework-
    // produced. Their conjunction is the only collection query path.
    const sql = compiled.sql.includes(' WHERE ')
      ? compiled.sql.replace(' ORDER BY ', ` AND (${scopeSql}) ORDER BY `)
      : compiled.sql.replace(' ORDER BY ', ` WHERE (${scopeSql}) ORDER BY `);
    const raw = db.prepare(sql).all({ ...compiled.params, ...scopeParams });
    const overflow = raw.length > compiled.boundedResultPolicy.limit ? compiled.boundedResultPolicy.overflowMarker ?? true : null;
    const rows: Record<string, unknown>[] = [];
    for (const value of raw.slice(0, compiled.boundedResultPolicy.limit)) {
      const hydrated = entity.hydrate ? entity.hydrate(value, principal) : value;
      if (!hydrated) continue;
      const allowed = authorization
        ? (await authorization.admit({ category: 'entity', verb: 'read', operation: 'read', principal, entity: entity as never, row: hydrated, resourceId: String(hydrated.id ?? '') })).admitted
        : await mayRow(entity as never, 'read', hydrated, principal, mayVerb as never);
      if (!allowed) continue;
      const projected = await projectRowForRecipient(entity as never, hydrated, principal, { authorization });
      rows.push(Object.fromEntries(Object.entries(projected).filter(([field]) => compiled.select.includes(field))));
    }
    return { rows, overflow };
  }

  async function refresh(): Promise<CollectionChange | null> {
    if (closed) return null;
    const { rows, overflow } = await admittedRows();
    const before = new Map(previous.map((row, index) => [String(row.id), index]));
    const after = new Map(rows.map((row, index) => [String(row.id), index]));
    const additions = rows.filter((row) => !before.has(String(row.id)));
    const removals = previous.filter((row) => !after.has(String(row.id))).map((row) => String(row.id));
    const reorderings = rows.flatMap((row, to) => {
      const from = before.get(String(row.id));
      return from !== undefined && from !== to ? [{ id: String(row.id), from, to }] : [];
    });
    const changed = additions.length > 0 || removals.length > 0 || reorderings.length > 0 || JSON.stringify(previous) !== JSON.stringify(rows);
    previous = rows;
    if (!changed && overflow === null) return null;
    return Object.freeze({ type: 'collection', additions: Object.freeze(additions), removals: Object.freeze(removals), reorderings: Object.freeze(reorderings), rows: Object.freeze(rows), overflow });
  }

  function notify(): Promise<void> {
    if (closed) return Promise.resolve();
    if (pending >= maxPendingDeliveries) return Promise.reject(new CollectionSubscriptionBackpressureError('Collection subscription pending-delivery limit exceeded.'));
    pending += 1;
    const run = async () => {
      try {
        const change = await refresh();
        if (change) await deliver(change);
      } finally {
        pending -= 1;
      }
    };
    const result = tail.then(run, run);
    tail = result.catch(() => {});
    return result;
  }

  return {
    refresh,
    notify,
    close: () => { closed = true; },
    get pendingDeliveries() { return pending; },
  };
}

// A connection-owned cap kept separate from the ordinary resource fan-out cap.
export function createCollectionSubscriptionRegistry(maxSubscriptionsPerConnection = 32): { add(connection: object, subscription: CollectionSubscription): void; remove(connection: object, subscription: CollectionSubscription): void; count(connection: object): number } {
  const subscriptions = new WeakMap<object, Set<CollectionSubscription>>();
  return {
    add(connection, subscription) {
      const current = subscriptions.get(connection) ?? new Set<CollectionSubscription>();
      if (current.size >= maxSubscriptionsPerConnection && !current.has(subscription)) throw new CollectionSubscriptionBackpressureError('Collection subscription limit exceeded.');
      current.add(subscription);
      subscriptions.set(connection, current);
    },
    remove(connection, subscription) { subscriptions.get(connection)?.delete(subscription); },
    count(connection) { return subscriptions.get(connection)?.size ?? 0; },
  };
}

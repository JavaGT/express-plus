// LIVE DELIVERY CORE — package-private transport-neutral committed event delivery core.
//
// One subscription = one async stream of committed events, re-authorised per batch.
// The core reads committed events via _Log/readSince, projects them through the
// injected projector, and delivers them to the subscriber's async deliver callback.
// The subscriber's in-memory cursor advances only after successful delivery.
// wake(scope) is a payloadless hint to re-check for new events.
//
// Each subscription owns an opaque record and cursor. Multiple subscriptions on the
// same scope are independent — they cannot share or replace each other's cursor.
// Per-subscription dirty/generation loop ensures that a wake arriving during an
// active read/delivery triggers a second canonical reread before quiescence.
//
// After close() or removeSub, the active flag prevents any further delivery —
// closed subscriptions cannot project, deliver, or advance their cursor.
//
// Cursor safety: the cursor is advanced only after a successful delivery callback.
// If delivery rejects, the subscription is removed, the cursor is NOT advanced,
// and a resubscribe starting from the same after cursor will re-deliver the event.
// If the WebSocket closes during delivery, the same invariant applies — the
// subscriber's deliver callback should reject (or the subscription is removed by
// the owning LiveConnection's abort signal), so the cursor never advances for an
// undelivered event.
//
// Empty projection: when projectRecipient returns an empty array for all events
// in a batch, the cursor IS advanced (the events were successfully processed, just
// nothing needed to be sent to the client). This is correct for filter-only
// projectors that suppress certain event types — the consumer has acknowledged
// them and should not re-deliver on reconnect.

import { readSeq, readSince } from './committed-log.ts';
import { EventKind, parseEventType } from './event-handle.ts';
import { mayRow } from './row-grant.ts';
import type { AuthorizationAdapter } from './authorization-adapter.ts';
import { tryParseScopeKey } from './scope-handle.ts';
import type { ScopeHandle } from './scope-handle.ts';
import type { Principal } from './principal.ts';
import type { FrameworkLog } from './log.ts';
import type { LiveDatabase, LiveEntityRecord, MayVerb } from './live-fanout.ts';

let nextSubId = 1;

function generateSubId(): number {
  return nextSubId++;
}

function deniedError(scope: string): Error & { code?: string } {
  const error = new Error(`subscribe authorization denied for scope '${scope}'`);
  (error as { code?: string }).code = 'live-delivery-revoked';
  return error;
}

export interface CoreProjectContext {
  readonly entity: LiveEntityRecord;
  readonly event: Readonly<Record<string, unknown>>;
  readonly principal: Principal;
  readonly row: Record<string, unknown> | null | undefined;
  readonly scope: string;
  readonly document: unknown;
}

export interface LiveDeliveryCoreOptions {
  db: LiveDatabase;
  entities: Map<string, LiveEntityRecord> | ((name: string) => LiveEntityRecord | undefined);
  mayVerb: MayVerb | null;
  authorization?: AuthorizationAdapter | null;
  projectRecipient: (ctx: CoreProjectContext) => unknown | Promise<unknown>;
  scopeVisible?: (ctx: { entity: LiveEntityRecord; principal: Principal; scope: ScopeHandle }) => boolean;
  log?: FrameworkLog | null;
}

interface CoreSub {
  entityRec: LiveEntityRecord;
  principal: Principal;
  deliver: (batch: unknown[]) => unknown | Promise<unknown>;
  revoke: (() => void) | null;
  signal: AbortSignal | undefined;
  cursor: number;
  pending: boolean;
  dirty: boolean;
  paused: boolean;
  scope: string;
  active: boolean;
  document: unknown;
  activation?: Promise<number>;
  resyncEnvelope?: unknown;
  _abortHandler?: () => void;
}

export interface CoreSubscribeInput {
  principal: Principal;
  scope: string;
  after?: number;
  signal?: AbortSignal;
  deliver: (batch: unknown[]) => unknown | Promise<unknown>;
  revoke?: (() => void) | null;
  paused?: boolean;
  allowTerminal?: boolean;
  document?: unknown;
}

export interface CoreActivation {
  activate(): Promise<number | undefined>;
  // Explicit non-terminal teardown for one subscription: detaches without
  // invoking the transport revoke. The connection and its other scopes stay
  // alive. Terminal removal (abort, error, auth denial, close) goes through
  // the core's removeSub path instead, which detaches then revokes once.
  // Absent on admission-denial shims that installed no subscription.
  unsubscribe?(): void;
}

export type CoreBootstrapResult =
  | { kind: 'snapshot'; snapshot: unknown; cursor: number }
  | { kind: 'revoked' };

export type CoreCatchupResult =
  | { kind: 'catchup'; envelopes: unknown[]; cursor: number | undefined }
  | { kind: 'revoked' };

export interface LiveDeliveryCore {
  bootstrap(input: { principal: Principal; scope: string; snapshot: (ctx: { principal: Principal; scope: string }) => unknown | Promise<unknown> }): Promise<CoreBootstrapResult>;
  catchup(input: { principal: Principal; scope: string; after?: number; document?: unknown }): Promise<CoreCatchupResult>;
  subscribe(input: CoreSubscribeInput): Promise<CoreActivation | undefined>;
  wake(scope: string): void;
  resync(scope: string, envelope: unknown): void;
  resyncEntity(entityName: string, envelopeForScope: (scope: string) => unknown): void;
  close(): void;
  snapshot(input: { principal: Principal; scope: string }): Record<string, unknown>;
  exceedsCatchupLimit(scope: string, after: number, limit: number): boolean;
}

export function createLiveDeliveryCore({ db, entities, mayVerb, authorization, projectRecipient, scopeVisible = () => true, log = null }: LiveDeliveryCoreOptions): LiveDeliveryCore {
  if (!db) throw new Error('live-delivery-core: db is required');
  if (!entities) throw new Error('live-delivery-core: entities is required');
  if (!mayVerb) throw new Error('live-delivery-core: mayVerb is required');
  if (typeof projectRecipient !== 'function') throw new Error('live-delivery-core: projectRecipient must be a function');

  const resolveEntity = typeof entities === 'function' ? entities : (name: string) => entities.get(name);
  const subs = new Map<number, CoreSub>();
  const byScope = new Map<string, Set<number>>();
  let closed = false;

  function entityRecord(name: string): LiveEntityRecord {
    const record = resolveEntity(name);
    if (!record) throw new Error(`unknown entity '${name}'`);
    return record;
  }

  async function authorizeSnapshot(principal: Principal, scope: string): Promise<boolean> {
    const handle = tryParseScopeKey(scope);
    if (!handle) throw new Error(`invalid scope '${scope}'`);
    let entityRec: LiveEntityRecord;
    try {
      entityRec = entityRecord(handle.entity);
    } catch {
      log?.error?.('live', 'entity not found', { scope, entity: handle.entity });
      return false;
    }
    const auth = reauthFor(entityRec, principal, handle);
    if (!auth || !(await checkMayRow(entityRec, auth.row, principal))) {
      log?.error?.('live', 'bootstrap denied', { scope });
      return false;
    }
    return true;
  }

  async function bootstrap({ principal, scope, snapshot }: { principal: Principal; scope: string; snapshot: (ctx: { principal: Principal; scope: string }) => unknown | Promise<unknown> }): Promise<CoreBootstrapResult> {
    if (closed) throw new Error('live-delivery-core is closed');
    if (typeof snapshot !== 'function') throw new Error('live delivery bootstrap requires a snapshot function');
    if (!(await authorizeSnapshot(principal, scope))) return { kind: 'revoked' };
    // Close can land on the awaited authorization await. Recheck so a closed
    // core never returns recipient state.
    if (closed) throw new Error('live-delivery-core is closed');
    // A materializer may await recipient authorization. If a commit interleaves,
    // reject rather than return a snapshot/cursor pair from different states.
    const before = readSeq(db, scope);
    const value = await snapshot({ principal, scope });
    const cursor = readSeq(db, scope);
    // A materializer is a synchronous read projection. Letting it commit while
    // materializing would make its returned state and cursor incomparable.
    if (cursor !== before) throw new Error('live delivery snapshot function must not change its committed cursor');
    // Authorization can await application policy. Recheck after the synchronous
    // snapshot/cursor pair so a revocation during the first check never returns
    // recipient state; a later committed change is caught up from this cursor.
    if (!(await authorizeSnapshot(principal, scope))) return { kind: 'revoked' };
    if (closed) throw new Error('live-delivery-core is closed');
    return { kind: 'snapshot', snapshot: value, cursor };
  }

  function snapshot({ principal, scope }: { principal: Principal; scope: string }): Record<string, unknown> {
    const handle = tryParseScopeKey(scope);
    if (!handle) throw new Error(`invalid scope '${scope}'`);
    const entityRec = entityRecord(handle.entity);
    const auth = reauthFor(entityRec, principal, handle);
    if (!auth) throw deniedError(scope);
    return auth.row;
  }

  function exceedsCatchupLimit(scope: string, after: number, limit: number): boolean {
    const row = db.prepare('SELECT COUNT(*) AS count FROM _Log WHERE scope = :scope AND seq > :after')
      .get({ scope, after });
    return Number(row?.count ?? 0) > limit;
  }

  function reauthFor(entityRec: LiveEntityRecord, principal: Principal, handle: ScopeHandle): { row: Record<string, unknown> } | null {
    try {
      if (!scopeVisible({ entity: entityRec, principal, scope: handle })) return null;
      const { sql: where, params: scopeParams } = entityRec.scopeFilter(principal);
      const raw = db.prepare(`SELECT * FROM ${entityRec.name} AS t0 WHERE ${where} AND t0.id = :id`).get({ ...scopeParams, id: handle.id });
      if (!raw) return null;
      // When hydrate is explicitly declared as a non-function (undefined/null),
      // fail closed — no raw row fallback. When hydrate is absent (compiled
      // entities without bind), use the raw row directly.
      if ('hydrate' in entityRec && typeof entityRec.hydrate !== 'function') return null;
      const row = typeof entityRec.hydrate === 'function' ? entityRec.hydrate(raw, principal) : raw;
      if (row === null || row === undefined) return null;
      return { row };
    } catch (err) {
      log?.error?.('live', 'reauthFor failed', { scope: handle.key, err: String(err) });
      return null;
    }
  }

  async function checkMayRow(entityRec: LiveEntityRecord, row: Record<string, unknown>, principal: Principal): Promise<boolean> {
    try {
      // Re-authorization goes through the injected authorization adapter (S5/A2)
      // when one is wired — the SAME seam subscribe-time admission uses — so a
      // policy adapter owns both ends of the live path (the ticket's single-path
      // requirement). Without an adapter the framework row-grant runs, unchanged.
      if (authorization) {
        const decision = await authorization.admit({
          category: 'entity',
          verb: 'subscribe',
          operation: 'subscribe',
          principal,
          entity: entityRec as never,
          row,
          resourceId: (row as { id?: unknown } | null | undefined)?.id as string | null | undefined,
        });
        return decision.admitted;
      }
      return await mayRow(entityRec as never, 'subscribe', row, principal, mayVerb as never);
    } catch {
      return false;
    }
  }

  function isTerminalRemoval(event: { eventType?: unknown; type?: unknown }, entityName: string): boolean {
    try {
      const type = event.eventType ?? event.type;
      const handle = parseEventType(type as string);
      return handle.entity === entityName && handle.kind === EventKind.removed;
    } catch {
      return false;
    }
  }

  // Shared internal detach: marks the subscription inactive, detaches its abort
  // listener, and removes it from the registries. Both lifecycle paths share it
  // — an explicit per-scope unsubscribe detaches without any transport revoke,
  // while the terminal path (removeSub) follows detach with revoke exactly once.
  function detachSub(subId: number): CoreSub | undefined {
    const sub = subs.get(subId);
    if (!sub) return undefined;
    sub.active = false;
    if (sub.signal && typeof sub.signal.removeEventListener === 'function') {
      try { sub.signal.removeEventListener('abort', sub._abortHandler as () => void); } catch { /* ignore */ }
    }
    subs.delete(subId);
    const set = byScope.get(sub.scope);
    if (set) {
      set.delete(subId);
      if (set.size === 0) byScope.delete(sub.scope);
    }
    return sub;
  }

  // Singular terminal lifecycle: every terminal removal path (read/projection/
  // delivery error, terminal removal, abort, close) flows through here. It
  // detaches then invokes the transport revoke exactly once so SSE ends and its
  // capacity releases. The subs.get guard makes later removals, aborts, and
  // close() calls no-ops, so nothing double-releases.
  function removeSub(subId: number): void {
    const sub = detachSub(subId);
    if (!sub) return;
    try { sub.revoke?.(); } catch { /* transport lifecycle callbacks are isolated */ }
  }

  async function catchUp(subId: number): Promise<void> {
    const sub = subs.get(subId);
    if (!sub || !sub.active) return;
    if (sub.paused) {
      sub.dirty = true;
      return;
    }
    sub.pending = true;
    try {
      while (true) {
        if (!sub.active) return;
        sub.dirty = false;
        const handle = tryParseScopeKey(sub.scope);
        if (!handle) { removeSub(subId); log?.error?.('live', 'invalid scope', { scope: sub.scope }); throw new Error(`invalid scope '${sub.scope}'`); }
        let events: Array<{ seq: number } & Readonly<Record<string, unknown>>>;
        try {
          events = readSince(db as never, sub.scope, sub.cursor) as unknown as Array<{ seq: number } & Readonly<Record<string, unknown>>>;
        } catch (err) {
          log?.error?.('live', 'readSince failed', { scope: sub.scope, cursor: sub.cursor, err: String(err) });
          removeSub(subId);
          throw new Error(`readSince failed for scope '${sub.scope}'`);
        }
        const auth = reauthFor(sub.entityRec, sub.principal, handle);
        // A removal deletes its authorization subject, so it cannot be
        // re-authorized against a current row. Without that row, only terminal
        // removals for this entity may be projected; other committed rows in
        // the catch-up batch stay fail-closed. The terminal subscription is
        // then removed without acknowledging withheld events.
        const terminalRemoval = !auth && events.length > 0 && events.every((event) => isTerminalRemoval(event as { eventType?: unknown; type?: unknown }, sub.entityRec.name));
        const deliverableEvents = auth
          ? events
          : terminalRemoval ? events : [];
        if (!auth && !terminalRemoval) { removeSub(subId); log?.error?.('live', 'reauth denied', { scope: sub.scope }); return; }
        if (auth && !(await checkMayRow(sub.entityRec, auth.row, sub.principal))) { removeSub(subId); log?.error?.('live', 'mayRow denied', { scope: sub.scope }); return; }
        if (!sub.active) return;
        const resyncEnvelope = sub.resyncEnvelope;
        if (events.length === 0 && !resyncEnvelope) {
          if (sub.dirty) continue;
          return;
        }
        const batch: unknown[] = resyncEnvelope ? [resyncEnvelope] : [];
        for (const event of deliverableEvents) {
          if (!sub.active) return;
          const ctx = Object.freeze({
            entity: sub.entityRec,
            event: Object.freeze({ ...event }),
            principal: sub.principal,
            row: auth?.row,
            scope: sub.scope,
            document: sub.document ?? null,
          });
          let projected: unknown;
          try {
            projected = await projectRecipient(ctx);
          } catch (err) {
            log?.error?.('live', 'projectRecipient threw', { scope: sub.scope, seq: event.seq, err: String(err) });
            removeSub(subId);
            throw new Error(`projectRecipient threw for scope '${sub.scope}' seq ${event.seq}`);
          }
          if (!sub.active) return;
          if (!Array.isArray(projected)) {
            log?.error?.('live', 'projectRecipient must return an array', { scope: sub.scope, seq: event.seq });
            removeSub(subId);
            throw new Error(`projectRecipient must return an array for scope '${sub.scope}' seq ${event.seq}`);
          }
          batch.push(...projected);
        }
        if (!sub.active) return;
        // Cursor advances only after successful delivery. If the deliver callback
        // rejects (e.g. WebSocket closed), the subscription is removed, cursor
        // stays at the previous value, and a resubscribe re-delivers the event.
        if (batch.length > 0) {
          try {
            await sub.deliver(batch);
          } catch (err) {
            log?.error?.('live', 'delivery callback threw', { scope: sub.scope, err: String(err) });
            removeSub(subId);
            throw new Error(`delivery callback threw for scope '${sub.scope}'`);
          }
          if (resyncEnvelope && sub.resyncEnvelope === resyncEnvelope) sub.resyncEnvelope = null;
        }
        if (!sub.active) return;
        if (terminalRemoval) {
          // The authorization subject is gone. A terminal removal is the only
          // allowed output, and this subscription cannot acknowledge unrelated
          // earlier events that were withheld by the fail-closed filter.
          sub.cursor = events[events.length - 1].seq;
          removeSub(subId);
          return;
        }
        // Advance cursor past the last event we processed (even if projection
        // returned empty — the events were acknowledged).
        if (events.length > 0) sub.cursor = events[events.length - 1].seq;
        if (sub.dirty) continue;
        return;
      }
    } catch (err) {
      // If we're the outermost catchUp (not a re-entrant dirty wake), re-throw.
      // If this was a re-entrant call from the finally block, we need to make
      // sure the error is not silently swallowed — the subscriber will learn
      // about it via the promise from subscribe() or the removal.
      const sub = subs.get(subId);
      if (sub) {
        // The sub is still active but the loop aborted — remove it.
        removeSub(subId);
      }
      throw err;
    } finally {
      const sub = subs.get(subId);
      if (sub) {
        sub.pending = false;
        if (sub.active && sub.dirty) {
          catchUp(subId).catch(() => {
            // nested catchUp failure — subscription already removed
          });
        }
      }
    }
  }

  async function subscribe({ principal, scope, after = 0, signal, deliver, revoke = null, paused = false, allowTerminal = false, document = null }: CoreSubscribeInput): Promise<CoreActivation | undefined> {
    if (closed) throw new Error('live-delivery-core is closed');
    if (signal?.aborted) return;
    const handle = tryParseScopeKey(scope);
    if (!handle) {
      log?.error?.('live', 'invalid scope', { scope });
      throw new Error(`invalid scope '${scope}'`);
    }
    if (typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0) {
      throw new Error(`after must be a nonnegative safe integer, got ${after}`);
    }
    if (typeof deliver !== 'function') {
      throw new Error('deliver must be a function');
    }
    let entityRec: LiveEntityRecord;
    try {
      entityRec = entityRecord(handle.entity);
    } catch {
      log?.error?.('live', 'entity not found', { scope, entity: handle.entity });
      throw new Error(`entity '${handle.entity}' not found for scope '${scope}'`);
    }
    const auth = reauthFor(entityRec, principal, handle);
    if (!auth) {
      const unread = allowTerminal ? readSince(db as never, scope, after) : [];
      if (unread.length > 0 && unread.every((event) => isTerminalRemoval(event, entityRec.name))) {
        // A catch-up may begin immediately after deletion. Only a fully
        // contiguous suffix of this anchor's terminal removals is safe to
        // deliver without a current authorization row.
      } else {
        log?.error?.('live', 'subscribe denied', { scope });
        throw deniedError(scope);
      }
    }
    if (auth && !(await checkMayRow(entityRec, auth.row, principal))) {
      log?.error?.('live', 'subscribe denied', { scope });
      throw deniedError(scope);
    }
    // Close can land on the awaited admission await. Recheck before insertion
    // so a closed core never installs a stranded subscription.
    if (closed) throw new Error('live-delivery-core is closed');
    const subId = generateSubId();
    const sub: CoreSub = { entityRec, principal, deliver, revoke, signal, cursor: after, pending: false, dirty: false, paused, scope, active: true, document };
    subs.set(subId, sub);
    let set = byScope.get(scope);
    if (!set) { set = new Set(); byScope.set(scope, set); }
    set.add(subId);
    if (signal) {
      const handler = () => { removeSub(subId); };
      sub._abortHandler = handler;
      signal.addEventListener('abort', handler, { once: true });
      if (signal.aborted) {
        removeSub(subId);
        throw new Error('subscription aborted');
      }
    }
    async function activate(): Promise<number | undefined> {
      const current = subs.get(subId);
      if (!current || !current.active) return;
      if (!current.activation) {
        current.activation = (async () => {
          current.paused = false;
          try {
            await catchUp(subId);
          } catch (err) {
            removeSub(subId);
            throw err;
          }
          return current.cursor;
        })();
      }
      return current.activation;
    }
    if (paused) return { activate, unsubscribe: () => detachSub(subId) };
    if (closed) {
      removeSub(subId);
      throw new Error('live-delivery-core is closed');
    }
    await activate();
  }

  async function wake(scope: string): Promise<void> {
    if (closed) return;
    const set = byScope.get(scope);
    if (!set) return;
    for (const subId of set) {
      const sub = subs.get(subId);
      if (!sub || !sub.active) continue;
      if (sub.paused) {
        sub.dirty = true;
        continue;
      }
      if (sub.pending) {
        sub.dirty = true;
      } else {
        catchUp(subId).catch(() => {});
      }
    }
  }

  function resync(scope: string, envelope: unknown): void {
    if (closed) return;
    const set = byScope.get(scope);
    if (!set) return;
    for (const subId of [...set]) {
      const sub = subs.get(subId);
      if (!sub || !sub.active) continue;
      sub.resyncEnvelope = envelope;
      sub.dirty = true;
      if (!sub.paused && !sub.pending) catchUp(subId).catch(() => {});
    }
  }

  function resyncEntity(entityName: string, envelopeForScope: (scope: string) => unknown): void {
    for (const sub of [...subs.values()]) {
      if (sub.entityRec.name !== entityName) continue;
      resync(sub.scope, envelopeForScope(sub.scope));
    }
  }

  function close(): void {
    closed = true;
    // Revoke every active subscription so transport skins (SSE ends its
    // response only via revoke) release their connections. Marking inactive
    // without revoking left sockets open and pinned server.close() forever.
    for (const subId of [...subs.keys()]) {
      removeSub(subId);
    }
    subs.clear();
    byScope.clear();
  }

  async function catchup({ principal, scope, after = 0, document = null }: { principal: Principal; scope: string; after?: number; document?: unknown }): Promise<CoreCatchupResult> {
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new Error(`after must be a nonnegative safe integer, got ${after}`);
    }
    const authorized = await authorizeSnapshot(principal, scope);
    // Close can land on the awaited admission await. Recheck so a closed core
    // never installs the paused catch-up subscription.
    if (closed) throw new Error('live-delivery-core is closed');
    if (!authorized) {
      const handle = tryParseScopeKey(scope);
      const entityRec = handle ? resolveEntity(handle.entity) : null;
      const unread = entityRec ? readSince(db as never, scope, after) : [];
      if (!entityRec || unread.length === 0 || !unread.every((event) => isTerminalRemoval(event, entityRec.name))) {
        return { kind: 'revoked' };
      }
    }
    const controller = new AbortController();
    const envelopes: unknown[] = [];
    let revoked = false;
    let activation: CoreActivation | undefined;
    try {
      activation = await subscribe({
        principal,
        scope,
        after,
        signal: controller.signal,
        paused: true,
        deliver: async (batch: unknown[]) => { envelopes.push(...batch); },
        revoke: () => { revoked = true; },
        allowTerminal: true,
        document,
      });
    } catch (error) {
      controller.abort();
      if ((error as { code?: unknown } | null | undefined)?.code === 'live-delivery-revoked') return { kind: 'revoked' };
      throw error;
    }
    try {
      const cursor = await activation!.activate();
      // A terminal removal delivers its removal envelope first and only then
      // revokes through the one removal path (the row is gone, so the stream
      // legitimately ends). That post-delivery revoke must not turn a delivered
      // catch-up into a revocation — only a revoke that delivered nothing is a
      // genuine revocation (admission/reauth denial before any envelope).
      return revoked && envelopes.length === 0 ? { kind: 'revoked' } : { kind: 'catchup', envelopes, cursor };
    } finally {
      controller.abort();
    }
  }

  return { bootstrap, catchup, subscribe, wake, resync, resyncEntity, close, snapshot, exceedsCatchupLimit };
}

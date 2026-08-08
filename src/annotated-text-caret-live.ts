import { randomUUID } from 'node:crypto';
import { mayRow } from './row-grant.ts';
import { projectAnnotatedTextCaretSnapshot } from './annotated-text-snapshot.ts';
import { scopeOf } from './scope-handle.ts';
import { getAnnotatedTextCompiledMetadata } from './annotated-text-field.ts';

interface CaretConnection {
  id: unknown;
  principal: unknown;
  closed: boolean;
  send(message: unknown): void;
}

interface CaretEntityRecord {
  name: string;
  fields: Record<string, any>;
  scopeFilter(principal: unknown): { sql: string; params: Record<string, unknown> };
  hydrate?: (raw: unknown, principal: unknown) => unknown;
}

interface CaretFanout {
  hasCaretInterest(conn: CaretConnection, scope: string, field: string): boolean;
  recipients(scope: string, field: string): Iterable<[CaretConnection, unknown]>;
  setOnCaretInterestChange?: (callback: (conn: CaretConnection, scope: string, removedFields: string[]) => void) => void;
}

interface CaretSlot {
  connection: CaretConnection;
  entity: string;
  id: string;
  field: string;
  presence: string;
  generation: number;
  recipients: Set<CaretConnection>;
}

interface CaretUpdateMessage {
  type: 'caret.update';
  entity: string;
  id: string;
  field: string;
  offset: number;
}

interface CaretClearMessage {
  type: 'caret.clear';
  entity: string;
  id: string;
  field: string;
}

type MayVerb = (entityRecord: unknown, verb: string, row: unknown, principal: unknown) => Promise<boolean>;

function invalid(message: string): never { throw Object.assign(new Error(message), { status: 400 }); }

function parse(message: unknown): CaretUpdateMessage {
  if (!message || typeof message !== 'object' || Array.isArray(message)) invalid('Invalid caret message.');
  const record = message as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const required = ['entity', 'field', 'id', 'offset', 'type'];
  if (keys.length !== required.length || keys.some((key, index) => key !== required[index]) ||
    record.type !== 'caret.update' || typeof record.entity !== 'string' || typeof record.id !== 'string' ||
    typeof record.field !== 'string' || !Number.isSafeInteger(record.offset) || (record.offset as number) < 0) {
    invalid('Invalid caret message.');
  }
  return message as CaretUpdateMessage;
}

function parseClear(message: unknown): CaretClearMessage {
  if (!message || typeof message !== 'object' || Array.isArray(message)) invalid('Invalid caret message.');
  const record = message as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const required = ['entity', 'field', 'id', 'type'];
  if (keys.length !== required.length || keys.some((key, index) => key !== required[index]) ||
    record.type !== 'caret.clear' || typeof record.entity !== 'string' || typeof record.id !== 'string' || typeof record.field !== 'string') {
    invalid('Invalid caret message.');
  }
  return message as CaretClearMessage;
}

export function createAnnotatedTextCaretLive({ db, resolveEntity, mayVerb, fanout, delay = null }: {
  db: { prepare(sql: string): { get(...args: unknown[]): any; all(...args: unknown[]): any[]; run(...args: unknown[]): { changes: number } } };
  resolveEntity: (name: string) => CaretEntityRecord | null | undefined;
  mayVerb: MayVerb;
  fanout: CaretFanout;
  delay?: number | (() => Promise<unknown>) | null;
}): { update: (conn: CaretConnection, message: unknown) => Promise<void>; clear: (conn: CaretConnection, message: unknown) => Promise<void>; removeConnection: (conn: CaretConnection, scope?: string | null) => Promise<void> } {
  const slots = new Map<string, CaretSlot>();
  const key = (conn: CaretConnection, entity: string, id: string, field: string) => `${conn.id}\0${entity}\0${id}\0${field}`;

  async function rowFor(entity: CaretEntityRecord, id: string, principal: unknown): Promise<{ raw: unknown; row: unknown } | null> {
    const { sql, params } = entity.scopeFilter(principal);
    const raw = db.prepare(`SELECT * FROM ${entity.name} AS t0 WHERE ${sql} AND t0.id = :id`).get({ ...params, id });
    if (!raw) return null;
    const row = entity.hydrate ? entity.hydrate(raw, principal) : raw;
    return await mayRow(entity, 'subscribe', row, principal, mayVerb) ? { raw, row } : null;
  }

  async function update(conn: CaretConnection, message: unknown): Promise<void> {
    const input = parse(message);
    const entity = resolveEntity(input.entity);
    const descriptor = entity?.fields?.[input.field];
    if (!entity || !descriptor || descriptor.kind !== 'annotatedText' || !getAnnotatedTextCompiledMetadata(descriptor)?.caret) invalid('Invalid caret message.');
    const scope = scopeOf(entity.name, input.id).key;
    if (!fanout.hasCaretInterest(conn, scope, input.field)) invalid('Caret subscription is required.');
    const slotKey = key(conn, entity.name, input.id, input.field);

    // Allocate/fence the slot generation BEFORE any async rowFor / projection.
    // A clear, disconnect, or newer update during the async gap bumps the
    // generation, so this batch's results cannot be delivered as stale.
    const slot = slots.get(slotKey) ?? { connection: conn, entity: entity.name, id: input.id, field: input.field, presence: randomUUID(), generation: 0, recipients: new Set<CaretConnection>() };
    slots.set(slotKey, slot);
    const generation = ++slot.generation;

    const source = await rowFor(entity, input.id, conn.principal);
    if (slots.get(slotKey) !== slot || slot.generation !== generation) {
      invalid('Caret update is denied.');
    }
    if (!source) {
      if (slots.get(slotKey) === slot && slot.generation === generation) {
        await retract(slotKey);
      }
      invalid('Caret update is denied.');
    }

    // Presence is stable: same connection/entity/id/field session keeps the
    // same opaque presence until clear or disconnect. A newer update upserts
    // the same presence with a new projected location; clear retracts it.

    // Test-only seam: inject a delay at this point so overlapping async
    // operations can race during the projection window.
    if (delay !== null) {
      const p = typeof delay === 'function' ? delay() : new Promise((resolve) => setTimeout(resolve, delay));
      await p;
      if (slots.get(slotKey) !== slot || slot.generation !== generation) {
        invalid('Caret update is denied.');
      }
    }

    for (const [recipient] of fanout.recipients(scope, input.field)) {
      const recipientState = await rowFor(entity, input.id, recipient.principal);
      if (!recipientState) {
        if (slot.recipients.delete(recipient) && !recipient.closed) {
          recipient.send({ type: 'annotated-text-caret', version: 1, entity: input.entity, id: input.id, field: input.field, change: { op: 'remove', presence: slot.presence } });
        }
        continue;
      }
      try {
        const value = await projectAnnotatedTextCaretSnapshot({ db, entity, row: recipientState.row, principal: recipient.principal, fieldName: input.field, descriptor, caret: { offset: input.offset }, presence: slot.presence });
        if (slots.get(slotKey) !== slot || slot.generation !== generation || recipient.closed || !fanout.hasCaretInterest(recipient, scope, input.field)) continue;
        // Re-authorize immediately before delivery: a subscription/row revoke
        // that landed during the projection window must not deliver on stale
        // access. (The projection itself authorizes against a fresh row, but
        // the send races any revocation between that read and this moment.)
        if (!(await rowFor(entity, input.id, recipient.principal))) {
          if (slot.recipients.delete(recipient) && !recipient.closed) {
            recipient.send({ type: 'annotated-text-caret', version: 1, entity: entity.name, id: input.id, field: input.field, change: { op: 'remove', presence: slot.presence } });
          }
          continue;
        }
        recipient.send({ type: 'annotated-text-caret', version: 1, entity: entity.name, id: input.id, field: input.field, change: { op: 'upsert', value } });
        slot.recipients.add(recipient);
      } catch {
        if (slots.get(slotKey) !== slot || slot.generation !== generation || recipient.closed || !fanout.hasCaretInterest(recipient, scope, input.field)) continue;
        if (slot.recipients.delete(recipient) && !recipient.closed) {
          recipient.send({ type: 'annotated-text-caret', version: 1, entity: entity.name, id: input.id, field: input.field, change: { op: 'remove', presence: slot.presence } });
        }
      }
    }
  }

  function retract(slotKey: string): void {
    const slot = slots.get(slotKey);
    if (!slot) return;
    slots.delete(slotKey);
    ++slot.generation;
    // Fix 4: deliver remove to every previously tracked recipient regardless
    // of current authorization. A remove has only opaque presence; it must
    // reach the recipient without re-evaluating row authorization.
    for (const recipient of slot.recipients) {
      if (!recipient.closed) {
        recipient.send({ type: 'annotated-text-caret', version: 1, entity: slot.entity, id: slot.id, field: slot.field, change: { op: 'remove', presence: slot.presence } });
      }
    }
  }

  async function clear(conn: CaretConnection, message: unknown): Promise<void> {
    const input = parseClear(message);
    // A clear fans out removes to tracked recipients, so it must carry the
    // same declared caret interest and source row authorization as an update
    // (a caller cannot clear presence it never had a right to set).
    const entity = resolveEntity(input.entity);
    const descriptor = entity?.fields?.[input.field];
    if (!entity || !descriptor || descriptor.kind !== 'annotatedText' || !getAnnotatedTextCompiledMetadata(descriptor)?.caret) invalid('Invalid caret message.');
    const scope = scopeOf(entity.name, input.id).key;
    if (!fanout.hasCaretInterest(conn, scope, input.field)) invalid('Caret subscription is required.');
    if (!(await rowFor(entity, input.id, conn.principal))) invalid('Caret clear is denied.');
    // Allocate/fence even on clear so a concurrent stale update cannot
    // resurrect after the slot is removed. If no slot exists, creating a
    // throwaway slot with a new generation still prevents delayed updates.
    const slotKey = key(conn, input.entity, input.id, input.field);
    if (!slots.has(slotKey)) {
      const slot = { connection: conn, entity: input.entity, id: input.id, field: input.field, presence: randomUUID(), generation: 0, recipients: new Set<CaretConnection>() };
      ++slot.generation;
      slots.set(slotKey, slot);
    }
    // Remove the slot and invalidate its generation; any future stale
    // update will see a missing slot (generation mismatch).
    await retract(slotKey);
  }

  async function removeConnection(conn: CaretConnection, scope: string | null = null): Promise<void> {
    const sourceKeys = [...slots.keys()].filter((slotKey) => {
      const slot = slots.get(slotKey);
      if (!slot || slot.connection !== conn) return false;
      if (scope !== null) {
        try { return scope === scopeOf(slot.entity, slot.id).key; } catch { return false; }
      }
      return true;
    });
    for (const slotKey of sourceKeys) {
      await retract(slotKey);
    }
    // Fix 5: remove dead recipient references and retract tokens for this
    // connection on every slot it was a recipient of.
    for (const [, slot] of slots) {
      if (scope !== null) {
        try { if (scope !== scopeOf(slot.entity, slot.id).key) continue; } catch { continue; }
      }
      if (slot.recipients.has(conn) && !conn.closed) {
        conn.send({ type: 'annotated-text-caret', version: 1, entity: slot.entity, id: slot.id, field: slot.field, change: { op: 'remove', presence: slot.presence } });
      }
      slot.recipients.delete(conn);
    }
  }

  // Fix 3: narrow caret transport hook for subscription replacement/removal.
  // When a subscription is replaced (new interest) or removed, the fanout
  // fires this callback with the removed caret fields so we retract tokens.
  fanout.setOnCaretInterestChange?.((conn, scope, removedFields) => {
    for (const [slotKey, slot] of [...slots]) {
      try { if (scope !== scopeOf(slot.entity, slot.id).key) continue; } catch { continue; }
      if (!removedFields.includes(slot.field)) continue;
      if (slot.connection === conn) {
        retract(slotKey);
        continue;
      }
      if (!slot.recipients.has(conn)) continue;
      if (!conn.closed) {
        conn.send({ type: 'annotated-text-caret', version: 1, entity: slot.entity, id: slot.id, field: slot.field, change: { op: 'remove', presence: slot.presence } });
      }
      slot.recipients.delete(conn);
    }
  });

  return { update, clear, removeConnection };
}

import { randomUUID } from 'node:crypto';
import { mayRow } from './row-grant.mjs';
import { projectAnnotatedTextCaretSnapshot } from './annotated-text-snapshot.mjs';
import { scopeOf } from './scope-handle.mjs';
import { getAnnotatedTextCompiledMetadata } from './annotated-text-field.mjs';

function invalid(message) { throw Object.assign(new Error(message), { status: 400 }); }

function parse(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) invalid('Invalid caret message.');
  const keys = Object.keys(message).sort();
  const required = ['blockId', 'entity', 'field', 'id', 'offset', 'type'];
  if (keys.length !== required.length || keys.some((key, index) => key !== required[index]) ||
    message.type !== 'caret.update' || typeof message.entity !== 'string' || typeof message.id !== 'string' ||
    typeof message.field !== 'string' || typeof message.blockId !== 'string' || !Number.isSafeInteger(message.offset) || message.offset < 0) {
    invalid('Invalid caret message.');
  }
  return message;
}

function parseClear(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) invalid('Invalid caret message.');
  const keys = Object.keys(message).sort();
  const required = ['entity', 'field', 'id', 'type'];
  if (keys.length !== required.length || keys.some((key, index) => key !== required[index]) ||
    message.type !== 'caret.clear' || typeof message.entity !== 'string' || typeof message.id !== 'string' || typeof message.field !== 'string') {
    invalid('Invalid caret message.');
  }
  return message;
}

export function createAnnotatedTextCaretLive({ db, resolveEntity, mayVerb, fanout, delay = null }) {
  const slots = new Map();
  const key = (conn, entity, id, field) => `${conn.id}\0${entity}\0${id}\0${field}`;

  async function rowFor(entity, id, principal) {
    const { sql, params } = entity.scopeFilter(principal);
    const raw = db.prepare(`SELECT * FROM ${entity.name} AS t0 WHERE ${sql} AND t0.id = :id`).get({ ...params, id });
    if (!raw) return null;
    const row = entity.hydrate ? entity.hydrate(raw, principal) : raw;
    return await mayRow(entity, 'subscribe', row, principal, mayVerb) ? { raw, row } : null;
  }

  async function update(conn, message) {
    const input = parse(message);
    const entity = resolveEntity(input.entity);
    const descriptor = entity?.fields?.[input.field];
    if (!descriptor || descriptor.kind !== 'annotatedText' || !getAnnotatedTextCompiledMetadata(descriptor)?.caret) invalid('Invalid caret message.');
    const scope = scopeOf(entity.name, input.id).key;
    if (!fanout.hasCaretInterest(conn, scope, input.field)) invalid('Caret subscription is required.');
    const slotKey = key(conn, entity.name, input.id, input.field);

    // Allocate/fence the slot generation BEFORE any async rowFor / projection.
    // A clear, disconnect, or newer update during the async gap bumps the
    // generation, so this batch's results cannot be delivered as stale.
    const slot = slots.get(slotKey) ?? { connection: conn, entity: entity.name, id: input.id, field: input.field, presence: randomUUID(), generation: 0, recipients: new Set() };
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
        const value = await projectAnnotatedTextCaretSnapshot({ db, entity, row: recipientState.row, principal: recipient.principal, fieldName: input.field, descriptor, caret: { blockId: input.blockId, offset: input.offset }, presence: slot.presence });
        if (slots.get(slotKey) !== slot || slot.generation !== generation || recipient.closed || !fanout.hasCaretInterest(recipient, scope, input.field)) continue;
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

  function retract(slotKey) {
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

  async function clear(conn, message) {
    const input = parseClear(message);
    // Allocate/fence even on clear so a concurrent stale update cannot
    // resurrect after the slot is removed. If no slot exists, creating a
    // throwaway slot with a new generation still prevents delayed updates.
    const slotKey = key(conn, input.entity, input.id, input.field);
    if (!slots.has(slotKey)) {
      const slot = { connection: conn, entity: input.entity, id: input.id, field: input.field, presence: randomUUID(), generation: 0, recipients: new Set() };
      ++slot.generation;
      slots.set(slotKey, slot);
    }
    // Remove the slot and invalidate its generation; any future stale
    // update will see a missing slot (generation mismatch).
    await retract(slotKey);
  }

  async function removeConnection(conn, scope = null) {
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

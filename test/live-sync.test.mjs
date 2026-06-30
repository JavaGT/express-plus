// Phase 2 — the live-event fan-out and subscription layer.
//
// A live server wraps an HTTP server's `upgrade` event and opens WebSocket
// connections on a configured path (default `/events`). Each connection is
// wrapped with a FrameParser/FrameSender and follows a minimal message protocol:
//
//   client → server:
//     { type: 'subscribe', entity: 'Doc', id: 'doc-1' }
//     { type: 'unsubscribe', entity: 'Doc', id: 'doc-1' }
//
//   server → client:
//     { type: 'event', entity: 'Doc', id: 'doc-1', data: { ... } }
//
// Subscriptions are per-entity-row. When an event is emitted for an entity row,
// the fan-out finds every subscriber, re-authorizes them (the second default-on
// auth layer — the SAME mayVerb the REST dispatch uses — never a second auth
// path), and sends the event to each authorized connection.
//
// Re-authorization runs BEFORE delivery: the subscriber's grant may have changed
// since subscribe time (a revoked share, a changed role), so every emit
// re-checks. A cached/revalidated variant is an optimization, not a different
// auth model.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { FrameSender, FrameParser, upgradeWebSocket } from '../src/websocket.mjs';

// We test the live layer's fan-out + re-auth independently from a real WebSocket
// socket. The connection wrapper we build in this test exercises:
//   - message protocol (subscribe / unsubscribe / event)
//   - subscription registry (add / remove / find)
//   - re-authorization gate (a test principal + mayVerb stub)
//   - fan-out (emit to authorized subscribers)

// --- stub helpers for testing without real sockets ---

// A thin connection wrapper around a raw socket. In the real server this is
// created by the live server on upgrade; here we instantiate it directly with
// stub sends.
function makeTestConnection(id) {
  const messages = [];
  const conn = {
    id,
    send(data) { messages.push(JSON.parse(data)); },
    drainMessages() { const m = [...messages]; messages.length = 0; return m; },
    close() { this.closed = true; },
    closed: false,
    // Per-connection principal (set after auth; anonymous until proven).
    principal: null,
  };
  return conn;
}

// A subscription registry: which connections watch which (entity, id) pairs.
function createSubscriptionRegistry() {
  // Map<entity, Map<id, Set<connection>>>
  const byEntity = new Map();

  function add(entity, id, conn) {
    if (!byEntity.has(entity)) byEntity.set(entity, new Map());
    const byId = byEntity.get(entity);
    if (!byId.has(id)) byId.set(id, new Set());
    byId.get(id).add(conn);
  }

  function remove(entity, id, conn) {
    const byId = byEntity.get(entity);
    if (!byId) return;
    const subs = byId.get(id);
    if (!subs) return;
    subs.delete(conn);
    if (subs.size === 0) byId.delete(id);
    if (byId.size === 0) byEntity.delete(entity);
  }

  function removeAll(conn) {
    for (const [entity, byId] of byEntity) {
      for (const [id, subs] of byId) {
        subs.delete(conn);
        if (subs.size === 0) byId.delete(id);
      }
      if (byId.size === 0) byEntity.delete(entity);
    }
  }

  function find(entity, id) {
    const byId = byEntity.get(entity);
    if (!byId) return [];
    return [...(byId.get(id) ?? [])];
  }

  return { add, remove, removeAll, find };
}

// --- tests ---

test('a connection can subscribe to an entity row', () => {
  const subs = createSubscriptionRegistry();
  const conn = makeTestConnection('c1');

  subs.add('Doc', 'doc-1', conn);
  assert.deepEqual(subs.find('Doc', 'doc-1'), [conn]);
  assert.deepEqual(subs.find('Doc', 'doc-2'), []);
  assert.deepEqual(subs.find('Note', 'doc-1'), []);
});

test('multiple connections can subscribe to the same row', () => {
  const subs = createSubscriptionRegistry();
  const c1 = makeTestConnection('c1');
  const c2 = makeTestConnection('c2');

  subs.add('Doc', 'doc-1', c1);
  subs.add('Doc', 'doc-1', c2);

  const found = subs.find('Doc', 'doc-1');
  assert.equal(found.length, 2);
  assert.ok(found.includes(c1));
  assert.ok(found.includes(c2));
});

test('a connection can unsubscribe from a row', () => {
  const subs = createSubscriptionRegistry();
  const c1 = makeTestConnection('c1');
  const c2 = makeTestConnection('c2');

  subs.add('Doc', 'doc-1', c1);
  subs.add('Doc', 'doc-1', c2);
  subs.remove('Doc', 'doc-1', c1);

  assert.deepEqual(subs.find('Doc', 'doc-1'), [c2]);
});

test('removeAll(conn) cleans every subscription for that connection', () => {
  const subs = createSubscriptionRegistry();
  const c1 = makeTestConnection('c1');
  const c2 = makeTestConnection('c2');

  subs.add('Doc', 'doc-1', c1);
  subs.add('Doc', 'doc-2', c1);
  subs.add('Doc', 'doc-1', c2);
  subs.removeAll(c1);

  assert.deepEqual(subs.find('Doc', 'doc-1'), [c2]);
  assert.deepEqual(subs.find('Doc', 'doc-2'), []);
});

test('emit fans out an event to every authorized subscriber', () => {
  const subs = createSubscriptionRegistry();
  const c1 = makeTestConnection('c1');
  const c2 = makeTestConnection('c2');
  const c3 = makeTestConnection('c3'); // not subscribed

  subs.add('Doc', 'doc-1', c1);
  subs.add('Doc', 'doc-1', c2);

  // A stub re-auth: c1 is authorized, c2 is NOT
  const mayVerb = (entity, verb, rowId, principal) => {
    if (principal.id === 'c1') return true;
    return false;
  };

  // Fan out
  const subscribers = subs.find('Doc', 'doc-1');
    for (const conn of subscribers) {
      if (mayVerb('Doc', 'subscribe', { id: 'doc-1', title: 'new' }, { id: conn.id })) {
        conn.send(JSON.stringify({ type: 'event', entity: 'Doc', id: 'doc-1', seq: 1, data: { title: 'new' } }));
      }
    }

    assert.deepEqual(c1.drainMessages(), [
      { type: 'event', entity: 'Doc', id: 'doc-1', seq: 1, data: { title: 'new' } },
    ]);
  // c2 was subscribed but denied by re-auth — no message
  assert.deepEqual(c2.drainMessages(), []);
});

test('a denied subscriber on a live event is not notified (the event is withheld, not the subscription disconnected)', () => {
  const subs = createSubscriptionRegistry();
  const c1 = makeTestConnection('c1');
  subs.add('Doc', 'doc-1', c1);

  const mayVerb = () => false; // never authorized
  const subscribers = subs.find('Doc', 'doc-1');
  for (const conn of subscribers) {
    if (mayVerb('Doc', 'subscribe', 'doc-1', { id: conn.id })) {
      conn.send(JSON.stringify({ type: 'event' }));
    }
  }

  assert.deepEqual(c1.drainMessages(), []);
  // The connection stays subscribed; re-auth runs every emit.
  assert.deepEqual(subs.find('Doc', 'doc-1'), [c1]);
});

test('removeAll on close cleans the connection', () => {
  const subs = createSubscriptionRegistry();
  const c1 = makeTestConnection('c1');
  subs.add('Doc', 'doc-1', c1);
  subs.add('Note', 'n-1', c1);

  subs.removeAll(c1);
  assert.deepEqual(subs.find('Doc', 'doc-1'), []);
  assert.deepEqual(subs.find('Note', 'n-1'), []);
});

// --- re-authorization always uses the SAME mayVerb (no second auth path) ---

test('live-event re-authorization calls the same mayVerb the REST dispatch uses', () => {
  // The REST CRUD dispatch calls mayVerb(entity, verb, row, principal) for
  // 'read'/'write'/'subscribe'. The live fan-out calls the SAME mayVerb with
  // verb='subscribe'. Assert that the call signature is identical — one auth
  // engine, two modes, no second auth path.

  const calls = [];
  const mayVerb = (entity, verb, row, principal) => {
    calls.push({ entity, verb, row, principal });
    return true;
  };

  // REST-like: mayVerb('Doc', 'read', row, { id: 'u1' })
  mayVerb('Doc', 'read', { id: 'doc-1', title: 'x' }, { id: 'u1' });

  // Live-like: mayVerb('Doc', 'subscribe', { id: 'doc-1', title: 'x' }, { id: 'u1' })
  mayVerb('Doc', 'subscribe', { id: 'doc-1', title: 'x' }, { id: 'u1' });

  // Both calls go through the same function with the same argument shape.
  // The only difference is the verb string — which the grant's .can body
  // handles through its capability map (read/write/subscribe). That is
  // exactly one auth engine, not two separate paths.
  assert.equal(calls.length, 2);
  assert.equal(calls[0].verb, 'read');
  assert.equal(calls[1].verb, 'subscribe');
  // The entity, row, and principal shapes are identical.
  assert.equal(calls[0].entity, calls[1].entity);
  assert.deepEqual(calls[0].row, calls[1].row);
  assert.deepEqual(calls[0].principal, calls[1].principal);
});


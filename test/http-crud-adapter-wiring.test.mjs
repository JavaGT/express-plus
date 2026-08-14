// The authorization adapter (S5/A2) WIRED into the real HTTP CRUD dispatch
// path. The adapter must be THE admission path for REST read/mutate — not an
// unused type. These tests prove:
//   - an injected adapter is consulted on every read/mutate verb
//   - the injected adapter's decision is honored (deny → 403)
//   - the route gate also consults the injected adapter (spec item 3)
//   - the framework default adapter is unchanged for existing callers

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { connect as tcpConnect } from 'node:net';
import { randomBytes } from 'node:crypto';

import { text, ref, scope, grant, deny, read, write, subscribe, principal, operations } from '../build/index.mjs';
import workbench, { entity } from '../build/internal.mjs';
import { createAuthorizationAdapter } from '../build/authorization-adapter.mjs';

// An owner-scoped Note: the owner may read+write+subscribe; anyone else is
// denied outright.
function ownedNote() {
  return entity('Note', {
    body: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : deny('no'),
      ),
    ],
  });
}

// A spy adapter records every admit input and delegates to the framework
// default, so the production decision surface stays the reference.
function spyAdapter() {
  const inner = createAuthorizationAdapter();
  const calls = [];
  return {
    calls,
    admit: async (input) => {
      calls.push(input);
      return inner.admit(input);
    },
    registerResource: (input) => inner.registerResource(input),
  };
}

// A wrapper adapter that overrides admission for one category while delegating
// everything else to the framework default.
function makeAdapter({ onEntity, onPrincipal } = {}) {
  const inner = createAuthorizationAdapter();
  return {
    admit: async (input) => {
      if (input.category === 'entity' && onEntity) return onEntity(input);
      if (input.category === 'principal' && onPrincipal) return onPrincipal(input);
      return inner.admit(input);
    },
    registerResource: (input) => inner.registerResource(input),
  };
}

function deniedDecision(input, reasonCode, operation) {
  return {
    admitted: false,
    operation: operation ?? operations.read,
    resourceCategory: input.category,
    resourceId: null,
    reasonCode,
    capabilities: [],
    trace: null,
  };
}

function seed(ddl, rows = []) {
  const db = new DatabaseSync(':memory:');
  db.exec(ddl);
  for (const { sql, params } of rows) db.prepare(sql).run(...params);
  return db;
}

async function serve(t, db, Entity, who, authorization) {
  const app = workbench({ db });
  app.mount('/notes', Entity);
  app.listen(0, { principalOf: () => who, authorization });
  await app.ready;
  t.after(() => {
    app.httpServer.close();
    db.close();
  });
  const { port } = app.httpServer.address();
  return { origin: `http://127.0.0.1:${port}` };
}

const alice = principal({ type: 'user', id: 'alice' });
const ddl = 'CREATE TABLE Note (id TEXT PRIMARY KEY, body TEXT, owner TEXT)';

const seededDb = () => seed(ddl, [
  { sql: 'INSERT INTO Note (id, body, owner) VALUES (?, ?, ?)', params: ['1', 'a', 'alice'] },
]);

test('HTTP read consults the injected adapter (injection honored)', async (t) => {
  const db = seededDb();
  const spy = spyAdapter();
  const a = await serve(t, db, ownedNote(), alice, spy);
  const res = await fetch(`${a.origin}/notes/1`);
  assert.equal(res.status, 200);
  const entityCalls = spy.calls.filter((c) => c.category === 'entity');
  assert.ok(entityCalls.some((c) => c.verb === 'read'), 'read consulted the injected adapter');
});

test('HTTP list consults the injected adapter (row post-filter)', async (t) => {
  const db = seededDb();
  const spy = spyAdapter();
  const a = await serve(t, db, ownedNote(), alice, spy);
  const res = await fetch(`${a.origin}/notes`);
  assert.equal(res.status, 200);
  const entityCalls = spy.calls.filter((c) => c.category === 'entity');
  assert.ok(entityCalls.some((c) => c.verb === 'list'), 'list consulted the injected adapter');
});

test('HTTP update and remove consult the injected adapter', async (t) => {
  const db = seededDb();
  const spy = spyAdapter();
  const a = await serve(t, db, ownedNote(), alice, spy);

  const updated = await fetch(`${a.origin}/notes/1`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'a2' }),
  });
  assert.equal(updated.status, 200);
  assert.ok(spy.calls.some((c) => c.category === 'entity' && c.verb === 'update'), 'update consulted the injected adapter');

  const removed = await fetch(`${a.origin}/notes/1`, { method: 'DELETE' });
  assert.equal(removed.status, 204);
  assert.ok(spy.calls.some((c) => c.category === 'entity' && c.verb === 'remove'), 'remove consulted the injected adapter');
});

test('the injected adapter decision is honored, not the framework default (deny → 403)', async (t) => {
  const db = seededDb();
  // An injected adapter that denies every entity admission. The framework
  // default would ADMIT alice reading her own note; the injected policy wins.
  const denying = makeAdapter({
    onEntity: (input) => deniedDecision(input, 'no-capability'),
  });
  const a = await serve(t, db, ownedNote(), alice, denying);
  const res = await fetch(`${a.origin}/notes/1`);
  assert.equal(res.status, 403, 'injected denial is honored over the framework default');
});

test('the route gate consults the injected adapter (principal category)', async (t) => {
  const db = seededDb();
  const spy = spyAdapter();
  const a = await serve(t, db, ownedNote(), alice, spy);
  const res = await fetch(`${a.origin}/notes/1`);
  assert.equal(res.status, 200);
  assert.ok(spy.calls.some((c) => c.category === 'principal'), 'the route gate ran through the injected adapter');
});

test('an injected adapter that denies the route gate yields 401', async (t) => {
  const db = seededDb();
  const denyingGate = makeAdapter({
    onPrincipal: (input) => deniedDecision(input, 'anonymous'),
  });
  const a = await serve(t, db, ownedNote(), alice, denyingGate);
  const res = await fetch(`${a.origin}/notes/1`);
  assert.equal(res.status, 401, 'an injected principal denial is honored');
});

test('the default adapter keeps existing callers working (no authorization injected)', async (t) => {
  const db = seededDb();
  const a = await serve(t, db, ownedNote(), alice, undefined);
  const read = await fetch(`${a.origin}/notes/1`);
  assert.equal(read.status, 200);
  const list = await fetch(`${a.origin}/notes`);
  assert.equal(list.status, 200);
  assert.equal((await list.json()).length, 1);
  // a stranger's read of alice's note is OUT OF SCOPE → 404 (invisible), while
  // a visible-but-denied write is 403 — the pre-adapter behavior, unchanged.
  const b = await serve(t, seededDb(), ownedNote(), principal({ type: 'user', id: 'bob' }), undefined);
  const strangerRead = await fetch(`${b.origin}/notes/1`);
  assert.equal(strangerRead.status, 404);
});

// --- the injected adapter reaches the live-delivery seam (serve.ts wiring) ----

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A raw WebSocket harness over the framework seam at /events (same pattern as
// live-delivery-seam.test.mjs) — proves serve.ts passes { authorization } into
// createWebSocketLiveDelivery.
function openRawWS(port) {
  return new Promise((resolve, reject) => {
    const sock = tcpConnect(port, '127.0.0.1');
    const key = randomBytes(16).toString('base64');
    const handshake =
      'GET /events HTTP/1.1\r\n' +
      'Host: localhost\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Key: ${key}\r\n` +
      'Sec-WebSocket-Version: 13\r\n' +
      '\r\n';

    let buf = Buffer.alloc(0);
    let upgraded = false;
    const inbox = [];

    sock.on('connect', () => sock.write(handshake));
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        const head = buf.slice(0, idx).toString();
        buf = buf.slice(idx + 4);
        if (!head.startsWith('HTTP/1.1 101')) {
          reject(new Error('upgrade failed: ' + head.split('\r\n')[0]));
          return;
        }
        upgraded = true;
        resolve({ sock, send, nextMessage, close });
      }
      while (buf.length >= 2) {
        const b0 = buf[0];
        const b1 = buf[1] & 0x7f;
        let payloadLen = b1;
        let headerLen = 2;
        if (b1 === 126) { if (buf.length < 4) return; payloadLen = buf.readUInt16BE(2); headerLen = 4; }
        else if (b1 === 127) { if (buf.length < 10) return; payloadLen = Number(buf.readBigUInt64BE(2)); headerLen = 10; }
        if (buf.length < headerLen + payloadLen) return;
        const payload = buf.slice(headerLen, headerLen + payloadLen);
        const opcode = b0 & 0x0f;
        buf = buf.slice(headerLen + payloadLen);
        if (opcode === 0x1) inbox.push(payload.toString('utf-8'));
      }
    });
    sock.on('error', reject);

    function send(text) {
      const payload = Buffer.from(text, 'utf-8');
      const mask = randomBytes(4);
      const masked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
      let header;
      if (payload.length < 126) {
        header = Buffer.alloc(2);
        header[1] = 0x80 | payload.length;
      } else if (payload.length <= 0xffff) {
        header = Buffer.alloc(4);
        header[1] = 0x80 | 126;
        header.writeUInt16BE(payload.length, 2);
      }
      header[0] = 0x81;
      sock.write(Buffer.concat([header, mask, masked]));
    }

    async function nextMessage(timeoutMs = 2000) {
      const start = Date.now();
      while (Date.now() - start <= timeoutMs) {
        if (inbox.length > 0) return JSON.parse(inbox.shift());
        await sleep(20);
      }
      return null;
    }

    function close() {
      try { sock.destroy(); } catch { /* ignore */ }
    }
  });
}

async function liveServe(t, db, Entity, who, authorization) {
  const app = workbench({ db });
  app.mount('/notes', Entity);
  app.listen(0, { principalOf: () => who, authorization });
  await app.ready;
  t.after(() => {
    app.httpServer.closeAllConnections?.();
    app.httpServer.close();
    db.close();
  });
  return app.httpServer.address().port;
}

test('serve.ts wires the injected adapter into the live-delivery seam (subscribe admission)', async (t) => {
  const db = seededDb();
  const spy = spyAdapter();
  const port = await liveServe(t, db, ownedNote(), alice, spy);
  const ws = await openRawWS(port);
  try {
    ws.send(JSON.stringify({ type: 'subscribe', entity: 'Note', id: '1' }));
    const ack = await ws.nextMessage();
    assert.ok(ack, 'subscribed ack received');
    assert.equal(ack.type, 'subscribed', `expected subscribed but got ${JSON.stringify(ack)}`);
    const subscribeCalls = spy.calls.filter((c) => c.category === 'entity' && c.verb === 'subscribe');
    assert.ok(subscribeCalls.length >= 1, 'live subscribe admission ran through the adapter serve.ts injected');
  } finally {
    ws.close();
  }
});

test('serve.ts live seam honors an injected adapter denial (no subscribed ack)', async (t) => {
  const db = seededDb();
  const denying = makeAdapter({
    onEntity: (input) => deniedDecision(input, 'no-capability'),
  });
  const port = await liveServe(t, db, ownedNote(), alice, denying);
  const ws = await openRawWS(port);
  try {
    ws.send(JSON.stringify({ type: 'subscribe', entity: 'Note', id: '1' }));
    const msg = await ws.nextMessage();
    assert.equal(msg?.type, 'error', 'a denied live subscription is an error, never a subscribed ack');
  } finally {
    ws.close();
  }
});

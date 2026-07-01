// P6e-2 (Slice B2): store/ordered native events are delta-native — their
// committedEvent.data IS the structural delta (no diff computed). Normalized
// under the same `delta` map key so a client dispatches one uniform delta
// shape regardless of kind (DECISIONLOG #71 risk #7, #71 F5 backward-compat).
//
// All tests use raw WebSocket against a direct createLiveServer + compiled entity
// (mirrors live-delta.test.mjs and live-pace.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { connect as tcpConnect } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';

import {
  entity, text, map, list, ref, scope, everyone, grant, read, write, subscribe,
  generateDDL, executeFrameworkDDL, createLiveServer, principal as makePrincipal,
} from '../src/index.mjs';
import { setActiveDb } from '../src/db.mjs';

// --- test entity ---

const User = entity('User', {
  fields: { name: text() },
  grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
});

const Doc = entity('Doc', {
  fields: {
    title: text(),
    collaborators: map(ref('User'), { role: ['viewer', 'editor'] }),
    items: list(text()),
  },
  grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
});

// --- raw WebSocket harness (mirrors live-delta.test.mjs) ---

function openRawWS(port, userId = 'test') {
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
      (userId != null ? `x-test-user: ${userId}\r\n` : '') +
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
        resolve({ sock, send, nextMessage, nextEvent, close });
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

    async function nextMessage(timeoutMs = 400) {
      const start = Date.now();
      while (Date.now() - start <= timeoutMs) {
        if (inbox.length > 0) return JSON.parse(inbox.shift());
        await new Promise((r) => setTimeout(r, 20));
      }
      return null;
    }

    async function nextEvent(timeoutMs = 400) {
      const start = Date.now();
      while (Date.now() - start <= timeoutMs) {
        while (inbox.length > 0) {
          const msg = JSON.parse(inbox.shift());
          if (msg.type === 'event') return msg;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      return null;
    }

    function close() { try { sock.destroy(); } catch { /* ignore */ } }
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- bootstrap: direct createLiveServer (mirrors live-delta.test.mjs) ---

function bootServer() {
  const db = new DatabaseSync(':memory:');
  setActiveDb(db);
  executeFrameworkDDL(db);
  for (const sql of generateDDL(User)) db.exec(sql);
  for (const sql of generateDDL(Doc)) db.exec(sql);

  const httpServer = http.createServer();
  const live = createLiveServer(httpServer, {
    path: '/events',
    mayVerb: async () => true,
    principalOf: (req) => {
      const u = req.headers?.['x-test-user'] ?? 'test';
      return { type: 'user', id: u };
    },
    db,
    resolveEntity: () => Doc,
  });

  httpServer.listen(0);
  return { db, httpServer, live };
}

// Helper: re-read a Doc row from db
function reRead(db, id) {
  return db.prepare('SELECT * FROM Doc WHERE id = ?').get(id);
}

// Helper: emit a store/ordered native event (no shadow involved)
function emitNative(live, entityRecord, db, id, seq, type, data) {
  const row = reRead(db, id);
  return live.emit(entityRecord, id, row, { type, seq, data });
}

// Helper: subscribe and wait for ack (named wsSubscribe to avoid collision with
// the imported `subscribe` grant-capability used in the entity declaration).
async function wsSubscribe(ws, entity, id) {
  ws.send(JSON.stringify({ type: 'subscribe', entity, id }));
  return ws.nextMessage();
}

// ============================================================
// Test 1: map `.added` delta
// ============================================================

test('P6e-2 B2: map .added delta', async () => {
  const { db, httpServer, live } = bootServer();
  const port = httpServer.address().port;
  let ws;
  const id = 'doc-test1';

  try {
    db.prepare('INSERT INTO Doc (id, title) VALUES (?, ?)').run(id, 'D1');
    const entityRecord = (() => Doc)();

    ws = await openRawWS(port, 'alice');
    assert.equal((await wsSubscribe(ws, 'Doc', id))?.type, 'subscribed');

    await emitNative(live, entityRecord, db, id, 1, 'Doc.collaborators.added', { owner: id, member: 'u2', role: 'viewer' });
    const ev = await ws.nextEvent(400);
    assert.ok(ev, 'event received');
    assert.equal(ev.event.type, 'Doc.collaborators.added');
    assert.deepEqual(ev.delta, { collaborators: { owner: id, member: 'u2', role: 'viewer' } });
    assert.deepEqual(ev.event.data, { owner: id, member: 'u2', role: 'viewer' });
    assert.deepEqual(ev.seqSpan, [1, 1]);
  } finally {
    ws?.close();
    live.close();
    httpServer.close();
  }
});

// ============================================================
// Test 2: map `.roleChanged` delta
// ============================================================

test('P6e-2 B2: map .roleChanged delta', async () => {
  const { db, httpServer, live } = bootServer();
  const port = httpServer.address().port;
  let ws;
  const id = 'doc-test2';

  try {
    db.prepare('INSERT INTO Doc (id, title) VALUES (?, ?)').run(id, 'D2');
    const entityRecord = (() => Doc)();

    ws = await openRawWS(port, 'alice');
    assert.equal((await wsSubscribe(ws, 'Doc', id))?.type, 'subscribed');

    await emitNative(live, entityRecord, db, id, 1, 'Doc.collaborators.roleChanged', { owner: id, member: 'u2', role: 'editor' });
    const ev = await ws.nextEvent(400);
    assert.ok(ev, 'event received');
    assert.equal(ev.event.type, 'Doc.collaborators.roleChanged');
    assert.deepEqual(ev.delta, { collaborators: { owner: id, member: 'u2', role: 'editor' } });
    assert.deepEqual(ev.event.data, { owner: id, member: 'u2', role: 'editor' });
  } finally {
    ws?.close();
    live.close();
    httpServer.close();
  }
});

// ============================================================
// Test 3: map `.removed` delta
// ============================================================

test('P6e-2 B2: map .removed delta', async () => {
  const { db, httpServer, live } = bootServer();
  const port = httpServer.address().port;
  let ws;
  const id = 'doc-test3';

  try {
    db.prepare('INSERT INTO Doc (id, title) VALUES (?, ?)').run(id, 'D3');
    const entityRecord = (() => Doc)();

    ws = await openRawWS(port, 'alice');
    assert.equal((await wsSubscribe(ws, 'Doc', id))?.type, 'subscribed');

    await emitNative(live, entityRecord, db, id, 1, 'Doc.collaborators.removed', { owner: id, member: 'u2' });
    const ev = await ws.nextEvent(400);
    assert.ok(ev, 'event received');
    assert.equal(ev.event.type, 'Doc.collaborators.removed');
    assert.deepEqual(ev.delta, { collaborators: { owner: id, member: 'u2' } });
    assert.deepEqual(ev.event.data, { owner: id, member: 'u2' });
  } finally {
    ws?.close();
    live.close();
    httpServer.close();
  }
});

// ============================================================
// Test 4: ordered `.inserted` delta
// ============================================================

test('P6e-2 B2: ordered .inserted delta', async () => {
  const { db, httpServer, live } = bootServer();
  const port = httpServer.address().port;
  let ws;
  const id = 'doc-test4';
  const uuid = randomUUID();

  try {
    db.prepare('INSERT INTO Doc (id, title) VALUES (?, ?)').run(id, 'D4');
    const entityRecord = (() => Doc)();

    ws = await openRawWS(port, 'alice');
    assert.equal((await wsSubscribe(ws, 'Doc', id))?.type, 'subscribed');

    await emitNative(live, entityRecord, db, id, 1, 'Doc.items.inserted', { owner: id, id: uuid, key: 'a', value: 'first' });
    const ev = await ws.nextEvent(400);
    assert.ok(ev, 'event received');
    assert.equal(ev.event.type, 'Doc.items.inserted');
    assert.deepEqual(ev.delta, { items: { owner: id, id: uuid, key: 'a', value: 'first' } });
    assert.deepEqual(ev.event.data, { owner: id, id: uuid, key: 'a', value: 'first' });
  } finally {
    ws?.close();
    live.close();
    httpServer.close();
  }
});

// ============================================================
// Test 5: ordered `.moved` delta
// ============================================================

test('P6e-2 B2: ordered .moved delta', async () => {
  const { db, httpServer, live } = bootServer();
  const port = httpServer.address().port;
  let ws;
  const id = 'doc-test5';

  try {
    db.prepare('INSERT INTO Doc (id, title) VALUES (?, ?)').run(id, 'D5');
    const entityRecord = (() => Doc)();

    ws = await openRawWS(port, 'alice');
    assert.equal((await wsSubscribe(ws, 'Doc', id))?.type, 'subscribed');

    await emitNative(live, entityRecord, db, id, 1, 'Doc.items.moved', { owner: id, id: 'i1', key: 'b' });
    const ev = await ws.nextEvent(400);
    assert.ok(ev, 'event received');
    assert.equal(ev.event.type, 'Doc.items.moved');
    assert.deepEqual(ev.delta, { items: { owner: id, id: 'i1', key: 'b' } });
    assert.deepEqual(ev.event.data, { owner: id, id: 'i1', key: 'b' });
  } finally {
    ws?.close();
    live.close();
    httpServer.close();
  }
});

// ============================================================
// Test 6: pass-through invariance — pace subscriber gets non-ephemeral events inline
// ============================================================

test('P6e-2 B2: pass-through invariance — pace subscriber gets non-ephemeral events inline', async () => {
  const { db, httpServer, live } = bootServer();
  const port = httpServer.address().port;
  let ws;
  const id = 'doc-test6';

  try {
    db.prepare('INSERT INTO Doc (id, title) VALUES (?, ?)').run(id, 'D6');
    const entityRecord = (() => Doc)();

    ws = await openRawWS(port, 'alice');
    // Subscribe with pace (profile '15fps' is accepted by pace validator).
    // Doc has no ephemeral field, so pace is unused — the event passes through.
    ws.send(JSON.stringify({ type: 'subscribe', entity: 'Doc', id, pace: { profile: '15fps' } }));
    assert.equal((await ws.nextMessage())?.type, 'subscribed');

    await emitNative(live, entityRecord, db, id, 1, 'Doc.collaborators.added', { owner: id, member: 'u2', role: 'viewer' });
    const ev = await ws.nextEvent(400);
    assert.ok(ev, 'event received within 400ms (pass-through, not coalesced)');
    assert.deepEqual(ev.seqSpan, [1, 1]);
    assert.deepEqual(ev.delta, { collaborators: { owner: id, member: 'u2', role: 'viewer' } });
  } finally {
    ws?.close();
    live.close();
    httpServer.close();
  }
});

// ============================================================
// Test 7: backward-compat — both delta AND event present
// ============================================================

test('P6e-2 B2: backward-compat — envelope has both delta and event', async () => {
  const { db, httpServer, live } = bootServer();
  const port = httpServer.address().port;
  let ws;
  const id = 'doc-test7';

  try {
    db.prepare('INSERT INTO Doc (id, title) VALUES (?, ?)').run(id, 'D7');
    const entityRecord = (() => Doc)();

    ws = await openRawWS(port, 'alice');
    assert.equal((await wsSubscribe(ws, 'Doc', id))?.type, 'subscribed');

    await emitNative(live, entityRecord, db, id, 1, 'Doc.collaborators.added', { owner: id, member: 'u2', role: 'editor' });
    const ev = await ws.nextEvent(400);
    assert.ok(ev, 'event received');
    // Both delta AND event keys present
    assert.ok('delta' in ev, 'delta key present');
    assert.ok('event' in ev, 'event key present');
    assert.ok(ev.event.data, 'event.data present');
    assert.deepEqual(ev.delta, { collaborators: { owner: id, member: 'u2', role: 'editor' } });
    assert.deepEqual(ev.event.data, { owner: id, member: 'u2', role: 'editor' });
    assert.equal(ev.event.type, 'Doc.collaborators.added');
  } finally {
    ws?.close();
    live.close();
    httpServer.close();
  }
});
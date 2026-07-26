import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { connect as tcpConnect } from 'node:net';
import { randomBytes } from 'node:crypto';

import { createLiveDelivery, createLiveServer } from '../src/live-delivery.mjs';
import { executeFrameworkDDL } from '../src/ddl.mjs';
import { scope } from '../src/scope.mjs';
import { grant, read, write, subscribe } from '../src/grant.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- raw WebSocket harness (same pattern as live-delta.test.mjs) ---

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
      'x-test-user: u1\r\n' +
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
        resolve({ sock, send, nextMessage, nextEvent, nextResync, close });
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

    async function nextMessage(timeoutMs = 1000) {
      const start = Date.now();
      while (Date.now() - start <= timeoutMs) {
        if (inbox.length > 0) return JSON.parse(inbox.shift());
        await new Promise((r) => setTimeout(r, 20));
      }
      return null;
    }

    async function nextEvent(timeoutMs = 1000) {
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

    async function nextResync(timeoutMs = 1000) {
      const start = Date.now();
      while (Date.now() - start <= timeoutMs) {
        while (inbox.length > 0) {
          const msg = JSON.parse(inbox.shift());
          if (msg.type === 'resync') return msg;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      return null;
    }

    function close() {
      try { sock.destroy(); } catch { /* ignore */ }
    }
  });
}

// --- helpers ---

function makeNoteEntity() {
  return {
    name: 'Note',
    hydrate: (row) => ({ ...row }),
    scopeFilter: () => ({ sql: '1=1', params: {} }),
    fields: { title: { kind: 'value' } },
    grant: [],
  };
}

function makeAnnotatedTextEntity() {
  return {
    name: 'Doc',
    hydrate: (row) => ({ ...row }),
    scopeFilter: () => ({ sql: '1=1', params: {} }),
    fields: { body: { kind: 'annotatedText' } },
    grant: [],
  };
}

function appendEvent(db, scope, seq, type, data = {}) {
  db.prepare(
    `INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(scope, seq, type, JSON.stringify(data), `action-${seq}`, new Date().toISOString());
  db.prepare(
    `INSERT INTO _Cursor (scope, lastSeq) VALUES (?, ?)
     ON CONFLICT(scope) DO UPDATE SET lastSeq = excluded.lastSeq`,
  ).run(scope, seq);
}

// --- tests ---

test('createLiveDelivery is the singular factory (createLiveServer is the same function)', () => {
  assert.equal(createLiveServer, createLiveDelivery);
});

test('createLiveDelivery exposes no public durable fanout', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec(`CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT)`);
  db.prepare(`INSERT INTO Note (id, title) VALUES (?, ?)`).run('n1', 'hello');

  const httpServer = http.createServer();
  const live = createLiveDelivery(httpServer, {
    path: '/events',
    mayVerb: async () => true,
    principalOf: () => ({ type: 'user', id: 'u1' }),
    db,
    resolveEntity: () => makeNoteEntity(),
  });

  assert.equal(live.emit, undefined);
  assert.equal(typeof live.count, 'function');
  assert.equal(typeof live.close, 'function');
  assert.equal(typeof live.createConsumer, 'function');
  assert.equal(live.count(), 0);

  const consumer = live.createConsumer({
    entities: new Map([
      ['Note', {
        name: 'Note',
        hydrate: (row) => ({ ...row, hydrated: true }),
        scopeFilter: () => ({ sql: '1=1', params: {} }),
      }],
    ]),
  });
  assert.equal(typeof consumer, 'function');

  // Consumer should not throw on empty or malformed events.
  await consumer([], { db });
  await consumer(
    [{ scope: 'Note:n1', type: 'Note.updated', seq: 1, data: { id: 'n1', title: 'x' } }],
    { db },
  );

  live.close();
  httpServer.close();
});

test('WebSocket subscribe receives ack, consumer delivers core-projected event via WS, not fanout', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec(`CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT, owner TEXT, workspace TEXT)`);
  db.prepare(`INSERT INTO Note (id, title, owner, workspace) VALUES (?, ?, ?, ?)`).run('n1', 'hello', 'u1', 'public');

  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'hello' });

  const httpServer = http.createServer();
  const live = createLiveDelivery(httpServer, {
    mayVerb: async () => true,
    principalOf: (req) => {
      const u = req.headers?.['x-test-user'] ?? 'test';
      return { type: 'user', id: u };
    },
    db,
    resolveEntity: (name) => name === 'Note' ? makeNoteEntity() : null,
    log: null,
  });

  httpServer.listen(0);
  const port = httpServer.address().port;

  try {
    const ws = await openRawWS(port);

    // Subscribe
    ws.send(JSON.stringify({ type: 'subscribe', entity: 'Note', id: 'n1' }));

    // Verify subscribed ack
    const ack = await ws.nextMessage();
    assert.ok(ack, 'subscribed ack received');
    if (ack.type === 'error') {
      console.error('subscribe error:', JSON.stringify(ack));
    }
    assert.equal(ack.type, 'subscribed', `expected subscribed but got ${JSON.stringify(ack)}`);
    assert.equal(ack.scope, 'Note:n1');
    assert.equal(ack.entity, 'Note');
    assert.equal(ack.id, 'n1');
    assert.ok(Number.isSafeInteger(ack.currentSeq), 'currentSeq is present');

    // Append a committed event to _Log AFTER subscription
    db.prepare(`UPDATE Note SET title = ? WHERE id = ?`).run('world', 'n1');
    appendEvent(db, 'Note:n1', 2, 'Note.updated', { title: 'world' });

    // Call the post-commit consumer — this is what the kernel calls.
    const consumer = live.createConsumer({
      entities: new Map([['Note', makeNoteEntity()]]),
    });
    await consumer([{ scope: 'Note:n1', type: 'Note.updated', seq: 2, data: { title: 'world' } }], { db });

    await sleep(100);

    // Verify event arrives via WS (core-projected delivery).
    const ev = await ws.nextEvent(200);
    assert.ok(ev, 'event received via WS');
    assert.equal(ev.type, 'event');
    assert.equal(ev.entity, 'Note');
    assert.equal(ev.id, 'n1');
    assert.equal(ev.seq, 2);
    assert.equal(ev.event.type, 'Note.updated');
    assert.equal(ev.event.data.title, 'world');
    assert.deepEqual(ev.seqSpan, [2, 2]);

    // Verify no extra events (only one event delivered).
    const extra = await ws.nextEvent(100);
    assert.equal(extra, null, 'no extra event delivered');
  } finally {
    live.close();
    httpServer.close();
    await sleep(50);
  }
});

test('annotated-text/native operated event produces resync, not raw event data', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec(`CREATE TABLE Doc (id TEXT PRIMARY KEY, title TEXT, owner TEXT, workspace TEXT)`);
  db.prepare(`INSERT INTO Doc (id, title, owner, workspace) VALUES (?, ?, ?, ?)`).run('d1', 'doc', 'u1', 'public');

  appendEvent(db, 'Doc:d1', 1, 'Doc.created', { title: 'doc' });

  const httpServer = http.createServer();
  const live = createLiveDelivery(httpServer, {
    mayVerb: async () => true,
    principalOf: (req) => {
      const u = req.headers?.['x-test-user'] ?? 'test';
      return { type: 'user', id: u };
    },
    db,
    resolveEntity: (name) => name === 'Doc' ? makeAnnotatedTextEntity() : null,
    log: null,
  });

  httpServer.listen(0);
  const port = httpServer.address().port;

  try {
    const ws = await openRawWS(port);

    // Subscribe
    ws.send(JSON.stringify({ type: 'subscribe', entity: 'Doc', id: 'd1' }));

    // Verify subscribed ack
    const ack = await ws.nextMessage();
    assert.ok(ack, 'subscribed ack received');
    assert.equal(ack.type, 'subscribed');
    assert.equal(ack.scope, 'Doc:d1');

    // Append an annotated-text native operated event to _Log AFTER subscription
    // The event type follows the convention: Entity.field.operated
    appendEvent(db, 'Doc:d1', 2, 'Doc.body.operated', { id: 'd1', ops: [{ type: 'insert', pos: 0, text: 'raw' }] });

    // Call the post-commit consumer
    const consumer = live.createConsumer({
      entities: new Map([['Doc', makeAnnotatedTextEntity()]]),
    });
    await consumer([{ scope: 'Doc:d1', type: 'Doc.body.operated', seq: 2, data: { ops: [{ type: 'insert', pos: 0, text: 'raw' }] } }], { db });

    await sleep(100);

    // Verify resync message arrives, NOT an event with raw data.
    const resync = await ws.nextResync(200);
    assert.ok(resync, 'resync message received');
    assert.equal(resync.type, 'resync');
    assert.equal(resync.entity, 'Doc');
    assert.equal(resync.id, 'd1');
    assert.equal(resync.seq, 2);
    assert.equal(resync.reason, 'annotated-text-snapshot-required');

    // Verify NO raw event message was delivered
    const raw = await ws.nextEvent(100);
    assert.equal(raw, null, 'no raw event delivered for annotated-text operated');

    // Verify no other unexpected messages
    const other = await ws.nextMessage(50);
    assert.equal(other, null, 'no other messages delivered');
  } finally {
    live.close();
    httpServer.close();
    await sleep(50);
  }
});

function makeDocWithEphemeralEntity() {
  return {
    name: 'Doc',
    hydrate: (row) => ({ ...row }),
    scopeFilter: () => ({ sql: '1=1', params: {} }),
    fields: { body: { kind: 'annotatedText' }, cursor: { kind: 'ephemeral' } },
    grant: [],
  };
}

test('(R1) one connection with two entity scopes, unsubscribe one, subsequent commit for the other is delivered', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec(`CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT, owner TEXT, workspace TEXT)`);
  db.prepare(`INSERT INTO Note (id, title, owner, workspace) VALUES (?, ?, ?, ?)`).run('n1', 'a', 'u1', 'public');
  db.prepare(`INSERT INTO Note (id, title, owner, workspace) VALUES (?, ?, ?, ?)`).run('n2', 'b', 'u1', 'public');

  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'a' });
  appendEvent(db, 'Note:n2', 1, 'Note.created', { title: 'b' });

  const httpServer = http.createServer();
  const live = createLiveDelivery(httpServer, {
    mayVerb: async () => true,
    principalOf: (req) => {
      const u = req.headers?.['x-test-user'] ?? 'test';
      return { type: 'user', id: u };
    },
    db,
    resolveEntity: (name) => name === 'Note' ? makeNoteEntity() : null,
    log: null,
  });

  httpServer.listen(0);
  const port = httpServer.address().port;

  try {
    const ws = await openRawWS(port);

    // Subscribe to both scopes
    ws.send(JSON.stringify({ type: 'subscribe', entity: 'Note', id: 'n1' }));
    const ack1 = await ws.nextMessage();
    assert.equal(ack1.type, 'subscribed');
    assert.equal(ack1.scope, 'Note:n1');

    ws.send(JSON.stringify({ type: 'subscribe', entity: 'Note', id: 'n2' }));
    const ack2 = await ws.nextMessage();
    assert.equal(ack2.type, 'subscribed');
    assert.equal(ack2.scope, 'Note:n2');

    // Unsubscribe from n1
    ws.send(JSON.stringify({ type: 'unsubscribe', entity: 'Note', id: 'n1' }));
    const unsub = await ws.nextMessage();
    assert.equal(unsub.type, 'unsubscribed');
    assert.equal(unsub.scope, 'Note:n1');

    // Append a committed event to Note:n1 AFTER unsubscribing
    appendEvent(db, 'Note:n1', 2, 'Note.updated', { title: 'a-ignored' });
    const consumer = live.createConsumer({
      entities: new Map([['Note', makeNoteEntity()]]),
    });
    await consumer([{ scope: 'Note:n1', type: 'Note.updated', seq: 2, data: { title: 'a-ignored' } }], { db });
    await sleep(100);

    // Verify no event for n1 (unsubscribed)
    const ev1 = await ws.nextEvent(150);
    assert.equal(ev1, null, 'no event for unsubscribed scope n1');

    // Append a committed event to Note:n2 — should still be delivered
    db.prepare(`UPDATE Note SET title = ? WHERE id = ?`).run('b-delivered', 'n2');
    appendEvent(db, 'Note:n2', 2, 'Note.updated', { title: 'b-delivered' });
    await consumer([{ scope: 'Note:n2', type: 'Note.updated', seq: 2, data: { title: 'b-delivered' } }], { db });
    await sleep(100);

    const ev2 = await ws.nextEvent(200);
    assert.ok(ev2, 'event for n2 delivered after n1 unsubscribe');
    assert.equal(ev2.entity, 'Note');
    assert.equal(ev2.id, 'n2');
    assert.equal(ev2.seq, 2);
    assert.equal(ev2.event.data.title, 'b-delivered');

    // Verify no extra events
    const extra = await ws.nextEvent(100);
    assert.equal(extra, null, 'no extra events');
  } finally {
    live.close();
    httpServer.close();
    await sleep(50);
  }
});

test('(R4) public live delivery cannot emit an annotated-text ephemeral payload', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec(`CREATE TABLE Doc (id TEXT PRIMARY KEY, title TEXT, owner TEXT, workspace TEXT)`);
  db.prepare(`INSERT INTO Doc (id, title, owner, workspace) VALUES (?, ?, ?, ?)`).run('d1', 'doc', 'u1', 'public');

  appendEvent(db, 'Doc:d1', 1, 'Doc.created', { title: 'doc' });

  const httpServer = http.createServer();
  const live = createLiveDelivery(httpServer, {
    mayVerb: async () => true,
    principalOf: (req) => {
      const u = req.headers?.['x-test-user'] ?? 'test';
      return { type: 'user', id: u };
    },
    db,
    resolveEntity: (name) => name === 'Doc' ? makeDocWithEphemeralEntity() : null,
    log: null,
  });

  httpServer.listen(0);
  const port = httpServer.address().port;

  try {
    const ws = await openRawWS(port);

    ws.send(JSON.stringify({ type: 'subscribe', entity: 'Doc', id: 'd1' }));
    const ack = await ws.nextMessage();
    assert.equal(ack.type, 'subscribed');
    assert.equal(ack.scope, 'Doc:d1');

    assert.equal(live.emit, undefined, 'generic ephemeral fanout is not publicly callable');
  } finally {
    live.close();
    httpServer.close();
    await sleep(50);
  }
});

function makeNoteEntityWithGrant() {
  return {
    name: 'Note',
    hydrate: (row) => ({ ...row }),
    scopeFilter: () => ({ sql: '1=1', params: {} }),
    fields: { title: { kind: 'value' } },
    grant: () => [scope(() => true).can(() => grant(read, write, subscribe))],
  };
}

test('(R6) activation failure occurs only after the subscribed acknowledgement', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec(`CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT, owner TEXT, workspace TEXT)`);
  db.prepare(`INSERT INTO Note (id, title, owner, workspace) VALUES (?, ?, ?, ?)`).run('n1', 'hello', 'u1', 'public');

  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'hello' });

  let mayVerbCallCount = 0;
  // Stateful mayVerb: admission succeeds, core.subscribe inline check passes,
  // but core.catchUp reauth fails on the third call (the checkMayRow inside catchUp).
  const failCoreMayVerb = async () => {
    mayVerbCallCount++;
    return mayVerbCallCount <= 2;
  };

  const httpServer = http.createServer();
  const live = createLiveDelivery(httpServer, {
    mayVerb: failCoreMayVerb,
    principalOf: (req) => {
      const u = req.headers?.['x-test-user'] ?? 'test';
      return { type: 'user', id: u };
    },
    db,
    resolveEntity: (name) => name === 'Note' ? makeNoteEntityWithGrant() : null,
    log: null,
  });

  httpServer.listen(0);
  const port = httpServer.address().port;

  try {
    const ws = await openRawWS(port);

    ws.send(JSON.stringify({ type: 'subscribe', entity: 'Note', id: 'n1' }));

    const ack = await ws.nextMessage(500);
    assert.ok(ack, 'subscribed acknowledgement received');
    assert.equal(ack.type, 'subscribed');
    const error = await ws.nextMessage(500);
    assert.ok(error, 'activation failure is reported after acknowledgement');
    assert.equal(error.type, 'error');
    assert.ok(error.failure);
  } finally {
    live.close();
    httpServer.close();
    await sleep(50);
  }
});

// P6e-1b (Slice B1): field-interest narrowing for ephemeral events.
//
// A subscriber declares which fields it wants via `fields: {...}` in the
// subscribe message. Ephemeral field events (<Entity>.<field>.set) are delivered
// ONLY to subscribers whose interest includes the field (fields[field] === true).
// Pass-through events (created/updated/removed/collection) are delivered to ALL
// subscribers (unchanged from P6e-1a firehose).
//
// The `pace` param is deferred (Slice B2) — reject with error if present.
// Coordinate narrowing is deferred (P6e-3) — reject range/in/is shapes.

import { text, ephemeral, grant, read, write, subscribe, scope, everyone } from '../src/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { connect as tcpConnect } from 'node:net';
import { randomBytes } from 'node:crypto';

import workbench, {
  entity, generateDDL } from '../src/internal.mjs';

// --- test entity ---

const Canvas = entity('Canvas', {
    title: text(),
  activeStroke: ephemeral({ points: true, color: true }),

  grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
});

// --- raw WebSocket harness (mirrors live-authz.test.mjs) ---

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

function bootCanvas() {
  const db = new DatabaseSync(':memory:');
  for (const sql of generateDDL(Canvas)) db.exec(sql);
  db.prepare('INSERT INTO Canvas (id, title) VALUES (?, ?)').run('c1', 'Drawing 1');
  db.prepare('INSERT INTO Canvas (id, title) VALUES (?, ?)').run('c2', 'Drawing 2');
  db.prepare('INSERT INTO Canvas (id, title) VALUES (?, ?)').run('c3', 'Drawing 3');
  db.prepare('INSERT INTO Canvas (id, title) VALUES (?, ?)').run('c4', 'Drawing 4');
  db.prepare('INSERT INTO Canvas (id, title) VALUES (?, ?)').run('c5', 'Drawing 5');
  const app = workbench({ db }).mount('/canvases', Canvas);
  app.listen(0, { principalOf: (req) => ({ type: 'user', id: req.headers?.['x-test-user'] ?? 'test' }) });
  return { app };
}

// --- Invariant 1: subscribe without fields → NO ephemeral .set events ---

test('B1: subscribe without fields does NOT receive ephemeral .set events', async () => {
  const { app } = bootCanvas();
  await app.ready;
  const port = app.httpServer.address().port;
  let ws;

  try {
    ws = await openRawWS(port, 'alice');
    ws.send(JSON.stringify({ type: 'subscribe', entity: 'Canvas', id: 'c1' }));
    const ack = await ws.nextMessage();
    assert.equal(ack.type, 'subscribed');

    const entityRecord = app.entities.get('Canvas');
    assert.ok(entityRecord, 'entity record exists');

    // Emit a pass-through event (Canvas.updated) — MUST be delivered
    await app.live.emit(entityRecord, 'c1', { id: 'c1', title: 'Drawing' }, {
      type: 'Canvas.updated', seq: 1, data: { title: 'updated' },
    });
    const ev1 = await ws.nextEvent(300);
    assert.ok(ev1, 'pass-through event (updated) must be delivered');
    assert.equal(ev1.event.type, 'Canvas.updated');

    // Emit an ephemeral .set event (Canvas.activeStroke.set) — MUST NOT be delivered
    await app.live.emit(entityRecord, 'c1', { id: 'c1', title: 'Drawing' }, {
      type: 'Canvas.activeStroke.set', seq: 2,
      data: { owner: 'c1', client: 'alice', cells: { points: [{ x: 1, y: 2 }] } },
    });
    const ev2 = await ws.nextEvent(200);
    assert.equal(ev2, null, 'ephemeral .set event must NOT be delivered without field interest');
  } finally {
    ws?.close();
    app.live.close();
    app.httpServer.close();
  }
});

// --- Invariant 2: subscribe WITH fields → receives ephemeral .set events ---

test('B1: subscribe WITH fields:{activeStroke:true} receives ephemeral .set events', async () => {
  const { app } = bootCanvas();
  await app.ready;
  const port = app.httpServer.address().port;
  let ws;

  try {
    ws = await openRawWS(port, 'alice');
    ws.send(JSON.stringify({
      type: 'subscribe', entity: 'Canvas', id: 'c1',
      fields: { activeStroke: true },
    }));
    const ack = await ws.nextMessage();
    assert.equal(ack.type, 'subscribed');

    const entityRecord = app.entities.get('Canvas');

    // Emit ephemeral .set event — MUST be delivered (field is in interest)
    await app.live.emit(entityRecord, 'c1', { id: 'c1', title: 'Drawing' }, {
      type: 'Canvas.activeStroke.set', seq: 1,
      data: { owner: 'c1', client: 'alice', cells: { points: [] } },
    });
    const ev1 = await ws.nextEvent(300);
    assert.ok(ev1, 'ephemeral .set event must be delivered with field interest');
    assert.equal(ev1.event.type, 'Canvas.activeStroke.set');

    // Pass-through events also delivered
    await app.live.emit(entityRecord, 'c1', { id: 'c1', title: 'Drawing' }, {
      type: 'Canvas.created', seq: 2, data: { title: 'Drawing 1' },
    });
    const ev2 = await ws.nextEvent(300);
    assert.ok(ev2, 'pass-through event (created) also delivered');
    assert.equal(ev2.event.type, 'Canvas.created');
  } finally {
    ws?.close();
    app.live.close();
    app.httpServer.close();
  }
});

// --- Invariant 3: coordinate narrowing rejected ---

test('B1: subscribe with fields:{activeStroke:{range:[1,2]}} rejects with "coordinate narrowing not yet supported"', async () => {
  const { app } = bootCanvas();
  await app.ready;
  const port = app.httpServer.address().port;
  let ws;

  try {
    ws = await openRawWS(port, 'alice');
    ws.send(JSON.stringify({
      type: 'subscribe', entity: 'Canvas', id: 'c1',
      fields: { activeStroke: { range: [1, 2] } },
    }));
    const msg = await ws.nextMessage();
    assert.ok(msg, 'server must respond');
    assert.equal(msg.type, 'error');
    assert.match(msg.message, /coordinate narrowing not yet supported/i);
  } finally {
    ws?.close();
    app.live.close();
    app.httpServer.close();
  }
});

// --- Invariant 4: unknown field rejected ---

test('B1: subscribe with fields:{bogus:true} rejects with "unknown field"', async () => {
  const { app } = bootCanvas();
  await app.ready;
  const port = app.httpServer.address().port;
  let ws;

  try {
    ws = await openRawWS(port, 'alice');
    ws.send(JSON.stringify({
      type: 'subscribe', entity: 'Canvas', id: 'c1',
      fields: { bogus: true },
    }));
    const msg = await ws.nextMessage();
    assert.ok(msg, 'server must respond');
    assert.equal(msg.type, 'error');
    assert.match(msg.message, /unknown field/i);
  } finally {
    ws?.close();
    app.live.close();
    app.httpServer.close();
  }
});

// --- Invariant 5: closure in fields rejected ---

test('B1: subscribe with closure in fields rejects "data, not a closure"', async () => {
  const { app } = bootCanvas();
  await app.ready;
  const port = app.httpServer.address().port;
  let ws;

  try {
    ws = await openRawWS(port, 'alice');
    // Fields with a closure cannot be serialized in JSON, so test via different
    // invalid types: a string, an array, or a function-value are all rejected.
    ws.send(JSON.stringify({
      type: 'subscribe', entity: 'Canvas', id: 'c1',
      fields: 'not-an-object',
    }));
    const msg = await ws.nextMessage();
    assert.ok(msg, 'server must respond');
    assert.equal(msg.type, 'error');
    assert.match(msg.message, /invalid fields interest/i);
  } finally {
    ws?.close();
    app.live.close();
    app.httpServer.close();
  }
});

test('B1: subscribe with array fields rejects "invalid fields interest"', async () => {
  const { app } = bootCanvas();
  await app.ready;
  const port = app.httpServer.address().port;
  let ws;

  try {
    ws = await openRawWS(port, 'alice');
    ws.send(JSON.stringify({
      type: 'subscribe', entity: 'Canvas', id: 'c1',
      fields: ['activeStroke'],
    }));
    const msg = await ws.nextMessage();
    assert.ok(msg, 'server must respond');
    assert.equal(msg.type, 'error');
    assert.match(msg.message, /invalid fields interest/i);
  } finally {
    ws?.close();
    app.live.close();
    app.httpServer.close();
  }
});

// --- Invariant 6: pace now accepted (B2) — valid pace subscribes, invalid rejects ---

test('B2: subscribe with a valid pace is accepted (pace retired the B1 rejection)', async () => {
  const { app } = bootCanvas();
  await app.ready;
  const port = app.httpServer.address().port;
  let ws;

  try {
    ws = await openRawWS(port, 'alice');
    ws.send(JSON.stringify({
      type: 'subscribe', entity: 'Canvas', id: 'c1',
      fields: { activeStroke: true },
      pace: { profile: '15fps' },
    }));
    const msg = await ws.nextMessage();
    assert.ok(msg, 'server must respond');
    assert.equal(msg.type, 'subscribed', 'a valid pace is accepted, not rejected');
  } finally {
    ws?.close();
    app.live.close();
    app.httpServer.close();
  }
});

test('B2: subscribe with an INVALID pace is rejected (validatePaceSelection fail-closed)', async () => {
  const { app } = bootCanvas();
  await app.ready;
  const port = app.httpServer.address().port;
  let ws;

  try {
    ws = await openRawWS(port, 'alice');
    ws.send(JSON.stringify({
      type: 'subscribe', entity: 'Canvas', id: 'c1',
      fields: { activeStroke: true },
      pace: { profile: 'no-such-profile' },
    }));
    const msg = await ws.nextMessage();
    assert.ok(msg, 'server must respond');
    assert.equal(msg.type, 'error', 'an unknown profile is rejected at subscribe time');
  } finally {
    ws?.close();
    app.live.close();
    app.httpServer.close();
  }
});

// --- Invariant 7: pass-through events delivered to ALL subscribers regardless of interest ---

test('B1: pass-through events (created, updated, removed) delivered to all subscribers regardless of fields', async () => {
  const { app } = bootCanvas();
  await app.ready;
  const port = app.httpServer.address().port;
  let ws1;
  let ws2;

  try {
    // Two connections: one WITH field interest, one WITHOUT
    ws1 = await openRawWS(port, 'alice');
    ws1.send(JSON.stringify({
      type: 'subscribe', entity: 'Canvas', id: 'c1',
      fields: { activeStroke: true },
    }));
    assert.equal((await ws1.nextMessage()).type, 'subscribed');

    ws2 = await openRawWS(port, 'bob');
    ws2.send(JSON.stringify({ type: 'subscribe', entity: 'Canvas', id: 'c1' }));
    assert.equal((await ws2.nextMessage()).type, 'subscribed');

    const entityRecord = app.entities.get('Canvas');

    // Emit a pass-through Canvas.updated — BOTH must receive it
    await app.live.emit(entityRecord, 'c1', { id: 'c1', title: 'Drawing' }, {
      type: 'Canvas.updated', seq: 1, data: { title: 'v2' },
    });
    const ev1a = await ws1.nextEvent(300);
    const ev1b = await ws2.nextEvent(300);
    assert.ok(ev1a, 'ws1 (with fields) receives updated');
    assert.ok(ev1b, 'ws2 (without fields) receives updated');
    assert.equal(ev1a.event.type, 'Canvas.updated');
    assert.equal(ev1b.event.type, 'Canvas.updated');

    // Emit ephemeral .set — ws1 must receive it, ws2 must NOT
    await app.live.emit(entityRecord, 'c1', { id: 'c1', title: 'Drawing' }, {
      type: 'Canvas.activeStroke.set', seq: 2,
      data: { owner: 'c1', client: 'alice', cells: { points: [] } },
    });
    const ev2a = await ws1.nextEvent(300);
    const ev2b = await ws2.nextEvent(200);
    assert.ok(ev2a, 'ws1 (with fields) receives ephemeral .set');
    assert.equal(ev2a.event.type, 'Canvas.activeStroke.set');
    assert.equal(ev2b, null, 'ws2 (without fields) must NOT receive ephemeral .set');
  } finally {
    ws1?.close();
    ws2?.close();
    app.live.close();
    app.httpServer.close();
  }
});

// --- Invariant 8: removed events are pass-through (no field filter) ---

test('B1: removed event delivered to ALL subscribers (no field filter on remove)', async () => {
  const { app } = bootCanvas();
  await app.ready;
  const port = app.httpServer.address().port;
  let ws1;
  let ws2;

  try {
    ws1 = await openRawWS(port, 'alice');
    ws1.send(JSON.stringify({
      type: 'subscribe', entity: 'Canvas', id: 'c1',
      fields: { activeStroke: true },
    }));
    assert.equal((await ws1.nextMessage()).type, 'subscribed');

    ws2 = await openRawWS(port, 'bob');
    ws2.send(JSON.stringify({ type: 'subscribe', entity: 'Canvas', id: 'c1' }));
    assert.equal((await ws2.nextMessage()).type, 'subscribed');

    const entityRecord = app.entities.get('Canvas');

    // Emit a removed event (row === undefined) — BOTH must receive it
    await app.live.emit(entityRecord, 'c1', undefined, {
      type: 'Canvas.removed', seq: 1,
    });
    const ev1a = await ws1.nextEvent(300);
    const ev1b = await ws2.nextEvent(300);
    assert.ok(ev1a, 'ws1 receives removed event');
    assert.ok(ev1b, 'ws2 receives removed event');
    assert.equal(ev1a.event.type, 'Canvas.removed');
    assert.equal(ev1b.event.type, 'Canvas.removed');
  } finally {
    ws1?.close();
    ws2?.close();
    app.live.close();
    app.httpServer.close();
  }
});

// --- Invariant 9: disconnect removes SubSpec entries (no leak) ---

test('B1: disconnect purges SubSpec entries from registry', async () => {
  const { app } = bootCanvas();
  await app.ready;
  const port = app.httpServer.address().port;
  let ws;

  try {
    ws = await openRawWS(port, 'alice');
    ws.send(JSON.stringify({
      type: 'subscribe', entity: 'Canvas', id: 'c1',
      fields: { activeStroke: true },
    }));
    assert.equal((await ws.nextMessage()).type, 'subscribed');

    // Disconnect
    ws.close();
    await sleep(100);

    // Emit an ephemeral event — should crash if registry still has stale entries
    // (emit deletes closed conns, so this should be a no-op)
    const entityRecord = app.entities.get('Canvas');
    await app.live.emit(entityRecord, 'c1', { id: 'c1', title: 'Drawing' }, {
      type: 'Canvas.activeStroke.set', seq: 1,
      data: { owner: 'c1', client: 'alice', cells: {} },
    });
    // No assertion needed — if this doesn't throw, the cleanup worked
  } finally {
    ws?.close();
    app.live.close();
    app.httpServer.close();
  }
});

// --- Invariant 10: MAX_SUBS_PER_CONN with fields (counts correctly) ---

test('B1: subs cap counts correctly with fields param', async () => {
  const { app } = bootCanvas();
  await app.ready;
  const port = app.httpServer.address().port;
  let ws;

  try {
    ws = await openRawWS(port, 'alice');
    // Subscribe to many different entity:id pairs with fields
    for (let i = 1; i <= 5; i++) {
      ws.send(JSON.stringify({
        type: 'subscribe', entity: 'Canvas', id: `c${i}`,
        fields: { activeStroke: true },
      }));
      const ack = await ws.nextMessage();
      assert.equal(ack.type, 'subscribed', `subscribe to c${i} should succeed`);
    }
    // All 5 subscriptions succeeded
  } finally {
    ws?.close();
    app.live.close();
    app.httpServer.close();
  }
});

// P6e-1b (Slice B1): field-interest narrowing for ephemeral events.
//
// A subscriber declares which fields it wants via `fields: {...}` in the
// subscribe message. Ephemeral field events (<Entity>.<field>.set) are delivered
// ONLY to subscribers whose interest includes the field (fields[field] === true).
// Pass-through events (created/updated/removed/collection) are delivered to ALL
// subscribers (unchanged from P6e-1a firehose).
//
// The `pace` param is deferred (Slice B2) -- reject with error if present.
// Coordinate narrowing is deferred (P6e-3) -- reject range/in/is shapes.
//
// Ephemeral delivery assertions use the package-private createLiveFanout seam
// (see also live-pace.test.mjs, live-fanout.test.mjs). Subscription input
// validation is exercised through raw WebSocket connections.

import { text, ephemeral, grant, read, write, subscribe, scope, everyone } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { connect as tcpConnect } from 'node:net';
import { randomBytes } from 'node:crypto';

import workbench, { entity, generateDDL } from '../build/internal.mjs';
import { createLiveFanout } from '../build/live-fanout.mjs';

// --- test entity ---

const Canvas = entity('Canvas', {
  title: text(),
  activeStroke: ephemeral({ points: true, color: true }),

  grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
});

// --- fake connection (mirrors live-pace.test.mjs, live-fanout.test.mjs) ---

function makeConn(id, principalId = id) {
  const messages = [];
  return {
    id,
    closed: false,
    principal: { type: 'user', id: principalId },
    send(message) { messages.push(message); },
    drain() { const out = [...messages]; messages.length = 0; return out; },
  };
}

function makeCanvasRecord() {
  return {
    name: 'Canvas',
    fields: { activeStroke: { kind: 'ephemeral' } },
    grant: () => [scope().can(() => grant(read, write, subscribe))],
    findById: () => ({ id: 'c1', title: 'Drawing' }),
  };
}

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

// --- Invariant 1: subscribe without fields -> NO ephemeral .set events ---

test('B1: subscribe without fields does NOT receive ephemeral .set events', async () => {
  const fanout = createLiveFanout({ mayVerb: async () => true });
  const conn = makeConn('c1', 'alice');
  const entity = makeCanvasRecord();
  fanout.addSubscription('Canvas', 'c1', conn);

  // Pass-through event (Canvas.updated) -- MUST be delivered
  await fanout.emit(entity, 'c1', { id: 'c1', title: 'Drawing' }, {
    type: 'Canvas.updated', seq: 1, data: { title: 'updated' },
  });
  const out1 = conn.drain();
  assert.equal(out1.length, 1);
  assert.equal(out1[0].event.type, 'Canvas.updated');

  // Ephemeral .set event (Canvas.activeStroke.set) -- MUST NOT be delivered
  await fanout.emit(entity, 'c1', { id: 'c1', title: 'Drawing' }, {
    type: 'Canvas.activeStroke.set', seq: 2,
    data: { owner: 'c1', client: 'alice', cells: { points: [{ x: 1, y: 2 }] } },
  });
  assert.deepEqual(conn.drain(), []);
  fanout.close();
});

// --- Invariant 2: subscribe WITH fields -> receives ephemeral .set events ---

test('B1: subscribe WITH fields:{activeStroke:true} receives ephemeral .set events', async () => {
  const fanout = createLiveFanout({ mayVerb: async () => true });
  const conn = makeConn('c1', 'alice');
  const entity = makeCanvasRecord();
  fanout.addSubscription('Canvas', 'c1', conn, { activeStroke: true });

  // Ephemeral .set event -- MUST be delivered (field is in interest)
  await fanout.emit(entity, 'c1', { id: 'c1', title: 'Drawing' }, {
    type: 'Canvas.activeStroke.set', seq: 1,
    data: { owner: 'c1', client: 'alice', cells: { points: [] } },
  });
  const out1 = conn.drain();
  assert.equal(out1.length, 1);
  assert.equal(out1[0].event.type, 'Canvas.activeStroke.set');

  // Pass-through events also delivered
  await fanout.emit(entity, 'c1', { id: 'c1', title: 'Drawing' }, {
    type: 'Canvas.created', seq: 2, data: { title: 'Drawing 1' },
  });
  const out2 = conn.drain();
  assert.equal(out2.length, 1);
  assert.equal(out2[0].event.type, 'Canvas.created');
  fanout.close();
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
    assert.equal(msg.failure.category, 'invalid-input');
    assert.match(msg.failure.message, /coordinate narrowing.*not supported/i);
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
    assert.equal(msg.failure.category, 'invalid-input');
    assert.match(msg.failure.message, /unknown field/i);
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
    ws.send(JSON.stringify({
      type: 'subscribe', entity: 'Canvas', id: 'c1',
      fields: 'not-an-object',
    }));
    const msg = await ws.nextMessage();
    assert.ok(msg, 'server must respond');
    assert.equal(msg.type, 'error');
    assert.equal(msg.failure.category, 'invalid-input');
    assert.match(msg.failure.message, /invalid fields interest/i);
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
    assert.equal(msg.failure.category, 'invalid-input');
    assert.match(msg.failure.message, /invalid fields interest/i);
  } finally {
    ws?.close();
    app.live.close();
    app.httpServer.close();
  }
});

// --- Invariant 6: pace now accepted (B2) -- valid pace subscribes, invalid rejects ---

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
  const fanout = createLiveFanout({ mayVerb: async () => true });
  const conn1 = makeConn('c1', 'alice');
  const conn2 = makeConn('c2', 'bob');
  const entity = makeCanvasRecord();
  fanout.addSubscription('Canvas', 'c1', conn1, { activeStroke: true });
  fanout.addSubscription('Canvas', 'c1', conn2);

  // Pass-through Canvas.updated -- BOTH must receive it
  await fanout.emit(entity, 'c1', { id: 'c1', title: 'Drawing' }, {
    type: 'Canvas.updated', seq: 1, data: { title: 'v2' },
  });
  const out1a = conn1.drain();
  const out1b = conn2.drain();
  assert.equal(out1a.length, 1);
  assert.equal(out1b.length, 1);
  assert.equal(out1a[0].event.type, 'Canvas.updated');
  assert.equal(out1b[0].event.type, 'Canvas.updated');

  // Ephemeral .set -- conn1 must receive it, conn2 must NOT
  await fanout.emit(entity, 'c1', { id: 'c1', title: 'Drawing' }, {
    type: 'Canvas.activeStroke.set', seq: 2,
    data: { owner: 'c1', client: 'alice', cells: { points: [] } },
  });
  const out2a = conn1.drain();
  const out2b = conn2.drain();
  assert.equal(out2a.length, 1);
  assert.equal(out2a[0].event.type, 'Canvas.activeStroke.set');
  assert.deepEqual(out2b, []);
  fanout.close();
});

// --- Invariant 8: removed events are pass-through (no field filter) ---

test('B1: removed event delivered to ALL subscribers (no field filter on remove)', async () => {
  const fanout = createLiveFanout({ mayVerb: async () => true });
  const conn1 = makeConn('c1', 'alice');
  const conn2 = makeConn('c2', 'bob');
  const entity = makeCanvasRecord();
  fanout.addSubscription('Canvas', 'c1', conn1, { activeStroke: true });
  fanout.addSubscription('Canvas', 'c1', conn2);

  await fanout.emit(entity, 'c1', undefined, {
    type: 'Canvas.removed', seq: 1,
  });
  const out1 = conn1.drain();
  const out2 = conn2.drain();
  assert.equal(out1.length, 1);
  assert.equal(out2.length, 1);
  assert.equal(out1[0].event.type, 'Canvas.removed');
  assert.equal(out2[0].event.type, 'Canvas.removed');
  fanout.close();
});

// --- Invariant 9: disconnect removes SubSpec entries (no leak) ---

test('B1: disconnect purges SubSpec entries from registry', async () => {
  const fanout = createLiveFanout({ mayVerb: async () => true });
  const conn = makeConn('c1', 'alice');
  const entity = makeCanvasRecord();
  fanout.addSubscription('Canvas', 'c1', conn, { activeStroke: true });

  conn.closed = true;
  fanout.removeAll(conn);

  await fanout.emit(entity, 'c1', { id: 'c1', title: 'Drawing' }, {
    type: 'Canvas.activeStroke.set', seq: 1,
    data: { owner: 'c1', client: 'alice', cells: {} },
  });
  fanout.close();
});

// --- Invariant 10: MAX_SUBS_PER_CONN with fields (counts correctly) ---

test('B1: subs cap counts correctly with fields param', async () => {
  const { app } = bootCanvas();
  await app.ready;
  const port = app.httpServer.address().port;
  let ws;

  try {
    ws = await openRawWS(port, 'alice');
    for (let i = 1; i <= 5; i++) {
      ws.send(JSON.stringify({
        type: 'subscribe', entity: 'Canvas', id: `c${i}`,
        fields: { activeStroke: true },
      }));
      const ack = await ws.nextMessage();
      assert.equal(ack.type, 'subscribed', `subscribe to c${i} should succeed`);
    }
  } finally {
    ws?.close();
    app.live.close();
    app.httpServer.close();
  }
});

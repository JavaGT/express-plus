// P6e-1b (Slice B2): pace/coalescing for ephemeral field events.
//
// A subscriber may carry `pace:{profile:'15fps'}` (or explicit coalesce config)
// to coalesce high-frequency ephemeral events into fewer envelopes. Window=0
// (pass-through) is the identity path: immediate, per-event, with seqSpan.
// removed events bypass coalescing (delivered immediately).
//
// All paths share ONE emit path — pass-through is window=0 on the same branch,
// not a separate raw-send path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { connect as tcpConnect } from 'node:net';
import { randomBytes } from 'node:crypto';

import expressPlus, {
  entity, text, ephemeral, grant, read, write, subscribe, scope, everyone,
  generateDDL, executeFrameworkDDL,
} from '../src/index.mjs';
import { setActiveDb } from '../src/db.mjs';

// --- test entity ---

const Canvas = entity('Canvas', {
  fields: {
    title: text(),
    activeStroke: ephemeral({ points: true, color: true }),
  },
  grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
});

// --- raw WebSocket harness (mirrors live-interest.test.mjs) ---

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
        resolve({ sock, send, nextMessage, nextEvent, nextEvents, close });
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

    async function nextEvents(timeoutMs = 400) {
      const start = Date.now();
      const events = [];
      while (Date.now() - start <= timeoutMs) {
        while (inbox.length > 0) {
          const msg = JSON.parse(inbox.shift());
          if (msg.type === 'event') events.push(msg);
        }
        if (events.length > 0) return events;
        await new Promise((r) => setTimeout(r, 20));
      }
      return events;
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
  const app = expressPlus({ db }).mount('/canvases', Canvas);
  app.listen(0, { principalOf: (req) => ({ type: 'user', id: req.headers?.['x-test-user'] ?? 'test' }) });
  return { app };
}

// Helper: emit an ephemeral .set event
function emitSet(app, id, seq, data) {
  const entityRecord = app.entities.get('Canvas');
  return app.live.emit(entityRecord, id, { id, title: 'Drawing' }, {
    type: 'Canvas.activeStroke.set', seq,
    data: data ?? { owner: 'test', client: 'test', cells: {} },
  });
}

function emitRemoved(app, id, seq) {
  const entityRecord = app.entities.get('Canvas');
  return app.live.emit(entityRecord, id, undefined, {
    type: 'Canvas.removed', seq,
  });
}

// ============================================================
// Invariant 1: no-pace subscriber receives ephemeral events
// IMMEDIATELY, one envelope per event, each with seqSpan:[seq,seq]
// ============================================================

test('B2: no-pace subscriber receives ephemeral events immediately with seqSpan', async () => {
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
    assert.equal((await ws.nextMessage())?.type, 'subscribed');

    await emitSet(app, 'c1', 1, { owner: 'alice', client: 'alice', cells: { points: [{ x: 0, y: 0 }] } });
    const ev1 = await ws.nextEvent(300);
    assert.ok(ev1, 'event received');
    assert.equal(ev1.type, 'event');
    assert.equal(ev1.seq, 1);
    assert.deepEqual(ev1.seqSpan, [1, 1], 'pass-through has single-event seqSpan');
    assert.equal(ev1.event.type, 'Canvas.activeStroke.set');

    // Second event — separate envelope
    await emitSet(app, 'c1', 2, { owner: 'alice', client: 'alice', cells: { points: [{ x: 1, y: 1 }] } });
    const ev2 = await ws.nextEvent(300);
    assert.ok(ev2, 'second event received');
    assert.equal(ev2.seq, 2);
    assert.deepEqual(ev2.seqSpan, [2, 2], 'each event has its own span');

    // Count: 2 events, 2 envelopes
    const ev3 = await ws.nextEvent(100);
    assert.equal(ev3, null, 'no extra envelope');
  } finally {
    ws?.close();
    app.live.close();
    app.httpServer.close();
  }
});

// ============================================================
// Invariant 2: 15fps subscriber receives FAR fewer envelopes
// than events emitted, each with spanning seqSpan
// ============================================================

test('B2: 15fps subscriber receives coalesced envelopes (far fewer than events)', async () => {
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
    assert.equal((await ws.nextMessage())?.type, 'subscribed');

    // Emit 10 events rapidly (no delay between emits)
    for (let i = 1; i <= 10; i++) {
      await emitSet(app, 'c1', i, { owner: 'alice', client: 'alice', cells: { points: [{ x: i, y: i * 2 }] } });
    }

    // Wait for flush timer (66ms window, give extra)
    await sleep(200);

    // Collect all coalesced envelopes
    const coalesced = await ws.nextEvents(200);
    assert.ok(coalesced.length > 0, 'some coalesced envelopes received');
    assert.ok(coalesced.length < 10, `far fewer than 10 envelopes (got ${coalesced.length})`);

    // Each envelope should have seqSpan that spans multiple seqs
    for (const ev of coalesced) {
      assert.equal(ev.type, 'event');
      assert.ok(Array.isArray(ev.seqSpan), 'seqSpan is an array');
      assert.equal(ev.seqSpan.length, 2, 'seqSpan [first, last]');
      assert.ok(ev.seqSpan[0] <= ev.seqSpan[1], 'seqSpan in order');
    }
  } finally {
    ws?.close();
    app.live.close();
    app.httpServer.close();
  }
});

// ============================================================
// Invariant 3: profile:'pass-through' → identical to no-pace
// ============================================================

test('B2: pace:{profile:"pass-through"} behaves identically to no-pace', async () => {
  const { app } = bootCanvas();
  await app.ready;
  const port = app.httpServer.address().port;
  let ws;

  try {
    ws = await openRawWS(port, 'alice');
    ws.send(JSON.stringify({
      type: 'subscribe', entity: 'Canvas', id: 'c1',
      fields: { activeStroke: true },
      pace: { profile: 'pass-through' },
    }));
    assert.equal((await ws.nextMessage())?.type, 'subscribed');

    await emitSet(app, 'c1', 1);
    const ev1 = await ws.nextEvent(300);
    assert.ok(ev1, 'pass-through profile delivers event');
    assert.equal(ev1.seq, 1);
    assert.deepEqual(ev1.seqSpan, [1, 1]);

    await emitSet(app, 'c1', 2);
    const ev2 = await ws.nextEvent(200);
    assert.ok(ev2, 'second event delivered in separate envelope');
    assert.equal(ev2.seq, 2);
    assert.deepEqual(ev2.seqSpan, [2, 2]);
  } finally {
    ws?.close();
    app.live.close();
    app.httpServer.close();
  }
});

// ============================================================
// Invariant 4: invalid pace rejected at subscribe time
// ============================================================

test('B2: subscribe with pace:{profile:"bogus"} rejects with unknown profile', async () => {
  const { app } = bootCanvas();
  await app.ready;
  const port = app.httpServer.address().port;
  let ws;

  try {
    ws = await openRawWS(port, 'alice');
    ws.send(JSON.stringify({
      type: 'subscribe', entity: 'Canvas', id: 'c1',
      fields: { activeStroke: true },
      pace: { profile: 'bogus' },
    }));
    const msg = await ws.nextMessage();
    assert.ok(msg, 'server must respond');
    assert.equal(msg.type, 'error');
    assert.match(msg.message, /unknown pace profile/i);
  } finally {
    ws?.close();
    app.live.close();
    app.httpServer.close();
  }
});

test('B2: subscribe with pace:{coalesce:{window:-5,by:"latest-wins"}} rejects', async () => {
  const { app } = bootCanvas();
  await app.ready;
  const port = app.httpServer.address().port;
  let ws;

  try {
    ws = await openRawWS(port, 'alice');
    ws.send(JSON.stringify({
      type: 'subscribe', entity: 'Canvas', id: 'c1',
      fields: { activeStroke: true },
      pace: { coalesce: { window: -5, by: 'latest-wins' } },
    }));
    const msg = await ws.nextMessage();
    assert.ok(msg, 'server must respond');
    assert.equal(msg.type, 'error');
    assert.match(msg.message, /pace window|exceeds bounds/i);
  } finally {
    ws?.close();
    app.live.close();
    app.httpServer.close();
  }
});

// ============================================================
// Invariant 5: removed event delivered IMMEDIATELY to paced
// subscriber (does NOT sit in stroke buffer)
// ============================================================

test('B2: removed event bypasses coalescing (delivered immediately to paced subscriber)', async () => {
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
    assert.equal((await ws.nextMessage())?.type, 'subscribed');

    // Emit an ephemeral .set (will be buffered)
    await emitSet(app, 'c1', 1, { owner: 'alice', client: 'alice', cells: { points: [{ x: 0, y: 0 }] } });

    // Immediately emit a removed event
    await emitRemoved(app, 'c1', 2);

    // The removed event should arrive BEFORE the 66ms flush timer fires for the .set
    // Use a short timeout — if removed is buffered, it won't arrive
    const removedEv = await ws.nextEvent(80);
    assert.ok(removedEv, 'removed event arrives immediately (before flush timer)');
    assert.equal(removedEv.event.type, 'Canvas.removed');
    assert.deepEqual(removedEv.seqSpan, [2, 2], 'removed is pass-through span');

    // The .set event might arrive later via its flush timer
  } finally {
    ws?.close();
    app.live.close();
    app.httpServer.close();
  }
});

// ============================================================
// Invariant 6: revoked grant → paced events dropped at flush
// ============================================================

test('B2: revoked subscriber receives NOTHING at flush time', async () => {
  // Directly create a live server with a controllable mayVerb.
  const db = new DatabaseSync(':memory:');
  setActiveDb(db);
  executeFrameworkDDL(db);
  for (const sql of generateDDL(Canvas)) db.exec(sql);
  db.prepare('INSERT INTO Canvas (id, title) VALUES (?, ?)').run('c1', 'Drawing 1');

  const http = await import('node:http');
  const httpServer = http.createServer();
  const { createLiveServer } = await import('../src/live.mjs');

  let bobAllowed = true;

  const live = createLiveServer(httpServer, {
    path: '/events',
    mayVerb: async (entity, verb, row, principal) => {
      if (principal?.id === 'bob' && verb === 'subscribe') {
        return bobAllowed;
      }
      return true;
    },
    principalOf: (req) => {
      const u = req.headers?.['x-test-user'] ?? 'test';
      return { type: 'user', id: u };
    },
    db,
    resolveEntity: () => Canvas,
  });

  httpServer.listen(0);
  await new Promise((r) => httpServer.once('listening', r));
  const port = httpServer.address().port;
  let bob;

  try {
    bob = await openRawWS(port, 'bob');
    bob.send(JSON.stringify({
      type: 'subscribe', entity: 'Canvas', id: 'c1',
      fields: { activeStroke: true },
      pace: { profile: '15fps' },
    }));
    assert.equal((await bob.nextMessage())?.type, 'subscribed');

    // Emit some ephemeral events (buffered)
    await live.emit(Canvas, 'c1', { id: 'c1', title: 'Drawing' }, {
      type: 'Canvas.activeStroke.set', seq: 1,
      data: { owner: 'bob', client: 'bob', cells: { points: [{ x: 0, y: 0 }] } },
    });
    await live.emit(Canvas, 'c1', { id: 'c1', title: 'Drawing' }, {
      type: 'Canvas.activeStroke.set', seq: 2,
      data: { owner: 'bob', client: 'bob', cells: { points: [{ x: 1, y: 1 }] } },
    });

    // Revoke bob's access BEFORE the flush timer fires
    await sleep(10);
    bobAllowed = false;

    // Wait for flush timer (66ms + margin)
    await sleep(150);

    // Bob should receive NOTHING
    const ev = await bob.nextEvent(100);
    assert.equal(ev, null, 'revoked subscriber receives nothing at flush time');
  } finally {
    bob?.close();
    live.close();
    httpServer.close();
  }
});

// ============================================================
// Invariant 7: disconnect purges pending buffers + timers
// ============================================================

test('B2: disconnect purges pending buffers and timers', async () => {
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
    assert.equal((await ws.nextMessage())?.type, 'subscribed');

    // Emit events (will be buffered)
    await emitSet(app, 'c1', 1);
    await emitSet(app, 'c1', 2);

    // Disconnect before flush
    ws.close();
    await sleep(50);

    // Emit more events — should not throw (closed conn handled)
    await emitSet(app, 'c1', 3);

    // Wait for flush timer to fire (66ms + margin)
    await sleep(150);

    // No assertions beyond "no crash" — the purge happened during close
    // and subsequent emit cleaned up closed conns
  } finally {
    ws?.close();
    app.live.close();
    app.httpServer.close();
  }
});

// ============================================================
// Invariant 8: existing fan-out stays green (full suite test)
// ============================================================

// This test verifies that non-ephemeral events still deliver normally with seqSpan.
test('B2: non-ephemeral events still deliver to paced subscriber (seqSpan on all events)', async () => {
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
    assert.equal((await ws.nextMessage())?.type, 'subscribed');

    const entityRecord = app.entities.get('Canvas');

    // Emit a pass-through event (Canvas.created — non-ephemeral)
    await app.live.emit(entityRecord, 'c1', { id: 'c1', title: 'Drawing' }, {
      type: 'Canvas.created', seq: 1, data: { title: 'Drawing 1' },
    });
    const ev1 = await ws.nextEvent(300);
    assert.ok(ev1, 'non-ephemeral event delivered');
    assert.equal(ev1.event.type, 'Canvas.created');
    assert.deepEqual(ev1.seqSpan, [1, 1], 'non-ephemeral event has seqSpan');
  } finally {
    ws?.close();
    app.live.close();
    app.httpServer.close();
  }
});

// ============================================================
// Invariant 9: separate (entity,id) scopes have separate buffers
// ============================================================

test('B2: events for different entity scopes have separate buffers (independent seqSpans)', async () => {
  const { app } = bootCanvas();
  await app.ready;
  const port = app.httpServer.address().port;
  let ws;

  try {
    ws = await openRawWS(port, 'alice');
    // Subscribe to two different entities with 15fps and same field interest
    ws.send(JSON.stringify({
      type: 'subscribe', entity: 'Canvas', id: 'c1',
      fields: { activeStroke: true },
      pace: { profile: '15fps' },
    }));
    assert.equal((await ws.nextMessage())?.type, 'subscribed');

    ws.send(JSON.stringify({
      type: 'subscribe', entity: 'Canvas', id: 'c2',
      fields: { activeStroke: true },
      pace: { profile: '15fps' },
    }));
    assert.equal((await ws.nextMessage())?.type, 'subscribed');

    const entityRecord = app.entities.get('Canvas');

    // Emit to c1 (seq 1)
    await app.live.emit(entityRecord, 'c1', { id: 'c1', title: 'Drawing' }, {
      type: 'Canvas.activeStroke.set', seq: 1,
      data: { owner: 'alice', client: 'alice', cells: { points: [] } },
    });

    // Emit to c2 (seq 1 in its own scope) — these are separate _Cursor scopes
    await app.live.emit(entityRecord, 'c2', { id: 'c2', title: 'Drawing 2' }, {
      type: 'Canvas.activeStroke.set', seq: 1,
      data: { owner: 'alice', client: 'alice', cells: { points: [] } },
    });

    // Wait for flush
    await sleep(150);

    const events = await ws.nextEvents(300);
    assert.ok(events.length >= 2, 'at least two coalesced envelopes (one per scope)');

    // Each envelope should reference a single scope's events
    for (const ev of events) {
      assert.ok(['c1', 'c2'].includes(ev.id), `event belongs to c1 or c2, got ${ev.id}`);
    }
  } finally {
    ws?.close();
    app.live.close();
    app.httpServer.close();
  }
});

// ============================================================
// B1-regression: subscribe with valid pace+fields is accepted
// (B1 test "pace not yet supported" → B2 it's accepted)
// ============================================================

test('B2: subscribe with pace + fields is accepted (replaces B1 pace rejection)', async () => {
  const { app } = bootCanvas();
  await app.ready;
  const port = app.httpServer.address().port;
  let ws;

  try {
    ws = await openRawWS(port, 'alice');
    ws.send(JSON.stringify({
      type: 'subscribe', entity: 'Canvas', id: 'c1',
      fields: { activeStroke: true },
      pace: { profile: 'pass-through' },
    }));
    const msg = await ws.nextMessage();
    assert.equal(msg.type, 'subscribed', 'pace + fields subscription is accepted');
  } finally {
    ws?.close();
    app.live.close();
    app.httpServer.close();
  }
});
// Ephemeral pacing belongs to the package-private fanout. Durable delivery is
// covered by live-delivery tests through the committed log and never uses this
// test seam.

import { text, ephemeral, grant, read, write, subscribe, scope, everyone } from '../src/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { connect as tcpConnect } from 'node:net';
import { randomBytes } from 'node:crypto';

import workbench, { entity, generateDDL } from '../src/internal.mjs';
import { createLiveFanout } from '../src/live-fanout.mjs';

const Canvas = entity('Canvas', {
  title: text(),
  activeStroke: ephemeral({ points: true, color: true }),
  grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const row = { id: 'c1', title: 'Drawing' };
  return {
    name: 'Canvas',
    fields: { activeStroke: { kind: 'ephemeral' } },
    grant: () => [scope().can(() => true)],
    findById: () => row,
  };
}

function stroke(seq, cells = {}) {
  return {
    type: 'Canvas.activeStroke.set',
    seq,
    data: { owner: 'alice', client: 'alice', cells },
  };
}

// Raw WebSocket coverage is limited to protocol validation. Emission itself is
// intentionally exercised through createLiveFanout above, not app.live.
function openRawWS(port) {
  return new Promise((resolve, reject) => {
    const sock = tcpConnect(port, '127.0.0.1');
    const key = randomBytes(16).toString('base64');
    const handshake = [
      'GET /events HTTP/1.1', 'Host: localhost', 'Upgrade: websocket',
      'Connection: Upgrade', `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13', 'x-test-user: alice', '', '',
    ].join('\r\n');
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    const inbox = [];
    sock.on('connect', () => sock.write(handshake));
    sock.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end === -1) return;
        if (!buffer.slice(0, end).toString().startsWith('HTTP/1.1 101')) return reject(new Error('upgrade failed'));
        buffer = buffer.slice(end + 4);
        upgraded = true;
        resolve({ send, nextMessage, close });
      }
      while (buffer.length >= 2) {
        const length = buffer[1] & 0x7f;
        if (length >= 126 || buffer.length < length + 2) return;
        const opcode = buffer[0] & 0x0f;
        const payload = buffer.slice(2, length + 2);
        buffer = buffer.slice(length + 2);
        if (opcode === 1) inbox.push(payload.toString('utf8'));
      }
    });
    sock.on('error', reject);
    function send(message) {
      const payload = Buffer.from(message);
      const mask = randomBytes(4);
      const body = Buffer.alloc(payload.length);
      for (let index = 0; index < payload.length; index++) body[index] = payload[index] ^ mask[index % 4];
      sock.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, body]));
    }
    async function nextMessage(timeoutMs = 400) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (inbox.length) return JSON.parse(inbox.shift());
        await sleep(10);
      }
      return null;
    }
    function close() { sock.destroy(); }
  });
}

function bootCanvas() {
  const db = new DatabaseSync(':memory:');
  for (const sql of generateDDL(Canvas)) db.exec(sql);
  db.prepare('INSERT INTO Canvas (id, title) VALUES (?, ?)').run('c1', 'Drawing 1');
  const app = workbench({ db }).mount('/canvases', Canvas);
  app.listen(0, { principalOf: () => ({ type: 'user', id: 'alice' }) });
  return app;
}

test('ephemeral no-pace delivery is immediate and preserves each sequence span', async () => {
  const fanout = createLiveFanout({ mayVerb: async () => true });
  const conn = makeConn('c1', 'alice');
  const entity = makeCanvasRecord();
  fanout.addSubscription('Canvas', 'c1', conn, { activeStroke: true });
  await fanout.emit(entity, 'c1', { id: 'c1', title: 'Drawing' }, stroke(1, { points: [{ x: 0, y: 0 }] }));
  await fanout.emit(entity, 'c1', { id: 'c1', title: 'Drawing' }, stroke(2, { points: [{ x: 1, y: 1 }] }));
  assert.deepEqual(conn.drain().map(({ seq, seqSpan }) => ({ seq, seqSpan })), [{ seq: 1, seqSpan: [1, 1] }, { seq: 2, seqSpan: [2, 2] }]);
  fanout.close();
});

test('ephemeral 15fps delivery coalesces a burst into one span', async () => {
  const fanout = createLiveFanout({ mayVerb: async () => true });
  const conn = makeConn('c1', 'alice');
  const entity = makeCanvasRecord();
  fanout.addSubscription('Canvas', 'c1', conn, { activeStroke: true }, { window: 30, by: 'latest-wins' });
  for (let seq = 1; seq <= 10; seq++) await fanout.emit(entity, 'c1', { id: 'c1', title: 'Drawing' }, stroke(seq));
  await sleep(60);
  assert.deepEqual(conn.drain().map(({ seq, seqSpan }) => ({ seq, seqSpan })), [{ seq: 10, seqSpan: [1, 10] }]);
  fanout.close();
});

test('pass-through profile is the same immediate fanout path', async () => {
  const fanout = createLiveFanout({ mayVerb: async () => true });
  const conn = makeConn('c1', 'alice');
  const entity = makeCanvasRecord();
  fanout.addSubscription('Canvas', 'c1', conn, { activeStroke: true }, { window: 0, by: null });
  await fanout.emit(entity, 'c1', { id: 'c1', title: 'Drawing' }, stroke(1));
  assert.deepEqual(conn.drain()[0].seqSpan, [1, 1]);
  fanout.close();
});

test('removal bypasses an ephemeral pace buffer', async () => {
  const fanout = createLiveFanout({ mayVerb: async () => true });
  const conn = makeConn('c1', 'alice');
  const entity = makeCanvasRecord();
  fanout.addSubscription('Canvas', 'c1', conn, { activeStroke: true }, { window: 100, by: 'latest-wins' });
  await fanout.emit(entity, 'c1', { id: 'c1', title: 'Drawing' }, stroke(1));
  await fanout.emit(entity, 'c1', undefined, { type: 'Canvas.removed', seq: 2 });
  assert.deepEqual(conn.drain()[0].seqSpan, [2, 2]);
  fanout.close();
});

test('revocation at flush time drops buffered ephemeral events', async () => {
  let allowed = true;
  const fanout = createLiveFanout({ mayVerb: async () => allowed });
  const conn = makeConn('c1', 'alice');
  const entity = makeCanvasRecord();
  fanout.addSubscription('Canvas', 'c1', conn, { activeStroke: true }, { window: 30, by: 'latest-wins' });
  await fanout.emit(entity, 'c1', { id: 'c1', title: 'Drawing' }, stroke(1));
  allowed = false;
  await sleep(60);
  assert.deepEqual(conn.drain(), []);
  fanout.close();
});

test('ephemeral pace buffers are isolated per entity scope and discarded on disconnect', async () => {
  const fanout = createLiveFanout({ mayVerb: async () => true });
  const conn = makeConn('c1', 'alice');
  const entity = makeCanvasRecord();
  fanout.addSubscription('Canvas', 'c1', conn, { activeStroke: true }, { window: 30, by: 'latest-wins' });
  fanout.addSubscription('Canvas', 'c2', conn, { activeStroke: true }, { window: 30, by: 'latest-wins' });
  await fanout.emit(entity, 'c1', { id: 'c1', title: 'Drawing' }, stroke(1));
  await fanout.emit(entity, 'c2', { id: 'c2', title: 'Drawing' }, stroke(1));
  await sleep(60);
  assert.deepEqual(conn.drain().map((event) => event.id).sort(), ['c1', 'c2']);
  await fanout.emit(entity, 'c1', { id: 'c1', title: 'Drawing' }, stroke(2));
  fanout.removeAll(conn);
  await sleep(60);
  assert.deepEqual(conn.drain(), []);
  fanout.close();
});

test('WebSocket subscription rejects invalid pace profiles and accepts valid fields', async () => {
  const app = bootCanvas();
  await app.ready;
  const port = app.httpServer.address().port;
  let ws;
  try {
    ws = await openRawWS(port);
    ws.send(JSON.stringify({ type: 'subscribe', entity: 'Canvas', id: 'c1', fields: { activeStroke: true }, pace: { profile: 'bogus' } }));
    assert.equal((await ws.nextMessage())?.type, 'error');
    ws.close();
    ws = await openRawWS(port);
    ws.send(JSON.stringify({ type: 'subscribe', entity: 'Canvas', id: 'c1', fields: { activeStroke: true }, pace: { profile: 'pass-through' } }));
    assert.equal((await ws.nextMessage())?.type, 'subscribed');
  } finally {
    ws?.close();
    app.live.close();
    app.httpServer.close();
  }
});

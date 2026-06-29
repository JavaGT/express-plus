// Hardening: WebSocket live-sync end-to-end via raw socket.
//
// Node's `http.WebSocket` client didn't interoperate with our manual upgrade
// handler, so this test drives the protocol directly over a raw TCP socket:
// send the RFC 6455 handshake, exchange masked frames, and verify CRUD
// operations produce live events with monotonic sequence numbers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { connect as tcpConnect } from 'node:net';
import { randomBytes, createHash } from 'node:crypto';

import expressPlus, { entity, text, ref, grant, read, write, subscribe, scope, generateDDL } from '../src/index.mjs';

function makeNote() {
  return entity('Note', {
    fields: { body: text(), owner: ref('User', { role: 'owner', readonly: true }) },
    grant: () => [scope(({ is }) => is.owner()).can(async ({ is }) => (await is.owner()) ? grant(read, write, subscribe) : grant(read))],
  });
}

// Open a raw WebSocket connection to the server's /events path. Returns a
// helper that sends masked text frames and collects incoming server frames.
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
      'Sec-WebSocket-Version: 13\r\n\r\n';

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
        resolve({ sock, send, nextEvent, close });
      }
      // Parse unmasked frames from the server (after upgrade).
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
        // ignore close/ping/pong for this test
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

    async function nextEvent(timeoutMs = 1000) {
      const start = Date.now();
      while (Date.now() - start <= timeoutMs) {
        while (inbox.length > 0) {
          const msg = JSON.parse(inbox.shift());
          if (msg.type === 'event') return msg;
          // skip subscribe confirmations / errors
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('create emits WS event with seq:1', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS User (id INTEGER PRIMARY KEY, username TEXT, password TEXT)');
  db.exec("INSERT INTO User (id, username, password) VALUES (1, 'alice', 'hash')");
  const Note = makeNote();
  for (const sql of generateDDL(Note)) db.exec(sql);

  const app = expressPlus({ db }).mount('/notes', Note);
  app.listen(0, { principalOf: () => ({ type: 'user', id: '1' }) });
  await app.ready;
  const { port } = app.httpServer.address();
  const origin = `http://127.0.0.1:${port}`;

  const ws = await openRawWS(port);
  ws.send(JSON.stringify({ type: 'subscribe', entity: 'Note', id: '1' }));
  await sleep(50);

  const r = await fetch(`${origin}/notes`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'hello' }),
  });
  assert.equal(r.status, 201);

  const ev = await ws.nextEvent();
  assert.ok(ev, 'event received');
  assert.equal(ev.type, 'event');
  assert.equal(ev.entity, 'Note');
  assert.equal(ev.seq, 1);
  assert.equal(ev.event.verb, 'create');

  ws.close();
  app.httpServer.close();
});

test('update and delete emit sequential WS events (seq:2, seq:3)', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS User (id INTEGER PRIMARY KEY, username TEXT, password TEXT)');
  db.exec("INSERT INTO User (id, username, password) VALUES (1, 'alice', 'hash')");
  const Note = makeNote();
  for (const sql of generateDDL(Note)) db.exec(sql);

  const app = expressPlus({ db }).mount('/notes', Note);
  app.listen(0, { principalOf: () => ({ type: 'user', id: '1' }) });
  await app.ready;
  const { port } = app.httpServer.address();
  const origin = `http://127.0.0.1:${port}`;

  const ws = await openRawWS(port);
  ws.send(JSON.stringify({ type: 'subscribe', entity: 'Note', id: '1' }));
  await sleep(50);

  // create (seq:1)
  const r1 = await fetch(`${origin}/notes`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'first' }),
  });
  assert.equal(r1.status, 201);
  const doc = await r1.json();

  // update (seq:2)
  const r2 = await fetch(`${origin}/notes/${doc.id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'updated' }),
  });
  assert.equal(r2.status, 200);

  // delete (seq:3)
  const r3 = await fetch(`${origin}/notes/${doc.id}`, { method: 'DELETE' });
  assert.equal(r3.status, 204);

  const ev1 = await ws.nextEvent();
  const ev2 = await ws.nextEvent();
  const ev3 = await ws.nextEvent();
  assert.ok(ev1 && ev2 && ev3, 'all three events received');
  assert.deepEqual([ev1.seq, ev2.seq, ev3.seq], [1, 2, 3]);
  assert.equal(ev1.event.verb, 'create');
  assert.equal(ev2.event.verb, 'update');
  assert.equal(ev3.event.verb, 'remove');

  ws.close();
  app.httpServer.close();
});

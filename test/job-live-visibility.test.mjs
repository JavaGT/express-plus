// W3 live job visibility, end to end: the job queue appends _Job.* events to
// _Log itself, and serve.mjs bridges app.jobs.onEvent into the live fan-out.
// A WS subscriber of the anchor scope (e.g. Note:n1) receives opaque recovery
// controls for _Job lifecycle changes. Jobs do not yet have a recipient-hydrated
// lifecycle grammar, so their raw durable payload never crosses live delivery.
// Fail-closed: a missing anchor row delivers nothing live, though the event
// stays durable in _Log for catch-up.

import { text, ref, grant, read, write, subscribe, scope } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { connect as tcpConnect } from 'node:net';
import { randomBytes } from 'node:crypto';

import workbench, { entity, generateDDL } from '../build/internal.mjs';

const SECRET = 's3cret-shared-deployment-key';

function makeNote() {
  return entity('Note', {
    body: text(), owner: ref('User', { role: 'owner', readonly: true }),

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
        if (msg.type === 'event' || msg.type === 'resync') return msg;
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

function bootApp() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS User (id TEXT PRIMARY KEY, username TEXT, password TEXT)');
  db.exec("INSERT INTO User (id, username, password) VALUES ('1', 'alice', 'hash')");
  const Note = makeNote();
  for (const sql of generateDDL(Note)) db.exec(sql);
  db.prepare("INSERT INTO Note (id, body, owner) VALUES ('n1', 'hello', '1')").run();

  const app = workbench({
    db,
    jobs: { sharedSecret: SECRET, leaseMs: 60_000, heartbeatGraceMs: 60_000, reapIntervalMs: 1_000_000 },
  }).mount('/notes', Note);
  app.listen(0, { principalOf: () => ({ type: 'user', id: '1' }) });
  return { db, app };
}

test('scoped job enqueue requires anchor-scope snapshot recovery', async (t) => {
  const { app } = bootApp();
  t.after(() => app.shutdown());
  await app.ready;
  const { port } = app.httpServer.address();

  const ws = await openRawWS(port);
  t.after(() => ws.close());
  ws.send(JSON.stringify({ type: 'subscribe', entity: 'Note', id: 'n1' }));
  await sleep(50);

  await app.jobs.enqueue({ kind: 'index', payload: { noteId: 'n1' }, scope: 'Note:n1' });

  const ev = await ws.nextEvent();
  assert.ok(ev, 'job recovery control pushed live');
  assert.equal(ev.type, 'resync');
  assert.equal(ev.entity, 'Note', 'anchor entity identity');
  assert.equal(ev.id, 'n1', 'anchor id identity');
  assert.equal(ev.seq, 1);
  assert.equal(ev.reason, 'recipient-snapshot-required');
  assert.equal(ev.event, undefined, 'job event data is not delivered');
  assert.equal(ev.delta, undefined, 'job recovery carries no delta');

  ws.close();
  app.httpServer.close();
});

test('job lifecycle transitions require ordered anchor-scope recovery', async (t) => {
  const { app } = bootApp();
  t.after(() => app.shutdown());
  await app.ready;
  const { port } = app.httpServer.address();

  const ws = await openRawWS(port);
  t.after(() => ws.close());
  ws.send(JSON.stringify({ type: 'subscribe', entity: 'Note', id: 'n1' }));
  await sleep(50);

  await app.jobs.enqueue({ kind: 'index', payload: { noteId: 'n1' }, scope: 'Note:n1' });
  const w = app.jobs.registerWorker(SECRET);
  const job = await app.jobs.claim(w.workerId);
  assert.ok(job, 'job claimed');
  const r = await app.jobs.submitResult(job.id, w.workerId, { status: 'completed', output: { ok: true } });
  assert.ok(r.accepted, 'result accepted');

  const evs = [];
  for (let i = 0; i < 3; i++) evs.push(await ws.nextEvent());
  assert.ok(evs.every(Boolean), 'three recovery controls received');
  assert.deepEqual(evs.map((e) => e.type), ['resync', 'resync', 'resync']);
  assert.deepEqual(evs.map((e) => e.reason), [
    'recipient-snapshot-required',
    'recipient-snapshot-required',
    'recipient-snapshot-required',
  ]);
  assert.deepEqual(evs.map((e) => e.seq), [1, 2, 3], 'shared per-scope seq, in order');
  for (const e of evs) {
    assert.equal(e.entity, 'Note');
    assert.equal(e.id, 'n1');
    assert.equal(e.event, undefined, 'job transition is not delivered');
  }

  ws.close();
  app.httpServer.close();
});

test('unscoped job delivers nothing live', async (t) => {
  const { app } = bootApp();
  t.after(() => app.shutdown());
  await app.ready;
  const { port } = app.httpServer.address();

  const ws = await openRawWS(port);
  t.after(() => ws.close());
  ws.send(JSON.stringify({ type: 'subscribe', entity: 'Note', id: 'n1' }));
  await sleep(50);

  await app.jobs.enqueue({ kind: 'index', payload: {} });

  assert.equal(await ws.nextEvent(300), null, 'no live delivery for unscoped jobs');

  ws.close();
  app.httpServer.close();
});

test('missing anchor row fails closed: no live delivery, event stays durable', async (t) => {
  const { db, app } = bootApp();
  t.after(() => app.shutdown());
  await app.ready;
  const { port } = app.httpServer.address();

  const ws = await openRawWS(port);
  t.after(() => ws.close());
  ws.send(JSON.stringify({ type: 'subscribe', entity: 'Note', id: 'n1' }));
  await sleep(50);

  // Remove the anchor row out of band: the subscription stays registered but
  // the bridge must now drop the event (never ride the removed-row path,
  // which skips authz re-checks).
  db.prepare("DELETE FROM Note WHERE id = 'n1'").run();

  await app.jobs.enqueue({ kind: 'index', payload: {}, scope: 'Note:n1' });

  assert.equal(await ws.nextEvent(300), null, 'event dropped when anchor row is missing');
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM _Log WHERE scope = 'Note:n1'").get().n,
    1,
    'event still durable in _Log for cursor catch-up',
  );

  ws.close();
  app.httpServer.close();
});

// P6e-2 (Slice B1): delivery-layer prev-shadow + per-field delta for `.updated`
// events ONLY. Delta is computed from committed-state vs prior committed shadow,
// attached alongside event.data (one-path backward-compat, #71 F5).
//
// All tests use raw WebSocket against a direct createLiveServer + compiled entity
// (mirrors live-pace.test.mjs).

import { text, state, link, scope, everyone, grant, read, write, subscribe, principal as makePrincipal } from '../src/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { connect as tcpConnect } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';

import {
  entity, generateDDL, executeFrameworkDDL, createLiveServer } from '../src/internal.mjs';
import { setActiveDb } from '../src/db.mjs';

// --- test entity ---

const Canvas = entity('Canvas', {
  fields: {
    title: text(),
    status: state({ values: ['draft', 'published'] }),
    body: text.crdt(),
    share: link(),  // struct (dormant-but-correct — .updated doesn't persist struct)
  },
  grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
});

// --- raw WebSocket harness (mirrors live-pace.test.mjs) ---

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

// --- bootstrap: direct createLiveServer (mirrors live-pace.test.mjs direct pattern) ---

function bootServer() {
  const db = new DatabaseSync(':memory:');
  setActiveDb(db);
  executeFrameworkDDL(db);
  for (const sql of generateDDL(Canvas)) db.exec(sql);

  const httpServer = http.createServer();
  const live = createLiveServer(httpServer, {
    path: '/events',
    mayVerb: async () => true,
    principalOf: (req) => {
      const u = req.headers?.['x-test-user'] ?? 'test';
      return { type: 'user', id: u };
    },
    db,
    resolveEntity: () => Canvas,
  });

  httpServer.listen(0);
  return { db, httpServer, live };
}

// Helper: insert a Canvas row into db
function insertRow(db, id, overrides = {}) {
  const title = overrides.title ?? 'Original';
  const status = overrides.status ?? 'draft';
  const body = overrides.body ?? '';
  db.prepare('INSERT INTO Canvas (id, title, status, body) VALUES (?, ?, ?, ?)').run(id, title, status, body);
}

// Helper: re-read a row from db (for emit's row param)
function reRead(db, id) {
  return db.prepare('SELECT * FROM Canvas WHERE id = ?').get(id);
}

// Helper: emit an update event (simulates kernel post-commit)
function emitUpdated(live, entityRecord, db, id, seq, data) {
  const row = reRead(db, id);
  return live.emit(entityRecord, id, row, {
    type: 'Canvas.updated', seq,
    data: { id, ...data },
  });
}

// Helper: emit a created event
function emitCreated(live, entityRecord, db, id, seq, data) {
  const row = reRead(db, id);
  return live.emit(entityRecord, id, row, {
    type: 'Canvas.created', seq,
    data: { id, ...data },
  });
}

// Helper: emit a removed event
function emitRemoved(live, entityRecord, db, id, seq) {
  return live.emit(entityRecord, id, undefined, {
    type: 'Canvas.removed', seq,
  });
}

// Helper: subscribe and wait for ack (named wsSubscribe to avoid collision with
// the imported `subscribe` grant-capability used in the entity declaration).
async function wsSubscribe(ws, entity, id) {
  ws.send(JSON.stringify({ type: 'subscribe', entity, id }));
  return ws.nextMessage();
}

// ============================================================
// Test 1: value field `.updated` delta — cold shadow → set-from-empty
// ============================================================

test('P6e-2 B1: value field .updated delta (cold shadow → set-from-empty)', async () => {
  const { db, httpServer, live } = bootServer();
  const port = httpServer.address().port;
  let ws;
  const cid = 'c-test1';

  try {
    insertRow(db, cid, { title: 'v1' });
    const entityRecord = (() => Canvas)();

    ws = await openRawWS(port, 'alice');
    assert.equal((await wsSubscribe(ws, 'Canvas', cid))?.type, 'subscribed');

    // 1st update: cold shadow → set-from-empty delta
    await emitUpdated(live, entityRecord, db, cid, 1, { title: 'v1' });
    const ev1 = await ws.nextEvent(400);
    assert.ok(ev1, 'first event received');
    assert.equal(ev1.event.type, 'Canvas.updated');
    assert.ok(ev1.delta, 'delta present on first update');
    assert.deepEqual(ev1.delta, { title: { set: 'v1' } }, 'cold shadow → set-from-empty delta');
    assert.equal(ev1.event.data.title, 'v1', 'whole state preserved');

    // 2nd update: diff against v1 → delta shows change
    db.prepare('UPDATE Canvas SET title = ? WHERE id = ?').run('v2', cid);
    await emitUpdated(live, entityRecord, db, cid, 2, { title: 'v2' });
    const ev2 = await ws.nextEvent(400);
    assert.ok(ev2, 'second event received');
    assert.ok(ev2.delta, 'delta present on second update');
    assert.deepEqual(ev2.delta, { title: { set: 'v2' } }, 'second delta shows {set:v2}');
    assert.equal(ev2.event.data.title, 'v2', 'whole state preserved on second update');
  } finally {
    ws?.close();
    live.close();
    httpServer.close();
  }
});

// ============================================================
// Test 2: crdt field `.updated` delta — per-element diff (insert-op object)
// ============================================================

test('P6e-2 B1: crdt field .updated delta (per-element insert-op, NOT whole-state)', async () => {
  const { db, httpServer, live } = bootServer();
  const port = httpServer.address().port;
  let ws;
  const cid = 'c-test2';

  try {
    insertRow(db, cid, { body: 'hello' });
    const entityRecord = (() => Canvas)();

    ws = await openRawWS(port, 'alice');
    assert.equal((await wsSubscribe(ws, 'Canvas', cid))?.type, 'subscribed');

    // Emit .created to seed the prev-shadow with body='hello' (mirrors production:
    // .create dispatches a .created event through the post-commit consumer).
    await emitCreated(live, entityRecord, db, cid, 1, { body: 'hello' });
    const evSeed = await ws.nextEvent(400);
    assert.ok(evSeed, 'created event received');

    // Update body from 'hello' to 'hello world'
    db.prepare('UPDATE Canvas SET body = ? WHERE id = ?').run('hello world', cid);
    await emitUpdated(live, entityRecord, db, cid, 2, { body: 'hello world' });
    const ev = await ws.nextEvent(400);
    assert.ok(ev, 'event received');
    assert.equal(ev.event.type, 'Canvas.updated');
    assert.ok(ev.delta, 'delta present');

    // crtd text diff: 'hello' → 'hello world' should produce {insert:{at:5,text:' world'}}
    assert.ok(ev.delta.body, 'delta has body field');
    assert.ok(ev.delta.body.insert, 'crdt delta has insert op (not set)');
    assert.equal(ev.delta.body.insert.at, 5);
    assert.equal(ev.delta.body.insert.text, ' world');
    // Verify it's NOT a whole-state set
    assert.equal(ev.delta.body.set, undefined, 'crdt delta is NOT whole-value {set}');
    assert.equal(ev.event.data.body, 'hello world', 'whole state preserved');
  } finally {
    ws?.close();
    live.close();
    httpServer.close();
  }
});

// ============================================================
// Test 3: state field `.updated` delta — {from, to}
// ============================================================

test('P6e-2 B1: state field .updated delta ({from, to})', async () => {
  const { db, httpServer, live } = bootServer();
  const port = httpServer.address().port;
  let ws;
  const cid = 'c-test3';

  try {
    insertRow(db, cid, { status: 'draft' });
    const entityRecord = (() => Canvas)();

    ws = await openRawWS(port, 'alice');
    assert.equal((await wsSubscribe(ws, 'Canvas', cid))?.type, 'subscribed');

    // Emit .created to seed the prev-shadow with status='draft' (mirrors production).
    await emitCreated(live, entityRecord, db, cid, 1, { status: 'draft' });
    const evSeed = await ws.nextEvent(400);
    assert.ok(evSeed, 'created event received');

    // Update status from draft to published
    db.prepare('UPDATE Canvas SET status = ? WHERE id = ?').run('published', cid);
    await emitUpdated(live, entityRecord, db, cid, 2, { status: 'published' });
    const ev = await ws.nextEvent(400);
    assert.ok(ev, 'event received');
    assert.equal(ev.event.type, 'Canvas.updated');
    assert.ok(ev.delta, 'delta present');
    assert.deepEqual(ev.delta, { status: { from: 'draft', to: 'published' } },
      'state delta shows {from,to}');
    assert.equal(ev.event.data.status, 'published', 'whole state preserved');
  } finally {
    ws?.close();
    live.close();
    httpServer.close();
  }
});

// ============================================================
// Test 4: removed evicts shadow — post-recreate update is set-from-empty
// ============================================================

test('P6e-2 B1: removed evicts shadow → post-recreate delta is set-from-empty', async () => {
  const { db, httpServer, live } = bootServer();
  const port = httpServer.address().port;
  let ws;
  const cid = 'c-test4';

  try {
    insertRow(db, cid, { title: 'v1' });
    const entityRecord = (() => Canvas)();

    ws = await openRawWS(port, 'alice');
    assert.equal((await wsSubscribe(ws, 'Canvas', cid))?.type, 'subscribed');

    // Update to seed shadow
    await emitUpdated(live, entityRecord, db, cid, 1, { title: 'v1' });
    const ev1 = await ws.nextEvent(400);
    assert.ok(ev1, 'first update received');
    assert.deepEqual(ev1.delta, { title: { set: 'v1' } }, 'first delta set-from-empty');

    // Remove — evicts shadow
    await emitRemoved(live, entityRecord, db, cid, 2);
    const evRemove = await ws.nextEvent(400);
    assert.ok(evRemove, 'removed event received');
    assert.equal(evRemove.event.type, 'Canvas.removed');
    // The remove handler DELETEd the row in production; mirror that here so the
    // re-create INSERT below doesn't UNIQUE-fail on the still-present row.
    db.prepare('DELETE FROM Canvas WHERE id = ?').run(cid);

    // Re-create row (same id)
    db.prepare('INSERT INTO Canvas (id, title, status, body) VALUES (?, ?, ?, ?)').run(cid, 'reborn', 'draft', '');

    // Emit created (seeds the shadow)
    await emitCreated(live, entityRecord, db, cid, 3, { title: 'reborn', status: 'draft', body: '' });
    const evCreated = await ws.nextEvent(400);
    assert.ok(evCreated, 'created event received');
    assert.equal(evCreated.event.type, 'Canvas.created');
    // created has no delta
    assert.equal(evCreated.delta, undefined, 'created has no delta');

    // Now update the re-created row — should be set-from-empty (NOT diffed against stale v1)
    db.prepare('UPDATE Canvas SET title = ? WHERE id = ?').run('reborn-v2', cid);
    await emitUpdated(live, entityRecord, db, cid, 4, { title: 'reborn-v2' });
    const evPost = await ws.nextEvent(400);
    assert.ok(evPost, 'post-recreate update received');
    assert.ok(evPost.delta, 'delta present on post-recreate update');
    assert.deepEqual(evPost.delta, { title: { set: 'reborn-v2' } },
      'post-recreate delta is set-from-empty (NOT diffed against stale pre-remove shadow)');
  } finally {
    ws?.close();
    live.close();
    httpServer.close();
  }
});

// ============================================================
// Test 5: created has no delta
// ============================================================

test('P6e-2 B1: created event has no delta', async () => {
  const { db, httpServer, live } = bootServer();
  const port = httpServer.address().port;
  let ws;
  const cid = 'c-test5';

  try {
    insertRow(db, cid, { title: 'Fresh' });
    const entityRecord = (() => Canvas)();

    ws = await openRawWS(port, 'alice');
    assert.equal((await wsSubscribe(ws, 'Canvas', cid))?.type, 'subscribed');

    // Emit created (already subscribed — receives the event)
    await emitCreated(live, entityRecord, db, cid, 1, { title: 'Fresh' });
    const ev = await ws.nextEvent(400);
    assert.ok(ev, 'created event received');
    assert.equal(ev.event.type, 'Canvas.created');
    assert.equal(ev.delta, undefined, 'created event has no delta key');
    assert.equal(ev.event.data.title, 'Fresh', 'whole state carried in event.data');
  } finally {
    ws?.close();
    live.close();
    httpServer.close();
  }
});

// ============================================================
// Test 6: multi-field `.updated` → ONE envelope with multi-key delta map
// ============================================================

test('P6e-2 B1: multi-field .updated is ONE envelope with multi-key delta map', async () => {
  const { db, httpServer, live } = bootServer();
  const port = httpServer.address().port;
  let ws;
  const cid = 'c-test6';

  try {
    insertRow(db, cid, { title: 'Old', status: 'draft' });
    const entityRecord = (() => Canvas)();

    ws = await openRawWS(port, 'alice');
    assert.equal((await wsSubscribe(ws, 'Canvas', cid))?.type, 'subscribed');

    // Emit .created to seed the prev-shadow with title='Old', status='draft'.
    await emitCreated(live, entityRecord, db, cid, 1, { title: 'Old', status: 'draft' });
    const evSeed = await ws.nextEvent(400);
    assert.ok(evSeed, 'created event received');

    // Update both title AND status
    db.prepare('UPDATE Canvas SET title = ?, status = ? WHERE id = ?').run('New Title', 'published', cid);
    await emitUpdated(live, entityRecord, db, cid, 2, { title: 'New Title', status: 'published' });
    const ev = await ws.nextEvent(400);
    assert.ok(ev, 'event received');
    assert.equal(ev.event.type, 'Canvas.updated');
    assert.equal(ev.seq, 2, 'single seq');
    assert.ok(ev.delta, 'delta present');
    // Both fields in one delta map
    assert.ok(ev.delta.title, 'delta has title');
    assert.ok(ev.delta.status, 'delta has status');
    assert.deepEqual(ev.delta.title, { set: 'New Title' });
    assert.deepEqual(ev.delta.status, { from: 'draft', to: 'published' });
    assert.equal(ev.event.data.title, 'New Title', 'whole state title');
    assert.equal(ev.event.data.status, 'published', 'whole state status');

    // NO second envelope for the same event
    const evExtra = await ws.nextEvent(100);
    assert.equal(evExtra, null, 'no extra envelope for multi-field update');
  } finally {
    ws?.close();
    live.close();
    httpServer.close();
  }
});

// ============================================================
// Test 7: unchanged `.updated` → delta is {} (empty, present)
// ============================================================

test('P6e-2 B1: unchanged .updated yields {} delta (present but empty)', async () => {
  const { db, httpServer, live } = bootServer();
  const port = httpServer.address().port;
  let ws;
  const cid = 'c-test7';

  try {
    insertRow(db, cid, { title: 'Same', status: 'draft' });
    const entityRecord = (() => Canvas)();

    ws = await openRawWS(port, 'alice');
    assert.equal((await wsSubscribe(ws, 'Canvas', cid))?.type, 'subscribed');

    // First update to seed shadow
    await emitUpdated(live, entityRecord, db, cid, 1, { title: 'Same' });
    const ev1 = await ws.nextEvent(400);
    assert.ok(ev1, 'first update received');
    assert.deepEqual(ev1.delta, { title: { set: 'Same' } }, 'first delta set-from-empty');

    // Second update with the SAME values — delta should be {} (empty object)
    await emitUpdated(live, entityRecord, db, cid, 2, { title: 'Same' });
    const ev2 = await ws.nextEvent(400);
    assert.ok(ev2, 'second update received');
    assert.ok(ev2.delta, 'delta present');
    assert.deepEqual(ev2.delta, {}, 'delta is empty object (no changes)');
    assert.equal(ev2.event.data.title, 'Same', 'whole state preserved');
  } finally {
    ws?.close();
    live.close();
    httpServer.close();
  }
});

// ============================================================
// Test 8: delta-unaware backward-compat — both delta AND event.data present
// ============================================================

test('P6e-2 B1: backward-compat — subscriber receives both delta and event.data', async () => {
  const { db, httpServer, live } = bootServer();
  const port = httpServer.address().port;
  let ws;
  const cid = 'c-test8';

  try {
    insertRow(db, cid, { title: 'b1' });
    const entityRecord = (() => Canvas)();

    ws = await openRawWS(port, 'alice');
    assert.equal((await wsSubscribe(ws, 'Canvas', cid))?.type, 'subscribed');

    // Subscribe with NO fields/pace (no pace, no field interest — bare subscriber)
    // This exercises the delta-unaware backward-compat path: the envelope carries
    // delta alongside event.data so a subscriber using event.data exclusively sees
    // the whole state as before.

    // UPDATE the DB to 'b2' so the post-commit re-read (authzRow) matches the
    // mutation payload — mirrors production, where the .update handler applies the
    // mutation BEFORE the post-commit consumer re-reads.
    db.prepare('UPDATE Canvas SET title = ? WHERE id = ?').run('b2', cid);
    await emitUpdated(live, entityRecord, db, cid, 1, { title: 'b2' });
    const ev = await ws.nextEvent(400);
    assert.ok(ev, 'event received');
    assert.equal(ev.event.type, 'Canvas.updated');
    // Both delta AND event.data are present
    assert.ok('delta' in ev, 'delta key is present on envelope');
    assert.ok('event' in ev, 'event key is present on envelope');
    assert.ok(ev.event.data, 'event.data is present (whole state)');
    assert.equal(ev.event.data.title, 'b2', 'whole state title in event.data');
    assert.deepEqual(ev.delta, { title: { set: 'b2' } }, 'delta computed correctly');
  } finally {
    ws?.close();
    live.close();
    httpServer.close();
  }
});

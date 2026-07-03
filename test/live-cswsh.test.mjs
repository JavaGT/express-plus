// SEC-1 — Cross-Site WebSocket Hijacking (CSWSH) guard on the /events upgrade.
//
// The live WS upgrade runs the SAME same-origin verdict the REST CSRF guard uses
// (middleware.mjs → isSameOriginRequest). A browser ALWAYS attaches Origin to a
// cross-origin WS handshake, so a FOREIGN Origin here is an attacker page opening
// a socket on the victim's cookies — the handshake is destroyed before upgrade.
// A SAME-origin handshake upgrades (101). An ABSENT Origin is a non-browser
// client (curl, server-to-server) with no CSWSH vector → allowed. This mirrors
// test/csrf-origin.test.mjs for the WebSocket transport (AGENTS.md → no second
// auth path: one same-origin implementation for both transports).

import { text, ref, grant, read, write, subscribe, scope } from '../src/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { connect as tcpConnect } from 'node:net';
import { randomBytes } from 'node:crypto';

import workbench, { entity, generateDDL } from '../src/internal.mjs';

function makeNote() {
  return entity('Note', {
        body: text(), owner: ref('User', { role: 'owner', readonly: true }),

    grant: () => [scope(({ is }) => is.owner()).can(async ({ is }) => (await is.owner()) ? grant(read, write, subscribe) : grant(read))],
  });
}

async function setup(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS User (id TEXT PRIMARY KEY, username TEXT, password TEXT)');
  db.exec("INSERT INTO User (id, username, password) VALUES ('1', 'alice', 'hash')");
  const Note = makeNote();
  for (const sql of generateDDL(Note)) db.exec(sql);
  db.prepare("INSERT INTO Note (id, body, owner) VALUES ('n1', 'hello', '1')").run();

  const app = workbench({ db }).mount('/notes', Note);
  app.listen(0, { principalOf: () => ({ type: 'user', id: '1' }) });
  await app.ready;
  const { port } = app.httpServer.address();
  t.after(() => { try { app.httpServer.close(); } catch { /* ignore */ } db.close(); });
  return { port };
}

// Attempt a raw WS handshake with an optional Origin header. Resolves with the
// handshake outcome: { upgraded: true } on a 101, { upgraded: false } when the
// server destroys the socket (connection closed with no HTTP response) or
// responds with a non-101 status.
function attemptHandshake(port, { origin } = {}) {
  return new Promise((resolve, reject) => {
    const sock = tcpConnect(port, '127.0.0.1');
    const key = randomBytes(16).toString('base64');
    const originLine = origin ? `Origin: ${origin}\r\n` : '';
    const handshake =
      'GET /events HTTP/1.1\r\n' +
      `Host: 127.0.0.1:${port}\r\n` +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      originLine +
      `Sec-WebSocket-Key: ${key}\r\n` +
      'Sec-WebSocket-Version: 13\r\n\r\n';

    let buf = Buffer.alloc(0);
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; try { sock.destroy(); } catch { /* ignore */ } resolve(v); };

    sock.on('connect', () => sock.write(handshake));
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      const statusLine = buf.slice(0, idx).toString().split('\r\n')[0];
      finish({ upgraded: statusLine.startsWith('HTTP/1.1 101') });
    });
    // A destroyed socket (guard rejected) closes with no HTTP response.
    sock.on('close', () => finish({ upgraded: false }));
    sock.on('error', () => finish({ upgraded: false }));
    setTimeout(() => reject(new Error('handshake timed out')), 2000);
  });
}

test('CSWSH: a same-origin WS handshake upgrades (101)', async (t) => {
  const { port } = await setup(t);
  const r = await attemptHandshake(port, { origin: `http://127.0.0.1:${port}` });
  assert.equal(r.upgraded, true, 'same-origin handshake should upgrade');
});

test('CSWSH: a WS handshake with no Origin upgrades (non-browser client)', async (t) => {
  const { port } = await setup(t);
  const r = await attemptHandshake(port, {});
  assert.equal(r.upgraded, true, 'absent Origin (non-browser) should upgrade');
});

test('CSWSH: a foreign-Origin WS handshake is rejected (no upgrade)', async (t) => {
  const { port } = await setup(t);
  const r = await attemptHandshake(port, { origin: 'http://evil.example' });
  assert.equal(r.upgraded, false, 'foreign Origin should be rejected before upgrade');
});

test('CSWSH: an unparseable Origin is rejected (fail closed)', async (t) => {
  const { port } = await setup(t);
  const r = await attemptHandshake(port, { origin: 'not-a-url' });
  assert.equal(r.upgraded, false, 'unparseable Origin fails closed');
});

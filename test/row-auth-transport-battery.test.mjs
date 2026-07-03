import { deny, entity, everyone, grant, inherit, map, read, ref, scope, subscribe, text, write } from '../src/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { connect as tcpConnect } from 'node:net';
import { randomBytes } from 'node:crypto';

import workbench, {
  anyOf } from '../src/internal.mjs';

const alice = { type: 'user', id: 'alice' };
const bob = { type: 'user', id: 'bob' };
const banned = { type: 'user', id: 'banned' };

function principalOf(req) {
  const id = req.headers?.['x-test-user'];
  return id ? { type: 'user', id } : { type: 'anonymous', id: null };
}

function openRawWS(port, userId) {
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
          reject(new Error(`upgrade failed: ${head.split('\r\n')[0]}`));
          return;
        }
        upgraded = true;
        resolve({ send, nextMessage, nextEvent, close });
      }
      while (buf.length >= 2) {
        const b0 = buf[0];
        const b1 = buf[1] & 0x7f;
        let payloadLen = b1;
        let headerLen = 2;
        if (b1 === 126) {
          if (buf.length < 4) return;
          payloadLen = buf.readUInt16BE(2);
          headerLen = 4;
        } else if (b1 === 127) {
          if (buf.length < 10) return;
          payloadLen = Number(buf.readBigUInt64BE(2));
          headerLen = 10;
        }
        if (buf.length < headerLen + payloadLen) return;
        const payload = buf.slice(headerLen, headerLen + payloadLen);
        const opcode = b0 & 0x0f;
        buf = buf.slice(headerLen + payloadLen);
        if (opcode === 0x1) inbox.push(payload.toString('utf-8'));
      }
    });
    sock.on('error', reject);

    function send(textValue) {
      const payload = Buffer.from(textValue, 'utf-8');
      const mask = randomBytes(4);
      const masked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
      sock.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]));
    }

    async function nextMessage(timeoutMs = 400) {
      const start = Date.now();
      while (Date.now() - start <= timeoutMs) {
        if (inbox.length > 0) return JSON.parse(inbox.shift());
        await new Promise((resolveNext) => setTimeout(resolveNext, 20));
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
        await new Promise((resolveNext) => setTimeout(resolveNext, 20));
      }
      return null;
    }

    function close() {
      try { sock.destroy(); } catch {}
    }
  });
}

async function boot(t, mounts) {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db });
  for (const [path, target] of mounts) app.mount(path, target);
  app.listen(0, { principalOf });
  await app.ready;
  t.after(() => {
    app.live?.close();
    app.httpServer.close();
    db.close();
  });
  const port = app.httpServer.address().port;
  return { app, db, origin: `http://127.0.0.1:${port}`, port };
}

function readableArticle() {
  return entity('D5Article', {
        title: text(),
    owner: ref('User', { role: 'owner', readonly: true }),

    grant: () => [
      scope(() => everyone()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read)),
    ],
  });
}

function bannedWidget() {
  return entity('D5Widget', {
        label: text(),
    owner: ref('User', { role: 'owner', readonly: true }),

    checks: {
      banned: ({ principal }) => principal.id === banned.id,
    },
    grant: () => [
      scope(() => everyone()).can(async ({ is }) =>
        (await is.banned()) ? deny('banned') : grant(read, write, subscribe)),
    ],
  });
}

function inheritedProjectEntities() {
  const Project = entity('D5Project', {
        title: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    members: map(ref('User'), { role: ['viewer'], default: {} }),

    checks: {
      member: ({ D5Project, principal }) => D5Project.members.has(principal.id),
    },
    grant: () => [
      scope(({ is }) => anyOf(is.owner(), is.member())).can(async ({ is }) => {
        if (await is.owner()) return grant(read, write, subscribe);
        if (await is.member()) return grant(read, subscribe);
        return deny('not a project member');
      }),
    ],
  });
  const Child = entity('D5ProjectChild', {
        project: ref('D5Project', { required: true }),
    title: text(),

    grant: inherit(Project, { via: 'project' }),
  });
  return { Project, Child };
}

function scopeOnlyRecord() {
  return entity('D5ScopeOnlyRecord', {
        title: text(),

    grant: () => [scope(() => everyone())],
  });
}

async function assertSubscribeDenied(port, entityName, id, userId) {
  const ws = await openRawWS(port, userId);
  try {
    ws.send(JSON.stringify({ type: 'subscribe', entity: entityName, id }));
    const msg = await ws.nextMessage();
    assert.ok(msg, 'subscribe denial responds');
    assert.notEqual(msg.type, 'subscribed');
    assert.equal(msg.currentSeq, undefined);
  } finally {
    ws.close();
  }
}

async function assertSubscribeAdmitted(port, entityName, id, userId) {
  const ws = await openRawWS(port, userId);
  ws.send(JSON.stringify({ type: 'subscribe', entity: entityName, id }));
  const ack = await ws.nextMessage();
  assert.equal(ack.type, 'subscribed');
  return ws;
}

test('D5 readable-but-not-writable rows deny write through every row-auth seam', async (t) => {
  const Article = readableArticle();
  const Widget = bannedWidget();
  const { app, db, origin, port } = await boot(t, [['/articles', Article], ['/widgets', Widget]]);
  db.prepare('INSERT INTO D5Article (id, title, owner) VALUES (?, ?, ?)').run('a1', 'Readable', alice.id);

  const list = await fetch(`${origin}/articles`, { headers: { 'x-test-user': bob.id } });
  assert.equal(list.status, 200);
  assert.deepEqual((await list.json()).map((row) => row.id), ['a1']);

  const readResponse = await fetch(`${origin}/articles/a1`, { headers: { 'x-test-user': bob.id } });
  assert.equal(readResponse.status, 200);

  const snapshot = await fetch(`${origin}/snapshot/D5Article/a1`, { headers: { 'x-test-user': bob.id } });
  assert.equal(snapshot.status, 200);

  const events = await fetch(`${origin}/events-since/D5Article/a1?cursor=0`, { headers: { 'x-test-user': bob.id } });
  assert.equal(events.status, 200);
  assert.deepEqual(await events.json(), { events: [] });

  const update = await fetch(`${origin}/articles/a1`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-test-user': bob.id },
    body: JSON.stringify({ title: 'Hijacked' }),
  });
  assert.equal(update.status, 403);

  const remove = await fetch(`${origin}/articles/a1`, { method: 'DELETE', headers: { 'x-test-user': bob.id } });
  assert.equal(remove.status, 403);

  const create = await fetch(`${origin}/widgets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-user': banned.id },
    body: JSON.stringify({ label: 'blocked' }),
  });
  assert.equal(create.status, 403);

  await assertSubscribeDenied(port, 'D5Article', 'a1', bob.id);

  const ws = await assertSubscribeAdmitted(port, 'D5Article', 'a1', alice.id);
  try {
    db.prepare('UPDATE D5Article SET owner = ? WHERE id = ?').run('charlie', 'a1');
    await app.live.emit(Article, 'a1', { id: 'a1', title: 'Changed', owner: 'charlie' }, {
      type: 'D5Article.updated',
      seq: 1,
      data: { id: 'a1', title: 'Changed' },
      actionId: 'd5-fanout-deny',
      committedAt: new Date(0).toISOString(),
    });
    assert.equal(await ws.nextEvent(250), null);
  } finally {
    ws.close();
  }
});

test('D5 inherited rows delegate every transport decision to the parent row grant', async (t) => {
  const { Project, Child } = inheritedProjectEntities();
  const { app, db, origin, port } = await boot(t, [['/projects', Project], ['/children', Child]]);
  db.prepare('INSERT INTO D5Project (id, title, owner) VALUES (?, ?, ?)').run('p1', 'Project', alice.id);
  db.prepare('INSERT INTO D5Project_members (D5Project_id, member_id, role) VALUES (?, ?, ?)').run('p1', bob.id, 'viewer');
  db.prepare('INSERT INTO D5ProjectChild (id, project, title) VALUES (?, ?, ?)').run('c1', 'p1', 'Child');

  const list = await fetch(`${origin}/children`, { headers: { 'x-test-user': bob.id } });
  assert.equal(list.status, 200);
  assert.deepEqual((await list.json()).map((row) => row.id), ['c1']);

  const readResponse = await fetch(`${origin}/children/c1`, { headers: { 'x-test-user': bob.id } });
  assert.equal(readResponse.status, 200);

  const snapshot = await fetch(`${origin}/snapshot/D5ProjectChild/c1`, { headers: { 'x-test-user': bob.id } });
  assert.equal(snapshot.status, 200);

  const events = await fetch(`${origin}/events-since/D5ProjectChild/c1?cursor=0`, { headers: { 'x-test-user': bob.id } });
  assert.equal(events.status, 200);
  assert.deepEqual(await events.json(), { events: [] });

  const update = await fetch(`${origin}/children/c1`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-test-user': bob.id },
    body: JSON.stringify({ title: 'Hijacked' }),
  });
  assert.equal(update.status, 403);

  const remove = await fetch(`${origin}/children/c1`, { method: 'DELETE', headers: { 'x-test-user': bob.id } });
  assert.equal(remove.status, 403);

  const ws = await assertSubscribeAdmitted(port, 'D5ProjectChild', 'c1', bob.id);
  try {
    await app.live.emit(Child, 'c1', { id: 'c1', project: 'p1', title: 'Changed' }, {
      type: 'D5ProjectChild.updated',
      seq: 1,
      data: { id: 'c1', title: 'Changed' },
      actionId: 'd5-inherit-fanout',
      committedAt: new Date(0).toISOString(),
    });
    const event = await ws.nextEvent();
    assert.ok(event);
    assert.equal(event.event.type, 'D5ProjectChild.updated');
  } finally {
    ws.close();
  }
});

test('D5 scope-only rows stay admitted by mayRow across transports', async (t) => {
  const ScopeOnly = scopeOnlyRecord();
  const { app, origin, port } = await boot(t, [['/open-records', ScopeOnly]]);

  const created = await fetch(`${origin}/open-records`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-user': bob.id },
    body: JSON.stringify({ title: 'Open' }),
  });
  assert.equal(created.status, 201);
  const row = await created.json();

  const list = await fetch(`${origin}/open-records`, { headers: { 'x-test-user': bob.id } });
  assert.equal(list.status, 200);
  assert.deepEqual((await list.json()).map((item) => item.id), [row.id]);

  const readResponse = await fetch(`${origin}/open-records/${row.id}`, { headers: { 'x-test-user': bob.id } });
  assert.equal(readResponse.status, 200);

  const snapshot = await fetch(`${origin}/snapshot/D5ScopeOnlyRecord/${row.id}`, { headers: { 'x-test-user': bob.id } });
  assert.equal(snapshot.status, 200);

  const events = await fetch(`${origin}/events-since/D5ScopeOnlyRecord/${row.id}?cursor=0`, { headers: { 'x-test-user': bob.id } });
  assert.equal(events.status, 200);
  assert.ok((await events.json()).events.length >= 1);

  const ws = await assertSubscribeAdmitted(port, 'D5ScopeOnlyRecord', row.id, bob.id);
  try {
    await app.live.emit(ScopeOnly, row.id, { id: row.id, title: 'Live' }, {
      type: 'D5ScopeOnlyRecord.updated',
      seq: 2,
      data: { id: row.id, title: 'Live' },
      actionId: 'd5-scope-only-fanout',
      committedAt: new Date(0).toISOString(),
    });
    const event = await ws.nextEvent();
    assert.ok(event);
    assert.equal(event.event.type, 'D5ScopeOnlyRecord.updated');
  } finally {
    ws.close();
  }

  const update = await fetch(`${origin}/open-records/${row.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-test-user': bob.id },
    body: JSON.stringify({ title: 'Edited' }),
  });
  assert.equal(update.status, 200);

  const remove = await fetch(`${origin}/open-records/${row.id}`, { method: 'DELETE', headers: { 'x-test-user': bob.id } });
  assert.equal(remove.status, 204);
});

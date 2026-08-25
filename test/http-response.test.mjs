import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  committedEventHeaders,
  sendJson,
  responseHasStarted,
  canWriteResponse,
  warnLateResponse,
  projectedCursorHeaders,
} from '../build/http-response.mjs';

function makeResponse(overrides = {}) {
  return {
    status: null,
    headers: null,
    body: null,
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    req: { method: 'GET', url: '/notes' },
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      this.headersSent = true;
    },
    end(body) {
      this.body = body;
      this.writableEnded = true;
    },
    ...overrides,
  };
}

test('sendJson writes status, JSON headers, content length, and payload', () => {
  const res = makeResponse();

  sendJson(res, 201, { ok: true });

  assert.equal(res.status, 201);
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(res.headers['content-length'], Buffer.byteLength('{"ok":true}'));
  assert.equal(res.body, '{"ok":true}');
});

test('sendJson preserves extra headers', () => {
  const res = makeResponse();

  sendJson(res, 200, { ok: true }, { 'x-test': '1' });

  assert.equal(res.headers['x-test'], '1');
});

// #165 — an undefined body is an EMPTY response (status only), not a throw.
test('sendJson treats an undefined body as an empty payload', () => {
  const res = makeResponse();

  assert.doesNotThrow(() => sendJson(res, 204, undefined));

  assert.equal(res.status, 204);
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(res.headers['content-length'], 0);
  assert.equal(res.body, '');
});

test('sendJson still serializes explicit null as null', () => {
  const res = makeResponse();

  sendJson(res, 200, null);

  assert.equal(res.status, 200);
  assert.equal(res.headers['content-length'], Buffer.byteLength('null'));
  assert.equal(res.body, 'null');
});

test('committedEventHeaders includes action id and max committed seq', () => {
  assert.deepEqual(
    committedEventHeaders({ events: [{ seq: 1 }, { seq: 4 }, { seq: 2 }] }, 'a1'),
    { 'x-workbench-action-id': 'a1', 'x-workbench-seq': '4' },
  );
});

test('committedEventHeaders scopes seq when a scope is provided', () => {
  assert.deepEqual(
    committedEventHeaders({ events: [
      { scope: 'Doc:1', seq: 3 },
      { scope: 'Doc:2', seq: 8 },
      { scope: 'Doc:1', seq: 5 },
    ] }, 'a2', 'Doc:1'),
    { 'x-workbench-action-id': 'a2', 'x-workbench-seq': '5' },
  );
});

test('committedEventHeaders omits seq when no finite relevant seq exists', () => {
  assert.deepEqual(
    committedEventHeaders({ events: [{ scope: 'Doc:1', seq: 1 }] }, 'a3', 'Doc:2'),
    { 'x-workbench-action-id': 'a3' },
  );
  assert.deepEqual(
    committedEventHeaders({ events: [{ seq: Number.NaN }] }, 'a4'),
    { 'x-workbench-action-id': 'a4' },
  );
});

test('responseHasStarted is true when headersSent, writableEnded, or destroyed', () => {
  assert.equal(responseHasStarted(makeResponse()), false);
  assert.equal(responseHasStarted(makeResponse({ headersSent: true })), true);
  assert.equal(responseHasStarted(makeResponse({ writableEnded: true })), true);
  assert.equal(responseHasStarted(makeResponse({ destroyed: true })), true);
});

test('canWriteResponse returns false and does not write when response already started', async () => {
  const res = makeResponse({ headersSent: true });
  // Primary contract: no second write. Warning is best-effort observability.
  assert.equal(canWriteResponse(res, `sendJson-${Date.now()}`), false);
  assert.equal(sendJson(res, 200, { ok: true }, {}, { operation: `late-${Date.now()}` }), false);
  assert.equal(res.body, null);
  assert.equal(res.status, null);
  // Fresh response can still write
  const open = makeResponse();
  assert.equal(canWriteResponse(open, 'ok'), true);
  assert.equal(sendJson(open, 200, { ok: true }), true);
  assert.equal(open.body, '{"ok":true}');
});

test('projectedCursorHeaders maps field → lastSeq headers', () => {
  assert.deepEqual(projectedCursorHeaders([]), {});
  assert.deepEqual(projectedCursorHeaders(null), {});
  assert.deepEqual(
    projectedCursorHeaders([{ field: 'summary', lastSeq: 9 }, { field: 'body', lastSeq: 3 }]),
    { 'x-workbench-projected-summary': '9', 'x-workbench-projected-body': '3' },
  );
});

test('warnLateResponse emits with operation and optional cause', async () => {
  const res = makeResponse({ headersSent: true, req: { method: 'POST', url: '/x' } });
  const warnings = [];
  const onWarn = (w) => { warnings.push(w); };
  process.on('warning', onWarn);
  try {
    warnLateResponse(res, 'dispatch', 'race');
    // process warnings are emitted asynchronously on some Node versions
    await new Promise((r) => setImmediate(r));
  } finally {
    process.off('warning', onWarn);
  }
  assert.ok(warnings.length >= 1, 'expected a process warning');
  const text = warnings.map((w) => String(w.message ?? w)).join('\n');
  assert.match(text, /dispatch/);
  assert.match(text, /POST \/x/);
});

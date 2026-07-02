import { test } from 'node:test';
import assert from 'node:assert/strict';

import { committedEventHeaders, sendJson } from '../src/http-response.mjs';

function makeResponse() {
  return {
    status: null,
    headers: null,
    body: null,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
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

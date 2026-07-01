// Structured logger tests — agent-readable JSON output + level gating.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLog } from '../src/log.mjs';

test('default level is info — debug and trace are dropped', () => {
  const lines = [];
  const log = createLog({ output: (level, channel, msg, ctx) => lines.push({ level, channel, msg, ctx }) });
  log.trace('auth', 'trace', { x: 1 });
  log.debug('auth', 'debug', { x: 2 });
  log.info('auth', 'info', { x: 3 });
  log.warn('auth', 'warn', { x: 4 });
  log.error('auth', 'error', { x: 5 });
  assert.equal(lines.length, 3, 'trace and debug dropped');
  assert.deepEqual(lines[0], { level: 'info', channel: 'auth', msg: 'info', ctx: { x: 3 } });
  assert.deepEqual(lines[2], { level: 'error', channel: 'auth', msg: 'error', ctx: { x: 5 } });
});

test('channel-specific levels override global floor', () => {
  const lines = [];
  const log = createLog({
    level: 'warn',
    channels: { auth: 'debug', http: 'error' },
    output: (level, channel, msg, ctx) => lines.push({ level, channel, msg, ctx }),
  });
  log.debug('auth', 'debug auth', {});
  log.info('auth', 'info auth', {});
  log.warn('http', 'warn http', {});
  log.warn('system', 'warn system', {});
  assert.equal(lines.length, 3);
  // auth gets debug+ because channel floor is debug
  assert.equal(lines[0].msg, 'debug auth');
  assert.equal(lines[1].msg, 'info auth');
  // http gets error+ only because channel floor is error → warn dropped
  // system uses global floor (warn) → warn passes
  assert.equal(lines[2].msg, 'warn system');
});

test('json format produces parseable JSON lines', (t) => {
  const chunks = [];
  const output = { write: (chunk) => chunks.push(chunk) };
  const log = createLog({ level: 'info', format: 'json', output });
  log.info('http', 'GET /notes 200', { method: 'GET', path: '/notes', status: 200 });
  log.warn('auth', 'update denied', { entity: 'Note', id: 'n1', principal: 'bob', verb: 'update' });
  const err = new Error('boom');
  err.code = 'E_TEST';
  log.error('dispatch', 'dispatch failed', { err, entity: 'Note' });
  assert.equal(chunks.length, 3);
  const entry1 = JSON.parse(chunks[0]);
  assert.equal(entry1.level, 'info');
  assert.equal(entry1.channel, 'http');
  assert.equal(entry1.msg, 'GET /notes 200');
  assert.deepEqual(entry1.ctx, { method: 'GET', path: '/notes', status: 200 });

  const entry2 = JSON.parse(chunks[1]);
  assert.equal(entry2.level, 'warn');
  assert.deepEqual(entry2.ctx, { entity: 'Note', id: 'n1', principal: 'bob', verb: 'update' });

  const entry3 = JSON.parse(chunks[2]);
  assert.equal(entry3.level, 'error');
  assert.equal(entry3.ctx.err.message, 'boom');
  assert.equal(entry3.ctx.err.code, 'E_TEST');
});

test('human format produces colorized output', () => {
  const lines = [];
  const log = createLog({ level: 'debug', format: 'human', output: { write: (chunk) => lines.push(chunk) } });
  log.debug('auth', 'grant checked', { entity: 'Note', id: 'n1' });
  log.warn('system', 'blob reap failed', { err: new Error('ENOENT') });
  log.info('http', 'GET /notes 200', { method: 'GET', status: 200 });
  assert.equal(lines.length, 3);
  assert.ok(lines[0].includes('[DEBUG'), 'has DEBUG tag');
  assert.ok(lines[0].includes('auth'), 'has channel');
  assert.ok(lines[0].includes('grant checked'), 'has message');
  assert.ok(lines[0].includes('entity=Note'), 'has context key-value');
  assert.ok(lines[1].includes('[WARN'));
  assert.ok(lines[1].includes('ENOENT'), 'error message in context');
});

test('deserializeRow ordering and empty row guard', () => {
  const lines = [];
  const log = createLog({ level: 'info', format: 'json', output: (l,c,m) => lines.push({ l,c,m }) });
  // info-level assertion: empty rows get 404 before deserialize (serve.mjs fix)
  log.info('http', 'read row not found', { path: '/notes/abc', status: 404 });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].c, 'http');
});

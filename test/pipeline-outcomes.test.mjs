import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  ValidationError,
  createServer,
  durableMutationVariant,
  generateFrameworkDDL,
} from '../src/internal.mjs';

const request = (type = 'note.create') => ({
  actionId: 'action-1',
  type,
  payload: { id: 'note-1' },
  principal: { id: 'user-1' },
});

const event = Object.freeze({ type: 'note.created', scope: 'Note:note-1', data: { id: 'note-1' } });

test('dispatch returns the exact success outcome', () => {
  const server = createServer({ handlers: { 'note.create': () => [event] }, authorize: () => true });
  assert.deepEqual(server.dispatch(request()), {
    ok: true,
    deduped: false,
    events: [{ ...event, seq: 1, actionId: 'action-1' }],
  });
});

test('dispatch returns the exact denied outcome', () => {
  const server = createServer({ handlers: { 'note.create': () => [event] }, authorize: () => false });
  assert.deepEqual(server.dispatch(request()), {
    ok: false,
    failure: { category: 'denied', message: 'Forbidden.' },
  });
});

test('unknown actions fail before authorization or execution', () => {
  let authorizationCalls = 0;
  const server = createServer({ handlers: {}, authorize: () => { authorizationCalls += 1; return true; } });
  assert.deepEqual({ outcome: server.dispatch(request('missing.action')), authorizationCalls, logSize: server.log.length }, {
    outcome: {
      ok: false,
      failure: { category: 'unknown-action', message: "No action named 'missing.action' is registered." },
    },
    authorizationCalls: 0,
    logSize: 0,
  });
});

test('validation errors become invalid-input outcomes', () => {
  const server = createServer({
    handlers: { 'note.create': () => { throw new ValidationError('Note.title is required.'); } },
    authorize: () => true,
  });
  assert.deepEqual(server.dispatch(request()), {
    ok: false,
    failure: { category: 'invalid-input', message: 'Note.title is required.' },
  });
});

test('unexpected handler errors become sanitized internal outcomes', () => {
  const server = createServer({
    handlers: { 'note.create': () => { throw new Error('database password leaked'); } },
    authorize: () => true,
  });
  assert.deepEqual(server.dispatch(request()), {
    ok: false,
    failure: { category: 'internal', message: 'Internal error.' },
  });
});

test('batch identifies an unknown action without running any handler', () => {
  let handlerCalls = 0;
  const server = createServer({
    handlers: { first: () => { handlerCalls += 1; return [event]; } },
    authorize: () => true,
  });
  assert.deepEqual({
    outcome: server.dispatchBatch({
      actionId: 'batch-1',
      actions: [{ type: 'first', payload: {} }, { type: 'missing', payload: {} }],
      principal: { id: 'user-1' },
    }),
    handlerCalls,
  }, {
    outcome: {
      ok: false,
      failure: {
        category: 'unknown-action',
        message: "No action named 'missing' is registered.",
        details: { actionIndex: 1 },
      },
    },
    handlerCalls: 0,
  });
});

test('empty batch returns the exact success outcome', () => {
  const server = createServer({ handlers: {}, authorize: () => true });
  assert.deepEqual(server.dispatchBatch({ actionId: 'batch-1', actions: [], principal: { id: 'user-1' } }), {
    ok: true,
    deduped: false,
    events: [],
  });
});

test('post-commit failure cannot turn a committed mutation into a reported failure', async () => {
  const db = new DatabaseSync(':memory:');
  for (const sql of generateFrameworkDDL()) db.exec(sql);
  const base = durableMutationVariant();
  const server = createServer({
    db,
    handlers: { 'note.create': () => [event] },
    authorize: () => true,
    pipeline: {
      ...base,
      afterCommit: async () => { throw Object.assign(new Error('fanout unavailable'), { status: 403 }); },
    },
  });

  const outcome = await server.dispatch(request());
  assert.deepEqual({ outcome, committedRows: db.prepare('SELECT COUNT(*) AS count FROM _Log').get().count }, {
    outcome: { ok: true, deduped: false, events: outcome.events },
    committedRows: 1,
  });
  db.close();
});

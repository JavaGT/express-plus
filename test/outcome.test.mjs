import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FAILURE_CATEGORIES,
  failure,
  failureOutcome,
  isWorkbenchFailure,
  sanitizeUnexpectedFailure,
} from '../src/index.mjs';
import { failureFromError } from '../src/outcome.mjs';
import { statusForFailure } from '../src/outcome.mjs';

test('failure categories are the six stable public categories', () => {
  assert.deepEqual(FAILURE_CATEGORIES, [
    'invalid-input',
    'denied',
    'unknown-action',
    'not-found',
    'conflict',
    'internal',
  ]);
});

test('failure creates the exact transport-neutral failure shape', () => {
  assert.deepEqual(failure('not-found', 'Project not found.', { projectId: 'p1' }), {
    category: 'not-found',
    message: 'Project not found.',
    details: { projectId: 'p1' },
  });
});

test('failure rejects categories outside the public grammar', () => {
  assert.throws(() => failure('unauthorized', 'No.'), /unknown failure category/);
});

test('failureOutcome creates the exact public failure result', () => {
  assert.deepEqual(failureOutcome(failure('denied', 'Forbidden.')), {
    ok: false,
    failure: { category: 'denied', message: 'Forbidden.' },
  });
});

test('isWorkbenchFailure recognizes only complete canonical failures', () => {
  assert.equal(isWorkbenchFailure({ category: 'conflict', message: 'Already exists.' }), true);
});

test('sanitizeUnexpectedFailure never exposes the original exception', () => {
  assert.deepEqual(sanitizeUnexpectedFailure(new Error('database password leaked')), {
    category: 'internal',
    message: 'Internal error.',
  });
});

test('failureFromError preserves deliberate transport-neutral failures', () => {
  const deliberate = failure('conflict', 'Already exists.');
  assert.equal(failureFromError(deliberate), deliberate);
});

test('failureFromError maps deliberate status errors to stable categories', () => {
  assert.deepEqual(
    [400, 403, 404, 409].map((status) => failureFromError(Object.assign(new Error(`status ${status}`), { status }))),
    [
      { category: 'invalid-input', message: 'status 400' },
      { category: 'denied', message: 'status 403' },
      { category: 'not-found', message: 'status 404' },
      { category: 'conflict', message: 'status 409' },
    ],
  );
});

test('failureFromError maps only known SQLite constraints to conflict', () => {
  assert.deepEqual(failureFromError(Object.assign(new Error('duplicate'), { code: 'SQLITE_CONSTRAINT_UNIQUE' })), {
    category: 'conflict',
    message: 'The requested change conflicts with existing data.',
  });
});

test('failureFromError sanitizes unexpected errors', () => {
  assert.deepEqual(failureFromError(new Error('database password leaked')), {
    category: 'internal',
    message: 'Internal error.',
  });
});

test('failure categories have one canonical HTTP status mapping', () => {
  assert.equal(statusForFailure(failure('invalid-input', 'bad')), 400);
  assert.equal(statusForFailure(failure('denied', 'no')), 403);
  assert.equal(statusForFailure(failure('unknown-action', 'missing')), 404);
  assert.equal(statusForFailure(failure('not-found', 'missing')), 404);
  assert.equal(statusForFailure(failure('conflict', 'duplicate')), 409);
  assert.equal(statusForFailure(failure('internal', 'safe')), 500);
});

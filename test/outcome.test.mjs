import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FAILURE_CATEGORIES,
  failure,
  failureOutcome,
  isWorkbenchFailure,
  sanitizeUnexpectedFailure,
} from '../src/index.mjs';

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

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { frameworkTableNames } from '../src/server.mjs';

test('frameworkTableNames is a frozen, sorted, duplicate-free array of persistent framework tables', () => {
  assert.ok(Array.isArray(frameworkTableNames), 'frameworkTableNames must be an array');

  const expected = [
    '_ConsumerCursor',
    '_Cursor',
    '_Job',
    '_Log',
    '_Migration',
    '_ProjectedCursor',
    '_ScheduleReceipt',
    '_Worker',
    'ApiKey',
    'BlobStore',
    'Credential',
    'Inbox',
    'Invitation',
    'Session',
    'TwoFactor',
    'User',
  ];

  assert.deepStrictEqual(frameworkTableNames, expected);
  assert.ok(Object.isFrozen(frameworkTableNames));
});

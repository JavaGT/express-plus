import { test } from 'node:test';
import assert from 'node:assert/strict';
import { now } from 'workbench';

test('now is an exported frozen deferred-value token', () => {
  assert.ok(now, 'now should be exported');
  assert.equal(Object.isFrozen(now), true);
  assert.equal(now.kind, 'deferred');
  assert.equal(now.resolve, 'commit-instant');
});

test('now stringifies to a stable identifier (never a magic string in source)', () => {
  assert.equal(String(now), 'now:commit');
  // usable as a computed object key
  const m = { [now]: 1 };
  assert.equal(m['now:commit'], 1);
});

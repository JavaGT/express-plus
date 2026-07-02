// `number()` field constructor (SPEC §5). A value-kind scalar field for
// integers/floats. At import time it must be a valid value-kind descriptor the
// entity compiler accepts and the scope compiler can compare like any other
// value field.

import { entity, scope, everyone, grant, read, computed } from '../src/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { number } from '../src/internal.mjs';

test('number is a value-kind descriptor typed number', () => {
  const d = number();
  assert.equal(d.kind, 'value');
  assert.equal(d.type, 'number');
  assert.ok(Object.isFrozen(d));
});


test('computed() returns a pull computed descriptor', () => {
  const compute = (row) => (row.body ? row.body.length : 0);
  const d = computed({ compute });
  assert.equal(d.kind, 'computed');
  assert.equal(d.mode, 'pull');
  assert.equal(d.compute, compute);
  assert.equal(d.readonly, true);
  assert.ok(Object.isFrozen(d));
});

test('a number field compiles into an entity and exposes a value query handle', () => {
  const Metric = entity('Metric', {
    fields: { score: number() },
    grant: () => [scope(() => everyone()).can(() => grant(read))],
  });
  // value-kind handle: .is lowers to an equality on the column
  const lowered = Metric.score.is(5);
  assert.equal(Metric.score.fieldName, 'score');
  assert.ok(lowered, 'score.is(5) builds a predicate node');
});

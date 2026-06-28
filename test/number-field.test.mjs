// `number()` field constructor (SPEC §5). A value-kind scalar field for
// integers/floats — the gdocs exemplar declares `wordCount: number({ derived })`.
// At import time it must be a valid value-kind descriptor the entity compiler
// accepts and the scope compiler can compare like any other value field; the
// `derived` materialization (recomputing from other fields on write) is a later
// write-path behavior piece, carried on the descriptor for now.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { number, entity, scope, everyone, grant, read } from '../src/index.mjs';

test('number is a value-kind descriptor typed number', () => {
  const d = number();
  assert.equal(d.kind, 'value');
  assert.equal(d.type, 'number');
  assert.ok(Object.isFrozen(d));
});

test('number carries declared options (derived) on the descriptor', () => {
  const derive = (row) => (row.body ? row.body.length : 0);
  const d = number({ derived: derive });
  assert.equal(d.derived, derive);
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

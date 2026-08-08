import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as coords from '../public/workbench-annotated-text-coords.mjs';
import * as editor from '../public/workbench-annotated-text-editor.mjs';
import * as redactionCoords from '../public/workbench-annotated-text-redaction-coords.mjs';
import * as snapshot from '../public/workbench-annotated-text-snapshot.mjs';

// The coordinate grammar's public surface: exactly these 10 functions. Scope
// imports this aggregator instead of copying the predicates, so the re-exports
// must stay in lockstep with their source modules.
const EXPECTED = Object.freeze([
  'wireToDisplayPosition', 'displayToWirePosition', 'classifyDisplayOffset',
  'selectionCrossesDisplayRedaction', 'placeholderDisplayWidth',
  'scalarStart', 'scalarEnd', 'changedRange',
  'projectRangesOverEdit', 'projectRangesOverText',
]);

test('annotated-text-coords re-exports exactly the 10 coordinate-grammar functions', () => {
  assert.deepEqual(Object.keys(coords).sort(), [...EXPECTED].sort());
  for (const name of EXPECTED) assert.equal(typeof coords[name], 'function', name);
});

test('annotated-text-coords re-exports resolve from their source modules', () => {
  const redactionNames = ['wireToDisplayPosition', 'displayToWirePosition', 'classifyDisplayOffset', 'selectionCrossesDisplayRedaction', 'placeholderDisplayWidth'];
  for (const name of redactionNames) {
    assert.equal(coords[name], redactionCoords[name], `${name} must be the redaction-coords binding`);
  }
  for (const name of ['scalarStart', 'scalarEnd', 'changedRange']) {
    assert.equal(coords[name], editor[name], `${name} must be the editor binding`);
  }
  for (const name of ['projectRangesOverEdit', 'projectRangesOverText']) {
    assert.equal(coords[name], snapshot[name], `${name} must be the snapshot binding`);
  }
});

test('annotated-text-coords functions behave as the grammar they re-export', () => {
  const redactions = [{ start: 2, end: 2, placeholder: '[-]' }];
  assert.deepEqual(coords.wireToDisplayPosition({ offset: 2, affinity: 'right' }, redactions), { offset: 5, affinity: 'right' });
  assert.deepEqual(coords.displayToWirePosition({ offset: 5, affinity: 'right' }, redactions), { offset: 2, affinity: 'right' });
  assert.deepEqual(coords.classifyDisplayOffset(3, redactions), { kind: 'interior', offset: 3 });
  assert.equal(coords.selectionCrossesDisplayRedaction(1, 3, redactions), true);
  assert.equal(coords.placeholderDisplayWidth(redactions), 3);
  assert.equal(coords.scalarStart('a💥b', 2), 1);
  assert.equal(coords.scalarEnd('a💥b', 2), 3);
  assert.deepEqual(coords.changedRange('a💥b', 'a💥c'), { from: 3, to: 4, text: 'c' });
  const ranges = [{ annotationId: 'note-1', start: 0, end: 2 }];
  assert.deepEqual(coords.projectRangesOverEdit(ranges, 1, 1, 'x'), [{ annotationId: 'note-1', start: 0, end: 3 }]);
  assert.deepEqual(coords.projectRangesOverText(ranges, 'ab', 'axb'), [{ annotationId: 'note-1', start: 0, end: 3 }]);
});

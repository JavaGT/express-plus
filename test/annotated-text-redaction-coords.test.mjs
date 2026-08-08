// Document-wide wire↔display coordinate mapping (issue #33 step 8). A redaction
// marker is zero-width in the recipient wire text at `start`; its placeholder
// occupies placeholder.length display columns at the display image of `start`.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  classifyDisplayOffset,
  displayToWirePosition,
  placeholderDisplayWidth,
  selectionCrossesDisplayRedaction,
  wireToDisplayPosition,
} from '../public/workbench-annotated-text-redaction-coords.mjs';

test('displayToWirePosition subtracts prior placeholder widths and maps edges to the wire start', () => {
  const redactions = [
    { start: 2, end: 2, placeholder: '[-]' },
    { start: 5, end: 5, placeholder: '[--]' },
  ];
  // Plain display offsets shift back by the accumulated placeholder width.
  assert.deepEqual(displayToWirePosition({ offset: 1, affinity: 'right' }, redactions), { offset: 1, affinity: 'right' });
  assert.deepEqual(displayToWirePosition({ offset: 2, affinity: 'right' }, redactions), { offset: 2, affinity: 'left' });
  assert.deepEqual(displayToWirePosition({ offset: 5, affinity: 'right' }, redactions), { offset: 2, affinity: 'right' });
  assert.deepEqual(displayToWirePosition({ offset: 6, affinity: 'right' }, redactions), { offset: 3, affinity: 'right' });
  assert.deepEqual(displayToWirePosition({ offset: 8, affinity: 'right' }, redactions), { offset: 5, affinity: 'left' });
  assert.deepEqual(displayToWirePosition({ offset: 13, affinity: 'right' }, redactions), { offset: 6, affinity: 'right' });
  assert.deepEqual(displayToWirePosition({ offset: 14, affinity: 'right' }, redactions), { offset: 7, affinity: 'right' });
});

test('displayToWirePosition rejects an interior placeholder offset', () => {
  const redactions = [{ start: 2, end: 2, placeholder: '[-]' }];
  for (const offset of [3, 4]) {
    assert.throws(() => displayToWirePosition({ offset, affinity: 'right' }, redactions), (error) => {
      assert.equal(error.code, 'position-redacted');
      return true;
    });
  }
});

test('wireToDisplayPosition adds placeholder widths and maps a placeholder-edge wire offset by affinity', () => {
  const redactions = [
    { start: 2, end: 2, placeholder: '[-]' },
    { start: 5, end: 5, placeholder: '[--]' },
  ];
  assert.deepEqual(wireToDisplayPosition({ offset: 1, affinity: 'right' }, redactions), { offset: 1, affinity: 'right' });
  assert.deepEqual(wireToDisplayPosition({ offset: 2, affinity: 'left' }, redactions), { offset: 2, affinity: 'left' });
  assert.deepEqual(wireToDisplayPosition({ offset: 2, affinity: 'right' }, redactions), { offset: 5, affinity: 'right' });
  assert.deepEqual(wireToDisplayPosition({ offset: 3, affinity: 'right' }, redactions), { offset: 6, affinity: 'right' });
  assert.deepEqual(wireToDisplayPosition({ offset: 5, affinity: 'left' }, redactions), { offset: 8, affinity: 'left' });
  assert.deepEqual(wireToDisplayPosition({ offset: 5, affinity: 'right' }, redactions), { offset: 12, affinity: 'right' });
  assert.deepEqual(wireToDisplayPosition({ offset: 6, affinity: 'right' }, redactions), { offset: 13, affinity: 'right' });
});

test('wire↔display round-trips through every placeholder edge', () => {
  const redactions = [
    { start: 2, end: 2, placeholder: '[-]' },
    { start: 5, end: 5, placeholder: '[--]' },
  ];
  for (const affinity of ['left', 'right']) {
    for (let wireOffset = 0; wireOffset <= 8; wireOffset += 1) {
      const display = wireToDisplayPosition({ offset: wireOffset, affinity }, redactions);
      const back = displayToWirePosition(display, redactions);
      assert.deepEqual(back, { offset: wireOffset, affinity }, `round-trip failed at wire ${wireOffset}/${affinity}`);
    }
  }
});

test('classifyDisplayOffset labels placeholder edges, interiors, and plain display offsets', () => {
  const redactions = [
    { start: 2, end: 2, placeholder: '[-]' },
    { start: 5, end: 5, placeholder: '[--]' },
  ];
  assert.deepEqual(classifyDisplayOffset(1, redactions), { kind: 'plain', offset: 1 });
  assert.deepEqual(classifyDisplayOffset(2, redactions), { kind: 'left', offset: 2, affinity: 'left' });
  assert.deepEqual(classifyDisplayOffset(3, redactions), { kind: 'interior', offset: 3 });
  assert.deepEqual(classifyDisplayOffset(5, redactions), { kind: 'right', offset: 5, affinity: 'right' });
  assert.deepEqual(classifyDisplayOffset(8, redactions), { kind: 'left', offset: 8, affinity: 'left' });
  assert.deepEqual(classifyDisplayOffset(13, redactions), { kind: 'plain', offset: 13 });
  assert.deepEqual(classifyDisplayOffset(14, redactions), { kind: 'plain', offset: 14 });
});

test('selectionCrossesDisplayRedaction rejects selections that touch a placeholder span', () => {
  const redactions = [{ start: 2, end: 2, placeholder: '[-]' }];
  assert.equal(selectionCrossesDisplayRedaction(0, 2, redactions), false, 'selection ending at the placeholder start is allowed');
  assert.equal(selectionCrossesDisplayRedaction(5, 6, redactions), false, 'selection past the placeholder is allowed');
  assert.equal(selectionCrossesDisplayRedaction(0, 5, redactions), true, 'selection spanning the placeholder is rejected');
  assert.equal(selectionCrossesDisplayRedaction(2, 3, redactions), true, 'selection covering just the placeholder is rejected');
});

test('placeholderDisplayWidth sums placeholder lengths', () => {
  assert.equal(placeholderDisplayWidth([]), 0);
  assert.equal(placeholderDisplayWidth([
    { start: 0, end: 0, placeholder: '[-]' },
    { start: 1, end: 1, placeholder: '[--]' },
  ]), 7);
});

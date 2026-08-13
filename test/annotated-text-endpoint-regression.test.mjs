import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createTextState, applyTextOp, textCheckpoint, materializeText as materializeCheckpointText } from '../build/annotated-text.mjs';
import {
  createTextFamily,
  materializeText,
  resolveOffsetToEndpoint,
  textOperationForOffsetEdit,
  applyTextOperation,
  compareStructuralEndpoints,
  projectEndpointToOffset,
} from '../build/annotated-text-continuous.mjs';

const A1 = 'ffffffffffffffffffffffffffffffff';
const A2 = '00000000000000000000000000000001';

function actorFor(index) {
  return (index + 1).toString(16).padStart(32, '0');
}

let editCounter = 1000;
function editActor() {
  return actorFor(editCounter++);
}

test('right-affinity endpoint after a root sibling stops before the next sibling, not document end', () => {
  // Two INDEPENDENT root children 'a' and 'b' (not a chained parent/child pair).
  // compareInsertOrder sorts siblings lamport DESC then op-id DESC, so 'a'
  // (higher actor) sorts before 'b'.
  let state = createTextState();
  state = applyTextOp(state, ['workbench.text', 1, [A1, 1], 1, state.frontier, ['insert', ['root'], 'a']]);
  state = applyTextOp(state, ['workbench.text', 1, [A2, 1], 1, state.frontier, ['insert', ['root'], 'b']]);
  assert.equal(materializeCheckpointText(state), 'ab');
  const family = createTextFamily('d1', textCheckpoint(state));

  // Endpoint after 'a' (offset 1), right affinity — the boundary between 'a' and 'b'.
  const afterA = resolveOffsetToEndpoint(family, 1, family.checkpoint.frontier, 'right');
  assert.equal(projectEndpointToOffset(family, afterA), 1, 'boundary after a must project to offset 1, not document end');

  // A range [afterA, end] must cover 'b' only.
  const end = resolveOffsetToEndpoint(family, 2, family.checkpoint.frontier, 'right');
  assert.equal(compareStructuralEndpoints(family, afterA, end), -1, 'afterA must be structurally before document end');
});

test('a right-affinity endpoint after an element with a child stays after the child subtree', () => {
  // 'ab' chained: b is a child of a. The boundary `[a, right]` is the offset
  // between a and b (before a's first child) — offset 1.
  let family = createTextFamily('d1', textCheckpoint(createTextState()));
  const opA = textOperationForOffsetEdit(family, { kind: 'text.insert', at: { offset: 0, affinity: 'right' }, text: 'a' }, actorFor(0), 1);
  family = applyTextOperation(family, opA);
  const opB = textOperationForOffsetEdit(family, { kind: 'text.insert', at: { offset: 1, affinity: 'right' }, text: 'b' }, editActor(), 2);
  family = applyTextOperation(family, opB);
  assert.equal(materializeText(family), 'ab');
  const afterA = resolveOffsetToEndpoint(family, 1, family.checkpoint.frontier, 'right');
  assert.equal(projectEndpointToOffset(family, afterA), 1, 'boundary after a is between a and b');
});

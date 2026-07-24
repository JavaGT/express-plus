// T1 owns the stable annotated-text operation grammar. T2 owns reduction.

const ACTOR = /^[0-9a-f]{32}$/;
const SAFE_POSITIVE = (value) => Number.isSafeInteger(value) && value > 0;
const HIGH_SURROGATE = /^[\uD800-\uDBFF]$/;
const LOW_SURROGATE = /^[\uDC00-\uDFFF]$/;

function fail(message) {
  throw new Error(`invalid annotated-text value: ${message}`);
}

function assertClosedArray(value, length, name) {
  if (!Array.isArray(value) || value.length !== length) fail(`${name} must be an array of length ${length}`);
  for (const key of Object.keys(value)) {
    if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length) fail(`${name} has an extra property`);
  }
}

function assertActor(actor) {
  if (typeof actor !== 'string' || !ACTOR.test(actor)) fail('actor must be 32 lowercase hexadecimal characters');
}

export function assertWellFormedText(text) {
  if (typeof text !== 'string') fail('text must be a string');
  for (let index = 0; index < text.length; index += 1) {
    const unit = text[index];
    if (HIGH_SURROGATE.test(unit)) {
      if (index + 1 === text.length || !LOW_SURROGATE.test(text[index + 1])) fail('text contains an unpaired high surrogate');
      index += 1;
    } else if (LOW_SURROGATE.test(unit)) {
      fail('text contains an unpaired low surrogate');
    }
  }
  return text;
}

export function scalarCount(text) {
  assertWellFormedText(text);
  return [...text].length;
}

export function assertUtf16Offset(text, offset) {
  assertWellFormedText(text);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) fail('offset is outside text bounds');
  if (offset > 0 && offset < text.length && HIGH_SURROGATE.test(text[offset - 1]) && LOW_SURROGATE.test(text[offset])) {
    fail('offset splits a surrogate pair');
  }
  return offset;
}

export function assertUtf16Range(text, start, end) {
  assertUtf16Offset(text, start);
  assertUtf16Offset(text, end);
  if (start > end) fail('range is reversed');
  return [start, end];
}

export function assertOpId(value) {
  assertClosedArray(value, 2, 'operation ID');
  const [actor, counter] = value;
  assertActor(actor);
  if (!SAFE_POSITIVE(counter)) fail('operation counter must be a positive safe integer');
  return Object.freeze([actor, counter]);
}

export function compareOpId(left, right) {
  const [leftActor, leftCounter] = assertOpId(left);
  const [rightActor, rightCounter] = assertOpId(right);
  return leftActor === rightActor ? leftCounter - rightCounter : leftActor < rightActor ? -1 : 1;
}

export function assertFrontier(value) {
  if (!Array.isArray(value)) fail('frontier must be an array');
  for (const key of Object.keys(value)) {
    if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) fail('frontier has an extra property');
  }
  let previousActor = null;
  for (const entry of value) {
    const [actor, counter] = assertOpId(entry);
    if (previousActor !== null && previousActor >= actor) fail('frontier actors must be sorted and unique');
    previousActor = actor;
    if (counter < 1) fail('frontier counters cannot be zero');
  }
  return Object.freeze(value.map((entry) => Object.freeze([...entry])));
}

export function frontierCounter(frontier, actor) {
  assertFrontier(frontier);
  assertActor(actor);
  return frontier.find(([candidate]) => candidate === actor)?.[1] ?? 0;
}

export function frontierDominates(left, right) {
  assertFrontier(left);
  assertFrontier(right);
  return right.every(([actor, counter]) => frontierCounter(left, actor) >= counter);
}

export function assertAnchor(value) {
  if (!Array.isArray(value)) fail('anchor must be an array');
  if (value.length === 1 && value[0] === 'root') {
    assertClosedArray(value, 1, 'root anchor');
    return Object.freeze(['root']);
  }
  if (value.length !== 2 || value[0] !== 'element' || !Array.isArray(value[1]) || value[1].length !== 2) {
    fail('anchor must be root or an element identity');
  }
  assertClosedArray(value, 2, 'anchor');
  assertClosedArray(value[1], 2, 'element identity');
  const [op, ordinal] = value[1];
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) fail('element ordinal must be a non-negative safe integer');
  // The operation grammar cannot know the referenced run length. T2 admission
  // verifies this names an observed scalar, never the run-end gap.
  return Object.freeze(['element', Object.freeze([assertOpId(op), ordinal])]);
}

function assertDeleteSpans(value, deps) {
  if (!Array.isArray(value) || value.length === 0) fail('delete spans must be a non-empty array');
  let previous = null;
  return Object.freeze(value.map((span) => {
    assertClosedArray(span, 3, 'delete span');
    const [op, first, count] = span;
    const canonicalOp = assertOpId(op);
    if (frontierCounter(deps, canonicalOp[0]) < canonicalOp[1]) fail('delete target was not observed');
    if (!Number.isSafeInteger(first) || first < 0 || !SAFE_POSITIVE(count)) fail('delete span bounds are invalid');
    if (previous !== null) {
      const compare = compareOpId(previous.op, canonicalOp);
      if (compare > 0 || (compare === 0 && previous.end >= first)) fail('delete spans must be sorted, disjoint, and minimally merged');
    }
    previous = { op: canonicalOp, end: first + count - 1 };
    return Object.freeze([canonicalOp, first, count]);
  }));
}

export function compareInsertOrder(left, right) {
  const [, , leftOp, leftLamport] = assertTextOp(left);
  const [, , rightOp, rightLamport] = assertTextOp(right);
  if (leftLamport !== rightLamport) return rightLamport - leftLamport;
  return -compareOpId(leftOp, rightOp);
}

export function assertTextOp(value) {
  if (!Array.isArray(value) || value.length !== 6 || value[0] !== 'workbench.text' || value[1] !== 1) {
    fail('operation must use the workbench.text v1 array grammar');
  }
  assertClosedArray(value, 6, 'operation');
  const op = assertOpId(value[2]);
  const lamport = value[3];
  if (!SAFE_POSITIVE(lamport)) fail('Lamport clock must be a positive safe integer');
  const deps = assertFrontier(value[4]);
  if (frontierCounter(deps, op[0]) !== op[1] - 1) fail('operation dependencies must include the previous local counter');
  const body = value[5];
  if (!Array.isArray(body) || body.length < 2) fail('operation body is invalid');
  let canonicalBody;
  if (body[0] === 'insert' && body.length === 3) {
    assertClosedArray(body, 3, 'insert body');
    const anchor = assertAnchor(body[1]);
    if (anchor[0] === 'element' && frontierCounter(deps, anchor[1][0][0]) < anchor[1][0][1]) {
      fail('insert anchor was not observed');
    }
    const text = assertWellFormedText(body[2]);
    if (text.length === 0) fail('insert text cannot be empty');
    canonicalBody = Object.freeze(['insert', anchor, text]);
  } else if (body[0] === 'delete' && body.length === 2) {
    assertClosedArray(body, 2, 'delete body');
    canonicalBody = Object.freeze(['delete', assertDeleteSpans(body[1], deps)]);
  } else {
    fail('operation body must be an insert or delete');
  }
  return Object.freeze(['workbench.text', 1, op, lamport, deps, canonicalBody]);
}

export function canonicalTextOp(value) {
  const canonical = assertTextOp(value);
  if (JSON.stringify(value) !== JSON.stringify(canonical)) fail('operation is not in canonical form');
  return canonical;
}

export function assertStructuralPoint(value) {
  if (!Array.isArray(value) || value.length !== 3 || value[0] !== 'point') fail('structural point is invalid');
  assertClosedArray(value, 3, 'structural point');
  const anchor = assertAnchor(value[1]);
  if (value[2] !== 'left' && value[2] !== 'right') fail('structural point affinity is invalid');
  return Object.freeze(['point', anchor, value[2]]);
}

// T2 owns causal application, buffering, tombstones, and checkpoint reduction.
export function applyTextOp() { throw new Error('not implemented: T2'); }

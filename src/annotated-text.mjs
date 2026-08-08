// T1 owns the stable annotated-text operation grammar. T2 owns reduction.

const ACTOR = /^[0-9a-f]{32}$/;
const SAFE_POSITIVE = (value         )          => Number.isSafeInteger(value) && (value          ) > 0;
const HIGH_SURROGATE = /^[\uD800-\uDBFF]$/;
const LOW_SURROGATE = /^[\uDC00-\uDFFF]$/;

                                                             
                                       
                                                                                                    
                                                                           
                                                                           
                                                                                                          
                                                                                        

                              
           
                  
                 
                 
                  
                      
 

                                    
                 
             
 

                            
             
                     
                                        
                                                
                                             
                     
                               
 

                            
                      
 

function fail(message        )        {
  throw new Error(`invalid annotated-text value: ${message}`);
}

function assertClosedArray(value         , length        , name        ) {
  if (!Array.isArray(value) || value.length !== length) fail(`${name} must be an array of length ${length}`);
  for (const key of Object.keys(value)) {
    if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length) fail(`${name} has an extra property`);
  }
}

function assertActor(actor         ) {
  if (typeof actor !== 'string' || !ACTOR.test(actor)) fail('actor must be 32 lowercase hexadecimal characters');
}

export function assertWellFormedText(text        )         {
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

export function scalarCount(text        )         {
  assertWellFormedText(text);
  return [...text].length;
}

export function assertUtf16Offset(text        , offset        )         {
  assertWellFormedText(text);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) fail('offset is outside text bounds');
  if (offset > 0 && offset < text.length && HIGH_SURROGATE.test(text[offset - 1]) && LOW_SURROGATE.test(text[offset])) {
    fail('offset splits a surrogate pair');
  }
  return offset;
}

export function assertUtf16Range(text        , start        , end        )                   {
  assertUtf16Offset(text, start);
  assertUtf16Offset(text, end);
  if (start > end) fail('range is reversed');
  return [start, end];
}

export function assertOpId(value         )       {
  assertClosedArray(value, 2, 'operation ID');
  const [actor, counter] = value        ;
  assertActor(actor);
  if (!SAFE_POSITIVE(counter)) fail('operation counter must be a positive safe integer');
  return Object.freeze([actor, counter]);
}

export function compareOpId(left      , right      )         {
  const [leftActor, leftCounter] = assertOpId(left);
  const [rightActor, rightCounter] = assertOpId(right);
  return leftActor === rightActor ? leftCounter - rightCounter : leftActor < rightActor ? -1 : 1;
}

export function assertFrontier(value         )           {
  if (!Array.isArray(value)) fail('frontier must be an array');
  for (const key of Object.keys(value)) {
    if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) fail('frontier has an extra property');
  }
  let previousActor                = null;
  for (const entry of value) {
    const [actor, counter] = assertOpId(entry);
    if (previousActor !== null && previousActor >= actor) fail('frontier actors must be sorted and unique');
    previousActor = actor;
    if (counter < 1) fail('frontier counters cannot be zero');
  }
  return Object.freeze(value.map((entry) => Object.freeze([...entry]                   )))            ;
}

export function frontierCounter(frontier          , actor        )         {
  assertFrontier(frontier);
  assertActor(actor);
  return frontier.find(([candidate]) => candidate === actor)?.[1] ?? 0;
}

export function frontierDominates(left          , right          )          {
  assertFrontier(left);
  assertFrontier(right);
  return right.every(([actor, counter]) => frontierCounter(left, actor) >= counter);
}

export function assertAnchor(value         )         {
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
  return Object.freeze(['element', Object.freeze([assertOpId(op), ordinal]                           )]);
}

function assertDeleteSpans(value         , deps          )                        {
  if (!Array.isArray(value) || value.length === 0) fail('delete spans must be a non-empty array');
  let previous                                   = null;
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
    return Object.freeze([canonicalOp, first, count])              ;
  }));
}

export function compareInsertOrder(left        , right        )         {
  const [, , leftOp, leftLamport] = assertTextOp(left);
  const [, , rightOp, rightLamport] = assertTextOp(right);
  if (leftLamport !== rightLamport) return rightLamport - leftLamport;
  return -compareOpId(leftOp, rightOp);
}

export function assertTextOp(value         )         {
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
  let canonicalBody            ;
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

export function canonicalTextOp(value         )         {
  const canonical = assertTextOp(value);
  if (JSON.stringify(value) !== JSON.stringify(canonical)) fail('operation is not in canonical form');
  return canonical;
}

export function assertStructuralPoint(value         )                  {
  if (!Array.isArray(value) || value.length !== 3 || value[0] !== 'point') fail('structural point is invalid');
  assertClosedArray(value, 3, 'structural point');
  const anchor = assertAnchor(value[1]);
  if (value[2] !== 'left' && value[2] !== 'right') fail('structural point affinity is invalid');
  return Object.freeze(['point', anchor, value[2]]);
}

const ROOT_ID = 'root';
const DEFAULT_MAX_PENDING = 1_000;

function opKey(op               )         {
  return `${op[0]}:${op[1]}`;
}

function elementKey(op      , ordinal        )         {
  return `${opKey(op)}:${ordinal}`;
}

function anchorKey(anchor        )         {
  return anchor[0] === 'root' ? ROOT_ID : elementKey(anchor[1][0], anchor[1][1]);
}

function canonicalDigest(op        )         {
  return JSON.stringify(op);
}

function canonicalFrontier(frontier          )         {
  return frontier.map(([actor, counter])       => [actor, counter]);
}

function makeState({ maxPending = DEFAULT_MAX_PENDING }                   = {})            {
  if (!Number.isSafeInteger(maxPending) || maxPending < 1) throw new TypeError('maxPending must be a positive safe integer');
  return {
    version: 1,
    frontier: [],
    elements: {},
    operations: {},
    pending: {},
    maxPending,
    rebootstrapRequired: false,
  };
}

function cloneState(state           )            {
  return {
    version: 1,
    frontier: canonicalFrontier(state.frontier),
    elements: Object.fromEntries(Object.entries(state.elements).map(([key, element]) => [key, {
      op: [...element.op]        , ordinal: element.ordinal, scalar: element.scalar,
      parent: element.parent, lamport: element.lamport, deletedBy: [...element.deletedBy],
    }])),
    operations: Object.fromEntries(Object.entries(state.operations).map(([key, value]) => [key, { digest: value.digest, op: value.op }])),
    pending: Object.fromEntries(Object.entries(state.pending).map(([key, value]) => [key, { digest: value.digest, op: value.op }])),
    maxPending: state.maxPending,
    rebootstrapRequired: state.rebootstrapRequired,
  };
}

function assertState(state           )            {
  if (!state || state.version !== 1 || !Array.isArray(state.frontier) || !state.elements || !state.operations || !state.pending) {
    throw new TypeError('invalid annotated-text reducer state');
  }
  assertFrontier(state.frontier);
  return state;
}

export function createTextState(options                   )            {
  return Object.freeze(makeState(options));
}

function stateFrontierCounter(state           , actor        )         {
  return state.frontier.find(([candidate]) => candidate === actor)?.[1] ?? 0;
}

function operationReady(state           , op        )          {
  if (!frontierDominates(state.frontier, op[4])) return false;
  const body = op[5];
  if (body[0] === 'insert') return body[1][0] === 'root' || Object.hasOwn(state.elements, anchorKey(body[1]));
  return body[1].every(([target, first, count]) => {
    for (let ordinal = first; ordinal < first + count; ordinal += 1) {
      if (!Object.hasOwn(state.elements, elementKey(target, ordinal))) return false;
    }
    return true;
  });
}

function advanceFrontier(state           , op        ) {
  const [actor, counter] = op[2];
  const frontier = state.frontier.filter(([candidate]) => candidate !== actor);
  frontier.push([actor, counter]);
  frontier.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  state.frontier = frontier;
}

function applyReadyOperation(state           , op        , digest        ) {
  const body = op[5];
  if (body[0] === 'insert') {
    const parent = anchorKey(body[1]);
    let previous = parent;
    let ordinal = 0;
    for (const scalar of body[2]) {
      const key = elementKey(op[2], ordinal);
      state.elements[key] = {
        op: [...op[2]], ordinal, scalar, parent: previous, lamport: op[3], deletedBy: [],
      };
      previous = key;
      ordinal += 1;
    }
  } else {
    const deleteTag = opKey(op[2]);
    for (const [target, first, count] of body[1]) {
      for (let ordinal = first; ordinal < first + count; ordinal += 1) {
        const element = state.elements[elementKey(target, ordinal)];
        if (!element.deletedBy.includes(deleteTag)) element.deletedBy.push(deleteTag);
      }
    }
  }
  state.operations[opKey(op[2])] = { digest, op };
  advanceFrontier(state, op);
}

function drainPending(state           ) {
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const key of Object.keys(state.pending).sort()) {
      const entry = state.pending[key];
      if (!operationReady(state, entry.op)) continue;
      delete state.pending[key];
      applyReadyOperation(state, entry.op, entry.digest);
      progressed = true;
    }
  }
}

function assertCheckpoint(value         )            {
  const raw = value                       ;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some((key) => !['version', 'frontier', 'elements', 'operations', 'pending', 'maxPending', 'rebootstrapRequired'].includes(key))) {
    throw new TypeError('invalid annotated-text checkpoint');
  }
  const state = makeState({ maxPending: raw.maxPending });
  state.frontier = assertFrontier(raw.frontier).map((entry) => [...entry]);
  state.rebootstrapRequired = raw.rebootstrapRequired === true;
  for (const [key, element] of Object.entries((raw.elements ?? {})                       )) {
    if (!element || typeof element.scalar !== 'string' || scalarCount(element.scalar) !== 1 || typeof element.parent !== 'string' || !Array.isArray(element.op) || !Number.isSafeInteger(element.ordinal) || element.ordinal < 0 || !SAFE_POSITIVE(element.lamport) || !Array.isArray(element.deletedBy)) throw new TypeError('invalid annotated-text checkpoint element');
    if (key !== elementKey(element.op, element.ordinal)) throw new TypeError('invalid annotated-text checkpoint element identity');
    state.elements[key] = { op: [...assertOpId(element.op)], ordinal: element.ordinal, scalar: element.scalar, parent: element.parent, lamport: element.lamport, deletedBy: [...element.deletedBy].sort() };
  }
  for (const registryName of ['operations', 'pending']         ) {
    for (const [key, entry] of Object.entries((raw[registryName] ?? {})                       )) {
      const op = canonicalTextOp(entry?.op);
      const digest = canonicalDigest(op);
      if (key !== opKey(op[2]) || entry.digest !== digest) throw new TypeError('invalid annotated-text checkpoint operation registry');
      state[registryName][key] = { digest, op };
    }
  }
  return state;
}

export function restoreTextCheckpoint(checkpoint         )            {
  const supplied = assertCheckpoint(checkpoint);
  const applied = Object.values(supplied.operations).map((entry) => entry.op);
  const pending = Object.values(supplied.pending).map((entry) => entry.op);
  const appliedIds = new Set(applied.map((op) => opKey(op[2])));
  if (pending.some((op) => appliedIds.has(opKey(op[2])))) {
    throw new TypeError('annotated-text checkpoint duplicates an operation across registries');
  }

  // Reducer effects are derived from the canonical operation registry. Never
  // admit independently supplied topology, tombstones, or frontier state.
  let restored = createTextState({ maxPending: supplied.maxPending });
  const remaining = [...applied];
  while (remaining.length > 0) {
    const nextIndex = remaining.findIndex((operation) => operationReady(restored, operation));
    if (nextIndex === -1) {
      throw new TypeError('annotated-text checkpoint applied operations are not causally reducible');
    }
    const [operation] = remaining.splice(nextIndex, 1);
    restored = applyTextOp(restored, operation);
  }
  for (const operation of pending.sort((left, right) => compareOpId(left[2], right[2]))) {
    if (operationReady(restored, operation)) {
      throw new TypeError('annotated-text checkpoint contains a ready pending operation');
    }
    restored = applyTextOp(restored, operation);
  }
  // The operation that exceeded the live pending cap is intentionally not
  // retained. Its terminal outcome is nevertheless durable checkpoint state.
  if (supplied.rebootstrapRequired) restored = Object.freeze({ ...cloneState(restored), rebootstrapRequired: true });
  if (JSON.stringify(textCheckpoint(supplied)) !== JSON.stringify(textCheckpoint(restored))) {
    throw new TypeError('annotated-text checkpoint does not match its operation registry');
  }
  return restored;
}

export function textCheckpoint(state           )            {
  assertState(state);
  const sortedElements = Object.fromEntries(Object.entries(state.elements).sort(([left], [right]) => left.localeCompare(right)).map(([key, element]) => [key, {
    op: [...element.op]        , ordinal: element.ordinal, scalar: element.scalar, parent: element.parent,
    lamport: element.lamport, deletedBy: [...element.deletedBy].sort(),
  }]));
  const registry = (entries                                   ) => Object.fromEntries(Object.entries(entries).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, { digest: entry.digest, op: entry.op }]));
  return Object.freeze({ version: 1, frontier: canonicalFrontier(state.frontier), elements: sortedElements, operations: registry(state.operations), pending: registry(state.pending), maxPending: state.maxPending, rebootstrapRequired: state.rebootstrapRequired });
}

export function materializeText(state           )         {
  assertState(state);
  const children = new Map                                      ([[ROOT_ID, []]]);
  for (const [key, element] of Object.entries(state.elements)) {
    const list = children.get(element.parent) ?? [];
    list.push([key, element]);
    children.set(element.parent, list);
  }
  for (const list of children.values()) {
    list.sort(([, left], [, right]) => right.lamport - left.lamport || -compareOpId(left.op, right.op));
  }
  let text = '';
  const stack                               = [...(children.get(ROOT_ID) ?? [])].reverse();
  while (stack.length > 0) {
    const [key, element] = stack.pop() ;
    if (element.deletedBy.length === 0) text += element.scalar;
    const descendants = children.get(key);
    if (descendants) stack.push(...descendants.slice().reverse());
  }
  return text;
}

// Applies one immutable operation. It is deliberately atomic: an operation is
// either fully reduced, retained intact in the bounded pending registry, or the
// replica fails closed and must rebootstrap from a checkpoint.
export function applyTextOp(current           , value         )            {
  const state = cloneState(assertState(current));
  if (state.rebootstrapRequired) return Object.freeze(state);
  const op = canonicalTextOp(value);
  const key = opKey(op[2]);
  const digest = canonicalDigest(op);
  const known = state.operations[key] ?? state.pending[key];
  if (known) {
    if (known.digest !== digest) throw new Error('annotated-text operation ID was reused with different content');
    return Object.freeze(state);
  }
  // A contiguous frontier also makes a counter at or behind it equivocal even
  // if a damaged checkpoint omitted its operation registry entry.
  if (stateFrontierCounter(state, op[2][0]) >= op[2][1]) throw new Error('annotated-text operation ID is behind the applied frontier');
  if (operationReady(state, op)) {
    applyReadyOperation(state, op, digest);
    drainPending(state);
  } else if (Object.keys(state.pending).length >= state.maxPending) {
    state.rebootstrapRequired = true;
  } else {
    state.pending[key] = { digest, op };
  }
  return Object.freeze(state);
}

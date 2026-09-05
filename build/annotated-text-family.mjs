import {
  assertFrontier, assertStructuralPoint,
} from './annotated-text.mjs';




const ROOT_ID = 'root';






function fail(message        )        {
  throw new Error(`invalid annotated-text family: ${message}`);
}

function deepFreeze   (value   )    {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value)     ;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) return value;
  for (const v of Object.values(value                           )) deepFreeze(v);
  return Object.freeze(value)     ;
}

function buildChildren(checkpoint           )                                            {
  const children = new Map                                      ([[ROOT_ID, []]]);
  // for-in avoids the per-element entry-tuple allocation of Object.entries on
  // this per-keystroke traversal rebuild; key order is identical.
  for (const key in checkpoint.elements) {
    const element = checkpoint.elements[key];
    const list = children.get(element.parent) ?? [];
    list.push([key, element]);
    children.set(element.parent, list);
  }
  for (const [parent, list] of children) {
    // Schwartzian transform: precompute the sort keys once instead of paying
    // tuple destructuring plus op derefs on every comparison. Ordering is
    // identical to the inline comparator (lamport desc, then op id desc).
    const keyed = new Array(list.length);
    for (let index = 0; index < list.length; index += 1) {
      const entry = list[index];
      keyed[index] = { lamport: entry[1].lamport, actor: entry[1].op[0], counter: entry[1].op[1], entry };
    }
    keyed.sort((left, right) => right.lamport - left.lamport
      || (left.actor === right.actor ? right.counter - left.counter : left.actor < right.actor ? 1 : -1));
    const sorted = new Array(list.length);
    for (let index = 0; index < keyed.length; index += 1) sorted[index] = keyed[index].entry;
    children.set(parent, sorted);
  }
  return children;
}

export function rgaTraversal(checkpoint           )                               {
  const children = buildChildren(checkpoint);
  const order                               = [];
  const stack                               = [...(children.get(ROOT_ID) ?? [])].reverse();
  while (stack.length > 0) {
    const entry = stack.pop()                         ;
    order.push(entry);
    const descendants = children.get(entry[0]);
    if (descendants) stack.push(...descendants.slice().reverse());
  }
  return order;
}

export function assertStructuralEndpoint(endpoint         )                     {
  if (!endpoint || typeof endpoint !== 'object' || Array.isArray(endpoint)) {
    fail('endpoint must be a non-array object');
  }
  const raw = endpoint                       ;
  const allowedKeys = ['point', 'basisFrontier'];
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.includes(key)) fail(`unknown endpoint key: ${key}`);
  }
  assertStructuralPoint(raw.point);
  assertFrontier(raw.basisFrontier);
  return deepFreeze({ point: raw.point, basisFrontier: raw.basisFrontier });
}

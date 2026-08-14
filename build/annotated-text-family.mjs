import {
  assertFrontier, assertStructuralPoint, compareOpId,
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
  for (const [key, element] of Object.entries(checkpoint.elements)) {
    const list = children.get(element.parent) ?? [];
    list.push([key, element]);
    children.set(element.parent, list);
  }
  for (const list of children.values()) {
    list.sort(([, left], [, right]) => right.lamport - left.lamport || -compareOpId(left.op, right.op));
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

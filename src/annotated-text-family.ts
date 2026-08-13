import {
  assertFrontier, assertStructuralPoint, compareOpId,
} from './annotated-text.ts';
import type {
  Frontier, StructuralPoint, TextElement, TextState,
} from './annotated-text.ts';

const ROOT_ID = 'root';

export interface StructuralEndpoint {
  point: StructuralPoint;
  basisFrontier: Frontier;
}

function fail(message: string): never {
  throw new Error(`invalid annotated-text family: ${message}`);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value) as T;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) return value;
  for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  return Object.freeze(value) as T;
}

function buildChildren(checkpoint: TextState): Map<string, Array<[string, TextElement]>> {
  const children = new Map<string, Array<[string, TextElement]>>([[ROOT_ID, []]]);
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

export function rgaTraversal(checkpoint: TextState): Array<[string, TextElement]> {
  const children = buildChildren(checkpoint);
  const order: Array<[string, TextElement]> = [];
  const stack: Array<[string, TextElement]> = [...(children.get(ROOT_ID) ?? [])].reverse();
  while (stack.length > 0) {
    const entry = stack.pop() as [string, TextElement];
    order.push(entry);
    const descendants = children.get(entry[0]);
    if (descendants) stack.push(...descendants.slice().reverse());
  }
  return order;
}

export function assertStructuralEndpoint(endpoint: unknown): StructuralEndpoint {
  if (!endpoint || typeof endpoint !== 'object' || Array.isArray(endpoint)) {
    fail('endpoint must be a non-array object');
  }
  const raw = endpoint as Record<string, any>;
  const allowedKeys = ['point', 'basisFrontier'];
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.includes(key)) fail(`unknown endpoint key: ${key}`);
  }
  assertStructuralPoint(raw.point);
  assertFrontier(raw.basisFrontier);
  return deepFreeze({ point: raw.point, basisFrontier: raw.basisFrontier });
}

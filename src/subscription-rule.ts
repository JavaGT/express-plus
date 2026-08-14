// Declarative collection interests. This is intentionally a data-only grammar:
// clients name declared fields and values, while this module owns SQL generation.

import type { LiveEntityRecord } from './live-fanout.ts';

export type SubscriptionFilterOperator = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'isNull';

export interface SubscriptionFilter {
  field: string;
  op?: SubscriptionFilterOperator;
  value?: unknown;
}

export interface SubscriptionSort {
  field: string;
  direction?: 'asc' | 'desc';
}

export interface BoundedResultPolicy {
  limit: number;
  overflowMarker?: unknown;
}

export interface SubscriptionRule {
  resourceKind: string;
  parent?: SubscriptionFilter;
  anchor?: SubscriptionFilter;
  filters?: SubscriptionFilter[];
  select?: string[] | { fields: string[] };
  sort?: SubscriptionSort[];
  boundedResultPolicy: BoundedResultPolicy;
}

export interface CompiledSubscriptionRule {
  readonly resourceKind: string;
  readonly sql: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly select: readonly string[];
  readonly sort: readonly SubscriptionSort[];
  readonly boundedResultPolicy: Readonly<BoundedResultPolicy>;
}

function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function fail(message: string): never {
  throw new Error(`Invalid collection subscription rule: ${message}`);
}

function assertKeys(value: object, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${label} contains an unknown property.`);
  }
}

function fieldsOf(entity: LiveEntityRecord): Set<string> {
  return new Set(['id', ...Object.keys(entity.fields ?? {})]);
}

function assertData(value: unknown, label: string): void {
  if (typeof value === 'function') fail(`${label} must be data, not a function.`);
  if (value && typeof value === 'object') {
    if (Array.isArray(value)) {
      for (const item of value) assertData(item, label);
    } else {
      for (const item of Object.values(value)) assertData(item, label);
    }
  }
}

function assertSqlValue(value: unknown): void {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return;
  fail('filter values must be SQLite scalar values.');
}

// Compile one filter into a parameterized fragment. The field name is checked
// against the declaration before it becomes an identifier; the value is always
// bound, never interpolated.
function compileFilter(filter: unknown, declaredFields: Set<string>, params: Record<string, unknown>, next: () => string): string {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) fail('filters must be objects.');
  assertKeys(filter, ['field', 'op', 'value'], 'filter');
  const { field, op = 'eq', value } = filter as SubscriptionFilter;
  if (typeof field !== 'string' || !declaredFields.has(field)) fail('a filter references an unknown field.');
  if (!['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'isNull'].includes(op)) fail('a filter uses an unsupported operator.');
  const column = `t0.${quote(field)}`;
  if (op === 'isNull') {
    if (value !== undefined) fail('isNull does not accept a value.');
    return `${column} IS NULL`;
  }
  if (op === 'in') {
    if (!Array.isArray(value) || value.length === 0 || value.length > 100) fail('in requires 1 through 100 values.');
    const names = value.map((item) => {
      assertSqlValue(item);
      const name = next();
      params[name] = item;
      return `:${name}`;
    });
    return `${column} IN (${names.join(', ')})`;
  }
  assertSqlValue(value);
  const name = next();
  params[name] = value;
  const operator = ({ eq: '=', ne: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' } as const)[op];
  return `${column} ${operator} :${name}`;
}

// Registration-time compiler. It accepts only declarative rule data and emits
// constrained SQL; callers must combine this with the entity's scopeFilter.
export function compileSubscriptionRule(input: unknown, entity: LiveEntityRecord): CompiledSubscriptionRule {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('rule must be an object.');
  assertKeys(input, ['resourceKind', 'parent', 'anchor', 'filters', 'select', 'sort', 'boundedResultPolicy'], 'rule');
  assertData(input, 'rule');
  const rule = input as SubscriptionRule;
  if (rule.resourceKind !== entity.name) fail('resourceKind does not match the subscribed collection.');
  if (!rule.boundedResultPolicy || typeof rule.boundedResultPolicy !== 'object' || Array.isArray(rule.boundedResultPolicy)) fail('boundedResultPolicy is required.');
  assertKeys(rule.boundedResultPolicy, ['limit', 'overflowMarker'], 'boundedResultPolicy');
  const { limit, overflowMarker = true } = rule.boundedResultPolicy;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) fail('boundedResultPolicy.limit must be an integer from 1 through 1000.');
  assertData(overflowMarker, 'overflowMarker');
  const declaredFields = fieldsOf(entity);
  if (rule.select !== undefined && !Array.isArray(rule.select)) {
    if (!rule.select || typeof rule.select !== 'object' || Array.isArray(rule.select)) fail('select must be an array or fields object.');
    assertKeys(rule.select, ['fields'], 'select');
  }
  const selectInput = Array.isArray(rule.select) ? rule.select : rule.select?.fields;
  const select = selectInput === undefined ? [...declaredFields] : selectInput;
  if (!Array.isArray(select) || select.length === 0 || new Set(select).size !== select.length || !select.every((field) => typeof field === 'string' && declaredFields.has(field))) {
    fail('select must contain unique declared fields.');
  }
  if (rule.sort === null) fail('sort must be an array.');
  const sort = rule.sort ?? [];
  if (!Array.isArray(sort) || sort.length > 8) fail('sort must contain at most eight entries.');
  for (const entry of sort) {
    if (!entry || typeof entry !== 'object' || !declaredFields.has(entry.field) || (entry.direction !== undefined && entry.direction !== 'asc' && entry.direction !== 'desc')) {
      fail('sort references an unknown field or direction.');
    }
    assertKeys(entry, ['field', 'direction'], 'sort entry');
  }
  const params: Record<string, unknown> = {};
  let index = 0;
  const next = () => `rule${index++}`;
  if (rule.parent === null || rule.anchor === null) fail('parent and anchor must be filters when supplied.');
  if (rule.filters === null || (rule.filters !== undefined && !Array.isArray(rule.filters))) fail('filters must be an array.');
  const filters = [rule.parent, rule.anchor, ...(rule.filters ?? [])].filter((filter): filter is SubscriptionFilter => filter !== undefined);
  if (filters.length > 32) fail('filters must contain at most 32 entries.');
  const where = filters.map((filter) => compileFilter(filter, declaredFields, params, next));
  const selected = new Set(['id', ...select]);
  const order = [...sort, ...(sort.some((entry) => entry.field === 'id') ? [] : [{ field: 'id', direction: 'asc' as const }])];
  // Row admission may reject arbitrary matching rows, so the bounded result is
  // applied after admission rather than letting inaccessible rows consume slots.
  const sql = `SELECT ${[...selected].map((field) => `t0.${quote(field)}`).join(', ')} FROM ${quote(entity.name)} AS t0${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order.map((entry) => `t0.${quote(entry.field)} ${entry.direction === 'desc' ? 'DESC' : 'ASC'}`).join(', ')}`;
  return Object.freeze({ resourceKind: entity.name, sql, params: Object.freeze(params), select: Object.freeze([...selected]), sort: Object.freeze(order), boundedResultPolicy: Object.freeze({ limit, overflowMarker }) });
}

/// <reference types="node" />

import type { IncomingMessage, ServerResponse } from 'node:http';

export interface WorkbenchStatement {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface WorkbenchDatabase {
  prepare(sql: string): WorkbenchStatement;
  exec(sql: string): void;
  txn?<T>(fn: () => Promise<T>): Promise<T>;
  begin?(): void;
  commit?(): void;
  rollback?(): void;
  upsert?(options: {
    table: string;
    keyColumns: string[];
    columns?: string[];
    values: Record<string, unknown>;
  }): void;
}

export type PrincipalType = 'user' | 'link' | 'system' | 'apiKey' | 'anonymous';

export interface Principal {
  readonly type: PrincipalType;
  readonly id: string | null;
  readonly attributes: Readonly<Record<string, unknown>>;
}

export function principal(options?: {
  type?: PrincipalType;
  id?: string | null;
  attributes?: Record<string, unknown>;
}): Principal;
export const anonymous: Principal;

export interface HandlerReq {
  body: Record<string, unknown>;
  params: Record<string, string>;
  query: Record<string, string>;
  principal: Principal;
  raw: IncomingMessage;
  headers: IncomingMessage['headers'];
  method: string;
  url: string;
  [key: string]: unknown;
}

export interface HandlerRes {
  status(code: number): this;
  json(value: unknown): this;
  send(value?: unknown): this;
  sendStatus(code: number): this;
  render(name: string, data?: Record<string, unknown>): this;
  stream(
    response: Response | ReadableStream<Uint8Array>,
    options?: { buffering?: boolean },
  ): Promise<this>;
  raw: ServerResponse;
}

export type Handler = (
  req: HandlerReq,
  res: HandlerRes,
  next?: (error?: unknown) => void,
) => void | Promise<void>;

export type Gate = (principal: Principal) => boolean;
export function requireUser(): Gate;
export function allowAnonymous(): Gate;

export interface EntityTarget {
  readonly name: string;
}

export interface RouteBuilder {
  get(path: string, ...handlers: Array<Gate | Handler>): this;
  post(path: string, ...handlers: Array<Gate | Handler>): this;
  patch(path: string, ...handlers: Array<Gate | Handler>): this;
  delete(path: string, ...handlers: Array<Gate | Handler>): this;
  mount(path: string, target: EntityTarget | RouteBuilder | Handler): this;
  use(path: string, target: EntityTarget | RouteBuilder | Handler): this;
  resource(): this;
}

export interface FieldDescriptor<Value = unknown> {
  readonly kind: string;
  readonly type?: string;
  readonly target?: string | WorkbenchEntity;
  readonly access?: (context: unknown) => unknown;
  can(check: (context: unknown) => unknown): FieldDescriptor<Value>;
  readonly __value?: Value;
  readonly [property: string]: unknown;
}

declare const queryPredicateBrand: unique symbol;
export interface QueryPredicate {
  readonly [queryPredicateBrand]: true;
}

export interface FieldHandle<Value = unknown, Key extends PropertyKey = string> {
  readonly fieldName: Key;
  is(value: Value): QueryPredicate;
  in(values: readonly Value[]): QueryPredicate;
  isNull(): QueryPredicate;
  gte(value: Value): QueryPredicate;
  lte(value: Value): QueryPredicate;
  matches(query: string): QueryPredicate;
}

export type EntityFields<Row extends object> = Readonly<{
  [Key in keyof Row]-?: FieldHandle<Row[Key], Key>;
}> & Readonly<{ id: FieldHandle<string, 'id'> }>;

export type FieldOptions<Value = unknown> = Readonly<{
  optional?: boolean;
  readonly?: boolean;
  default?: Value | (() => Value);
  validate?: (value: Value) => true | string;
  oneOf?: readonly Value[];
  indexed?: string;
  role?: string | readonly string[];
}> & Readonly<Record<string, unknown>>;

export interface TextFieldFactory {
  (options?: FieldOptions<string>): FieldDescriptor<string>;
  crdt(options?: FieldOptions<string>): FieldDescriptor<string>;
}

export const text: TextFieldFactory;
export function boolean(options?: FieldOptions<boolean>): FieldDescriptor<boolean>;
export function date(options?: FieldOptions<Date | number | string>): FieldDescriptor<Date>;
export function number(options?: FieldOptions<number>): FieldDescriptor<number>;
export function json<Value = unknown>(shape?: unknown, options?: FieldOptions<Value>): FieldDescriptor<Value>;
export function ref(
  target: string | WorkbenchEntity,
  options?: FieldOptions<string> & { role?: string | readonly string[] },
): FieldDescriptor<string>;
export function hash(options?: FieldOptions<string>): FieldDescriptor<string>;
export function blob(options?: FieldOptions<string>): FieldDescriptor<string>;
export function link(options?: Readonly<Record<string, unknown>>): FieldDescriptor<Record<string, unknown>>;
export function map<Value = unknown>(
  value: FieldDescriptor<Value>,
  options?: FieldOptions<Record<string, Value>>,
): FieldDescriptor<Record<string, Value>>;
export function list<Value = unknown>(
  value: FieldDescriptor<Value>,
  options?: FieldOptions<Value[]>,
): FieldDescriptor<Value[]>;
export function log<Value = unknown>(
  value: FieldDescriptor<Value>,
  options?: FieldOptions<Value[]>,
): FieldDescriptor<Value[]>;
export function ephemeral<Value = unknown>(
  value: FieldDescriptor<Value>,
  options?: FieldOptions<Value>,
): FieldDescriptor<Value>;
export function state<Value extends string = string>(
  options: Readonly<Record<string, unknown>>,
): FieldDescriptor<Value>;
export function computed<Value = unknown>(
  compute: (row: Readonly<Record<string, unknown>>) => Value,
  options?: Readonly<Record<string, unknown>>,
): FieldDescriptor<Value>;
export interface ProjectedFieldFactory {
  async<Value = unknown>(options: {
    compute: (
      row: Readonly<Record<string, unknown>>,
      context: { readonly db: WorkbenchDatabase },
    ) => Value | Promise<Value>;
    from?: string | readonly string[];
  }): FieldDescriptor<Value>;
}
export const projected: ProjectedFieldFactory;
export const raster: { crdt(options?: Readonly<Record<string, unknown>>): FieldDescriptor<unknown> };
export const polyline: { crdt(options?: Readonly<Record<string, unknown>>): FieldDescriptor<unknown> };
export function vector(dimensions: number, options?: FieldOptions<number[]>): FieldDescriptor<number[]>;

export interface Capability {
  readonly capability: string;
}
export const read: Capability;
export const write: Capability;
export const subscribe: Capability;
export const admin: Capability;
export interface OwnerFieldFactory {
  (): FieldDescriptor<string>;
  only(): readonly ScopeClause[];
}
export const owner: OwnerFieldFactory;

export type GrantDecision =
  | { readonly granted: true; readonly capabilities: readonly Capability[] }
  | { readonly granted: false; readonly reason: unknown };
export function grant(...capabilities: Capability[]): GrantDecision;
export function deny(reason?: unknown): GrantDecision;

export interface ScopeClause {
  readonly predicate?: (context: unknown) => boolean;
  can(check: (context: unknown) => GrantDecision): ScopeClause;
  readonly [property: string]: unknown;
}
export type ScopePredicate = (context: unknown) => unknown;
export function scope(predicate: ScopePredicate): ScopeClause;
export const everyone: ScopePredicate;
export const never: ScopePredicate;
export function anyOf(...clauses: ScopePredicate[]): ScopePredicate;
export function inherit(
  parent: WorkbenchEntity,
  options: { via: string },
): ScopePredicate;

export interface ActionHandle<Payload = Record<string, unknown>> {
  readonly brand: 'action';
  readonly type: string;
  readonly __payload?: Payload;
}
export interface EventHandle<State = unknown, Payload = Record<string, unknown>> {
  readonly brand: 'event';
  readonly type: string;
  readonly reduce: (state: State, payload: Payload) => State;
}
export function action<Payload = Record<string, unknown>>(type: string): ActionHandle<Payload>;
export function event<State = unknown, Payload = Record<string, unknown>>(
  type: string | Readonly<Record<string, unknown>>,
  reduce: (state: State, payload: Payload) => State,
): EventHandle<State, Payload>;

export interface CommittedEvent<Data = unknown> {
  readonly type: string;
  readonly scope: string;
  readonly seq: number;
  readonly actionId: string;
  readonly committedAt: string;
  readonly data: Data;
}
export interface DispatchRequest<Payload = Record<string, unknown>> {
  actionId: string;
  type: string;
  payload: Payload;
  principal: Principal;
  scope?: string;
}
export interface DispatchResult<Event extends CommittedEvent = CommittedEvent> {
  granted: boolean;
  events: Event[];
  replayed?: boolean;
}

export interface WorkbenchEntity<Row extends object = Record<string, unknown>> {
  readonly name: string;
  readonly fields: Readonly<Record<string, FieldDescriptor>>;
  readonly field: EntityFields<Row>;
  readonly verbs: Readonly<Record<string, ActionHandle | EventHandle>>;
  readonly routes?: (routes: RouteBuilder, entity: BoundWorkbenchEntity<Row>) => unknown | Promise<unknown>;
  readonly [member: string]: unknown;
}

type SelectedKeys<Row extends object, Fields extends readonly FieldHandle<any, any>[]> =
  Extract<Fields[number] extends FieldHandle<any, infer Key> ? Key : never, keyof Row>;

export interface QueryBuilder<Row extends object> extends PromiseLike<Row[]> {
  sort(field: FieldHandle, direction?: 'asc' | 'desc'): this;
  limit(count: number): this;
  select<Fields extends readonly FieldHandle<any, any>[]>(
    ...fields: Fields
  ): QueryBuilder<Pick<Row, SelectedKeys<Row, Fields>>>;
}

export interface HydratedRows<Row extends object> extends Array<Row> {
  select<Fields extends readonly FieldHandle<any, any>[]>(
    ...fields: Fields
  ): Array<Pick<Row, SelectedKeys<Row, Fields>>>;
}

export interface BoundWorkbenchEntity<Row extends object = Record<string, unknown>>
  extends WorkbenchEntity<Row> {
  create(payload: Partial<Row> & Record<string, unknown>): Row;
  insert(payload: Partial<Row> & Record<string, unknown>): Row;
  delete(id: string): void;
  findById(id: string, principal?: Principal): Row | null;
  findOne(where: QueryPredicate): Row | null;
  findAll(): HydratedRows<Row>;
  findAll(where: QueryPredicate): QueryBuilder<Row>;
  getOrFail(id: string, principal?: Principal): Row;
}

export type EntityDeclaration<Row extends object> = Readonly<Record<string, unknown>> & {
  routes?: (routes: RouteBuilder, entity: BoundWorkbenchEntity<Row>) => unknown | Promise<unknown>;
  grant?: ScopeClause | ScopePredicate | GrantDecision | ((context: unknown) => GrantDecision);
};
export function entity<Row extends object = Record<string, unknown>>(
  name: string,
  declaration?: EntityDeclaration<Row>,
): WorkbenchEntity<Row>;

export function membership(
  entity: WorkbenchEntity | BoundWorkbenchEntity,
  roles: Readonly<Record<string, unknown>>,
): WorkbenchEntity;

export function inc(value: number): Readonly<{ kind: 'inc'; value: number }>;
export function dec(value: number): Readonly<{ kind: 'dec'; value: number }>;
export const self: Readonly<Record<string, unknown>>;
export function many(
  target: WorkbenchEntity,
  options: { over: FieldDescriptor },
): Readonly<Record<string, unknown>>;
export const effect: {
  anyOf(...triggers: readonly unknown[]): symbol;
};
export const now: Readonly<{ kind: 'deferred'; resolve: 'commit-instant' }>;

export interface ScheduleTrigger { readonly kind: string; readonly [key: string]: unknown }
export const schedule: {
  at(field: FieldDescriptor, options?: Readonly<Record<string, unknown>>): ScheduleTrigger;
  after(field: FieldDescriptor, delay: number | string, options?: Readonly<Record<string, unknown>>): ScheduleTrigger;
};
export const tick: {
  hz(value: number, options?: Readonly<Record<string, unknown>>): ScheduleTrigger;
  every(delay: number | string, options?: Readonly<Record<string, unknown>>): ScheduleTrigger;
};
export function simulate(options: Readonly<Record<string, unknown>>): unknown;

export interface WorkbenchOptions {
  db?: string | WorkbenchDatabase;
  entities?: readonly WorkbenchEntity[];
  port?: number;
  env?: string;
  session?: { durationMs?: number };
  viewsDir?: string;
  migrations?: readonly Readonly<{ version: number; up(db: WorkbenchDatabase): void }>[];
  jobs?: Readonly<Record<string, unknown>>;
  blobs?: Readonly<Record<string, unknown>>;
  log?: Readonly<Record<string, unknown>>;
}

export interface WorkbenchApp extends RouteBuilder {
  readonly db?: WorkbenchDatabase;
  readonly routes: readonly unknown[];
  readonly config: Readonly<Record<string, unknown>>;
  readonly jobs?: unknown;
  readonly blobs?: unknown;
  readonly ready?: Promise<WorkbenchApp>;
  mount(path: string, target: EntityTarget | RouteBuilder | Handler): this;
  use(path: string, target: EntityTarget | RouteBuilder | Handler): this;
  entity<Row extends object>(declaration: WorkbenchEntity<Row>): BoundWorkbenchEntity<Row>;
  entity<Row extends object = Record<string, unknown>>(name: string): BoundWorkbenchEntity<Row>;
  register(...declarations: readonly (WorkbenchEntity | readonly WorkbenchEntity[])[]): this;
  auth(options?: { identifyBy?: readonly string[] }): this;
  static(prefix: string, directory: string): this;
  prepareSchema(): Promise<this>;
  ddl(): Promise<this>;
  dispatch<Payload = Record<string, unknown>>(
    request: DispatchRequest<Payload>,
  ): Promise<DispatchResult>;
  listen(port?: number, options?: unknown): this;
}

export function router(options?: { mergeParams?: boolean }): RouteBuilder;

export const User: WorkbenchEntity;
export const Session: WorkbenchEntity;
export const Inbox: WorkbenchEntity;
export const Credential: WorkbenchEntity;
export const Invitation: WorkbenchEntity;
export const ApiKey: WorkbenchEntity;
export const TwoFactor: WorkbenchEntity;

export default function workbench(options?: WorkbenchOptions): WorkbenchApp;

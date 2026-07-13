/// <reference types="node" />

import type { IncomingMessage, Server, ServerResponse } from 'node:http';

export interface WorkbenchStatement {
  run(...params: unknown[]): { changes: number | bigint };
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

export interface UserPrincipal extends Principal {
  readonly type: 'user';
  readonly id: string;
}

export function principal(options: {
  type: 'user';
  id: string;
  attributes?: Record<string, unknown>;
}): UserPrincipal;
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
}

export interface EntityRouteBuilder extends RouteBuilder {
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
  target: string | WorkbenchEntity<any>,
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
export function log<Entry extends Record<string, FieldDescriptor> = Record<string, never>>(
  entry?: Entry,
): FieldDescriptor<unknown[]>;
export function ephemeral<Cells extends Record<string, FieldDescriptor> = Record<string, never>>(
  cells?: Cells,
): FieldDescriptor<unknown>;
export interface StateFieldFactory {
  (options?: Readonly<Record<string, unknown>>): FieldDescriptor<string>;
  transition<From extends string, To extends string>(
    from: From,
    to: To,
  ): Readonly<{
    brand: 'state-transition-handle';
    from: From;
    to: To;
    readonly type: `transition:${From}->${To}`;
    toString(): string;
  }>;
}
export const state: StateFieldFactory;
export interface ComputedFieldFactory {
  <Value = unknown>(
    options: { compute: (row: Readonly<Record<string, unknown>>) => Value },
  ): FieldDescriptor<Value>;
  stored<Value = unknown>(
    options: { compute: (row: Readonly<Record<string, unknown>>) => Value },
  ): FieldDescriptor<Value>;
}
export const computed: ComputedFieldFactory;
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
export interface InheritDirective {
  readonly inherit: WorkbenchEntity<any>;
  readonly via: string;
}
export function inherit(
  parent: WorkbenchEntity<any>,
  options: { via: string },
): InheritDirective;

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
  deduped: boolean;
}

export interface BatchAction<Payload = Record<string, unknown>> {
  readonly type: string;
  readonly payload: Payload;
  readonly scope?: string;
}

export type BatchActionFactory<Action extends BatchAction = BatchAction> =
  () => readonly Action[];

export interface WorkbenchEntity<Row extends object = Record<string, unknown>> {
  readonly name: string;
  readonly fields: Readonly<Record<string, FieldDescriptor>>;
  readonly field: EntityFields<Row>;
  readonly verbs: Readonly<Record<string, ActionHandle | EventHandle>>;
  readonly routes?: (routes: EntityRouteBuilder, entity: BoundWorkbenchEntity<Row>) => unknown | Promise<unknown>;
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
  routes?: (routes: EntityRouteBuilder, entity: BoundWorkbenchEntity<Row>) => unknown | Promise<unknown>;
  grant?: ScopeClause | ScopePredicate | InheritDirective | GrantDecision | ((context: unknown) => GrantDecision);
};
export function entity<Row extends object = Record<string, unknown>>(
  name: string,
  declaration?: EntityDeclaration<Row>,
): WorkbenchEntity<Row>;

export function membership<Row extends object>(
  entity: BoundWorkbenchEntity<Row>,
  roles: Readonly<Record<string, unknown>>,
): BoundWorkbenchEntity<Row>;
export function membership<Row extends object>(
  entity: WorkbenchEntity<Row>,
  roles: Readonly<Record<string, unknown>>,
): WorkbenchEntity<Row>;

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

export interface ScheduleOptions<Row extends object = Record<string, unknown>> {
  readonly key?: string;
  readonly while?: (context: { readonly fields: EntityFields<Row> }) => QueryPredicate;
  readonly when?: (context: { readonly row: Readonly<Row & { id: string }> }) => boolean;
  readonly with?: Partial<Row> | null | (
    (context: { readonly row: Readonly<Row & { id: string }> }) => Partial<Row>
  );
}
export type ScheduleTrigger<Row extends object = Record<string, unknown>> =
  | (ScheduleOptions<Row> & Readonly<{
      kind: 'schedule.at';
      field: FieldDescriptor;
    }>)
  | (ScheduleOptions<Row> & Readonly<{
      kind: 'schedule.after';
      field: FieldDescriptor;
      delay: number;
    }>)
  | (ScheduleOptions<Row> & Readonly<{
      kind: 'tick.hz';
      hertz: number;
    }>)
  | (ScheduleOptions<Row> & Readonly<{
      kind: 'tick.every';
      intervalMs: number;
    }>);
export const schedule: {
  at<Row extends object = Record<string, unknown>>(field: FieldDescriptor, options?: ScheduleOptions<Row>): ScheduleTrigger<Row>;
  after<Row extends object = Record<string, unknown>>(field: FieldDescriptor, delay: number | string, options?: ScheduleOptions<Row>): ScheduleTrigger<Row>;
};
export const tick: {
  hz<Row extends object = Record<string, unknown>>(value: number, options?: ScheduleOptions<Row>): ScheduleTrigger<Row>;
  every<Row extends object = Record<string, unknown>>(delay: number | string, options?: ScheduleOptions<Row>): ScheduleTrigger<Row>;
};
export function simulate(options: Readonly<Record<string, unknown>>): unknown;

export interface WorkbenchLog {
  readonly level: number;
  readonly channels: Readonly<Record<string, string>>;
  readonly format: string;
  trace(channel: string, message: string, context?: Record<string, unknown>): void;
  debug(channel: string, message: string, context?: Record<string, unknown>): void;
  info(channel: string, message: string, context?: Record<string, unknown>): void;
  warn(channel: string, message: string, context?: Record<string, unknown>): void;
  error(channel: string, message: string, context?: Record<string, unknown>): void;
}

export interface WorkbenchClock {
  add(options: {
    name: string;
    intervalMs: number;
    fn: () => void | Promise<void>;
    delayMs?: number;
  }): { remove(): void };
  stop(): void;
}

export interface RateLimitWindow {
  windowMs: number;
  max: number;
}

export interface ListenOptions {
  principalOf?: (request: IncomingMessage) => Principal;
  onListening?: () => void;
  env?: string;
  rateLimit?: { ip: RateLimitWindow; session?: RateLimitWindow };
  csp?: string;
  hsts?: boolean;
  cors?: { origins: readonly string[] };
  requestLog?: boolean;
  blobReapIntervalMs?: number;
  blobReapTtlMs?: number;
  logRetentionDays?: number;
  logRetentionIntervalMs?: number;
}

export interface WorkbenchOptions {
  db?: string | WorkbenchDatabase;
  entities?: readonly WorkbenchEntity<any>[];
  port?: number;
  env?: string;
  requireEnv?: readonly string[];
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
  readonly entities: ReadonlyMap<string, BoundWorkbenchEntity<any>>;
  readonly log: WorkbenchLog;
  readonly clock: WorkbenchClock;
  readonly port?: number;
  readonly httpServer?: Server;
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
  batch<Action extends BatchAction>(
    actions: readonly Action[] | BatchActionFactory<Action>,
    options?: { principal?: Principal },
  ): Promise<DispatchResult>;
  listen(): this;
  listen(callback: () => void): this;
  listen(options: ListenOptions): this;
  listen(port: number, callback?: () => void): this;
  listen(port: number, options: ListenOptions): this;
}

export function router(options?: { mergeParams?: boolean }): RouteBuilder;

export const User: WorkbenchEntity;
export const Session: WorkbenchEntity;
export const Inbox: WorkbenchEntity;
export const Credential: WorkbenchEntity;
export const Invitation: WorkbenchEntity;
export const ApiKey: WorkbenchEntity;
export const TwoFactor: WorkbenchEntity;

// These helpers are runtime exports of the root module as well as the
// `workbench/server` entry point. Re-export their declarations so both import
// paths describe the same public API.
export {
  SESSION_COOKIE,
  apiKeyPrincipalOf,
  createInvitationApi,
  emailSeam,
  matchRoute,
  noopTransport,
  parseCookies,
  serveStatic,
  sessionCookie,
  sessionPrincipalOf,
  sessionTokenOf,
} from './src/server.js';
export type {
  EmailMessage,
  EmailSeam,
  EmailTransport,
  InvitationApi,
  Invitation as InvitationRecord,
} from './src/server.js';

export default function workbench(options?: WorkbenchOptions): WorkbenchApp;

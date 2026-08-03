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

export type FailureCategory =
  | 'invalid-input'
  | 'denied'
  | 'unknown-action'
  | 'not-found'
  | 'conflict'
  | 'internal';

export const FAILURE_CATEGORIES: readonly [
  'invalid-input',
  'denied',
  'unknown-action',
  'not-found',
  'conflict',
  'internal',
];

export interface WorkbenchFailure {
  readonly category: FailureCategory;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface FailureOutcome {
  readonly ok: false;
  readonly failure: WorkbenchFailure;
}

export function failure(
  category: FailureCategory,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): WorkbenchFailure;
export function failureOutcome(workbenchFailure: WorkbenchFailure): FailureOutcome;
export function isWorkbenchFailure(value: unknown): value is WorkbenchFailure;
export function sanitizeUnexpectedFailure(value?: unknown): WorkbenchFailure;
export function statusForFailure(failure: WorkbenchFailure): 400 | 403 | 404 | 409 | 500;

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
  nullable?: boolean;
  readonly?: boolean;
  immutable?: boolean;
  touch?: boolean;
  default?: Value | (() => Value);
  validate?: (value: Value) => true | string;
  canonicalize?: (value: Value) => Value;
  oneOf?: readonly Value[];
  indexed?: string;
  /** Emit a SQLite foreign key and one-column index for a declaration-bound ref. */
  physical?: boolean;
  role?: string | readonly string[];
}> & Readonly<Record<string, unknown>>;

export interface TextFieldFactory {
  (options?: FieldOptions<string>): FieldDescriptor<string>;
  crdt(options?: FieldOptions<string>): FieldDescriptor<string>;
}

export const text: TextFieldFactory;
export interface AnnotatedTextAnnotationDescriptor {
  readonly kind: 'annotation';
  readonly annotationName: string;
  readonly appliesTo: 'block' | 'block-group';
  readonly cardinality: 'many' | 'one';
  readonly fields: Readonly<Record<string, FieldDescriptor>>;
  readonly actions: readonly AnnotatedTextActionDescriptor[];
  readonly empty: 'delete' | 'orphan';
}
export interface AnnotatedTextProtectingAnnotationDescriptor {
  readonly kind: 'protectingAnnotation';
  readonly annotationName: string;
  readonly fields: Readonly<Record<string, FieldDescriptor>>;
  readonly protects: string | null;
  readonly placeholder: string;
  readonly access: ((context: { readonly is: Record<string, () => Promise<boolean>>; readonly entity: unknown; readonly annotation: unknown }) => unknown) | null;
  readonly actions: readonly AnnotatedTextActionDescriptor[];
  readonly empty: 'delete' | 'orphan';
}
export interface AnnotatedTextMeasurementDescriptor {
  readonly kind: 'measurement';
  readonly measurementName: string;
  readonly extension: string | null;
  readonly formatVersion: number;
  readonly queries: readonly string[];
}
export interface AnnotatedTextActionDescriptor {
  readonly kind: 'annotationAction';
  readonly actionName: string;
}
export function annotation(name: string, options?: {
  appliesTo?: 'block' | 'block-group';
  cardinality?: 'many' | 'one';
  fields?: Record<string, FieldDescriptor>;
  actions?: readonly AnnotatedTextActionDescriptor[];
  empty?: 'delete' | 'orphan';
}): AnnotatedTextAnnotationDescriptor;
export function protectingAnnotation(name: string, options?: {
  fields?: Record<string, FieldDescriptor>;
  protects?: string | null;
  placeholder?: string;
  access?: (context: { readonly is: Record<string, () => Promise<boolean>>; readonly entity: unknown; readonly annotation: unknown }) => unknown;
  actions?: readonly AnnotatedTextActionDescriptor[];
  empty?: 'delete' | 'orphan';
}): AnnotatedTextProtectingAnnotationDescriptor;
export function measurement(name: string, options?: {
  extension?: string | null;
  formatVersion?: number;
  queries?: readonly string[];
}): AnnotatedTextMeasurementDescriptor;
export function annotationAction(name: string): AnnotatedTextActionDescriptor;

export interface AnnotatedTextOptions {
  project: string;
  owner: string;
  block: Record<string, FieldDescriptor>;
  annotations: readonly (AnnotatedTextAnnotationDescriptor | AnnotatedTextProtectingAnnotationDescriptor)[];
  measurements: readonly AnnotatedTextMeasurementDescriptor[];
  capabilities?: Readonly<Record<string, unknown>>;
}

export interface AnnotatedTextAnnotationHandle {
  readonly family: string;
  readonly annotationName: string;
  readonly appliesTo: 'block' | 'block-group';
  readonly cardinality: 'many' | 'one';
  readonly actions: readonly string[];
  readonly empty: 'delete' | 'orphan';
}
export interface AnnotatedTextMeasurementHandle {
  readonly family: string;
  readonly measurementName: string;
  readonly [queryName: string]: string | (() => never);
}
export interface AnnotatedTextCapabilityHandle {
  readonly name: string;
}
export interface AnnotatedTextFieldHandle {
  readonly fieldName: string;
  readonly annotations: Readonly<Record<string, AnnotatedTextAnnotationHandle>>;
  readonly measurements: Readonly<Record<string, AnnotatedTextMeasurementHandle>>;
  readonly capabilities: Readonly<Record<string, AnnotatedTextCapabilityHandle>> | null;
}
export function annotatedText(options: AnnotatedTextOptions): FieldDescriptor<AnnotatedTextFieldHandle>;

export function registerAnnotatedTextContract(contractName: string, contract: { readonly kind: 'measurement' | 'measurement-query' | 'annotation-action' | 'event'; readonly [key: string]: unknown }): void;

export interface AnnotatedTextMeasurementValidationInput {
  readonly version: 1;
  readonly formatVersion: number;
  readonly blockText: string;
  readonly payload: unknown;
}
export interface AnnotatedTextMeasurementPartitionInput extends AnnotatedTextMeasurementValidationInput {
  readonly utf16Offset: number;
}
export interface AnnotatedTextMeasurementPartitionResult {
  readonly version: 1;
  readonly leftPayload: unknown;
  readonly rightPayload: unknown;
}
/** Reserved until Workbench supports structural edit orchestration. */
export type AnnotatedTextMeasurementEditInput = unknown;
/** Reserved until Workbench supports structural edit orchestration. */
export type AnnotatedTextMeasurementEditResult = unknown;
export interface AnnotatedTextMeasurementCombineSide {
  readonly blockText: string;
  readonly payload: unknown;
}
export interface AnnotatedTextMeasurementCombineInput {
  readonly version: 1;
  readonly formatVersion: number;
  readonly blockText: string;
  readonly left: AnnotatedTextMeasurementCombineSide | null;
  readonly right: AnnotatedTextMeasurementCombineSide | null;
}
export interface AnnotatedTextMeasurementCombineResult {
  readonly version: 1;
  readonly payload: unknown;
}
export interface AnnotatedTextStructuralExtensionSpec {
  readonly version: 1;
  readonly validate: (input: AnnotatedTextMeasurementValidationInput) => undefined;
  readonly edit: (input: AnnotatedTextMeasurementEditInput) => AnnotatedTextMeasurementEditResult;
  readonly partition: (input: AnnotatedTextMeasurementPartitionInput) => AnnotatedTextMeasurementPartitionResult;
  readonly combine: (input: AnnotatedTextMeasurementCombineInput) => AnnotatedTextMeasurementCombineResult;
}
export function registerAnnotatedTextStructuralExtension(extensionName: string, spec: AnnotatedTextStructuralExtensionSpec): void;

export interface AnnotatedTextPosition {
  readonly blockId: string;
  readonly offset: number;
  readonly affinity: 'left' | 'right';
}
export interface AnnotatedTextActionAnnotation {
  readonly id: string;
  readonly family: string;
  readonly fields: Readonly<Record<string, unknown>>;
}
export interface AnnotatedTextOneSelection { readonly kind: 'one'; readonly blockGroupId: string; }
export interface AnnotatedTextGroupSelection { readonly kind: 'consecutive' | 'listed'; readonly blockGroupIds: readonly [string, ...string[]]; }
export type AnnotatedTextSelection = AnnotatedTextOneSelection | AnnotatedTextGroupSelection;
interface AnnotatedTextCommandBase {
  readonly id: string;
  readonly mutationId: string;
}
export interface AnnotatedTextInsertCommand extends AnnotatedTextCommandBase {
  readonly kind: 'text.insert';
  readonly at: AnnotatedTextPosition;
  readonly text: string;
}
export interface AnnotatedTextDeleteCommand extends AnnotatedTextCommandBase {
  readonly kind: 'text.delete';
  readonly from: AnnotatedTextPosition;
  readonly to: AnnotatedTextPosition;
}
export interface AnnotatedTextSplitCommand extends AnnotatedTextCommandBase { readonly kind: 'block.split'; readonly at: AnnotatedTextPosition; }
export interface AnnotatedTextMergeCommand extends AnnotatedTextCommandBase { readonly kind: 'block.merge'; readonly leftBlockId: string; readonly rightBlockId: string; }
export interface AnnotatedTextApplyAnnotationCommand extends AnnotatedTextCommandBase { readonly kind: 'annotation.apply'; readonly annotation: { readonly id: string; readonly family: string; readonly fields: Readonly<Record<string, unknown>>; readonly protectedTargetIds?: readonly string[] }; readonly from: AnnotatedTextPosition; readonly to: AnnotatedTextPosition; }
export interface AnnotatedTextDetachAnnotationCommand extends AnnotatedTextCommandBase { readonly kind: 'annotation.detach'; readonly annotationId: string; readonly blockId: string; }
export interface AnnotatedTextContinueBlockCommand extends AnnotatedTextCommandBase { readonly kind: 'block.continue'; readonly at: AnnotatedTextPosition; }
export interface AnnotatedTextSetGroupAssignmentCommand extends AnnotatedTextCommandBase { readonly kind: 'block-group.assignment.set'; readonly selection: AnnotatedTextSelection; readonly annotation: AnnotatedTextActionAnnotation; }
export interface AnnotatedTextClearGroupAssignmentCommand extends AnnotatedTextCommandBase { readonly kind: 'block-group.assignment.clear'; readonly selection: AnnotatedTextSelection; readonly family: string; }
export interface AnnotatedTextSplitAndAssignCommand extends AnnotatedTextCommandBase { readonly kind: 'block.split-and-assign'; readonly at: AnnotatedTextPosition; readonly annotation: AnnotatedTextActionAnnotation; }
export type AnnotatedTextOperationCommand =
  | AnnotatedTextInsertCommand
  | AnnotatedTextDeleteCommand
  | AnnotatedTextSplitCommand
  | AnnotatedTextMergeCommand
  | AnnotatedTextApplyAnnotationCommand
  | AnnotatedTextDetachAnnotationCommand
  | AnnotatedTextContinueBlockCommand
  | AnnotatedTextSetGroupAssignmentCommand
  | AnnotatedTextClearGroupAssignmentCommand
  | AnnotatedTextSplitAndAssignCommand;
export interface AnnotatedTextActionRequest<Payload = unknown> {
  readonly type: string;
  readonly payload: Payload;
}
export function annotatedTextAction(
  entity: WorkbenchEntity,
  field: AnnotatedTextFieldHandle,
  command: AnnotatedTextOperationCommand,
): AnnotatedTextActionRequest;
export interface AnnotatedTextCreateSourceMeasurement {
  readonly family: string;
  readonly payload: unknown;
}
export interface AnnotatedTextCreateSourceBlock {
  readonly text: string;
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly measurements?: readonly AnnotatedTextCreateSourceMeasurement[];
}
export interface AnnotatedTextCreateInput {
  readonly id: string;
  readonly projectId: string;
  readonly ownerId: string;
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly source?: { readonly blocks: readonly AnnotatedTextCreateSourceBlock[] };
}
export function annotatedTextCreateAction(
  entity: WorkbenchEntity,
  field: AnnotatedTextFieldHandle,
  input: AnnotatedTextCreateInput,
): AnnotatedTextActionRequest;
export function annotatedTextRetireAction(entity: WorkbenchEntity, documentId: string): AnnotatedTextActionRequest<{ readonly id: string }>;

export interface AnnotatedTextBlock {
  readonly id: string;
  readonly text: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly annotationIds: readonly string[];
}
export interface AnnotatedTextCanonicalBlock extends AnnotatedTextBlock {
  readonly groupId: string;
}
export interface AnnotatedTextAnnotation {
  readonly id: string;
  readonly family: string;
  readonly fields: Readonly<Record<string, unknown>>;
  /** Principal id of the user who applied this annotation; absent on legacy/interop snapshots that predate attribution. */
  readonly owner?: string;
}
export interface AnnotatedTextMembership {
  readonly annotationId: string;
  readonly blockId: string;
  readonly ordinal: number;
}
export interface AnnotatedTextGroupMembership {
  readonly annotationId: string;
  readonly groupId: string;
  readonly ordinal: number;
}
export interface AnnotatedTextRecipientVisibleBlock {
  readonly kind: 'visible';
  readonly id: string;
  readonly text: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly annotationIds: readonly string[];
}
export interface AnnotatedTextRecipientRestrictedBlock {
  readonly kind: 'restricted';
  readonly id: string;
  readonly placeholder: string;
}
export type AnnotatedTextRecipientBlock = AnnotatedTextRecipientVisibleBlock | AnnotatedTextRecipientRestrictedBlock;
export interface AnnotatedTextRecipientBlockGroup {
  readonly id: string;
  readonly blockIds: readonly string[];
  readonly annotationIds: readonly string[];
}
export interface AnnotatedTextMeasurement {
  readonly id: string;
  readonly blockId: string;
  readonly family: string;
  readonly formatVersion: number;
  readonly payload: unknown;
}
export interface AnnotatedTextDocument {
  readonly version: 1;
  readonly blocks: readonly AnnotatedTextBlock[];
  readonly annotations: readonly AnnotatedTextAnnotation[];
  readonly memberships: readonly AnnotatedTextMembership[];
  readonly measurements: readonly AnnotatedTextMeasurement[];
  readonly capabilities: readonly string[] | null;
}
export interface AnnotatedTextCanonicalDocument {
  readonly kind: 'workbench.annotatedText.canonical'; readonly version: 1;
  readonly blocks: readonly AnnotatedTextCanonicalBlock[];
  readonly annotations: readonly (AnnotatedTextAnnotation & { readonly protectedTargetIds?: readonly string[] })[];
  readonly memberships: readonly AnnotatedTextMembership[];
  readonly groupMemberships: readonly AnnotatedTextGroupMembership[];
  readonly measurements: readonly AnnotatedTextMeasurement[];
  readonly capabilities: readonly [];
}
export interface AnnotatedTextRecipientDocument {
  readonly kind: 'workbench.annotatedText.recipient';
  readonly version: 1;
  readonly blockGroups: readonly AnnotatedTextRecipientBlockGroup[];
  readonly blocks: readonly AnnotatedTextRecipientBlock[];
  readonly annotations: readonly AnnotatedTextAnnotation[];
  readonly memberships: readonly AnnotatedTextMembership[];
  readonly measurements: readonly AnnotatedTextMeasurement[];
  readonly capabilityHints: readonly string[];
}
export interface AnnotatedTextExpectedOwningScope {
  readonly entity: WorkbenchEntity;
  readonly id: string;
}
export type AnnotatedTextRecipientReadResult =
  | { readonly kind: 'snapshot'; readonly document: AnnotatedTextRecipientDocument; readonly owningScopeCursor: number }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'retry' };
export function readAnnotatedTextForRecipient(input: {
  readonly app: WorkbenchApp;
  readonly entity: WorkbenchEntity;
  readonly field: AnnotatedTextFieldHandle;
  readonly documentId: string;
  readonly expectedOwningScope: AnnotatedTextExpectedOwningScope;
  readonly principal: Principal;
}): Promise<AnnotatedTextRecipientReadResult>;
export function exportAnnotatedText(input: {
  readonly app: WorkbenchApp;
  readonly entity: WorkbenchEntity;
  readonly field: AnnotatedTextFieldHandle;
  readonly documentId: string;
  readonly expectedOwningScope: AnnotatedTextExpectedOwningScope;
  readonly principal: Principal;
}): Promise<AnnotatedTextCanonicalDocument>;
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

declare class CapabilityToken<Name extends string> {
  readonly capability: Name;
  #brand: Name;
}
export type Capability<Name extends string = string> = CapabilityToken<Name>;
export const read: Capability<'read'>;
export const write: Capability<'write'>;
export const subscribe: Capability<'subscribe'>;
export const admin: Capability<'admin'>;
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
  /** Caller-owned session identifier recorded with the immutable action receipt. */
  clientId?: string;
  history?: { session: string };
}
export type DispatchResult<Event extends CommittedEvent = CommittedEvent> =
  | {
      readonly ok: true;
      readonly events: readonly Event[];
      readonly deduped: boolean;
    }
  | FailureOutcome;

export interface BatchAction<Payload = Record<string, unknown>> {
  readonly type: string;
  readonly payload: Payload;
  readonly scope?: string;
}

export type BatchActionFactory<Action extends BatchAction = BatchAction> =
  () => readonly Action[];

export type ApplicationHttpCrudVerb = 'create' | 'update' | 'remove';

export interface WorkbenchEntity<Row extends object = Record<string, unknown>> {
  readonly name: string;
  readonly fields: Readonly<Record<string, FieldDescriptor>>;
  readonly indexes: readonly EntityIndexDeclaration<Row>[];
  readonly field: EntityFields<Row>;
  readonly verbs: Readonly<Record<string, ActionHandle | EventHandle>>;
  readonly routes?: (routes: EntityRouteBuilder, entity: BoundWorkbenchEntity<Row>) => unknown | Promise<unknown>;
  readonly applicationHttpActions?: readonly ApplicationHttpCrudVerb[];
  readonly [member: string]: unknown;
}

export type EntityIndexFields<Row extends object> = readonly [keyof Row & string, keyof Row & string, ...(keyof Row & string)[]];
export interface EntityIndexDeclaration<Row extends object> {
  readonly fields: EntityIndexFields<Row>;
  readonly unique: true;
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
  history?: Readonly<{ create?: 'conditional'; update?: 'conditional' }>;
  indexes?: readonly EntityIndexDeclaration<Row>[];
  /** Explicit allowlist of generated CRUD verbs admitted on POST /workbench/actions. */
  applicationHttpActions?: readonly ApplicationHttpCrudVerb[];
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

declare const projectionSourceFieldBrand: unique symbol;
declare const projectionSourceBrand: unique symbol;
declare const principalSnapshotManyBrand: unique symbol;
declare const principalSnapshotObjectBrand: unique symbol;
declare const principalSnapshotDeclarationBrand: unique symbol;

export interface ProjectionSourceField {
  readonly [projectionSourceFieldBrand]: true;
  readonly kind: 'sourceField';
  readonly source: ProjectionSource;
  readonly column: string;
  readonly entityName: string;
  readonly fieldName: string;
}
export interface ProjectionSourceFieldWithDirection extends ProjectionSourceField {
  readonly direction: 'asc' | 'desc';
}

export interface ProjectionSource {
  readonly [projectionSourceBrand]: true;
  readonly kind: 'projectionSource';
  readonly schema: import('./src/server.js').SqliteSchemaResult;
  readonly table: string;
  readonly field: Readonly<Record<string, ProjectionSourceField>>;
}
export function projectionSource(schema: import('./src/server.js').SqliteSchemaResult, table: string): ProjectionSource;

export interface PrincipalSnapshotMany {
  readonly [principalSnapshotManyBrand]: true;
  readonly kind: 'many';
  readonly source: ProjectionSource;
  readonly via: ProjectionSourceField;
  readonly key: ProjectionSourceField;
  readonly select: readonly ProjectionSourceField[];
  readonly orderBy?: readonly ProjectionSourceFieldWithDirection[];
}
export interface PrincipalSnapshotObject {
  readonly [principalSnapshotObjectBrand]: true;
  readonly kind: 'object';
  readonly shape: Readonly<Record<string, PrincipalSnapshotMany>>;
}
export interface PrincipalSnapshotDeclaration {
  readonly [principalSnapshotDeclarationBrand]: true;
  readonly kind: 'principalSnapshot';
  readonly name: string;
  readonly principalType: Exclude<PrincipalType, 'anonymous'>;
  readonly output: PrincipalSnapshotObject;
  readonly fields: Readonly<Record<string, PrincipalSnapshotMany>>;
}
export interface PrincipalSnapshotGrammar {
  (name: string, options: { principalType: Exclude<PrincipalType, 'anonymous'>; output: PrincipalSnapshotObject }): PrincipalSnapshotDeclaration;
  object(shape: Readonly<Record<string, PrincipalSnapshotMany>>): PrincipalSnapshotObject;
  many(source: ProjectionSource, options: { via: ProjectionSourceField; key: ProjectionSourceField; select: readonly ProjectionSourceField[]; orderBy?: readonly ProjectionSourceFieldWithDirection[] }): PrincipalSnapshotMany;
  select(...handles: readonly ProjectionSourceField[]): readonly ProjectionSourceField[];
  orderBy(handle: ProjectionSourceField, direction?: 'asc' | 'desc'): ProjectionSourceFieldWithDirection;
}
export const principalSnapshot: PrincipalSnapshotGrammar;

export interface PrincipalSnapshotTransaction {
  readonly db: WorkbenchDatabase;
  invalidate(declaration: PrincipalSnapshotDeclaration, recipient: { type: Exclude<PrincipalType, 'anonymous'>; id: string }): void;
}

export interface PrincipalSnapshotTransactionApi {
  transaction<T>(callback: (tx: PrincipalSnapshotTransaction) => T): Promise<T>;
}

export function principalSnapshotScope(options: { declaration: string; principal: { type: Exclude<PrincipalType, 'anonymous'>; id: string } }): string;

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
}

export interface SnapshotSelect { readonly kind: 'select'; }
export interface SnapshotOrder { readonly kind: 'orderBy'; }
export interface SnapshotOutput { readonly kind: 'object'; }
export interface SnapshotRelation { readonly kind: 'one' | 'many' | 'keyed' | 'count'; }
export interface SnapshotRelated { readonly kind: 'related'; }
export interface SnapshotUser { readonly kind: 'user'; }
export interface SnapshotTombstones { readonly kind: 'tombstones'; }
export interface SnapshotDeclaration { readonly kind: 'snapshot'; readonly anchor: WorkbenchEntity; readonly output: SnapshotOutput; }
export interface SnapshotGrammar {
  <Row extends object>(anchor: WorkbenchEntity<Row>, options: { output: SnapshotOutput; tombstones?: SnapshotTombstones }): SnapshotDeclaration;
  object(shape: Readonly<Record<string, SnapshotSelect | SnapshotRelation | SnapshotUser>>): SnapshotOutput;
  select(...fields: readonly FieldHandle[]): SnapshotSelect;
  one<Row extends object>(entity: WorkbenchEntity<Row>, options: { via: FieldHandle; select?: SnapshotSelect; include?: SnapshotOutput; output?: SnapshotSelect | SnapshotOutput; orderBy?: SnapshotOrder }): SnapshotRelation;
  many<Row extends object>(entity: WorkbenchEntity<Row>, options: { via: FieldHandle; require?: SnapshotRelated; select?: SnapshotSelect; include?: SnapshotOutput; output?: SnapshotSelect | SnapshotOutput; orderBy?: SnapshotOrder }): SnapshotRelation;
  keyed<Row extends object>(entity: WorkbenchEntity<Row>, options: { via: FieldHandle; require?: SnapshotRelated; select?: SnapshotSelect; include?: SnapshotOutput; output?: SnapshotSelect | SnapshotOutput; orderBy?: SnapshotOrder }): SnapshotRelation;
  count<Row extends object>(entity: WorkbenchEntity<Row>, options: { via: FieldHandle; require?: SnapshotRelated }): SnapshotRelation;
  related(childRef: FieldHandle, options: { via: FieldHandle }): SnapshotRelated;
  user(options: { via: FieldHandle }): SnapshotUser;
  tombstones<Row extends object>(target: WorkbenchEntity<Row>, options: { entity: WorkbenchEntity; entityId: FieldHandle; scopeId?: FieldHandle; targetScopeId?: FieldHandle; targetScope?: WorkbenchEntity; terminalScope?: WorkbenchEntity; kind: FieldHandle; state: FieldHandle; kindValue: string; hidden: readonly string[] }): SnapshotTombstones;
  include(shape: Readonly<Record<string, SnapshotSelect | SnapshotRelation>>): SnapshotOutput;
  orderBy(field: FieldHandle, direction?: 'asc' | 'desc'): SnapshotOrder;
}
export const snapshot: SnapshotGrammar;
export const object: SnapshotGrammar['object'];
export const one: SnapshotGrammar['one'];
export const keyed: SnapshotGrammar['keyed'];
export const select: SnapshotGrammar['select'];
export const include: SnapshotGrammar['include'];
export const orderBy: SnapshotGrammar['orderBy'];
export const count: SnapshotGrammar['count'];
export const related: SnapshotGrammar['related'];
export const user: SnapshotGrammar['user'];
export const tombstones: SnapshotGrammar['tombstones'];

export interface AppLiveDeliveryOptions {
  /** Uses the same authenticated principal shape as the application kernel. */
  principalOf(request: IncomingMessage): Principal | Promise<Principal>;
  path?: string;
  maxSubscriptions?: number;
  /** Constrained relational snapshots; no event, SQL, or callback access. */
  snapshots?: readonly SnapshotDeclaration[];
  /** Read-only principal-anchored recipient snapshots. */
  principalSnapshots?: readonly PrincipalSnapshotDeclaration[];
  maxCatchupEvents?: number;
}

export interface WorkbenchOptions {
  db?: string | WorkbenchDatabase;
  /** Declares physical SQLite tables. Named entity main tables are never generated. */
  schema?: import('./src/server.js').SqliteSchemaResult;
  entities?: readonly WorkbenchEntity<any>[];
  actions?: readonly RegisteredAction<any, RegisteredProjection>[];
  port?: number;
  env?: string;
  requireEnv?: readonly string[];
  session?: { durationMs?: number };
  viewsDir?: string;
  /** Map a coarse recovery scope to the entity row that owns its authorization. */
  resolveScope?: (
    scope: string,
  ) => { entity: string; id: string | number } | null | Promise<{ entity: string; id: string | number } | null>;
  /** Build a coarse snapshot after its resolved anchor row has been authorized. */
  scopeSnapshot?: (
    scope: string,
    principal: Principal,
    anchor: { entity: string; id: string; row: Record<string, unknown> },
  ) => unknown | Promise<unknown>;
  history?: DurableHistoryDescriptor;
  migrations?: readonly Readonly<{ version: number; up(db: WorkbenchDatabase): void }>[];
  jobs?: Readonly<Record<string, unknown>>;
  blobs?: Readonly<Record<string, unknown>>;
  log?: Readonly<Record<string, unknown>>;
  /** Pending-blob sweep cadence in milliseconds; must be finite and > 0. */
  blobReapIntervalMs?: number;
  /** Pending-blob minimum age in milliseconds; must be finite and >= 0. */
  blobReapTtlMs?: number;
  /** Durable-log retention in days; finite and >= 0, with 0 disabling retention. */
  logRetentionDays?: number;
  /** Durable-log sweep cadence in milliseconds; must be finite and > 0. */
  logRetentionIntervalMs?: number;
  operationalConsumers?: readonly OperationalConsumer<unknown, any>[];
  blobLifecycle?: BlobLifecycleOptions;
}

export type PendingBlobKey = string & { readonly __brand: 'PendingBlobKey' };
export type PendingBlobClaim = Readonly<{ pendingKey: PendingBlobKey; claimToken: string & { readonly __brand: 'PendingBlobClaimToken' } }>;
export type ClaimedBlobRef = Readonly<{ blobId: string & { readonly __brand: 'ClaimedBlobId' } }>;
export type DeclaredClaimedBlob = Readonly<{ blobId: ClaimedBlobRef['blobId']; resourceId: string; sha256: string; md5: string; byteLength: number; mediaType: string | null }>;
export type DeclaredClaimedBlobs = Readonly<Record<string, DeclaredClaimedBlob>>;
export type DeclaredBlobField = Readonly<{
  actionName: string;
  field: string;
  resourceField: string;
  purgeActionName?: string;
  /** Package-written paths beneath the owning event's data; handlers must leave each leaf absent. */
  canonicalEventMetadata?: Readonly<{ byteLength?: readonly string[]; mediaType?: readonly string[] }>;
}>;
export type BlobLifecycleOptions = Readonly<{ fields: readonly DeclaredBlobField[]; pendingTtlMs: number; adoptedRecoveryTtlMs: number }>;

export type OperationalConsumerName = string & { readonly __brand: 'OperationalConsumerName' };
export type OperationalDeclarationVersion = string & { readonly __brand: 'OperationalDeclarationVersion' };
export type OperationalIdempotencyKey = string & { readonly __brand: 'OperationalIdempotencyKey' };
export type OperationalCommittedMetadata = Readonly<{
  committedEventId: string;
  actionId: string;
  scopeId: string;
  eventType: string;
  committedAt: string;
}>;
export type OperationalEventSpec<TFields extends object, TPayload> = Readonly<{
  eventType: string;
  fields: readonly (keyof TFields)[];
  project(fields: Readonly<TFields>, metadata: OperationalCommittedMetadata): TPayload;
}>;
export function defineOperationalEvent<TFields extends object, TPayload>(spec: OperationalEventSpec<TFields, TPayload>): OperationalEventSpec<TFields, TPayload>;
export type OperationalDelivery<TPayload> = Readonly<{
  metadata: OperationalCommittedMetadata;
  payload: TPayload;
  idempotencyKey: OperationalIdempotencyKey;
}>;
export type OperationalRetry = Readonly<{ kind: 'retry'; afterMs: number }> | Readonly<{ kind: 'terminal'; code: string; detail: string }>;
export type OperationalEffectResult = Readonly<{ kind: 'ack' }> | OperationalRetry;
export type OperationalConsumer<TPayload, TFields extends object = object> = Readonly<{
  name: OperationalConsumerName;
  declarationVersion: OperationalDeclarationVersion;
  projectionId: string;
  effectId: string;
  event: OperationalEventSpec<TFields, TPayload>;
  idempotencyKey(delivery: Readonly<Omit<OperationalDelivery<TPayload>, 'idempotencyKey'>>): OperationalIdempotencyKey;
  handle(delivery: OperationalDelivery<TPayload>): Promise<OperationalEffectResult>;
}>;
export function operationalConsumer<TPayload, TFields extends object>(consumer: OperationalConsumer<TPayload, TFields>): OperationalConsumer<TPayload, TFields>;

export interface OrdinaryRegisteredProjection {
  readonly eventTypes: readonly string[];
  readonly privateFact?: never;
  apply(event: CommittedEvent, db: WorkbenchDatabase, context?: Readonly<{ claimedBlobs?: DeclaredClaimedBlobs }>): void;
}
export interface PrivateFactRegisteredProjection<PrivateFact = { readonly before: unknown; readonly after: unknown }> {
  readonly eventTypes: readonly string[];
  readonly privateFact: true;
  apply(event: CommittedEvent, db: WorkbenchDatabase, context: Readonly<{ privateFact: PrivateFact; claimedBlobs?: DeclaredClaimedBlobs }>): void;
}
export type RegisteredProjection = OrdinaryRegisteredProjection | PrivateFactRegisteredProjection;

export interface ErasureEventTargetV1 {
  readonly scope: string;
  readonly seq: number;
  readonly actionId: string;
  readonly eventType: string;
  readonly committedAt: string;
  readonly eventDataDigest: string;
}
export interface ErasureActionTargetV1 {
  readonly scope: string;
  readonly actionId: string;
  readonly historyOrder: number;
  readonly committedAt: string;
  readonly receiptDigest: string;
  readonly events: readonly ErasureEventTargetV1[];
}
export interface ErasureCensusRuleV1 {
  readonly kind: 'action' | 'event';
  readonly type: string;
  readonly disposition: 'target' | 'retain';
  readonly identityPointers: readonly string[];
}
export interface ErasureDirectiveV1 {
  readonly kind: 'workbench.erasure';
  readonly version: 1;
  readonly owningScope: string;
  readonly subject: string;
  readonly actions: readonly ErasureActionTargetV1[];
  readonly census: { readonly version: 1; readonly rules: readonly ErasureCensusRuleV1[] };
}
export interface ErasureDirectivePreparationV1 {
  readonly kind: 'workbench.erasure.preparation';
  readonly version: 1;
  readonly owningScope: string;
  readonly subject: string;
  readonly census: ErasureDirectiveV1['census'];
}
export interface ErasurePreparationWrites {
  insert(table: string, values: Readonly<Record<string, unknown>>): number | bigint;
  update(table: string, values: Readonly<Record<string, unknown>>, where: Readonly<Record<string, unknown>>): number | bigint;
  delete(table: string, where: Readonly<Record<string, unknown>>): number | bigint;
}
export interface ErasurePreparationReads {
  /** Read matching rows using an AND of bound equality filters. */
  find(table: string, where: Readonly<Record<string, unknown>>): readonly Readonly<Record<string, unknown>>[];
}
export interface ErasurePreparationContext<Payload = Record<string, unknown>> {
  readonly action: Readonly<{
    readonly id: string;
    readonly type: string;
    readonly scope: string;
    readonly operation: 'erasure';
    /** Canonical origin transaction commit timestamp, captured once for this dispatch. */
    readonly committedAt: string;
    readonly payload: Payload;
    readonly principal: Pick<Principal, 'type' | 'id'>;
  }>;
  readonly subject: Readonly<{ readonly owningScope: string; readonly id: string }>;
}
export interface RegisteredActionCommit {
  readonly events: readonly Readonly<{ type: string; scope: string; data: unknown }>[];
  readonly directive?: ErasureDirectiveV1 | ErasureDirectivePreparationV1;
  readonly privateFact?: { readonly before: unknown; readonly after: unknown };
  readonly effects?: readonly PostCommitEffectDeclaration[];
}
export interface PostCommitEffectDeclaration {
  readonly file: string;
  readonly operation: string;
  readonly key?: string;
  readonly verification: string;
  readonly payload?: unknown;
}
export function postCommitEffect(input: PostCommitEffectDeclaration): Readonly<PostCommitEffectDeclaration>;
export interface AuthorizedRowRequirement {
  readonly entity: string | WorkbenchEntity<any>;
  readonly id: string;
  readonly capability: typeof read | typeof write | typeof subscribe | typeof admin;
}
export function authorizedRows<Payload = Record<string, unknown>>(
  resolve: (context: { payload: Payload; principal: Principal }) => readonly AuthorizedRowRequirement[] | Promise<readonly AuthorizedRowRequirement[]>,
): RegisteredAction<Payload>['authorize'];
export interface PostCommitEffectId {
  readonly scope: string;
  readonly actionId: string;
  readonly file: string;
  readonly operation: string;
  readonly ordinal: number;
}
export interface ClaimedPostCommitEffect {
  readonly id: PostCommitEffectId;
  readonly key: string;
  readonly verification: string;
  readonly payload: unknown;
  readonly fence: number;
  readonly leaseUntil: number;
}
export interface PostCommitEffectRunner {
  claim(workerId: string): ClaimedPostCommitEffect | null;
  heartbeat(id: PostCommitEffectId, workerId: string, fence: number): boolean;
  complete(id: PostCommitEffectId, workerId: string, fence: number, result: { verification: string }): { accepted: boolean; noop?: boolean; verification?: false };
  fail(id: PostCommitEffectId, workerId: string, fence: number, result?: { retryAt?: number }): { accepted: boolean };
  reconstruct(): { inserted: number };
}
export function erasureDirective(input: ErasureDirectiveV1): Readonly<ErasureDirectiveV1>;
export function erasureDirectivePreparation(
  input: Pick<ErasureDirectiveV1, 'owningScope' | 'subject' | 'census'>,
): Readonly<ErasureDirectivePreparationV1>;

export interface RegisteredAction<
  Payload = Record<string, unknown>,
  Projection extends RegisteredProjection = OrdinaryRegisteredProjection,
> {
  readonly type: string;
  authorize(context: {
    type: string;
    payload: Payload;
    principal: Principal;
    db: WorkbenchDatabase;
  }): boolean | Promise<boolean>;
  handler(context: {
    readonly actionId: string;
    payload: Payload;
    principal: Principal;
    db: WorkbenchDatabase;
    now: string;
    /** Exact caller-selected owning scope for this dispatch. */
    readonly scope: string;
    /** Package-attested staged-blob identity and metadata; transaction-bound and never serialized. */
    readonly claimedBlobs?: DeclaredClaimedBlobs;
    /** Present only for a Workbench-owned inverse/redo dispatch; never serialized. */
    readonly history?: Readonly<{
      readonly operation: 'undo' | 'redo';
      readonly input: unknown;
    }>;
  }): readonly Readonly<{ type: string; scope: string; data: unknown }>[] | RegisteredActionCommit | Promise<readonly Readonly<{ type: string; scope: string; data: unknown }>[] | RegisteredActionCommit>;
  readonly projections?: readonly Projection[];
  readonly history?: { readonly cursor?: 'eligible' | 'excluded' };
  /** Privileged durable-pipeline erasure directive; requires history.cursor excluded. */
  readonly erasure?: true | Readonly<{
    /** Exact application-owned tables the preparation callback may mutate. */
    tables: readonly string[];
    /** Exact application-owned tables the preparation callback may query. */
    readTables?: readonly string[];
    /** Runs once inside the origin transaction, after exact manifest validation and before erasure. */
    prepare(context: Readonly<{
      /** Transaction-bound, write-only access to application-owned tables. */
      writes: ErasurePreparationWrites;
      /** Transaction-bound equality reads over explicitly declared application tables. */
      reads: ErasurePreparationReads;
      manifest: Readonly<ErasureDirectiveV1>;
      /** Canonical, non-persisted identity of the originating erasure action and declared subject. */
      context: Readonly<ErasurePreparationContext<Payload>>;
    }>): void | Promise<void>;
  }>;
}

/** Serializes all application writes and drains them during shutdown. */
export interface WriteQueue {
  run<T>(fn: () => Promise<T> | T): Promise<T>;
  close(): Promise<void>;
  readonly depth: number;
  readonly running: boolean;
  readonly closed: boolean;
  /** True when the current async context holds this queue's writer slot. This does not start a SQLite transaction. */
  readonly owned: boolean;
}

export interface WorkbenchApp extends RouteBuilder {
  readonly db?: WorkbenchDatabase;
  readonly routes: readonly unknown[];
  readonly config: Readonly<Record<string, unknown>>;
  readonly entities: ReadonlyMap<string, BoundWorkbenchEntity<any>>;
  readonly actions: readonly RegisteredAction<any, RegisteredProjection>[];
  readonly log: WorkbenchLog;
  readonly clock: WorkbenchClock;
  readonly writeQueue: WriteQueue;
  readonly port?: number;
  readonly httpServer?: Server;
  readonly jobs?: unknown;
  readonly postCommitEffects?: PostCommitEffectRunner;
  readonly blobs?: unknown;
  readonly principalSnapshots?: PrincipalSnapshotTransactionApi;
  readonly history?: DurableHistoryRuntime;
  resolveScope?: WorkbenchOptions['resolveScope'];
  scopeSnapshot?: WorkbenchOptions['scopeSnapshot'];
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
  /** Attach package-owned HTTP/SSE delivery to this app before start or listen. */
  attachLiveDelivery(options: AppLiveDeliveryOptions): this;
  start(): Promise<this>;
  onShutdown(
    name: string,
    hook: () => void | Promise<void>,
    options?: { timeoutMs?: number },
  ): void;
  shutdown(): Promise<void>;
  dispatch<Payload = Record<string, unknown>>(
    request: DispatchRequest<Payload>,
  ): Promise<DispatchResult>;
  /** Rebuild explicitly private-fact projections from private facts and receipt event references. */
  replayPrivateFactProjections(): Promise<{ projected: number }>;
  batch<Action extends BatchAction>(
    actions: readonly Action[] | BatchActionFactory<Action>,
    options?: { principal?: Principal; clientId?: string; scope?: string },
  ): Promise<DispatchResult>;
  listen(): this;
  listen(callback: () => void): this;
  listen(options: ListenOptions): this;
  listen(port: number, callback?: () => void): this;
  listen(port: number, options: ListenOptions): this;
}

export function router(options?: { mergeParams?: boolean }): RouteBuilder;

export type HistoryOperation = 'read' | 'undo' | 'redo';

export interface HistoryAction {
  readonly scope: string;
  readonly order: number;
  readonly actionId: string;
  readonly type: string | null;
  readonly payload: unknown;
  readonly principal: string | null;
  readonly session: string | null;
  readonly operation: 'action' | 'undo' | 'redo';
  readonly committedAt: string;
  readonly events: readonly CommittedEvent[];
}

export interface HistoryAccess {
  readonly operation: HistoryOperation;
  readonly scope: string;
  readonly principal: Principal;
  readonly session?: string;
  readonly action?: HistoryAction;
}

export interface HistoryActionRequest<Payload = Record<string, unknown>, Input = unknown> {
  readonly type: string;
  readonly payload?: Payload;
  readonly scope?: string;
  /** Opaque transaction-bound handler input. Workbench never serializes this value. */
  readonly input?: Input;
}

export interface HistoryActionBatchRequest {
  readonly actions: readonly HistoryActionRequest[];
}

export type HistoryTranslationRequest = HistoryActionRequest | HistoryActionBatchRequest;

export interface DurableHistoryDescriptor {
  readonly authorize: (access: HistoryAccess) => boolean | Promise<boolean>;
  readonly actions: Readonly<Record<string, Readonly<{
    readonly inverse: (context: {
    readonly action: HistoryAction;
    /** Canonical erasure-aware material, supplied only to server-side translation. */
    readonly fact: Readonly<{ readonly before: unknown; readonly after: unknown }>;
    readonly principal: Principal;
    readonly session: string;
  }) => HistoryTranslationRequest | Promise<HistoryTranslationRequest>;
    readonly redo: (context: {
    readonly action: HistoryAction;
    /** Canonical erasure-aware material, supplied only to server-side translation. */
    readonly fact: Readonly<{ readonly before: unknown; readonly after: unknown }>;
    readonly principal: Principal;
    readonly session: string;
  }) => HistoryTranslationRequest | Promise<HistoryTranslationRequest>;
  }>>>;
}

export function durableHistory(options: DurableHistoryDescriptor): DurableHistoryDescriptor;

export interface HistorySessionOptions {
  readonly scope: string;
  readonly session: string;
  readonly principal: Principal;
  /** Stable retry identity. Required for mutation; omitted only by cursor reads. */
  readonly actionId: string;
  /** Cursor revision returned by cursor(); stale revisions fail with conflict. */
  readonly revision: string;
}

export interface DurableHistoryRuntime {
  cursor(options: Omit<HistorySessionOptions, 'actionId' | 'revision'>): Promise<Readonly<{ undo: number; redo: number; revision: string }>>;
  undo(options: HistorySessionOptions): Promise<DispatchResult & { readonly empty?: boolean }>;
  redo(options: HistorySessionOptions): Promise<DispatchResult & { readonly empty?: boolean }>;
}

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

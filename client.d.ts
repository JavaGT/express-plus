// Type definitions for workbench-client — the browser-side live sync SDK.
//
// Source of truth: public/workbench-client.mjs
// Projection for TypeScript app authors. JS users see no change.

import type { AnnotatedTextFieldHandle } from './index.js';

// ---------------------------------------------------------------------------
// LiveChannel — WebSocket transport layer
// ---------------------------------------------------------------------------

export class LiveChannel {
  constructor(baseUrl: string, options?: LiveChannelOptions);

  subscribe(
    entity: string,
    id: string | number,
    optionsOrOnEvent?: SubscribeOptions | OnEvent,
    maybeOnEvent?: OnEvent,
  ): Promise<{ currentSeq: number }>;

  subscribeScope(
    scope: string,
    optionsOrOnEvent?: ScopeSubscribeOptions | OnEvent,
    maybeOnEvent?: OnEvent,
  ): Promise<{ currentSeq: number }>;

  unsubscribe(entity: string, id: string | number): Promise<void>;
  unsubscribeScope(scope: string): Promise<void>;
  updateCaret(input: CaretUpdate): boolean;
  clearCaret(input: CaretClear): boolean;
  close(): void;
  onConnectionChange(cb: (status: ConnectionStatus) => void): () => void;
}

export interface LiveChannelOptions {
  maxBackoff?: number;
  backoffBase?: number;
  socketFactory?: (url: string) => WebSocket;
}

export type FieldInterest = Record<string, true>;

export type PaceSelection =
  | { profile: string }
  | { coalesce: { window: number; by: string } };

export interface SubscriptionCheckpoint {
  currentSeq: number;
}

export interface SubscribeOptions {
  fields?: FieldInterest;
  pace?: PaceSelection;
  carets?: string[];
  onCaret?: OnCaret;
  onCheckpoint?: (checkpoint: SubscriptionCheckpoint) => void;
}

export interface ScopeSubscribeOptions {
  interest?: {
    entity?: string;
    id?: string | number;
    fields?: FieldInterest;
    pace?: PaceSelection;
    carets?: string[];
  };
  fields?: FieldInterest;
  pace?: PaceSelection;
  carets?: string[];
  onCaret?: OnCaret;
  onCheckpoint?: (checkpoint: SubscriptionCheckpoint) => void;
}

export type ConnectionStatus = 'connected' | 'disconnected' | 'reconnecting';

export type OnEvent = (envelope: WsEnvelope) => void;
export type OnCaret = (frame: AnnotatedTextCaretFrame) => void;

export interface CaretUpdate {
  entity: string;
  id: string;
  field: string;
  blockId: string;
  offset: number;
}

export interface CaretClear {
  entity: string;
  id: string;
  field: string;
}

export type AnnotatedTextCaretFrame = AnnotatedTextCaretUpsert | AnnotatedTextCaretRemove;

export interface AnnotatedTextCaretUpsert {
  type: 'annotated-text-caret';
  version: 1;
  entity: string;
  id: string;
  field: string;
  change: { op: 'upsert'; value: AnnotatedTextVisibleCaret | AnnotatedTextRestrictedCaret };
}

export interface AnnotatedTextCaretRemove {
  type: 'annotated-text-caret';
  version: 1;
  entity: string;
  id: string;
  field: string;
  change: { op: 'remove'; presence: string };
}

export interface AnnotatedTextVisibleCaret {
  kind: 'caret';
  presence: string;
  blockId: string;
  offset: number;
}

export interface AnnotatedTextRestrictedCaret {
  kind: 'edge';
  presence: string;
  blockId: string;
  edge: 'start' | 'end';
}

// ---------------------------------------------------------------------------
// Wire protocol envelopes (server → client)
// ---------------------------------------------------------------------------

export type WsEnvelope =
  | WsSubscribedEnvelope
  | WsUnsubscribedEnvelope
  | WsErrorEnvelope
  | WsEventEnvelope;

export interface WsSubscribedEnvelope {
  type: 'subscribed';
  requestId?: number | string;
  scope?: string;
  entity?: string;
  id?: string | number;
  currentSeq: number;
}

export interface WsUnsubscribedEnvelope {
  type: 'unsubscribed';
  scope?: string;
  entity?: string;
  id?: string | number;
}

export interface WsErrorEnvelope {
  type: 'error';
  requestId?: number | string;
  failure: WorkbenchFailure;
}

export class WorkbenchFailureError extends Error {
  readonly failure: WorkbenchFailure;
  constructor(failure: WorkbenchFailure);
}

export interface WsEventEnvelope {
  type: 'event';
  entity?: string;
  id?: string | number;
  seq: number;
  seqSpan: [number, number];
  event: { type: string; data?: unknown; actionId?: string };
  delta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// LiveList — single-document live state
// ---------------------------------------------------------------------------

export class LiveList<Row extends Record<string, unknown> = Record<string, unknown>> {
  constructor(config: LiveListConfig);

  get state(): Row | null;
  get cursor(): number;
  get ready(): Promise<void>;

  subscribe(): Promise<void>;
  onRender(cb: (state: Row | null) => void): () => void;
  close(): Promise<void>;
}

export interface LiveListConfig {
  entity: string;
  id: string | number;
  channel: LiveChannel;
  fetchImpl?: typeof globalThis.fetch;
  snapshotUrl: (entity: string, id: string | number) => string;
  eventsSinceUrl: (entity: string, id: string | number, cursor: number) => string;
  fields?: FieldInterest;
  pace?: PaceSelection;
  maxBufferedEvents?: number;
  resyncBackoffBase?: number;
  maxResyncBackoff?: number;
}

// ---------------------------------------------------------------------------
// REST contract types
// ---------------------------------------------------------------------------

export interface SnapshotResponse<Row> {
  snapshot: Row;
  seq: number;
}

export interface EventsSinceResponse {
  events: Array<{
    seq: number;
    type: string;
    data?: unknown;
    actionId?: string;
  }>;
}

export interface StaleResponse<Row> {
  resync: 'stale';
  reason: string;
}

// ---------------------------------------------------------------------------
// decodeResult — HTTP response decoder
// ---------------------------------------------------------------------------

export type FailureCategory =
  | 'invalid-input'
  | 'denied'
  | 'unknown-action'
  | 'not-found'
  | 'conflict'
  | 'internal';

export interface WorkbenchFailure {
  readonly category: FailureCategory;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type DecodeResult<T = unknown> =
  | { ok: true; httpStatus: number; value: T | undefined }
  | { ok: false; httpStatus: number; failure: WorkbenchFailure }
  | { ok: false; httpStatus: number; error: string };

export function decodeResult<T = unknown>(res: Response): Promise<DecodeResult<T>>;

// ---------------------------------------------------------------------------
// createLiveStore — client SDK store
// ---------------------------------------------------------------------------

export interface LiveStoreConfig {
  baseUrl: string;
  name: string;
  path: string;
  channel?: LiveChannel;
  fetchImpl?: typeof globalThis.fetch;
  replicaState?: TextReplicaState;
}

export interface TextReplicaState {
  reserve(document: string, generate: (reservation: { actor: string; counter: number; lamport: number; frontier: Array<[string, number]>; epoch: string | null }) => unknown): Promise<TextOutboxRecord>;
  head(document: string): Promise<TextOutboxRecord | null>;
  commit(document: string, counter: number): Promise<void>;
  block(document: string, counter: number, failure: WorkbenchFailure): Promise<void>;
  reconcile(document: string, observation: { epoch?: string; frontier: Array<[string, number]>; lamport: number }): Promise<TextOutboxRecord[]>;
}

export interface TextOutboxRecord {
  operation: unknown;
  actionId: string;
  counter: number;
  replica: string;
  body: string;
  status: 'pending' | 'blocked';
  failure: WorkbenchFailure | null;
}

export function createIndexedDbReplicaState(options?: { indexedDB?: IDBFactory; database?: string }): TextReplicaState;

export type DispatchResult =
  | {
      ok: true;
      status: 'committed';
      opId: string;
      id?: string | number;
      row?: unknown;
      value?: unknown;
    }
  | {
      ok: false;
      status: 'failed-rolled-back';
      opId: string;
      failure: WorkbenchFailure;
    }
  | {
      ok: false;
      status: 'outcome-unknown';
      opId: string;
      deliveryError: { message: string };
    };

export type TextDispatchResult = DispatchResult
  | {
      ok: false;
      status: 'failed-rolled-back';
      opId: null;
      failure: WorkbenchFailure;
    }
  | {
      ok: false;
      status: 'queued';
      opId: string;
      waitingFor: string;
    }
  | {
      ok: false;
      status: 'blocked';
      opId: string;
      failure: WorkbenchFailure | null;
    };

export interface OverlayStatus {
  status: 'pending' | 'confirmed';
  kind: 'create' | 'update' | 'remove';
  error: string | null;
  opId: string;
}

export interface PendingCreateEntry {
  opId: string;
  id: string | number | null;
  kind: 'create';
  optimistic: Record<string, unknown>;
  status: 'pending';
  row: null;
  confirmedSeq: null;
}

export interface LiveStore<Row extends Record<string, unknown> = Record<string, unknown>> {
  subscribe: (id: string | number, options?: SubscribeOptions) => LiveList<Row>;
  dispatch: (type: string, payload: Record<string, unknown>) => Promise<DispatchResult>;
  create: (payload: Record<string, unknown>) => Promise<DispatchResult>;
  update: (id: string | number, payload: Record<string, unknown>) => Promise<DispatchResult>;
  remove: (id: string | number) => Promise<DispatchResult>;
  apply: (id: string | number, field: string, operation: unknown) => Promise<DispatchResult>;
  text: (id: string | number, field: string) => {
    insert(input: { at: number; text: string }): Promise<TextDispatchResult>;
    delete(input: { start: number; end: number }): Promise<TextDispatchResult>;
  };
  retryText: (id: string | number, field: string) => Promise<TextDispatchResult>;
  action: (actionType: string, config: { method: string; path: string }) => (body?: unknown) => Promise<DispatchResult>;
  close: () => void;
  overlayFor: (id: string | number) => Row | null;
  overlayStatusFor: (id: string | number) => OverlayStatus | null;
  pendingCreates: () => PendingCreateEntry[];
  onRender: (cb: () => void) => () => void;
  [key: string]: unknown;
}

export function createLiveStore<Row extends Record<string, unknown> = Record<string, unknown>>(
  config: LiveStoreConfig,
): LiveStore<Row>;

// ---------------------------------------------------------------------------
// createLiveDeliverySession — recipient-envelope delivery and recovery
// ---------------------------------------------------------------------------

export interface LiveDeliveryEventEnvelope {
  readonly type: 'event';
  readonly seq: number;
  readonly seqSpan?: readonly [number, number];
  readonly event: { readonly type: string; readonly data?: unknown; readonly actionId?: string };
  readonly delta?: Readonly<Record<string, unknown>>;
}

export interface LiveDeliveryResyncEnvelope {
  readonly type: 'resync';
  readonly seq: number;
  readonly reason: string;
}

export type LiveDeliveryEnvelope = LiveDeliveryEventEnvelope | LiveDeliveryResyncEnvelope;

export type LiveDeliveryBootstrap<Snapshot> =
  | { kind: 'snapshot'; snapshot: Snapshot; cursor: number }
  | { kind: 'catchup'; envelopes: readonly LiveDeliveryEnvelope[]; cursor: number }
  | { kind: 'revoked'; reason?: unknown };

export interface LiveDeliverySubscription {
  close?: () => void;
}

export interface LiveDeliverySessionConfig<Snapshot, Payload = unknown> {
  bootstrap(input: { after?: number; mode: 'snapshot' | 'catchup' }): Promise<LiveDeliveryBootstrap<Snapshot>>;
  subscribe(input: {
    after: number;
    deliver: (envelopes: readonly LiveDeliveryEnvelope[]) => Promise<void>;
    revoke: (reason?: unknown) => void;
    closed: () => void;
  }): Promise<LiveDeliverySubscription>;
  validateSnapshot(snapshot: unknown): Snapshot;
  /** Omit for a snapshot-only (opaque-resync) composite stream. */
  fold?: (snapshot: Snapshot, envelope: LiveDeliveryEventEnvelope) => Snapshot;
  optimistic?: (snapshot: Snapshot, action: { actionId: string; type: string; payload: Payload }) => Snapshot;
  sendAction(action: { actionId: string; type: string; payload: Payload }): Promise<{ ok?: boolean; value?: unknown; failure?: unknown; error?: unknown } | void>;
  createActionId?: () => string;
}

export interface LiveDeliverySession<Snapshot, Payload = unknown> {
  readonly snapshot: Snapshot | null;
  readonly cursor: number;
  readonly status: 'bootstrapping' | 'recovering' | 'catching-up' | 'live' | 'unavailable' | 'revoked';
  readonly ready: Promise<void>;
  dispatch(type: string, payload: Payload): Promise<ScopeDispatchResult>;
  reconnect(): Promise<void>;
  operations(): Array<{ opId: string; actionId: string; action: { actionId: string; type: string; payload: Payload }; status: 'pending'; error: unknown }>;
  pendingCount(): number;
  subscribe(listener: (snapshot: Snapshot | null) => void): () => void;
  close(): void;
}

export function createLiveDeliverySession<Snapshot, Payload = unknown>(
  config: LiveDeliverySessionConfig<Snapshot, Payload>,
): LiveDeliverySession<Snapshot, Payload>;

export interface LiveDeliveryHttpSessionConfig<Snapshot, Payload = unknown> {
  baseUrl: string;
  scope: string;
  validateSnapshot: (snapshot: unknown) => Snapshot;
  fold?: (snapshot: Snapshot, envelope: LiveDeliveryEventEnvelope) => Snapshot;
  optimistic?: (snapshot: Snapshot, action: { actionId: string; type: string; payload: Payload }) => Snapshot;
  sendAction: LiveDeliverySessionConfig<Snapshot, Payload>['sendAction'];
  fetchImpl?: typeof globalThis.fetch;
  eventSourceFactory?: (url: string, options: EventSourceInit) => EventSource;
  createActionId?: () => string;
}

export function createLiveDeliveryHttpSession<Snapshot, Payload = unknown>(
  config: LiveDeliveryHttpSessionConfig<Snapshot, Payload>,
): LiveDeliverySession<Snapshot, Payload>;

// ---------------------------------------------------------------------------
// createScopeLiveStore — composite scope projection
// ---------------------------------------------------------------------------

export interface ScopeEvent {
  scope: string;
  seq: number;
  seqSpan: [number, number];
  type: string;
  data?: unknown;
  actionId?: string;
  committedAt?: string;
  delta?: Record<string, unknown>;
}

export interface ScopeAction<Payload = unknown> {
  actionId: string;
  scope: string;
  type: string;
  payload: Payload;
}

export type ScopeDispatchReceipt =
  | { ok: true; cursor?: number; seq?: number; value?: unknown }
  | { ok: false; failure?: unknown; error?: unknown };

export interface ScopeOperation<Payload = unknown> {
  opId: string;
  actionId: string;
  action: ScopeAction<Payload>;
  status: 'pending' | 'failed';
  error: unknown;
  delivered: boolean;
  confirmedCursor: number | null;
  echoCursor: number | null;
}

export type ScopeDispatchResult =
  | { ok: true; status: 'committed'; opId: string; value?: unknown }
  | { ok: false; status: 'failed-rolled-back'; opId: string; failure: unknown };

export interface ScopeLiveStoreConfig<Snapshot> {
  baseUrl: string;
  scope: string;
  validateSnapshot: (snapshot: unknown) => Snapshot;
  fold: (snapshot: Snapshot, event: ScopeEvent) => Snapshot;
  optimistic?: (snapshot: Snapshot, action: ScopeAction) => Snapshot;
  sendAction: (action: ScopeAction) => Promise<ScopeDispatchReceipt | void>;
  channel?: LiveChannel;
  fetchImpl?: typeof globalThis.fetch;
  snapshotUrl?: string;
  eventsSinceUrl?: (cursor: number) => string;
  createActionId?: () => string;
  resyncBackoffBase?: number;
  maxResyncBackoff?: number;
}

export interface ScopeLiveStore<Snapshot> {
  readonly snapshot: Snapshot | null;
  readonly cursor: number;
  readonly ready: Promise<void>;
  dispatch(type: string, payload: unknown): Promise<ScopeDispatchResult>;
  operations(): ScopeOperation[];
  pendingCount(): number;
  failedCount(): number;
  discardFailed(opId: string): void;
  subscribe(listener: (snapshot: Snapshot) => void): () => void;
  close(): void;
}

export function createScopeLiveStore<Snapshot>(config: ScopeLiveStoreConfig<Snapshot>): ScopeLiveStore<Snapshot>;

// ---------------------------------------------------------------------------
// createAuthClient — login/logout
// ---------------------------------------------------------------------------

export interface AuthClientConfig {
  baseUrl: string;
  fetchImpl?: typeof globalThis.fetch;
}

export interface LoginResult {
  user: { id: string; username: string };
}

export interface AuthClient {
  login(username: string, password: string): Promise<LoginResult>;
  logout(): Promise<{ ok: boolean }>;
}

export function createAuthClient(config?: AuthClientConfig): AuthClient;

// ---------------------------------------------------------------------------
// materializeAnnotatedTextSnapshot — browser snapshot materialization
// ---------------------------------------------------------------------------

export interface AnnotatedTextVisibleBlock {
  readonly kind: 'visible';
  readonly id: string;
  readonly text: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly annotationIds: readonly string[];
}

export interface AnnotatedTextRestrictedBlock {
  readonly kind: 'restricted';
  readonly id: string;
  readonly placeholder: string;
}

export type AnnotatedTextBlock = AnnotatedTextVisibleBlock | AnnotatedTextRestrictedBlock;

export interface AnnotatedTextAnnotation {
  readonly id: string;
  readonly family: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

export interface AnnotatedTextMembership {
  readonly annotationId: string;
  readonly blockId: string;
  readonly ordinal: number;
}

export interface AnnotatedTextMeasurement {
  readonly id: string;
  readonly blockId: string;
  readonly family: string;
  readonly formatVersion: number;
  readonly payload: unknown;
}

export interface AnnotatedTextDocument {
  readonly kind: 'workbench.annotatedText.recipient';
  readonly version: 1;
  readonly blocks: readonly AnnotatedTextBlock[];
  readonly annotations: readonly AnnotatedTextAnnotation[];
  readonly memberships: readonly AnnotatedTextMembership[];
  readonly measurements: readonly AnnotatedTextMeasurement[];
  readonly capabilities: readonly string[] | null;
}

export function materializeAnnotatedTextSnapshot(
  snapshot: Record<string, unknown>,
  declaration: AnnotatedTextFieldHandle,
): AnnotatedTextDocument;

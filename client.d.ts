// Type definitions for workbench-client — the browser-side live sync SDK.
//
// Source of truth: public/workbench-client.mjs
// Projection for TypeScript app authors. JS users see no change.

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
  onCheckpoint?: (checkpoint: SubscriptionCheckpoint) => void;
}

export interface ScopeSubscribeOptions {
  interest?: {
    entity?: string;
    id?: string | number;
    fields?: FieldInterest;
    pace?: PaceSelection;
  };
  fields?: FieldInterest;
  pace?: PaceSelection;
  onCheckpoint?: (checkpoint: SubscriptionCheckpoint) => void;
}

export type ConnectionStatus = 'connected' | 'disconnected' | 'reconnecting';

export type OnEvent = (envelope: WsEnvelope) => void;

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
}

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

/// <reference types="node" />

import type {
  BoundWorkbenchEntity,
  EntityDeclaration,
  Principal,
  UserPrincipal,
  Handler,
  WorkbenchEntity,
  WorkbenchDatabase,
  WorkbenchStatement,
} from '../index.d.ts';
export type { WorkbenchDatabase, WorkbenchStatement, UserPrincipal } from '../index.d.ts';
export type { PostCommitEffectRunner } from '../index.d.ts';
export function createPostCommitEffectRunner(options: {
  db: WorkbenchDatabase;
  leaseMs?: number;
  now?: () => number;
}): import('../index.d.ts').PostCommitEffectRunner;

export type OperationalFailure = Readonly<{
  consumer: import('../index.d.ts').OperationalConsumerName;
  scopeId: string;
  committedEventId: string;
  declarationFingerprint: string;
  code: string;
  detail: string;
  status: 'terminal';
}>;
export interface OperationalConsumerAdmin {
  listFailures(consumer: import('../index.d.ts').OperationalConsumerName): Promise<readonly OperationalFailure[]>;
  retryFailure(failure: Pick<OperationalFailure, 'consumer' | 'scopeId' | 'committedEventId'>): Promise<void>;
}
export function operationalConsumerAdmin(workbench: import('../index.d.ts').WorkbenchApp): OperationalConsumerAdmin;

export type PendingBlobKey = string & { readonly __brand: 'PendingBlobKey' };
export type PendingBlobClaim = Readonly<{ pendingKey: PendingBlobKey; claimToken: string & { readonly __brand: 'PendingBlobClaimToken' } }>;
export type ClaimedBlobRef = Readonly<{ blobId: string & { readonly __brand: 'ClaimedBlobId' } }>;
export type DeclaredClaimedBlob = import('../index.d.ts').DeclaredClaimedBlob;
export type DeclaredClaimedBlobs = import('../index.d.ts').DeclaredClaimedBlobs;
export type StagePendingBlobRequest = Readonly<{ scopeId: string; resourceId: string; bytes: Uint8Array | AsyncIterable<Uint8Array>; mediaType?: string }>;
export type StagedPendingBlob = Readonly<{ claim: PendingBlobClaim; pendingKey: PendingBlobKey; byteLength: number; contentDigest: string }>;
export interface PendingBlobStager { stage(request: StagePendingBlobRequest): Promise<StagedPendingBlob>; }
export function pendingBlobStager(workbench: import('../index.d.ts').WorkbenchApp, authenticatedPrincipal: Principal): PendingBlobStager;
export function readClaimedBlob(workbench: import('../index.d.ts').WorkbenchApp, blobId: ClaimedBlobRef['blobId']): Buffer;
export type ClaimedBlobLifecycleState =
  | Readonly<{ kind: 'available'; readRange(range?: readonly [number, number]): Buffer }>
  | Readonly<{ kind: 'pending' }>
  | Readonly<{ kind: 'failed' }>
  | Readonly<{ kind: 'missing' }>;
export interface ClaimedBlobLifecycle {
  inspect(blobId: string): ClaimedBlobLifecycleState;
  reconcile(): Promise<void>;
}
export function claimedBlobLifecycle(workbench: import('../index.d.ts').WorkbenchApp): ClaimedBlobLifecycle;
export type DeclaredBlobField = import('../index.d.ts').DeclaredBlobField;
export function declaredBlobField(field: DeclaredBlobField): DeclaredBlobField;

// ---------------------------------------------------------------------------
// Framework table names (derived from DDL generators)
// ---------------------------------------------------------------------------

export const frameworkTableNames: readonly string[];

export function declaredTableNames(
  entities: readonly WorkbenchEntity<any>[],
): readonly string[];

/** Reject SQL that references a framework-owned table (FROM/JOIN/INTO/UPDATE/TABLE/USING). */
export function assertNoFrameworkTableSql(sql: string): void;

// ---------------------------------------------------------------------------
// Job types — both raw rows and the parsed runtime shape
// ---------------------------------------------------------------------------

export interface JobRow {
  id: string;
  kind: string;
  payload: unknown;
  status: 'queued' | 'claimed' | 'running' | 'completed' | 'failed' | 'cancelled';
  enqueuedAt: number;
  workerId: string | null;
  claimedAt: number | null;
  leaseUntil: number | null;
  scope: string | null;
  progress: number;
  stage: string | null;
  attempts: number;
  availableAt: number | null;
  // S5/A5 machine attribution persisted on the _Job row: the canonical
  // principal key and the normalized allowlist of the enqueue-time machine
  // principal (both null when the job is unattributed). Survives restart and
  // separate worker processes.
  principalKey: string | null;
  operations: readonly string[] | null;
}

export type SubmitResultOk =
  | { accepted: true; noop?: boolean }
  | { accepted: true; retried: true; attempts: number }
  | { accepted: true; deadLettered: true; attempts: number };

export type CancelJobResult = JobRow | { terminal: true } | { forbidden: true } | null;

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

export interface Migration {
  version: number;
  up(db: WorkbenchDatabase): void;
}

// ---------------------------------------------------------------------------
// Blob store
// ---------------------------------------------------------------------------

/** Durability of a byte store: `durable` bytes survive a process restart; `ephemeral` bytes live only within the owning process. */
export type ByteStoreDurability = 'durable' | 'ephemeral';

/** Consistency tag a backend declares for its byte storage. `single-node-strong` is the only tag shipped. */
export type ByteStoreConsistency = 'single-node-strong';

/** A byte store's closed, queryable declaration of what it guarantees. A backend must declare honestly and never overstate it. */
export interface ByteStoreCapabilities {
  readonly durability: ByteStoreDurability;
  readonly atomicPromotion: boolean;
  readonly rangeSupport: boolean;
  readonly deleteVerification: boolean;
  readonly consistency: ByteStoreConsistency;
}

/**
 * The byte-store contract — what `createBlobStore`'s `bytes` option must
 * provide, and what any conforming backend (fs, memory, or a future S3
 * adapter) guarantees. Each method's guarantee is PART OF THE TYPE: the blob
 * lifecycle in `createBlobStore` depends on these semantics. See
 * `src/fs-blobs.ts` for the same contract at the implementation boundary.
 */
export interface ByteStore {
  /** Queryable, honest capability declaration. A backend must not overstate it. */
  readonly capabilities: ByteStoreCapabilities;

  /**
   * Write `bytes` to the pending slot for `id`. Atomic enough that a crash
   * mid-write leaves NO partial FINAL blob — a torn pending write is fine (the
   * reaper sweeps it); a torn final write is not. Callers normalize strings to
   * Buffers before calling.
   */
  writePending(id: string, bytes: Uint8Array): void;

  /**
   * Promote the pending slot to the final slot. The durability MUST is scoped
   * by `capabilities.durability`: on a `durable` backend, after this returns
   * the bytes MUST survive a process restart (an adopted blob's final bytes are
   * the product of a committed dispatch). An `ephemeral` backend (memoryBlobs)
   * conforms structurally — atomic promotion, idempotence, readable final
   * bytes — and documents that its bytes live only in the owning process;
   * losing them at a process boundary is the declared price of `ephemeral`.
   * Idempotent: a missing pending slot (already finalized, or never uploaded)
   * is a no-op — the reaper and the post-commit finalize consumer both rely on
   * that.
   */
  finalizePending(id: string): string;

  /**
   * Return the bytes in `[start, end)` as a Buffer. Falls back to the pending
   * slot when no final slot exists (a blob is readable while still pending).
   * `end` clamps to the byte length; `Infinity` (or an absent/null `end`) is
   * the accepted EOF sentinel — an open-ended range reads to EOF. `start`
   * stays strictly validated: negative / non-finite / inverted bounds throw,
   * never handed to the underlying store to misbehave with.
   */
  readRange(id: string, range?: [start?: number, end?: number]): Buffer;

  /**
   * Delete the pending (`pending: true`) or final (`pending: false`) slot.
   * Idempotent: a missing slot is a no-op (ENOENT-equivalent swallowed). Any
   * OTHER failure MUST throw — a delete-verification-capable backend never
   * reports success for an erasure that did not happen.
   */
  remove(id: string, options: { pending: boolean }): void;

  /**
   * True iff the pending / final slot has bytes. Used by the reaper to
   * reconcile (an adopted blob whose pending slot still exists needs
   * finalizing) and by tests.
   */
  exists(id: string, options: { pending: boolean }): boolean;
}

export interface BlobStore {
  safeId(id: unknown): void;
  upload(options?: {
    bytes: string | Uint8Array;
    mime?: string;
    id?: string;
  }): { id: string; md5: string; sha256: string; size: number; mime: string | null };
  adopt(
    dbOrTxn: { prepare(sql: string): WorkbenchStatement },
    id: string,
  ): { adopted: number };
  finalize(id: string): string;
  readRange(id: string, range?: [start?: number, end?: number]): Buffer;
  discardPending(id: string): void;
  discard(id: string): void;
  reap(options: {
    ttl: number;
    blobColumns: Array<{ table: string; column: string }>;
  }): { orphans: number; danglers: number };
  stat(
    id: string,
  ):
    | {
        id: string;
        status: string;
        md5: string;
        sha256: string;
        size: number;
        mime: string | null;
        createdAt: string;
      }
    | undefined;
  /**
   * TEST/DEBUG-ONLY introspection was RETIRED from the portable surface (S6/A2):
   * no code path may use a physical filesystem path to authorize, read, or
   * locate bytes. The concrete fs/memory byte-store objects still expose a
   * `pathFor` test handle at the `src/fs-blobs.ts` / `src/memory-blobs.ts`
   * boundary only.
   */
  readonly capabilities: ByteStoreCapabilities;
}

// ---------------------------------------------------------------------------
// Email seam
// ---------------------------------------------------------------------------

export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
}

export type EmailTransport = (msg: EmailMessage) => Promise<void>;

export interface EmailSeam {
  install(app: { _emailConsumer?: unknown }): void;
  consumer(
    events: unknown[],
    context: { db: WorkbenchDatabase },
  ): Promise<void>;
  send(
    app: {
      jobs?: {
        enqueue: (job: {
          id: string;
          kind: string;
          payload: unknown;
        }) => unknown;
      };
    },
    msg: EmailMessage,
  ): void;
  transport: EmailTransport;
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

export const SESSION_COOKIE: 'sid';

export function parseCookies(header?: string | null): Record<string, string>;

export function sessionCookie(
  token: string,
  options?: { secure?: boolean; env?: string },
): string;

export function sessionTokenOf(req: {
  headers?: { cookie?: string };
}): string | undefined;

export function sessionPrincipalOf(
  db: WorkbenchDatabase,
  options?: { durationMs?: number; now?: () => number },
): (req: { headers?: { cookie?: string } }) => Principal;

export function apiKeyPrincipalOf(
  db: WorkbenchDatabase,
): (req: { headers?: { authorization?: string } }) => Principal;

// ---------------------------------------------------------------------------
// Invitation helpers
// ---------------------------------------------------------------------------

export interface Invitation {
  id: string;
  token: string;
  targetEntity: string;
  targetId: string;
  role: string;
  targetUser: string | null;
  maxUses: number | null;
  useCount: number;
  expiresAt: number | null;
  createdBy: string;
  createdAt: unknown;
}

export interface InvitationApi {
  createInvitation(params: {
    targetEntity: string;
    targetId: string;
    role: string;
    principal: UserPrincipal;
    targetUser?: string;
    maxUses?: number;
    expiresAt?: number;
  }): Promise<Invitation>;
  acceptInvitation(token: string, user: UserPrincipal): Promise<{
    targetEntity: string;
    targetId: string;
    role: string;
  }>;
  rejectInvitation(token: string, user: UserPrincipal): Promise<void>;
  listInvitationsForUser(user: UserPrincipal): Invitation[];
}

export function createInvitationApi(options: {
  db?: WorkbenchDatabase;
  Invitation: BoundWorkbenchEntity<Invitation>;
}): InvitationApi;

// ---------------------------------------------------------------------------
// SQLite schema declaration
// ---------------------------------------------------------------------------

export interface ColumnDeclaration {
  name: string;
  type: 'text' | 'integer' | 'real' | 'blob';
  primaryKey?: boolean;
  notNull?: boolean;
  default?: string | number;
  defaultExpression?: 'CURRENT_DATE' | 'CURRENT_TIME' | 'CURRENT_TIMESTAMP' | "(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))";
  /** Column collation (e.g. `NOCASE`). */
  collation?: string;
  /** Raw CHECK expression for the column. */
  check?: string;
}

export interface ForeignKeyDeclaration {
  columns: readonly string[];
  references: { table: string; columns: readonly string[] };
  onDelete?: 'cascade' | 'set null' | 'set default' | 'restrict' | 'no action';
  onUpdate?: 'cascade' | 'set null' | 'set default' | 'restrict' | 'no action';
}

export interface UniqueConstraintDeclaration {
  /** Optional name; named unique constraints occupy SQLite's index namespace. */
  name?: string;
  columns: readonly string[];
}

export interface CheckConstraintDeclaration {
  name?: string;
  /** Raw CHECK expression. */
  expression: string;
}

export interface IndexDeclaration {
  name: string;
  /** Column terms. Optional when `expression` terms are declared instead. */
  columns?: readonly string[];
  /** Raw expression terms (e.g. `lower("title")`), emitted after column terms. */
  expression?: readonly string[];
  unique?: boolean;
  /** Partial-index predicate (raw boolean expression). */
  where?: string;
}

export interface TriggerDeclaration {
  name: string;
  timing: 'before' | 'after' | 'instead of';
  event: 'insert' | 'update' | 'delete';
  /** `UPDATE OF` column list — only valid for `event: 'update'`. */
  columnNames?: readonly string[];
  /** Raw WHEN predicate; `NEW.`/`OLD.` references must resolve to declared columns. */
  when?: string;
  /** Raw semicolon-terminated statements inside `BEGIN … END`. */
  body: string;
}

export interface VirtualTableDeclaration {
  name: string;
  /** Only `fts5` is available in this cut; other modules are rejected. */
  module: 'fts5';
  /** Raw module arguments, e.g. `title`, `content='articles'`, `tokenize='porter'`. */
  options: readonly string[];
  ownerPluginId: string;
  /** Shadow tables (e.g. FTS `_data`/`_idx`) this plugin owns — attributed in the census. */
  shadowTables: readonly string[];
}

export interface TableDeclaration {
  name: string;
  columns: readonly ColumnDeclaration[];
  foreignKeys?: readonly ForeignKeyDeclaration[];
  indexes?: readonly IndexDeclaration[];
  primaryKey?: readonly string[];
  /** Table-level UNIQUE constraints. */
  unique?: readonly UniqueConstraintDeclaration[];
  /** Table-level CHECK constraints. */
  check?: readonly CheckConstraintDeclaration[];
  /** Emit the STRICT table policy. */
  strict?: boolean;
  /** Emit WITHOUT ROWID; requires a declared primary key. */
  withoutRowid?: boolean;
  /** Declared triggers — compiled to DDL but never created at prepare time. */
  triggers?: readonly TriggerDeclaration[];
}

export interface NamespacedMigration extends Migration {
  /** Per-namespace migration ledger identity (A4 owns the runtime). */
  namespace: string;
  name: string;
  /** Cross-namespace dependencies, e.g. `"workbench@5"`. */
  dependencies?: readonly string[];
}

export interface SqliteSchemaResult {
  readonly name: string;
  readonly tableNames: readonly string[];
  /** Immutable declarations used to verify schema-owned entity tables at startup. */
  readonly tables: readonly Readonly<TableDeclaration>[];
  readonly virtualTables: readonly Readonly<VirtualTableDeclaration>[];
  readonly triggers: readonly Readonly<TriggerDeclaration>[];
  readonly migrations: readonly NamespacedMigration[];
  /** Executed by `prepare`: CREATE TABLE / CREATE INDEX (IF NOT EXISTS). */
  readonly ddl: readonly string[];
  /** Plugin-owned virtual tables — compiled but NOT executed by `prepare`. */
  readonly virtualTableDdl: readonly string[];
  /** Declared triggers — compiled but NEVER created/dropped by `prepare`. */
  readonly triggerDdl: readonly string[];
  prepare(db: WorkbenchDatabase, options?: { skipMigrations?: boolean; skipIndexes?: boolean; now?: () => string }): void;
}

export function defineSqliteSchema(spec: {
  name: string;
  externalTables?: readonly { name: string; columns: readonly string[] }[];
  virtualTables?: readonly VirtualTableDeclaration[];
  tables: readonly TableDeclaration[];
  migrations?: readonly NamespacedMigration[];
}): SqliteSchemaResult;

export interface SqliteStorageColumnDescription {
  readonly name: string;
  readonly type: string;
  readonly notNull: boolean;
  readonly defaultValue: string | null;
  readonly primaryKeyPosition: number;
  readonly hidden: number;
}

export interface SqliteStorageIndexDescription {
  readonly name: string;
  readonly unique: boolean;
  readonly origin: string;
  readonly partial: boolean;
  readonly sql: string | null;
  readonly columns: readonly (string | null)[];
  readonly terms: readonly {
    readonly sequence: number;
    readonly columnId: number;
    readonly name: string | null;
    readonly descending: boolean;
    readonly collation: string | null;
    readonly key: true;
  }[];
}

export interface SqliteStorageForeignKeyDescription {
  readonly table: string;
  readonly columns: readonly string[];
  readonly referencedColumns: readonly (string | null)[];
  readonly onUpdate: string;
  readonly onDelete: string;
  readonly match: string;
}

export interface SqliteStorageTableDescription {
  readonly name: string;
  readonly sql: string;
  readonly virtual: boolean;
  readonly withoutRowid: boolean;
  readonly strict: boolean;
  readonly columns: readonly SqliteStorageColumnDescription[];
  readonly primaryKey: readonly string[];
  readonly foreignKeys: readonly SqliteStorageForeignKeyDescription[];
  readonly indexes: readonly SqliteStorageIndexDescription[];
}

export interface SqliteStorageDescription {
  readonly tableNames: readonly string[];
  readonly tables: readonly SqliteStorageTableDescription[];
}

export function describeSqliteStorage(
  db: WorkbenchDatabase,
  tableNames: readonly string[],
): SqliteStorageDescription;

export function describeEntityStorage(
  entity: Pick<WorkbenchEntity<Record<string, unknown>>, 'name' | 'fields'>,
): SqliteStorageDescription;

// ---------------------------------------------------------------------------
// Route / static helpers
// ---------------------------------------------------------------------------

export function matchRoute(
  routes: Array<{ method: string; path: string; handler?: Handler }>,
  method: string,
  pathname: string,
):
  | { route: { method: string; path: string; handler?: Handler }; params: Record<string, string> }
  | { route: null; params: null; pathMatched: boolean };

export function serveStatic(
  dir: string,
  options?: { prefix?: string },
): Handler;

// ---------------------------------------------------------------------------
// Job queue
// ---------------------------------------------------------------------------

interface ClockSpec {
  name: string;
  intervalMs: number;
  fn: () => void;
}

interface ClockHandle {
  remove(): void;
}

interface Clock {
  add(spec: ClockSpec): ClockHandle;
}

export interface JobQueue {
  registerWorker(presentedSecret: string): { workerId: string; token: string } | null;
  authenticate(bearer: string): string | null;
  enqueue(job: {
    kind: string;
    payload?: unknown;
    id?: string;
    scope?: string;
    // Optional machine attribution (S5/A5): the attributable machine principal
    // this job runs under. Must be a machinePrincipal; anything else throws.
    principal?: import('../index.d.ts').MachinePrincipal;
  }): JobRow;
  claim(workerId: string, options?: { kind?: string; scope?: string }): JobRow | null;
  heartbeat(jobId: string, workerId: string, options?: { now?: () => number }): boolean;
  submitResult(
    jobId: string,
    workerId: string,
    result: { status: 'completed' | 'failed'; output?: unknown },
  ): SubmitResultOk | { accepted: false };
  updateProgress(options: {
    jobId: string;
    workerId: string;
    progress: number;
    stage?: string;
  }): JobRow | null;
  cancelJob(options: { jobId: string; workerId?: string }): CancelJobResult;
  reap(options?: { now?: () => number }): {
    reassigned: number;
    deadLettered: number;
    revoked: number;
  };
  startReaper(): void;
  stop(): void;
  work(
    kind: string,
    fn: (job: JobRow) => unknown | Promise<unknown>,
    options: {
      // S5/A5: the attributable machine principal the worker runs under.
      principal: import('../index.d.ts').MachinePrincipal;
      // The handler/context allowlist: the operations this handler performs.
      // Dispatch validates the executing principal against it and denies on
      // mismatch (fail closed — the fn is never invoked).
      operations: readonly string[];
      pollIntervalMs?: number;
    },
  ): {
    once: () => Promise<{
      job: JobRow;
      result: SubmitResultOk | { accepted: false };
      // Present on a fail-closed denial: the operation the executing principal
      // was not granted (fn was never invoked).
      denied?: string;
    } | null>;
    stop: () => void;
    workerId: string;
  };
  onEvent(
    fn: (event: {
      type: string;
      scope: string | null;
      seq: number;
      data: unknown;
      actionId: string;
      committedAt: string;
    }) => void,
  ): () => void;
  list(options?: {
    scope?: string;
    kind?: string;
    status?: string;
    limit?: number;
  }): JobRow[];
}

export function createJobQueue(options: {
  db: WorkbenchDatabase;
  sharedSecret: string;
  leaseMs?: number;
  heartbeatGraceMs?: number;
  reapIntervalMs?: number;
  maxAttempts?: number;
  backoffMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  clock?: Clock;
}): JobQueue;

// ---------------------------------------------------------------------------
// Blob store factory
// ---------------------------------------------------------------------------

export function createBlobStore(options: {
  /**
   * Explicit byte root (back-compat `blobs: { root }`), refused on overlap with
   * the owned directory. When omitted and the store is built through
   * `workbench()`, a file-mode app's byte store roots under the owned
   * directory's managed `blobs/` (pending slots in `staging/`) — never cwd
   * (S6/A2 relocation) — and a memory database uses the in-memory fake byte
   * store (S6/A1).
   */
  root?: string;
  db: WorkbenchDatabase;
  bytes?: ByteStore;
}): BlobStore;

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

export function runMigrations(
  db: WorkbenchDatabase,
  migrations?: Migration[],
  options?: { now?: () => string },
): void;

// ---------------------------------------------------------------------------
// Committed log reads
// ---------------------------------------------------------------------------

export function readCommittedCursor(
  db: WorkbenchDatabase,
  scope: string,
): number;

export type LiveDeliveryEnvelope =
  | {
      readonly type: 'event';
      readonly entity: string;
      readonly id: string;
      readonly seq: number;
      readonly seqSpan: readonly [number, number];
      readonly event: {
        readonly type: string;
        readonly scope: string;
        readonly seq: number;
      readonly actionId: string;
      readonly committedAt: string;
        readonly data: Readonly<Record<string, unknown>>;
      };
    }
  | {
      readonly type: 'resync';
      readonly entity: string;
      readonly id: string;
      readonly seq: number;
      readonly reason: 'recipient-snapshot-required' | 'annotated-text-snapshot-required';
    };

export interface LiveDeliverySubscription {
  readonly principal: Principal;
  readonly scope: string;
  readonly after?: LiveDeliveryCursor;
  readonly signal: AbortSignal;
  readonly deliver: (batch: readonly LiveDeliveryEnvelope[]) => void | Promise<void>;
  readonly revoke?: (reason?: unknown) => void;
}

export interface LiveDeliveryActivation {
  activate(): Promise<LiveDeliveryCursor | undefined>;
}

export type LiveDeliveryCursor = number | Readonly<{ anchor: number; aggregate: number }>;

export type LiveDeliveryBootstrap<Snapshot = unknown> =
  | { readonly kind: 'snapshot'; readonly snapshot: Snapshot; readonly cursor: LiveDeliveryCursor }
  | { readonly kind: 'revoked'; readonly reason?: unknown }
  | { readonly kind: 'retry' };

export type LiveDeliveryCatchup =
  | {
      readonly kind: 'catchup';
      readonly envelopes: readonly LiveDeliveryEnvelope[];
    readonly cursor: LiveDeliveryCursor;
  }
  | { readonly kind: 'snapshot'; readonly snapshot: unknown; readonly cursor: LiveDeliveryCursor }
  | { readonly kind: 'revoked'; readonly reason?: unknown }
  | { readonly kind: 'retry' };

export interface LiveDeliveryEntity {
  readonly name: string;
  readonly fields: Readonly<Record<string, unknown>>;
  scopeFilter(principal: Principal): { sql: string; params: Readonly<Record<string, unknown>> };
  hydrate?(raw: unknown, principal: Principal): Record<string, unknown> | null | undefined;
}

export interface LiveDeliverySnapshot { readonly kind: 'snapshot'; readonly anchor: LiveDeliveryEntity; readonly output: object; }

export interface LiveDelivery {
  bootstrap(input: {
    readonly principal: Principal;
    readonly scope: string;
  }): Promise<LiveDeliveryBootstrap>;
  catchup(input: {
    readonly principal: Principal;
    readonly scope: string;
    readonly after: LiveDeliveryCursor;
  }): Promise<LiveDeliveryCatchup>;
  subscribe(input: LiveDeliverySubscription): Promise<LiveDeliveryActivation>;
  wake(scope: string): void;
}

export function createLiveDelivery(options: {
  db: WorkbenchDatabase;
  entities: ReadonlyMap<string, LiveDeliveryEntity> | ((name: string) => LiveDeliveryEntity | undefined);
  mayVerb: (entity: LiveDeliveryEntity, verb: 'subscribe', row: Record<string, unknown>, principal: Principal) => boolean | Promise<boolean>;
  /** The injected authorization adapter — THE admission path for subscription admission and re-authorization when provided. */
  authorization?: import('../index.d.ts').AuthorizationAdapter;
  /** Package-owned constrained relational snapshot declarations. */
  snapshots?: readonly LiveDeliverySnapshot[];
  log?: { error?: (channel: string, message: string, context?: Record<string, unknown>) => void } | null;
  maxCatchupEvents?: number;
}): LiveDelivery;

export function createLiveDeliveryHttpHandler(options: {
  delivery: LiveDelivery;
  principalOf(request: import('node:http').IncomingMessage): Principal | Promise<Principal>;
  path?: string;
  maxSubscriptions?: number;
}): (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => Promise<boolean>;

// ---------------------------------------------------------------------------
// Email seam factory
// ---------------------------------------------------------------------------

export function emailSeam(options?: {
  transport?: EmailTransport;
}): EmailSeam;

export const noopTransport: EmailTransport;

// ---------------------------------------------------------------------------
// History-read façade
// ---------------------------------------------------------------------------

export type RecipientProjectedEvent = Readonly<Record<string, unknown>>;

export interface ReadCommittedHistoryOptions {
  scope: string;
  principal: Principal;
  sinceSeq?: number;
  limit?: number;
}

export interface ReadCommittedHistoryResult {
  events: readonly RecipientProjectedEvent[];
  hasMore: boolean;
}

export interface ReceiptMetadata {
  scope: string;
  actionId: string;
  committedAt: string;
  eventRefs: readonly { scope: string; seq: number }[];
  actionType: string | null;
  operation: string;
}

export interface HistoryReader {
  readCommittedHistory(options: ReadCommittedHistoryOptions): Promise<ReadCommittedHistoryResult>;
  readReceipt(options: { scope: string; actionId: string; principal: Principal }): Promise<ReceiptMetadata | null>;
}

export type ProjectRecipientContext = Readonly<{
  entity: LiveDeliveryEntity;
  event: Readonly<Record<string, unknown>>;
  principal: Principal;
  row: Record<string, unknown>;
  scope: string;
}>;

export type ProjectRecipient = (context: ProjectRecipientContext) => readonly RecipientProjectedEvent[];

export type ScopeVisibleCheck = (context: Readonly<{
  entity: LiveDeliveryEntity;
  principal: Principal;
  scope: Readonly<{ entity: string; id: string }>;
}>) => boolean;

export function createHistoryReader(options: {
  db: WorkbenchDatabase;
  entities: ReadonlyMap<string, LiveDeliveryEntity> | ((name: string) => LiveDeliveryEntity | undefined);
  /** Defaults to the framework row-grant engine (same engine REST and live delivery use). */
  mayVerb?: (entity: LiveDeliveryEntity, verb: string, row: Record<string, unknown>, principal: Principal) => boolean | Promise<boolean>;
  annotatedHistory?: { entities?: Set<string>; actionTypes?: Set<string> } | null;
  /** Required to read committed history; optional for receipt reads only. */
  projectRecipient?: ProjectRecipient;
  scopeVisible?: ScopeVisibleCheck;
}): HistoryReader;

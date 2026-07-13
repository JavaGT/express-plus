/// <reference types="node" />

import type {
  BoundWorkbenchEntity,
  CommittedEvent,
  EntityDeclaration,
  Principal,
  UserPrincipal,
  Handler,
  WorkbenchDatabase,
  WorkbenchStatement,
} from '../index.d.ts';
export type { WorkbenchDatabase, WorkbenchStatement, UserPrincipal } from '../index.d.ts';

// ---------------------------------------------------------------------------
// Framework table names (derived from DDL generators)
// ---------------------------------------------------------------------------

export const frameworkTableNames: readonly string[];

export function declaredTableNames(
  entities: readonly EntityDeclaration<Record<string, unknown>>[],
): readonly string[];

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

interface ByteStore {
  writePending(id: string, bytes: Uint8Array): void;
  finalizePending(id: string): string;
  readRange(id: string, range?: [number, number]): Buffer;
  remove(id: string, options: { pending: boolean }): void;
  exists(id: string, options: { pending: boolean }): boolean;
  pathFor(id: string, options?: { pending?: boolean }): string;
}

export interface BlobStore {
  safeId(id: string): void;
  upload(options: {
    bytes: string | Uint8Array;
    mime?: string;
    id?: string;
  }): { id: string; md5: string; sha256: string; size: number; mime: string | null };
  adopt(
    dbOrTxn: { prepare(sql: string): WorkbenchStatement },
    id: string,
  ): { adopted: number };
  finalize(id: string): string;
  readRange(id: string, range?: [number, number]): Buffer;
  reap(options: {
    ttl: number;
    blobColumns: Array<{ table: string; column: string }>;
  }): { orphans: number; danglers: number; reconciled: number };
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
  pathFor(id: string, options?: { pending?: boolean }): string;
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
  defaultExpression?: 'CURRENT_DATE' | 'CURRENT_TIME' | 'CURRENT_TIMESTAMP';
}

export interface ForeignKeyDeclaration {
  columns: readonly string[];
  references: { table: string; columns: readonly string[] };
  onDelete?: 'cascade' | 'set null' | 'set default' | 'restrict' | 'no action';
  onUpdate?: 'cascade' | 'set null' | 'set default' | 'restrict' | 'no action';
}

export interface IndexDeclaration {
  name: string;
  columns: readonly string[];
  unique?: boolean;
}

export interface TableDeclaration {
  name: string;
  columns: readonly ColumnDeclaration[];
  foreignKeys?: readonly ForeignKeyDeclaration[];
  indexes?: readonly IndexDeclaration[];
  primaryKey?: readonly string[];
}

export interface SqliteSchemaResult {
  readonly name: string;
  readonly tableNames: readonly string[];
  readonly ddl: readonly string[];
  prepare(db: WorkbenchDatabase, options?: { now?: () => string }): void;
}

export function defineSqliteSchema(spec: {
  name: string;
  externalTables?: readonly { name: string; columns: readonly string[] }[];
  tables: readonly TableDeclaration[];
  migrations?: readonly Migration[];
}): SqliteSchemaResult;

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
    options?: { pollIntervalMs?: number },
  ): {
    once: () => Promise<{
      job: JobRow;
      result: SubmitResultOk | { accepted: false };
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

export function readCommittedEventsSince(
  db: WorkbenchDatabase,
  scope: string,
  cursor: number,
): CommittedEvent[];

// ---------------------------------------------------------------------------
// Email seam factory
// ---------------------------------------------------------------------------

export function emailSeam(options?: {
  transport?: EmailTransport;
}): EmailSeam;

export const noopTransport: EmailTransport;

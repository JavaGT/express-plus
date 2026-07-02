// Type definitions for workbench — the stable public handler contract.
//
// The .mjs source remains the sole source of truth; this is a projection for
// TypeScript app authors. JS app authors see nothing change. `req.raw` and
// `res.raw` expose node's real IncomingMessage / ServerResponse so SSE/stream
// casts compile away (ServerResponse already provides writeHead/write/end) —
// no custom RawRes alias to maintain in lockstep with node.
//
// Requires @types/node available in the consuming project (peer expectation,
// not bundled).

/// <reference types="node" />

import type { IncomingMessage, ServerResponse } from 'node:http';

// ---------------------------------------------------------------------------
// Principal — the closed union (user | link | system | anonymous).
// ---------------------------------------------------------------------------

export type PrincipalType = 'user' | 'link' | 'system' | 'anonymous';

export interface Principal {
  readonly type: PrincipalType;
  readonly id: string | null;
  readonly attributes: Readonly<Record<string, unknown>>;
}

export const anonymous: Principal;

// ---------------------------------------------------------------------------
// Handler contract — the (req, res, next) chain run for imperative routes.
// ---------------------------------------------------------------------------

export interface HandlerReq {
  /** Already-parsed JSON/form body ({} when empty). */
  body: Record<string, unknown>;
  /** Matched `:param` path segments. */
  params: Record<string, string>;
  /** Parsed query string (Object.fromEntries of url.searchParams). */
  query: Record<string, string>;
  /** The already-admitted principal (the route gate ran before the chain). */
  principal: Principal;
  /** The raw node IncomingMessage (headers, streaming reads). */
  raw: IncomingMessage;
  headers: IncomingMessage['headers'];
  method: string;
  url: string;
  /** Entity auto-load: `req.<entityName>` for a route under an entity's `:<entity>Id` subtree. */
  [key: string]: unknown;
}

export interface HandlerRes {
  /** Record a pending status code; chains to json/send/stream. */
  status(code: number): this;
  /** Send a JSON body with the pending (default 200) status. */
  json(value: unknown): this;
  /** Send a text body with the pending status. */
  send(value: unknown): this;
  /** End with a status code and no body. */
  sendStatus(code: number): this;
  /** Render a server-side template (views dir). */
  render(name: string, data?: Record<string, unknown>): this;
  /** Stream a Web Response or ReadableStream — owns header write + reader pump. */
  stream(
    webResponse: Response | ReadableStream<Uint8Array>,
    options?: { buffering?: boolean },
  ): Promise<this>;
  /** The raw node ServerResponse (writeHead/write/end — typed, no cast needed). */
  raw: ServerResponse;
}

/** A request handler in an imperative route chain. */
export type Handler = (
  req: HandlerReq,
  res: HandlerRes,
  next?: (err?: unknown) => void,
) => void | Promise<void>;

/** A route gate — an authorization function `(principal) => boolean`. */
export type Gate = (principal: Principal) => boolean;

// ---------------------------------------------------------------------------
// Route builder — the `r` handed to `app.mount(path, r)` / entity `routes` thunks.
// ---------------------------------------------------------------------------

export interface RouteBuilder {
  get(path: string, ...rest: Array<Gate | Handler>): this;
  post(path: string, ...rest: Array<Gate | Handler>): this;
  patch(path: string, ...rest: Array<Gate | Handler>): this;
  delete(path: string, ...rest: Array<Gate | Handler>): this;
  mount(path: string, target: unknown): this;
}

export interface ResourceGateConfig {
  gate?: Partial<Record<'list' | 'read' | 'create' | 'update' | 'remove', Gate>>;
}

// ---------------------------------------------------------------------------
// Gates — the named factories (route-gate.mjs).
// ---------------------------------------------------------------------------

export function requireUser(): Gate;
export function allowAnonymous(): Gate;
export function isGate(value: unknown): value is Gate;

// ---------------------------------------------------------------------------
// Job queue — the substrate for app-authored worker routes. The framework owns
// /jobs/claim, /jobs/:id/heartbeat, /jobs/:id/result (already safe). An app
// building its OWN worker routes composes these primitives — submitResult and
// heartbeat carry the ownership check (job.workerId === workerId), so the safe
// path is the obvious one.
// ---------------------------------------------------------------------------

export interface Job {
  id: string;
  kind: string;
  payload: unknown;
  status: 'queued' | 'claimed' | 'running' | 'completed' | 'failed';
  enqueuedAt: number;
  workerId: string | null;
  claimedAt: number | null;
  leaseUntil: number | null;
}

export interface JobQueueOptions {
  db: unknown;
  sharedSecret: string;
  leaseMs?: number;
  heartbeatGraceMs?: number;
  reapIntervalMs?: number;
  now?: () => number;
}

export interface JobQueue {
  /** Shared secret → per-worker bearer token (constant-time). null on mismatch. */
  registerWorker(presentedSecret: string): { workerId: string; token: string } | null;
  /** Bearer `<workerId>.<token>` → workerId, or null (unknown/revoked/bad token). */
  authenticate(bearer: string): string | null;
  enqueue(job: { kind: string; payload?: unknown; id?: string }): Job;
  /** Claim the oldest queued job for a worker (atomic). null if none queued. */
  claim(workerId: string): Job | null;
  /** Extend the lease; flips claimed→running. Non-owner/terminal → false. `now` is a testing seam. */
  heartbeat(jobId: string, workerId: string, options?: { now?: () => number }): boolean;
  /** Submit a result. Idempotent by job id. Non-owner/not-found → { accepted: false }. */
  submitResult(
    jobId: string,
    workerId: string,
    result: { status: 'completed' | 'failed'; output?: unknown },
  ): { accepted: boolean; noop?: boolean };
  /** Reaper sweep: reassign expired leases + revoke stale workers. `now` is a testing seam. */
  reap(options?: { now?: () => number }): { reassigned: number; revoked: number };
  startReaper(): void;
  stop(): void;
}

export function createJobQueue(options: JobQueueOptions): JobQueue;

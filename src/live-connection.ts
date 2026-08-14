// A live WebSocket connection — socket I/O, frame parsing/sending,
// message routing, and the connection lifecycle.
//
// Subscribe-time admission is delegated to live-admission.mjs; subscription
// registration delegates to the injected fanout handle. The transport wiring
// (WebSocket upgrade, CSWSH check, principalOf) stays in live-delivery.mjs.

import type { Duplex } from 'node:stream';

import { FrameSender, FrameParser } from './websocket.ts';
import { authorizeSubscription, parseSubscribeMsg } from './live-admission.ts';
import { failure, isWorkbenchFailure, sanitizeUnexpectedFailure } from './outcome.ts';
import { anonymous } from './principal.ts';
import type { Principal } from './principal.ts';
import type { AuthorizationAdapter } from './authorization-adapter.ts';
import type { FrameworkLog } from './log.ts';
import type { LiveConn, LiveDatabase, LiveEntityRecord, LiveFanoutHandle, MayVerb } from './live-fanout.ts';
import type { CoreActivation, LiveDeliveryCore } from './live-delivery-core.ts';

function requestIdOf(msg: { requestId?: unknown }): number | string | undefined {
  const value = msg?.requestId;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && value.length > 0 && value.length <= 128) return value;
  return undefined;
}

interface ParsedFrame {
  opcode: number;
  payload?: Buffer;
  closeCode?: number;
  closeReason?: string;
  error?: string;
}

interface CaretLiveHandle {
  update(conn: LiveConn, message: unknown): Promise<unknown>;
  clear(conn: LiveConn, message: unknown): Promise<unknown>;
  removeConnection(conn: LiveConn, scope?: string): Promise<unknown>;
}

export interface LiveConnectionOptions {
  fanout: LiveFanoutHandle;
  core?: LiveDeliveryCore | null;
  resolveEntity: ((name: string) => LiveEntityRecord | undefined | null) | null;
  mayVerb: MayVerb | null;
  authorization?: AuthorizationAdapter | null;
  db: LiveDatabase | null;
  currentSeq: (scope: string) => number;
  onClose: () => void;
  log?: FrameworkLog | null;
  carets?: CaretLiveHandle | null;
}

export class LiveConnection {
  #socket: Duplex;
  #sender: FrameSender;
  #parser: FrameParser;
  #id: string;
  #closed = false;
  #closing = false;
  #closePromise: Promise<void> | null = null;
  #principal: Principal | null;
  #fanout: LiveFanoutHandle;
  #core: LiveDeliveryCore | null;
  #resolveEntity: ((name: string) => LiveEntityRecord | undefined | null) | null;
  #mayVerb: MayVerb | null;
  #authorization: AuthorizationAdapter | null;
  #db: LiveDatabase | null;
  #currentSeq: (scope: string) => number;
  #onClose: (() => void) | null;
  #log: FrameworkLog | null;
  #carets: CaretLiveHandle | null;
  #coreAcs: Map<string, AbortController>;
  #coreActivations: Map<string, CoreActivation>;
  #coreGen: Map<string, number>;

  constructor(socket: Duplex, id: string, { fanout, core = null, resolveEntity, mayVerb, authorization = null, db, currentSeq, onClose, log = null, carets = null }: LiveConnectionOptions) {
    this.#socket = socket;
    this.#sender = new FrameSender();
    this.#parser = new FrameParser();
    this.#id = id;
    this.#principal = null;
    this.#fanout = fanout;
    this.#core = core;
    this.#resolveEntity = resolveEntity;
    this.#mayVerb = mayVerb;
    this.#authorization = authorization;
    this.#db = db;
    this.#currentSeq = currentSeq;
    this.#onClose = onClose;
    this.#log = log;
    this.#carets = carets;
    this.#coreAcs = new Map();
    this.#coreActivations = new Map();
    this.#coreGen = new Map();

    socket.on('data', (chunk) => {
      if (this.#closing) return;
      this.#parser.feed(chunk);
      this.#drain();
    });

    socket.on('error', () => this.#close());
    socket.on('end', () => this.#close());
    socket.on('close', () => this.#close());
  }

  get id(): string { return this.#id; }
  get closed(): boolean { return this.#closed; }
  get principal(): Principal | null { return this.#principal; }

  close(): Promise<void> { return this.#close(); }

  setPrincipal(p: Principal): void {
    this.#principal = p;
  }

  send(data: unknown): void {
    if (this.#closed || this.#closing) return;
    try {
      this.#socket.write(this.#sender.text(JSON.stringify(data)));
    } catch {
      this.#close();
    }
  }

  error(workbenchFailure: unknown, requestId?: number | string): void {
    const response: Record<string, unknown> = {
      type: 'error',
      failure: isWorkbenchFailure(workbenchFailure)
        ? workbenchFailure
        : sanitizeUnexpectedFailure(),
    };
    if (requestId !== undefined) response.requestId = requestId;
    this.send(response);
  }

  #drain(): void {
    const msgs = this.#parser.drainMessages() as ParsedFrame[];
    for (const msg of msgs) {
      if (msg.opcode === 0x8) {
        // 1005 means the peer sent a close frame without a status code. It is
        // an internal RFC 6455 sentinel, not a code valid on the wire; echo an
        // empty close frame rather than sending Chromium an illegal 1005 code.
        const code = msg.closeCode === 1005 ? undefined : (msg.closeCode ?? 1000);
        // Mark the connection closing before cleanup can fan out a presence
        // retraction, then acknowledge the peer's close frame.
        this.#closing = true;
        try { this.#socket.write(this.#sender.close(code, msg.closeReason)); } catch { /* ignore */ }
        this.#close();
        return;
      }
      if (msg.opcode === 0x1) {
        try {
          const parsed = JSON.parse(msg.payload?.toString('utf-8') ?? '');
          this.#handleMessage(parsed);
        } catch {
          this.error(failure('invalid-input', 'Invalid JSON.'));
        }
      }
      if (msg.opcode === -1) {
        this.error(failure('invalid-input', String(msg.error || 'Invalid WebSocket frame.')));
      }
    }

    const pongs = this.#parser.drainPongs();
    for (const payload of pongs) {
      try { this.#socket.write(this.#sender.pong(payload)); } catch { this.#close(); }
    }
  }

  #handleMessage(msg: Record<string, unknown>): void {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      this.error(failure('invalid-input', 'Message must be an object.'));
      return;
    }
    switch (msg.type) {
      case 'subscribe':
        this.#authorizeAndSubscribe(msg).catch((err) => {
          const requestId = requestIdOf(msg);
          this.#log?.error('live', 'subscription admission failed', {
            err,
            connectionId: this.#id,
            ...(requestId === undefined ? {} : { requestId }),
          });
          this.error(sanitizeUnexpectedFailure(), requestId);
        });
        break;
      case 'unsubscribe':
        this.#handleUnsubscribe(msg);
        break;
      case 'caret.update':
        this.#carets?.update(this, msg).catch(() => this.error(failure('invalid-input', 'Invalid caret update.')));
        break;
      case 'caret.clear':
        this.#carets?.clear(this, msg).catch(() => this.error(failure('invalid-input', 'Invalid caret clear.')));
        break;
      default:
        this.error(
          failure('unknown-action', `Unknown message type: ${String(msg.type)}.`),
          requestIdOf(msg),
        );
    }
  }

  // Advance the per-scope ownership generation and return the new value. Every
  // subscribe request claims the newest generation for its scope before its
  // first await, and an explicit unsubscribe advances it again to invalidate any
  // in-flight request. A request that finds the scope at a higher generation
  // after an await is stale and must only detach its own activation/controller.
  #bumpScopeGen(scope: string): number {
    const gen = (this.#coreGen.get(scope) ?? 0) + 1;
    this.#coreGen.set(scope, gen);
    return gen;
  }

  #handleUnsubscribe(msg: unknown): void {
    const normalized = parseSubscribeMsg(msg);
    if (normalized) {
      // A per-scope unsubscribe is genuinely non-terminal: detach the core
      // subscription through its explicit handle without any transport revoke,
      // so the connection and its other scopes stay alive. The AbortSignal is
      // reserved for terminal removal (transport abort, error, auth denial,
      // close/shutdown) and is never used here. The generation bump invalidates
      // any still-pending subscribe: it becomes stale and detaches only its own
      // controller when admission completes, never this scope's newer state.
      this.#bumpScopeGen(normalized.scope);
      this.#carets?.removeConnection(this, normalized.scope).catch(() => {});
      this.#fanout.removeSubscription(normalized.scope, this);
      const activation = this.#coreActivations.get(normalized.scope);
      activation?.unsubscribe?.();
      this.#coreActivations.delete(normalized.scope);
      // The controller in the scope map belongs to the winner (or to a request
      // still pending inside core.subscribe). Detaching the winner's activation
      // first removed the core's abort listener, so aborting its controller is
      // an idempotent no-op that cannot trigger a transport revoke — the
      // ordering is what keeps a per-scope unsubscribe genuinely non-terminal.
      // A still-pending request has no subscription installed yet, so aborting
      // its controller simply cancels its in-flight core admission; its own
      // stale branch then completes silently. Every detached controller is
      // aborted exactly once here or by its owning request's stale branch.
      this.#coreAcs.get(normalized.scope)?.abort();
      this.#coreAcs.delete(normalized.scope);
      const response: Record<string, unknown> = { type: 'unsubscribed', scope: normalized.scope };
      if (normalized.interest.entity) response.entity = normalized.interest.entity;
      if (normalized.interest.id !== undefined) response.id = normalized.interest.id;
      this.send(response);
    }
  }

  async #authorizeAndSubscribe(msg: unknown): Promise<void> {
    const requestId = requestIdOf(msg as { requestId?: unknown });
    // Per-scope ownership fence. The generation is claimed before the first
    // await so arrival order decides the winner: a later subscribe for the same
    // scope — and any explicit unsubscribe — supersedes requests still in
    // flight. Every post-await mutation below re-checks ownsScope() and, when
    // stale, detaches only this request's own activation/controller — never the
    // newer owner's state, ack, or fan-out registration.
    const normalized = parseSubscribeMsg(msg);
    const pendingScope = normalized?.scope;
    const scopeGen = pendingScope === undefined ? 0 : this.#bumpScopeGen(pendingScope);
    const ownsScope = () => pendingScope === undefined || this.#coreGen.get(pendingScope) === scopeGen;

    const result = await authorizeSubscription(msg, this, {
      resolveEntity: this.#resolveEntity,
      mayVerb: this.#mayVerb,
      authorization: this.#authorization ?? undefined,
      db: this.#db,
      fanout: this.#fanout,
    });
    if (!result.admitted) {
      // A superseded request reports nothing: its outcome is noise to a client
      // that already moved on to the newer owner.
      if (ownsScope()) this.error(result.failure, requestId);
      return;
    }
    // A newer subscribe or an explicit unsubscribe superseded us during
    // admission. We never installed anything, so detach nothing and send no ack.
    if (!ownsScope()) return;

    const scope = result.scope;
    let activateCore: (() => Promise<number | undefined>) | null = null;
    let coreSubscription: CoreActivation | null = null;
    // This request's OWN controller. The scope map (#coreAcs) holds only the
    // current owner's controller, so a newer same-scope request overwrites the
    // map — this local reference is the only handle a stale request has to
    // cancel exactly its own work. Every branch below that detaches its own
    // subscription also aborts this controller, ordered AFTER the detach so the
    // abort is an idempotent no-op that cannot reach the transport revoke.
    let requestController: AbortController | null = null;

    // Subscribe to the core for committed-event delivery BEFORE sending the
    // subscribed ack. If core subscription fails, we remove the fanout
    // registration and send only an error — no ack reaches the client.
    if (this.#core) {
      // A resubscribe replaces the previous subscription for this scope. That
      // is non-terminal for the connection: detach the old subscription through
      // its explicit handle instead of aborting, so no revoke error reaches the
      // client. A still-pending older subscribe has no handle yet; the
      // ownership fence below detaches it without revoke when it completes.
      const previousActivation = this.#coreActivations.get(scope);
      if (previousActivation) {
        previousActivation.unsubscribe?.();
        this.#coreActivations.delete(scope);
        this.#fanout.removeSubscription(scope, this);
        // The replaced controller belongs to the previous owner and its abort
        // listener was removed by the detach above, so aborting it is an
        // idempotent no-op that cannot trigger a transport revoke.
        this.#coreAcs.get(scope)?.abort();
      }
      const ac = new AbortController();
      requestController = ac;
      this.#coreAcs.set(scope, ac);
      try {
        coreSubscription = (await this.#core.subscribe({
          principal: this.#principal ?? anonymous,
          scope,
          after: this.#currentSeq(scope),
          signal: ac.signal,
          paused: true,
          deliver: async (batch) => {
            if (this.#closed) throw new Error('live connection closed');
            for (const envelope of batch) {
              if (this.#closed) throw new Error('live connection closed');
              this.send(envelope);
            }
          },
          revoke: () => {
            // A reauthorization failure after acknowledgement is terminal for
            // this recipient — but only while this request still owns the
            // scope. A newer owner or an explicit unsubscribe has (or will
            // have) its own terminal handling; reporting here would clobber the
            // winner. The revoke also advances the generation, so this
            // request's own post-await continuation reports nothing further:
            // terminal reporting has already happened, exactly once.
            if (!ownsScope()) return;
            this.#coreAcs.delete(scope);
            this.#coreActivations.delete(scope);
            this.#fanout.removeSubscription(scope, this);
            ac.abort();
            this.#bumpScopeGen(scope);
            this.error(failure('denied', 'Subscription revoked.'), requestId);
          },
        })) ?? null;
        activateCore = coreSubscription?.activate ?? null;
        if (ac.signal.aborted) return;
        // Register our own activation only while this request still owns the
        // scope; a stale request must never overwrite the winner's entry.
        if (coreSubscription && ownsScope()) this.#coreActivations.set(scope, coreSubscription);
      } catch (err) {
        // The core already removed its own subscription (or never installed
        // one), so the detach no-ops and the abort below is an idempotent
        // no-op that cannot reach the transport revoke. It fires exactly once
        // for this request's controller whether this request is stale or the
        // owner, and never touches a newer winner's controller.
        coreSubscription?.unsubscribe?.();
        ac.abort();
        if (!ownsScope()) return;
        this.#coreAcs.delete(scope);
        this.#coreActivations.delete(scope);
        this.#fanout.removeSubscription(scope, this);
        this.#log?.error?.('live', 'core subscription failed', { scope, err: String(err) });
        this.error(failure('denied', 'Subscription failed.'), requestId);
        return;
      }
      // A newer subscribe or an explicit unsubscribe owns this scope now —
      // detach only our own subscription without revoke, then abort our own
      // controller (an idempotent no-op after the detach). The winner (or
      // connection close) handles terminal teardown. Never leave an active
      // paused subscription.
      if (!ownsScope()) {
        coreSubscription?.unsubscribe?.();
        ac.abort();
        return;
      }
    }

    const response: Record<string, unknown> = {
      type: 'subscribed',
      scope,
      currentSeq: this.#currentSeq(scope),
    };
    if (requestId !== undefined) response.requestId = requestId;
    if (result.entityName) response.entity = result.entityName;
    if (result.id !== undefined) response.id = result.id;
    this.send(response);

    if (activateCore) {
      try {
        await activateCore();
      } catch (err) {
        // A core activation rejection only ever surfaces through the core's
        // terminal removal path, whose revoke callback (when this request still
        // owned the scope) already reported and advanced the generation. If we
        // no longer own the generation — a newer owner superseded us, or the
        // revoke already handled terminal reporting — reporting again here
        // would emit a second terminal frame. Detach and abort only this
        // request's own subscription/controller first (both no-ops when the
        // terminal path already ran), so a rejection without a core revoke
        // still aborts this request's own controller exactly once.
        coreSubscription?.unsubscribe?.();
        requestController?.abort();
        if (!ownsScope()) return;
        this.#coreAcs.delete(scope);
        this.#coreActivations.delete(scope);
        this.#fanout.removeSubscription(scope, this);
        this.#log?.error?.('live', 'core activation failed', { scope, err: String(err) });
        this.error(failure('denied', 'Subscription failed.'), requestId);
        return;
      }
    }
    if (!ownsScope()) {
      // Superseded while our activation ran: the winner already detached our
      // activation (or this no-ops), and the detach came first, so aborting our
      // own controller is an idempotent no-op that cannot reach a revoke. No
      // stale cancellation handle outlives the request.
      coreSubscription?.unsubscribe?.();
      requestController?.abort();
      return;
    }
    if (this.#coreAcs.get(scope) === undefined) return;
    this.#fanout.addSubscription(scope, this, result.fields, result.pace, { ...result.interest, carets: result.carets });
  }

  #close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closePromise = this.#performClose();
    return this.#closePromise;
  }

  async #performClose(): Promise<void> {
    if (this.#closed) return;
    // Remove the connection from the transport registry synchronously. The
    // returned promise still waits for caret retraction and socket cleanup,
    // but callers observing count() during shutdown must not see a closing
    // connection as live. Do not set #closing until after cleanup: send()
    // drops frames while #closing, and shutdown must flush the caret remove
    // before the socket is destroyed. Peer close (opcode 0x8) already sets
    // #closing first so a departing client is not echoed its own retraction.
    this.#onClose?.();
    await this.#cleanup();
    this.#closing = true;
    this.#closed = true;
    try { this.#socket.destroy(); } catch { /* ignore */ }
  }

  async #cleanup(): Promise<void> {
    for (const ac of this.#coreAcs.values()) {
      ac.abort();
    }
    // Connection teardown is terminal for every in-flight request: advance each
    // scope's generation so a pending subscribe continuation never reports or
    // mutates state on a closed connection.
    for (const scope of [...this.#coreGen.keys()]) {
      this.#bumpScopeGen(scope);
    }
    this.#coreAcs.clear();
    this.#coreActivations.clear();
    this.#fanout.removeAll(this);
    await this.#carets?.removeConnection(this).catch(() => {});
  }
}

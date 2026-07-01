// Live-sync — WebSocket subscription + fan-out with re-authorization (SPEC §8).
//
// A live server upgrades WebSocket connections on a configured path, wraps every
// connection with frame parsing/sending, tracks per-entity-row subscriptions, and
// fans out events to authorized subscribers. Re-authorization runs through the
// SAME mayVerb engine the REST dispatch uses — no second auth path.
//
// Message protocol (JSON over WebSocket text frames):
//
//   client → server:
//     { type: 'subscribe', entity, id }
//     { type: 'unsubscribe', entity, id }
//
//   server → client:
//     { type: 'event', entity, id, event }
//     { type: 'error', message }
//
// When an entity row changes (CRUD create/update/delete), the kernel's
// post-commit fan-out loop calls `live.emit(entity, id, row, committedEvent)`
// after commit. The fan-out:
//   1. Finds every subscriber for (entity, id)
//   2. Re-authorizes each via mayVerb(entity, 'subscribe', row, principal) when
//      the entity owns a `.can` body; inherit children are admitted by read-scope
//      at the parent seam.
//   3. Forwards the kernel's committed event (carrying its per-scope seq) to
//      every authorized subscriber
//
// Access to the subscriber's principal is governed by the same auth engine —
// the principal is set on the connection after the HTTP request-level auth
// (or via a connect-time token). The framework owns the /events path;
// an app never mounts it.

import { FrameSender, FrameParser, upgradeWebSocket } from './websocket.mjs';
import { isSameOriginRequest } from './middleware.mjs';
import { anonymous } from './principal.mjs';
import { bindReadScope } from './scope-sql.mjs';
import { hasOwnCanGrant } from './row-grant.mjs';
import { PACE_STRATEGIES, validatePaceSelection } from './field-pace.mjs';
import { computeDelta } from './field-delta.mjs';

// Bounds on subscriptions: a single connection can't register unbounded keys
// (memory DoS), and a scope id can't be an unbounded string (-parse/storage
// cost before any DB work). Failures here reject the ONE message, not the
// connection — a misbehaving client stays connected (it may have other valid
// subscriptions), but can't grow its footprint past the cap.
const MAX_SUBS_PER_CONN = 256;
const MAX_ID_LEN = 256;

// Create a live server on the given HTTP server, upgrading connections on
// `path` (default '/events'). `mayVerb` is the re-authorization engine —
// the same function the REST dispatch uses: mayVerb(entity, verb, row, principal).
// `principalOf` derives a WS connection's principal (default: anonymous).
// `resolveEntity(name)` maps an entity NAME to its compiled record — needed so
// subscribe-time can run bindReadScope + mayVerb (the same engine fan-out uses).
export function createLiveServer(httpServer, {
  path = '/events',
  mayVerb = null,
  principalOf = () => ({ type: 'anonymous', id: null }),
  db = null,
  resolveEntity = null,
} = {}) {
  // Subscription registry: Map<entity, Map<id, Map<conn, SubSpec>>>
  // SubSpec = { fields: object|null, latch: true }
  //   fields — the validated interest object (or null = none declared)
  //   latch  — cached subscribe-time mayVerb decision (emitted per-emit)
  const byEntity = new Map();
  // Per-connection subscription keys (`${entity}:${id}`) — mirrors byEntity so a
  // disconnect can purge in O(subs) without scanning every entity, and so the
  // per-conn cap is O(1) to check.
  const connSubs = new Map();
  const connections = new Set();

  // Coalescing buffers for paced subscribers: Map<bufferKey, {conn, scope, field, events:Array, timer:Timeout|null}>
  // key = `${conn.id}|${scope}|${field}` — scope = `${entity}:${id}`, field = ephemeral field name.
  // SEPARATE from SubSpec (DECISIONLOG #69 F2: folding a draining timer into the registry value
  // re-creates a two-lifetime smell).
  const paceBuffers = new Map();

  // P6e-2: delivery-layer prev-shadow for `.updated` delta computation (DECISIONLOG
  // #71 F1). Per-scope (`${entity}:${id}`), NOT per-conn — committed state shared
  // across subs. Seeded on created/updated, evicted on remove + clear. NOT purged
  // on disconnect (other subs may share the scope).
  const prevState = new Map();
  function prevGet(scope) { return prevState.get(scope) ?? {}; }
  function prevSeed(scope, row) { prevState.set(scope, row); }
  function prevEvict(scope) { prevState.delete(scope); }

  // Flush one paced buffer: re-auth, coalesce, send ONE envelope, then clear.
  // Called from setTimeout. Async with internal error handling (never rejects the
  // timer callback's returned promise).
  async function flushPacedBuffer(key) {
    const entry = paceBuffers.get(key);
    if (!entry) return;
    const { conn, scope, field, events, entityRecord, authzRow } = entry;
    // Clear FIRST — re-entrant safety.
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    paceBuffers.delete(key);
    if (events.length === 0) return;
    if (conn.closed) return;

    // Re-auth (fail-closed): a thrown check or !allowed → drop the buffer silently.
    if (mayVerb && hasOwnCanGrant(entityRecord)) {
      let allowed = true;
      try {
        allowed = await mayVerb(entityRecord, 'subscribe', authzRow, conn.principal ?? anonymous);
      } catch {
        allowed = false;
      }
      if (!allowed) return;
    }

    // Coalesce using the ephemeral kind's logic.
    const kind = PACE_STRATEGIES.ephemeral;
    const coalescer = entry.by ? kind.coalescers[entry.by] : null;
    const coalesced = coalescer ? events.reduce(coalescer) : events[events.length - 1];
    const span = kind.reduceSpan(events);
    const [entityName, idStr] = scope.split(':');
    conn.send({
      type: 'event', entity: entityName, id: idStr,
      seq: span.seq, seqSpan: span.seqSpan, event: coalesced,
    });
  }

  // The per-scope committed seq from the kernel's `_Cursor`. Reported on subscribe
  // so a client can detect the snapshot-vs-live race: if the server's currentSeq
  // is ahead of the client's bootstrap cursor, the client resyncs the gap before
  // going live (never misses an event committed between snapshot read and
  // subscribe). The log is the single seq source — no second counter (D7).
  const currentSeq = (scope) => {
    if (!db) return 0;
    const row = db.prepare('SELECT lastSeq FROM _Cursor WHERE scope = ?').get(scope);
    return row ? row.lastSeq : 0;
  };

  // A live connection wraps one upgraded WebSocket socket.
  class LiveConnection {
    #socket;
    #sender;
    #parser;
    #id;
    #closed = false;
    #principal;

    constructor(socket, id) {
      this.#socket = socket;
      this.#sender = new FrameSender();
      this.#parser = new FrameParser();
      this.#id = id;
      this.#principal = null;

      socket.on('data', (chunk) => {
        this.#parser.feed(chunk);
        this.#drain();
      });

      socket.on('error', () => this.#close());
      socket.on('end', () => this.#close());
      socket.on('close', () => this.#close());
    }

    get id() { return this.#id; }
    get closed() { return this.#closed; }
    get principal() { return this.#principal; }

    setPrincipal(p) {
      this.#principal = p;
    }

    // Send a JSON message to the client over a WebSocket text frame.
    send(data) {
      if (this.#closed) return;
      try {
        this.#socket.write(this.#sender.text(JSON.stringify(data)));
      } catch {
        this.#close();
      }
    }

    // Send an error to the client (still a valid text frame).
    error(message) {
      this.send({ type: 'error', message });
    }

    #drain() {
      const msgs = this.#parser.drainMessages();
      for (const msg of msgs) {
        if (msg.opcode === 0x8) {
          // Client-initiated close — acknowledge with a close frame, then tear
          // the TCP socket down. Writing the close frame WITHOUT destroying the
          // socket leaves the connection half-open: a well-behaved WS client
          // (e.g. undici's WebSocket) waits for the TCP FIN before releasing its
          // socket handle, so a bare #cleanup() here leaks the client socket for
          // the OS keep-alive lifetime. Route through #close() so the socket is
          // destroyed (idempotent — #closed guards double-entry).
          try { this.#socket.write(this.#sender.close(msg.closeCode ?? 1000, msg.closeReason)); } catch { /* ignore */ }
          this.#close();
          return;
        }
        if (msg.opcode === 0x1) {
          // Text message — try to parse as JSON protocol.
          try {
            const parsed = JSON.parse(msg.payload.toString('utf-8'));
            this.#handleMessage(parsed);
          } catch {
            this.error('invalid JSON');
          }
        }
        if (msg.opcode === -1) {
          this.error(msg.error);
        }
      }

      // Ping → pong (automatic keepalive)
      const pongs = this.#parser.drainPongs();
      for (const payload of pongs) {
        try { this.#socket.write(this.#sender.pong(payload)); } catch { this.#close(); }
      }
    }

    #handleMessage(msg) {
      if (!msg || typeof msg !== 'object') return;
      switch (msg.type) {
        case 'subscribe':
          // Authorized by the SAME engine as fan-out (bindReadScope + mayVerb
          // 'subscribe'), run BEFORE the subscription is stored or the cursor is
          // revealed. #handleMessage is sync, so dispatch the async authorizer and
          // treat any rejection as a denial (uniform — no existence leak).
          this.#authorizeAndSubscribe(msg).catch(() => this.error('forbidden'));
          break;
        case 'unsubscribe':
          if (typeof msg.entity === 'string' && msg.id !== undefined) {
            removeSubscription(msg.entity, String(msg.id), this);
            this.send({ type: 'unsubscribed', entity: msg.entity, id: msg.id });
          }
          break;
        default:
          this.error(`unknown message type: ${msg.type}`);
      }
    }

    // One admission decision for subscribe: load the row under the principal's
    // read-scope, then run mayVerb('subscribe') on the HYDRATED row (a `.can`
    // body may read a struct like entity.linkShare.tier, which a raw SELECT row
    // lacks). Denials are uniform (`forbidden`) and NEVER return currentSeq — an
    // unknown entity, an out-of-scope row, and a `.can`-denied principal all
    // look identical to the client (no existence/activity oracle). Scope-only /
    // bare grants (hasOwnCanGrant false) are admitted by scope alone — the same
    // rule authorizeRead, the list filter, and the create hook apply, so one
    // engine decides across every path.
    async #authorizeAndSubscribe(msg) {
      if (typeof msg.entity !== 'string' || msg.id === undefined) {
        this.error('subscribe requires entity (string) and id');
        return;
      }
      const idStr = String(msg.id);
      if (idStr.length > MAX_ID_LEN) { this.error('subscribe id too long'); return; }
      const key = `${msg.entity}:${idStr}`;
      const mine = connSubs.get(this);
      if (mine && mine.size >= MAX_SUBS_PER_CONN && !mine.has(key)) {
        this.error('too many subscriptions');
        return;
      }
      if (!resolveEntity || !mayVerb || !db) { this.error('forbidden'); return; }
      const entity = resolveEntity(msg.entity);
      if (!entity) { this.error('forbidden'); return; }

      // Validate optional fields interest (P6e-1b).
      let fields = null;
      if (msg.fields !== undefined && msg.fields !== null) {
        // Must be a plain object (not array, not string, not function).
        if (typeof msg.fields !== 'object' || msg.fields === null || Array.isArray(msg.fields)) {
          this.error('invalid fields interest');
          return;
        }
        // Reject closures (data-not-code — SPEC §8).
        if (typeof msg.fields === 'function') {
          this.error('fields interest must be data, not a closure');
          return;
        }
        for (const [key, value] of Object.entries(msg.fields)) {
          if (typeof value === 'function') {
            this.error('fields interest must be data, not a closure');
            return;
          }
          // Each field-key must be a declared field on the entity.
          if (!entity.fields || !(key in entity.fields)) {
            this.error(`unknown field ${key} in interest`);
            return;
          }
          // In B1 the value must be `true` (whole-field). Reject coordinate
          // narrowing (range, in, is) — deferred to P6e-3.
          if (value !== true) {
            this.error('coordinate narrowing not yet supported');
            return;
          }
        }
        fields = msg.fields;
      }

      // Validate optional pace/coalescing (P6e-1b B2).
      let pace = null;
      if (msg.pace !== undefined && msg.pace !== null) {
        try {
          pace = validatePaceSelection('ephemeral', msg.pace);
        } catch (err) {
          this.error(err.message);
          return;
        }
      }

      const principal = this.#principal ?? anonymous;
      const bound = bindReadScope(entity.readScope, principal);
      const where = bound ? bound.sql : '1=1';
      const scopeParams = bound ? bound.params : {};
      let row;
      try {
        row = db
          .prepare(`SELECT * FROM ${entity.name} AS t0 WHERE ${where} AND t0.id = :id`)
          .get({ ...scopeParams, id: idStr });
      } catch {
        this.error('forbidden');
        return;
      }
      if (!row) { this.error('forbidden'); return; }
      if (hasOwnCanGrant(entity)) {
        let allowed = true;
        try {
          const hydrated = entity.hydrate ? entity.hydrate(row, principal) : row;
          allowed = await mayVerb(entity, 'subscribe', hydrated, principal);
        } catch {
          allowed = false;
        }
        if (!allowed) { this.error('forbidden'); return; }
      }
      addSubscription(msg.entity, idStr, this, fields, pace);
      this.send({
        type: 'subscribed', entity: msg.entity, id: msg.id,
        currentSeq: currentSeq(key),
      });
    }

    #close() {
      if (this.#closed) return;
      this.#closed = true;
      this.#cleanup();
      try { this.#socket.destroy(); } catch { /* ignore */ }
    }

    #cleanup() {
      removeAll(this);
      connections.delete(this);
    }
  }

  // Subscription helpers
  function addSubscription(entity, id, conn, fields = null, pace = null) {
    if (!byEntity.has(entity)) byEntity.set(entity, new Map());
    const byId = byEntity.get(entity);
    if (!byId.has(id)) byId.set(id, new Map());
    byId.get(id).set(conn, { fields, latch: true, pace });
    let mine = connSubs.get(conn);
    if (!mine) { mine = new Set(); connSubs.set(conn, mine); }
    mine.add(`${entity}:${id}`);
  }

  function removeSubscription(entity, id, conn) {
    const byId = byEntity.get(entity);
    if (byId) {
      const subs = byId.get(id);
      if (subs) {
        subs.delete(conn);
        if (subs.size === 0) byId.delete(id);
        if (byId.size === 0) byEntity.delete(entity);
      }
    }
    const mine = connSubs.get(conn);
    if (mine) {
      mine.delete(`${entity}:${id}`);
      if (mine.size === 0) connSubs.delete(conn);
    }
  }

  function removeAll(conn) {
    const mine = connSubs.get(conn);
    if (!mine) return;
    for (const key of mine) {
      const sep = key.indexOf(':');
      const entity = key.slice(0, sep);
      const id = key.slice(sep + 1);
      const byId = byEntity.get(entity);
      if (!byId) continue;
      const subs = byId.get(id);
      if (!subs) continue;
      subs.delete(conn);
      if (subs.size === 0) byId.delete(id);
      if (byId.size === 0) byEntity.delete(entity);
    }
    connSubs.delete(conn);
    // Purge all pacing buffers for this connection (conn.id is part of buffer key).
    for (const [bufKey, entry] of paceBuffers) {
      if (entry.conn === conn) {
        if (entry.timer !== null) { clearTimeout(entry.timer); entry.timer = null; }
        paceBuffers.delete(bufKey);
      }
    }
  }

  // Fan-out: forward a committed kernel event to every authorized subscriber of
  // (entity, id). `entity` is the compiled entity RECORD — mayVerb needs it to
  // run the grant's `.can` body. For 'created'/'updated', the row is re-read +
  // HYDRATED here (a raw SELECT row lacks the assembled struct namespace that
  // `.can` bodies read, e.g. `entity.linkShare.tier`); hydration via findById
  // also re-reads the post-commit materialized state. For 'removed', the row is
  // gone (the consumer passes `undefined`) — re-authorization is SKIPPED and the
  // remove event forwards to every current subscriber (it IS the revocation
  // signal). `committedEvent` is the kernel's event — its `seq` is the per-scope
  // monotonic seq from `_Cursor`, and `data` is the mutation payload. The client
  // receives the SAME committed-event shape it would replay from the log on
  // subscribe-since resync — one event shape, one seq source, one dedupe (the
  // kernel's). live is a post-commit projection consumer, not a second path
  // (SPEC §7, §7.1; eng-review §D2/D3 — subtract before add at the post-commit
  // seam).
  async function emit(entityRecord, id, row, committedEvent) {
    const name = entityRecord?.name;
    if (!name) return;                       // unknown entity → can't authorize → fail closed
    const byId = byEntity.get(name);
    if (!byId) return;
    const subs = byId.get(String(id));
    if (!subs) return;

    const removed = row === undefined;       // removed → row gone post-commit
    // Hydrate so .can bodies reading entity.<struct>.* resolve. Falls back to
    // the raw row when hydration is unavailable (unchanged behavior for simple
    // entities whose .can body reads only `is.*`).
    let authzRow = row;
    if (!removed && entityRecord.findById) {
      try { authzRow = entityRecord.findById(String(id), null) ?? row; } catch { authzRow = row; }
    }

    // Determine if this is an ephemeral field event that requires opt-in.
    // An ephemeral event has type `<Entity>.<field>.set` where `<field>` is a
    // declared ephemeral field. Split on `.`; 3 parts → Entity.field.set.
    let ephemeralField = null;
    if (!removed) {
      const parts = committedEvent.type?.split('.');
      if (parts?.length === 3 && parts[2] === 'set') {
        const fieldName = parts[1];
        const fd = entityRecord.fields?.[fieldName];
        if (fd?.kind === 'ephemeral') {
          ephemeralField = fieldName;
        }
      }
    }

    // P6e-2: compute per-field delta for `.updated` events (DECISIONLOG #71 F1).
    // Delta is per-(scope, event) — same for all subs, computed once. Computed from
    // the hydrated authzRow (committed state) vs the prior committed shadow. A cold
    // shadow → set-from-empty delta (NOT a whole-state bootstrap event — #71 F2
    // dual-reconciliation-path trap). `delta` attaches alongside `event.data` (one-path
    // backward-compat, #71 F5). removed → evict shadow (delete-then-recreate safety,
    // #71 risk #3). created → seed (no delta envelope — created already carries whole
    // state, #71 F5). 3-part/ephemeral/store/ordered events → no delta (B2 normalizes
    // store/ordered; ephemeral is 1b's paced path).
    const scope = `${name}:${String(id)}`;
    let delta = undefined;
    if (removed) {
      prevEvict(scope);
    } else {
      const parts = committedEvent.type?.split('.');
      if (parts?.length === 2 && parts[1] === 'updated') {
        const prev = prevGet(scope);
        const changed = Object.keys(committedEvent.data ?? {}).filter((k) => k !== 'id');
        delta = computeDelta(entityRecord, prev, authzRow, changed);
        prevSeed(scope, authzRow);
      } else if (parts?.length === 2 && parts[1] === 'created') {
        prevSeed(scope, authzRow);
      } else if (parts?.length === 3 && ephemeralField === null) {
        // P6e-2 B2: store/ordered native events are delta-native — their event.data
        // IS the structural delta (no diff computed, #71 risk #7). Normalize under
        // the same `delta` map key so a client dispatches one uniform delta shape
        // regardless of kind. (ephemeralField===null excludes the paced ephemeral
        // .set, which is 1b's path — its delta stays undefined.)
        delta = { [parts[1]]: committedEvent.data };
      }
    }

    for (const [conn, subSpec] of subs) {
      if (conn.closed) {
        subs.delete(conn);
        continue;
      }
      if (mayVerb && hasOwnCanGrant(entityRecord) && !removed) {
        // AWAIT — the bypass bug was calling mayVerb without await, so the
        // returned Promise was always truthy and the `!allowed` guard never
        // fired. The SAME mayVerb the REST dispatch uses (verb='subscribe') —
        // no second auth path.
        let allowed = true;
        try {
          allowed = await mayVerb(entityRecord, 'subscribe', authzRow, conn.principal ?? anonymous);
        } catch {
          allowed = false;                   // a thrown check fails closed
        }
        if (!allowed) continue;
      }
      // Interest filter for ephemeral events: deliver ONLY if the subscriber's
      // SubSpec.fields includes the ephemeral field. Pass-through events
      // (created/updated/removed/collection) and removed events are delivered
      // to ALL subscribers (unchanged from P6e-1a).
      if (ephemeralField !== null) {
        const interest = subSpec?.fields;
        if (!interest || interest[ephemeralField] !== true) continue;
      }

      // Determine effective pace for this subscriber + field.
      // Only ephemeral field events may be paced; pass-through/removed events
      // and subscribers without pace always use window=0.
      let pace = { window: 0, by: null };
      if (ephemeralField !== null && subSpec?.pace !== null && subSpec?.pace !== undefined) {
        pace = subSpec.pace;
      }

      // ONE paced emit path: window=0 = pass-through (flush-on-receive, inline);
      // window>0 = enqueue + timer (coalesced on flush).
      if (pace.window === 0) {
        // Pass-through: send immediately with single-event seqSpan.
        const envelope = {
          type: 'event', entity: name, id, seq: committedEvent.seq,
          seqSpan: [committedEvent.seq, committedEvent.seq],
          event: committedEvent,
        };
        if (delta !== undefined) envelope.delta = delta;
        conn.send(envelope);
      } else {
        // Paced: enqueue into per-(conn, scope, field) buffer.
        const scope = `${name}:${String(id)}`;
        const bufKey = `${conn.id}|${scope}|${ephemeralField}`;
        let entry = paceBuffers.get(bufKey);
        if (!entry) {
          entry = {
            conn,
            scope,
            field: ephemeralField,
            events: [],
            timer: null,
            by: pace.by,
            entityRecord,
            authzRow,
          };
          paceBuffers.set(bufKey, entry);
        }
        entry.events.push(committedEvent);
        // Refresh authzRow with latest re-read so flush-time re-auth is current.
        entry.authzRow = authzRow;
        if (entry.timer === null) {
          entry.timer = setTimeout(() => flushPacedBuffer(bufKey), pace.window);
        }
      }
    }
  }

  // Count of active connections (for tests).
  function count() {
    return connections.size;
  }

  function close() {
    for (const conn of connections) {
      try { conn.close?.(); } catch { /* ignore */ }
    }
    byEntity.clear();
    connections.clear();
    // Purge any remaining pacing buffers + timers.
    for (const [, entry] of paceBuffers) {
      if (entry.timer !== null) { clearTimeout(entry.timer); entry.timer = null; }
    }
    paceBuffers.clear();
    prevState.clear();
  }

  // Attach the upgrade handler.
  httpServer.on('upgrade', (req, socket, head) => {
    // Only upgrade on the configured path.
    const url = req.url ? new URL(req.url, 'http://localhost') : { pathname: '' };
    if (url.pathname !== path) {
      socket.destroy();
      return;
    }

    // Cross-Site WebSocket Hijacking (CSWSH) defense — the SAME same-origin
    // verdict the REST CSRF guard uses (middleware.mjs). A browser ALWAYS
    // attaches Origin to a cross-origin WS handshake, so a foreign Origin here
    // is an attacker page connecting on the victim's cookies; reject it. An
    // absent Origin is a non-browser client (no CSWSH vector) → allowed.
    if (!isSameOriginRequest(req)) {
      socket.destroy();
      return;
    }

    const result = upgradeWebSocket(req, socket);
    if (!result) {
      socket.destroy();
      return;
    }

    const id = `ws:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
    const conn = new LiveConnection(socket, id);
    conn.setPrincipal(principalOf(req));
    connections.add(conn);
  });

  return { emit, count, close };
}

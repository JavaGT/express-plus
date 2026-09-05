// Fake Workbench CRUD server for outbox tests (#183).
//
// Implements the M1 conflict/merge policy per field kind (docs/conflict-merge-policy.md)
// so durable outbox resends can be tested against realistic concurrent/offline
// outcomes:
//   value   — whole-value replace (last commit wins), silent
//   map     — merge {added, removed, changed}; idempotent re-set is a client no-op
//   ordered — coexist for distinct ids (insert after a given id, no renumber)
// plus optional per-row optimistic concurrency: `expectedRevision` mismatch →
// 409 `conflict` (the live-tier fail-closed rule).
//
// The server dedupes per (scope, actionId): a resend replays the stored
// receipt (same seq, same row) without re-running the handler.
//
// Transport shape matches decodeResult: { ok, status, headers: {get}, json }.
// Committed events fan out through `onCommit` (wire it to a fake channel's
// emit for live delivery). Snapshot + events-since routes serve LiveList.

const FAILURE = {
  denied: () => ({ category: 'denied', message: 'forbidden' }),
  notFound: () => ({ category: 'not-found', message: 'not found' }),
  invalid: (message) => ({ category: 'invalid-input', message }),
  conflict: (message) => ({ category: 'conflict', message }),
};

function response(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  };
}

// The real server serializes rows; handing the client a live object would
// alias server state into client state and fake convergence.
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

export function makeCrudServer({
  entity = 'Todo',
  path = '/todos',
  kinds = {},          // field name → 'value' | 'map' | 'ordered'
} = {}) {
  const state = {
    rows: new Map(),          // id → row (plain object, includes id)
    revisions: new Map(),     // id → per-row revision (live-tier OCC)
    scopeSeqs: new Map(),     // scope → last per-scope seq
    events: new Map(),        // scope → [{ seq, type, data, actionId, delta }]
    receiptsByAction: new Map(), // actionId → receipt (dedupe identity)
    handlerRuns: new Map(),   // actionId → handler invocations (dedupe proof)
    requests: [],             // [{ method, url, actionId, body }]
    nextRowId: 1,
    nextServerActionId: 1,
    revoked: false,           // simulated grant revocation → 403
    validate: null,           // (payload, row|null) → { message } | null → 422
    paused: false,
    onCommit: null,           // (envelope) => void — live delivery hook
  };

  function scopeOf(id) { return `${entity}:${id}`; }

  function nextSeq(scope) {
    const seq = (state.scopeSeqs.get(scope) ?? 0) + 1;
    state.scopeSeqs.set(scope, seq);
    return seq;
  }

  function emit(envelope) {
    if (state.onCommit) state.onCommit(envelope);
  }

  function commit(scope, id, type, data, actionId, delta, { status = 200, body = null } = {}) {
    const seq = nextSeq(scope);
    const row = state.rows.get(id) ?? null;
    const receipt = { seq, row: clone(row), status, body: clone(body), revision: state.revisions.get(id) ?? null };
    state.receiptsByAction.set(actionId, receipt);
    const history = state.events.get(scope) ?? [];
    history.push({ seq, type, data: clone(data), actionId, delta: clone(delta) });
    state.events.set(scope, history);
    emit({
      type: 'event',
      entity,
      id,
      seq,
      seqSpan: [seq, seq],
      event: { type, data: clone(data), actionId },
      delta: clone(delta),
    });
    return receipt;
  }

  function replay(receipt, actionId) {
    // Dedupe: same (scope, actionId) returns the stored outcome without
    // re-running the handler and without re-emitting.
    return response(receipt.status ?? 200, receipt.body, commitHeaders(actionId, receipt.seq));
  }

  function commitHeaders(actionId, seq) {
    const headers = { 'x-workbench-action-id': actionId };
    if (seq != null) headers['x-workbench-seq'] = String(seq);
    return headers;
  }

  function fail(status, failure) {
    return response(status, { ok: false, failure });
  }

  function guardRevoked() {
    return state.revoked ? fail(403, FAILURE.denied()) : null;
  }

  function guardValidate(payload, row) {
    if (!state.validate) return null;
    const message = state.validate(payload, row);
    return message ? fail(422, FAILURE.invalid(message)) : null;
  }

  /** Simulate another client's committed write while our entry is queued. */
  function remoteUpdate(id, changes, actionId = `remote-${state.nextServerActionId++}`) {
    const row = state.rows.get(id);
    if (!row) throw new Error(`remoteUpdate: no row ${id}`);
    const data = {};
    for (const [field, value] of Object.entries(changes)) {
      data[field] = value;
      row[field] = value;
    }
    state.revisions.set(id, (state.revisions.get(id) ?? 0) + 1);
    commit(scopeOf(id), id, `${entity}.updated`, data, actionId);
    return row;
  }

  /** Simulate another client's committed map write while our entry is queued. */
  function remoteMapUpdate(id, field, patch, actionId = `remote-${state.nextServerActionId++}`) {
    const row = state.rows.get(id);
    if (!row) throw new Error(`remoteMapUpdate: no row ${id}`);
    const merged = { ...(row[field] ?? {}) };
    const delta = {};
    if (patch.added) {
      for (const entry of patch.added) merged[entry.member] = entry.role;
      delta.added = patch.added;
    }
    if (patch.changed) {
      for (const entry of patch.changed) merged[entry.member] = entry.role;
      delta.changed = patch.changed;
    }
    if (patch.removed) {
      for (const member of patch.removed) delete merged[member];
      delta.removed = patch.removed;
    }
    row[field] = merged;
    state.revisions.set(id, (state.revisions.get(id) ?? 0) + 1);
    commit(scopeOf(id), id, `${entity}.updated`, { [field]: merged }, actionId, { [field]: delta });
    return row;
  }

  /** Simulate another client's committed ordered-list insert (distinct id). */
  function remoteOrderedInsert(id, field, insertId, after = null, actionId = `remote-${state.nextServerActionId++}`) {
    const row = state.rows.get(id);
    if (!row) throw new Error(`remoteOrderedInsert: no row ${id}`);
    const list = [...(row[field] ?? [])];
    if (!list.includes(insertId)) {
      const at = after != null ? list.indexOf(after) + 1 : list.length;
      list.splice(at, 0, insertId);
    }
    row[field] = list;
    state.revisions.set(id, (state.revisions.get(id) ?? 0) + 1);
    commit(scopeOf(id), id, `${entity}.updated`, { [field]: list }, actionId);
    return row;
  }

  async function fetch(url, opts = {}) {
    while (state.paused) await new Promise((resolve) => setTimeout(resolve, 5));
    const urlStr = String(url);
    const method = (opts.method ?? 'GET').toUpperCase();
    const actionId = opts.headers?.['x-workbench-action-id'] ?? `server-${state.nextServerActionId++}`;
    const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : null;

    // --- reads (snapshot + events-since) ---
    const snapshotMatch = urlStr.match(new RegExp(`/snapshot/${entity}/([^/?]+)`));
    if (snapshotMatch) {
      const id = decodeURIComponent(snapshotMatch[1]);
      const row = state.rows.get(id) ?? null;
      return response(200, { snapshot: clone(row), seq: state.scopeSeqs.get(scopeOf(id)) ?? 0 });
    }
    const eventsMatch = urlStr.match(new RegExp(`/events-since/${entity}/([^/?]+)`));
    if (eventsMatch) {
      const id = decodeURIComponent(eventsMatch[1]);
      const cursor = Number(new URL(urlStr, 'http://x').searchParams.get('cursor') ?? 0);
      const history = state.events.get(scopeOf(id)) ?? [];
      return response(200, {
        events: history
          .filter((row) => row.seq > cursor)
          .map(({ seq, type, data, actionId: rowActionId, delta }) => ({ seq, type, data: clone(data), actionId: rowActionId, delta: clone(delta) })),
      });
    }

    if (method === 'POST' && urlStr.endsWith(path)) {
      state.requests.push({ method, url: urlStr, actionId, body });
      const rejected = guardRevoked() ?? guardValidate(body, null);
      if (rejected) return rejected;
      const prior = state.receiptsByAction.get(actionId);
      if (prior) return replay(prior, actionId);
      state.handlerRuns.set(actionId, (state.handlerRuns.get(actionId) ?? 0) + 1);
      const id = `r${state.nextRowId++}`;
      const row = { id, ...body };
      state.rows.set(id, row);
      state.revisions.set(id, 1);
      const receipt = commit(scopeOf(id), id, `${entity}.created`, row, actionId, undefined, {
        status: 201,
        body: clone(row),
      });
      return response(201, clone(receipt.body), commitHeaders(actionId, receipt.seq));
    }

    const idMatch = urlStr.match(new RegExp(`${path}/([^/]+)$`));
    if (idMatch) {
      const id = decodeURIComponent(idMatch[1]);
      state.requests.push({ method, url: urlStr, actionId, body });
      const row = state.rows.get(id);
      if (!row) return fail(404, FAILURE.notFound());
      const rejected = guardRevoked() ?? guardValidate(body, row);
      if (rejected) return rejected;
      if (method === 'PATCH') {
        if (body?.expectedRevision != null && body.expectedRevision !== state.revisions.get(id)) {
          return fail(409, FAILURE.conflict('stale revision: row changed concurrently'));
        }
        const prior = state.receiptsByAction.get(actionId);
        if (prior) return replay(prior, actionId);
        state.handlerRuns.set(actionId, (state.handlerRuns.get(actionId) ?? 0) + 1);
        const data = {};
        const delta = {};
        for (const [field, value] of Object.entries(body ?? {})) {
          if (field === 'id' || field === 'expectedRevision') continue;
          const kind = kinds[field] ?? 'value';
          if (kind === 'map') {
            const merged = { ...(row[field] ?? {}) };
            const fieldDelta = {};
            if (value.added) {
              for (const entry of value.added) merged[entry.member] = entry.role;
              fieldDelta.added = value.added;
            }
            if (value.changed) {
              for (const entry of value.changed) merged[entry.member] = entry.role;
              fieldDelta.changed = value.changed;
            }
            if (value.removed) {
              for (const member of value.removed) delete merged[member];
              fieldDelta.removed = value.removed;
            }
            row[field] = merged;
            data[field] = merged;   // whole value in data…
            delta[field] = fieldDelta; // …but the delta owns the fold
          } else if (kind === 'ordered') {
            // { insert: { id, after } } — distinct ids coexist, no renumber.
            const list = [...(row[field] ?? [])];
            const insertId = value.insert.id;
            if (!list.includes(insertId)) {
              const at = value.insert.after != null
                ? list.indexOf(value.insert.after) + 1
                : list.length;
              list.splice(at, 0, insertId);
            }
            row[field] = list;
            data[field] = list;
          } else {
            // value: whole-value replace — last commit wins, silent.
            row[field] = value;
            data[field] = value;
          }
        }
        state.revisions.set(id, (state.revisions.get(id) ?? 0) + 1);
        const receipt = commit(scopeOf(id), id, `${entity}.updated`, data, actionId, delta, {
          status: 200,
          body: clone(row),
        });
        return response(200, clone(receipt.body), commitHeaders(actionId, receipt.seq));
      }
      if (method === 'DELETE') {
        const prior = state.receiptsByAction.get(actionId);
        if (prior) return replay(prior, actionId);
        state.handlerRuns.set(actionId, (state.handlerRuns.get(actionId) ?? 0) + 1);
        state.rows.delete(id);
        state.revisions.delete(id);
        const receipt = commit(scopeOf(id), id, `${entity}.removed`, { id }, actionId, undefined, {
          status: 204,
          body: undefined,
        });
        return response(204, undefined, commitHeaders(actionId, receipt.seq));
      }
    }

    return response(404, { error: 'not found' });
  }

  return {
    fetch,
    state,
    // `onCommit` lives on `state` (emit() reads it); expose it as a property
    // so `server.onCommit = fn` works.
    get onCommit() { return state.onCommit; },
    set onCommit(fn) { state.onCommit = fn; },
    remoteUpdate,
    remoteMapUpdate,
    remoteOrderedInsert,
  };
}

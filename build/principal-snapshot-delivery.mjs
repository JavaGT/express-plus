import { principalSnapshotScope, parsePrincipalSnapshotScope } from './principal-snapshot-scope.mjs';
import { isPrincipalSnapshotDeclaration,                                   } from './principal-snapshot-declaration.mjs';


const PRINCIPAL_PREFIX = 'PrincipalSnapshot:';

export function isPrincipalSnapshotScope(scope         )          {
  return typeof scope === 'string' && scope.startsWith(PRINCIPAL_PREFIX);
}

export function validatePrincipalSnapshotDeclarations(
  declarations                                            ,
  schema                                                                                ,
)       {
  if (declarations === undefined) return;
  if (!Array.isArray(declarations)) throw new TypeError('principalSnapshots must be an array');
  if (!schema || !Array.isArray(schema.tables)) throw new Error('principal snapshots require an application schema');
  const names = new Set        ();
  const tables = new Map                     (schema.tables.map((table) => [table.name, new Set(table.columns.map((column) => column.name))]));
  for (const declaration of declarations) {
    if (!isPrincipalSnapshotDeclaration(declaration)) throw new TypeError('principalSnapshots accepts only principalSnapshot(...) declarations');
    if (names.has(declaration.name)) throw new Error(`principal snapshot '${declaration.name}' is declared more than once`);
    names.add(declaration.name);
    for (const collection of Object.values(declaration.fields)) {
      if (collection.source .schema !== schema) throw new Error(`principal snapshot source '${collection.source .table}' must use the application schema`);
      const columns = tables.get(collection.source .table);
      if (!columns) throw new Error(`principal snapshot source table '${collection.source .table}' must be declared in the application schema`);
      for (const field of [collection.via, collection.key, ...(collection.select ?? []), ...(collection.orderBy ?? [])]) {
        if (!columns.has(field .column)) throw new Error(`principal snapshot source column '${field .column}' must be declared on '${collection.source .table}'`);
      }
    }
  }
}

function quote(name        ) {
  return `"${name.replace(/"/g, '""')}"`;
}

function jsonValue(value         , path        )                                   {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new TypeError(`${path} is not a JSON value`);
}






// The circumstances under which a principal snapshot may be projected. Each
// entry point names the trigger it is re-authorizing so an app implementation
// can distinguish one-shot reads from long-lived subscription maintenance.








/**
 * The package-owned reauthorization seam for principal snapshots. Admission on
 * declaration grammar alone (name + principal type + id) is a scope-level gate;
 * the host's own authorization/membership state lives HERE. The delivery
 * invokes the authorizer BEFORE every recipient projection: bootstrap,
 * catch-up, subscription admission, and each replacement/resync drain. A denial
 * fails closed — the request/subscription is revoked and no replacement
 * projection is ever delivered to the denied principal. An authorizer error or
 * a non-true result is a denial, never an admit. With NO authorizer supplied,
 * every access is denied (fail closed): a deployment that attaches principal
 * snapshots MUST declare one. Scope supplies a membership-aware
 * implementation.
 */


















































































function revisionFor(db          , declaration                              , principal                            )         {
  const row = db.prepare(
    'SELECT revision FROM _PrincipalSnapshotRevision WHERE declaration = ? AND principalType = ? AND principalId = ?',
  ).get(declaration.name, principal.type, principal.id)                                      ;
  return Number(row?.revision ?? 0);
}

function project(db          , declaration                              , principal                            )                          {
  const output                                                               = {};
  for (const [name, collection] of Object.entries(declaration.fields)) {
    const selected = collection.select .map((field) => field.column);
    const columns = selected.includes(collection.key .column) ? selected : [...selected, collection.key .column];
    const ordering = collection.orderBy?.length
      ? collection.orderBy.map((field) => `${quote(field.column)} ${field.direction === 'desc' ? 'DESC' : 'ASC'}`).join(', ')
      : `${quote(collection.key .column)} ASC`;
    const sql = `SELECT ${columns.map(quote).join(', ')} FROM ${quote(collection.source .table)} WHERE ${quote(collection.via .column)} = ? ORDER BY ${ordering}`;
    const rows = db.prepare(sql).all(principal.id).map((raw, rowIndex) => {
      const row                          = {};
      for (const column of columns) row[column] = jsonValue(raw[column], `${name}[${rowIndex}].${column}`);
      return Object.freeze(row);
    });
    output[name] = Object.freeze(rows);
  }
  return Object.freeze(output);
}

function resolution(
  declarations                                           ,
  principal                                               ,
  scope        ,
)                                   {
  let parsed;
  try {
    parsed = parsePrincipalSnapshotScope(scope);
  } catch {
    return null;
  }
  const declaration = declarations.get(parsed.declaration);
  if (!declaration || principal?.type !== parsed.type || principal?.id !== parsed.id || declaration.principalType !== parsed.type) return null;
  return Object.freeze({ declaration, principal: Object.freeze({ type: parsed.type, id: parsed.id }) });
}

export function createPrincipalSnapshotDelivery({ db, declarations, authorize }



 )                            {
  if (!db) throw new TypeError('principal snapshot delivery requires a database');
  const database = db;
  // Fail closed when the host supplied no reauthorization seam: a
  // principal-snapshot deployment MUST declare one (see
  // PrincipalSnapshotAuthorize). Absent it, no principal is ever admitted.
  const authorizer = authorize ?? null;
  const byName = new Map                                      ();
  for (const declaration of declarations ?? []) {
    if (!isPrincipalSnapshotDeclaration(declaration) || byName.has(declaration.name)) {
      throw new TypeError('principal snapshot delivery requires unique valid declarations');
    }
    byName.set(declaration.name, declaration);
  }
  const subs = new Map                                            ();
  const byScope = new Map                     ();
  let nextId = 1;
  let closed = false;

  // Host reauthorization before any recipient projection. Strictly `true`
  // admits; a denial, an authorizer error, or a non-true result all fail
  // closed.
  async function authorized(input                              )                   {
    if (!authorizer) return false;
    try {
      return await authorizer(input) === true;
    } catch {
      return false;
    }
  }

  function pairedSnapshot(resolved                           )                                                                 {
    // Both reads are synchronous. The fence prevents returning source rows from a
    // different recipient revision if a host transaction interleaves between them.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = revisionFor(database, resolved.declaration, resolved.principal);
      const snapshot = project(database, resolved.declaration, resolved.principal);
      const after = revisionFor(database, resolved.declaration, resolved.principal);
      if (before === after) return Object.freeze({ kind: 'snapshot', snapshot, cursor: after });
    }
    return Object.freeze({ kind: 'retry' });
  }

  // Singular lifecycle: every removal path (abort signal, drain failure, close)
  // flows through here. It marks the subscription inactive, detaches its abort
  // listener, removes it from the registries, then invokes the transport revoke
  // exactly once so the SSE stream ends and its capacity is released. The
  // subs.get guard makes later removals, aborts, and close() calls no-ops, so
  // nothing double-releases.
  function remove(id        ) {
    const sub = subs.get(id);
    if (!sub) return;
    sub.active = false;
    if (sub.signal && sub.abort) sub.signal.removeEventListener('abort', sub.abort);
    subs.delete(id);
    const scopeSubs = byScope.get(sub.scope);
    scopeSubs?.delete(id);
    if (scopeSubs?.size === 0) byScope.delete(sub.scope);
    try {
      sub.revoke?.();
    } catch {
      // Transport lifecycle callbacks are isolated.
    }
  }

  async function drain(id        ) {
    const sub = subs.get(id);
    if (!sub || !sub.active || sub.pending) return;
    sub.pending = true;
    try {
      while (sub.active) {
        sub.dirty = false;
        const revision = revisionFor(database, sub.declaration, sub.principal);
        if (revision > sub.cursor) {
          // Reauthorize BEFORE the replacement projection. A denial revokes
          // the subscription here (remove -> revoke) so no resync envelope is
          // ever delivered to a principal the host no longer admits.
          if (!(await authorized({ declaration: sub.declaration, principal: sub.principal, trigger: 'resync' }))) {
            remove(id);
            return;
          }
          await sub.deliver([{ type: 'resync', seq: revision, reason: 'recipient-snapshot-required' }]);
          if (!sub.active) return;
          sub.cursor = revision;
        }
        if (!sub.dirty) return;
      }
    } catch (error) {
      remove(id);
      throw error;
    } finally {
      const current = subs.get(id);
      if (current) {
        current.pending = false;
        if (current.active && current.dirty) void drain(id).catch(() => {});
      }
    }
  }

  return Object.freeze({
    async bootstrap({ principal, scope }                                                                             )                                            {
      if (closed) throw new Error('principal snapshot delivery is closed');
      const resolved = resolution(byName, principal, scope);
      if (!resolved) return Object.freeze({ kind: 'revoked' });
      if (!(await authorized({ declaration: resolved.declaration, principal: resolved.principal, trigger: 'bootstrap' }))) {
        return Object.freeze({ kind: 'revoked' });
      }
      return pairedSnapshot(resolved);
    },
    async catchup({ principal, scope, after }                                                                                            )                                            {
      if (closed) throw new Error('principal snapshot delivery is closed');
      const resolved = resolution(byName, principal, scope);
      if (!resolved) return Object.freeze({ kind: 'revoked' });
      if (!Number.isSafeInteger(after) || after < 0) throw new Error('after must be a nonnegative safe integer');
      if (!(await authorized({ declaration: resolved.declaration, principal: resolved.principal, trigger: 'catchup' }))) {
        return Object.freeze({ kind: 'revoked' });
      }
      const revision = revisionFor(database, resolved.declaration, resolved.principal);
      return after === revision
        ? Object.freeze({ kind: 'catchup', envelopes: Object.freeze([]), cursor: revision })
        : pairedSnapshot(resolved);
    },
    async subscribe({ principal, scope, after, signal, deliver, revoke }                                 )                                       {
      if (closed) throw new Error('principal snapshot delivery is closed');
      const resolved = resolution(byName, principal, scope);
      if (!resolved) {
        const error                            = new Error('principal snapshot subscription denied');
        error.code = 'live-delivery-revoked';
        throw error;
      }
      if (!Number.isSafeInteger(after) || after < 0 || typeof deliver !== 'function') throw new Error('invalid principal snapshot subscription');
      // Subscription admission consults the host authorizer BEFORE the
      // subscription is installed. A denial revokes (tearing the transport
      // down before any delivery) and rejects with the same terminal code the
      // scope-level denial uses.
      if (!(await authorized({ declaration: resolved.declaration, principal: resolved.principal, trigger: 'subscribe' }))) {
        revoke?.();
        const error                            = new Error('principal snapshot subscription denied');
        error.code = 'live-delivery-revoked';
        throw error;
      }
      if (signal?.aborted) return { activate: async () => undefined };
      const id = nextId++;
      const sub                                     = {
        ...resolved,
        scope,
        cursor: after,
        deliver,
        revoke,
        signal,
        active: true,
        pending: false,
        dirty: false,
        abort: () => remove(id),
      };
      subs.set(id, sub);
      const scopeSubs = byScope.get(scope) ?? new Set();
      scopeSubs.add(id);
      byScope.set(scope, scopeSubs);
      signal?.addEventListener('abort', sub.abort, { once: true });
      return Object.freeze({ activate: async () => { await drain(id); return subs.get(id)?.cursor; } });
    },
    wake(declaration                                       , principal                            ) {
      if (closed) return;
      const scope = typeof declaration === 'string' ? declaration : principalSnapshotScope({ declaration: declaration.name, principal });
      for (const id of [...(byScope.get(scope) ?? [])]) {
        const sub = subs.get(id);
        if (!sub || !sub.active) continue;
        sub.dirty = true;
        void drain(id).catch(() => {});
      }
    },
    close() {
      closed = true;
      for (const id of [...subs.keys()]) remove(id);
    },
  });
}

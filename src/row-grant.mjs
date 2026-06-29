// The row grant's RUNTIME half — the second default-on auth layer (SPEC §6).
//
// Two default-on auth layers protect every request. The route GATE (route-gate.mjs)
// decides admission to a route from the request principal. The row GRANT decides,
// per row, what the principal may DO with it. The grant itself has two halves:
//
//   - the SQL scope (scope-sql.mjs / bindReadScope) — which rows are VISIBLE; and
//   - the `.can` capability body — given a visible row, which capabilities
//     (read / write / subscribe) the principal holds on it.
//
// This module runs the `.can` half. It builds the entity's `is` checks bound to a
// concrete { row, principal }, runs the grant clause's `.can` body through the
// await-backstop (resolveDecision), and returns the conferred capability set. The
// HTTP dispatcher calls mayVerb on every admitted verb so a principal who passed
// the route gate still cannot write a row it does not own — no second auth path,
// the grant runs every verb.

import { check, resolveDecision } from './check.mjs';
import { read, write } from './grant.mjs';

// Build the `is` proxy the .can body destructures: each entity check, bound to
// this row + principal, wrapped as an awaitable check so `await is.owner()`
// works and an un-awaited use is caught by the backstop. An undeclared role is
// a thrown error (fail closed) rather than a silent false.
function makeIs(entityRecord, row, principal) {
  const is = {};
  // Read from the unified registry's RUN faces — a check with no run face
  // simply isn't present at runtime (calling it → undefined → would throw;
  // fail-closed). The canonical home is `registry`; `checks` is a backward-
  // compat bridge exposed on the entity record.
  for (const [role, entry] of Object.entries(entityRecord.registry)) {
    if (entry.run) {
      is[role] = check(() => entry.run({ entity: row, principal }), { name: role });
    }
  }
  return is;
}

// Run the grant clause's `.can` body against a materialized row + principal and
// return its decision: { granted, capabilities } from grant(...), or
// { granted: false } from deny(...). The body runs through resolveDecision so an
// un-awaited check fails closed instead of silently granting.
//
// The read-scope already decided this row is VISIBLE; the .can body decides the
// capabilities held on it. A grant with no scope clause (an inherit child) has no
// own .can body here — its capabilities follow its parent, resolved upstream.
export async function rowCapabilities(entityRecord, row, principal) {
  const clauses = typeof entityRecord.grant === 'function' ? entityRecord.grant() : null;
  const clause = Array.isArray(clauses)
    ? clauses.find((c) => c && typeof c.can === 'function')
    : null;
  if (!clause) return { granted: false, capabilities: [] };

  const is = makeIs(entityRecord, row, principal);
  // resolveDecision awaits the body once and rejects an escaped (un-awaited)
  // check; here the body returns a grant()/deny() object, not a boolean, so we
  // run the body directly under the same backstop by inspecting its result.
  let decision;
  await resolveDecision(
    async () => {
      decision = await clause.can({ is });
      // hand the backstop a boolean so its thenable-escape check applies to the
      // body's control flow, not to the grant object it returns.
      return decision.granted;
    },
    [],
    { where: `the .can grant body on entity('${entityRecord.name}')` },
  );
  return decision.granted
    ? { granted: true, capabilities: decision.capabilities ?? [] }
    : { granted: false, capabilities: [] };
}

// The capability each CRUD verb requires. Reads (list/read) need `read`;
// mutations (create/update/remove) need `write`. This is the allowlist: a verb
// names the capability that GRANTS it, never a condition that denies it.
const VERB_CAPABILITY = Object.freeze({
  list: read,
  read,
  create: write,
  update: write,
  remove: write,
});

// True iff the principal holds the capability `verb` requires on this row. The
// dispatcher calls this on every admitted verb (the row grant runs every verb,
// regardless of the route gate). An unknown verb fails closed.
export async function mayVerb(entityRecord, verb, row, principal) {
  const required = VERB_CAPABILITY[verb];
  if (!required) return false;
  const decision = await rowCapabilities(entityRecord, row, principal);
  if (!decision.granted) return false;
  return decision.capabilities.includes(required);
}

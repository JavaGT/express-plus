// The per-verb route gate — the FIRST of the two default-on auth layers (SPEC
// §6.2, ADR #20). The route gate decides whether a request's principal is
// admitted to a verb's route AT ALL; the row grant (the SQL scope + .can, §6)
// then decides which rows that admitted request may see. The two are distinct
// layers, both default-on, and there is no second auth path: the gate never
// substitutes for the grant — it only relaxes route admission for named verbs.
//
// A gate is an AUTHORIZATION FUNCTION `(principal) => boolean`, never a magic
// word (AGENTS: authorization is always functions). The DEFAULT gate for every
// verb is `requireUser()` — the default-on route gate. Per-verb opt-out names the
// capability that GRANTS route access (allowlist, not denylist):
//
//   r.resource({ gate: { list: allowAnonymous(), create: requireUser() } })
//
// relaxes only `list` to admit anonymous; the row grant still runs on every verb.

// The standard CRUD verbs a resource route exposes. A gate declaration may only
// name these; an unknown verb is a load-time typo guard (fail closed).
export const ROUTE_VERBS = Object.freeze(['list', 'read', 'create', 'update', 'remove']);

// requireUser() — admit any authenticated (non-anonymous) principal; reject
// anonymous. This is the default-on route gate: the smoothest path is authed.
export function requireUser() {
  return (principal) => principal.type !== 'anonymous';
}

// allowAnonymous() — admit everyone, including the first-class `anonymous`
// principal. The public-read path (a published blog post, the reddit front page)
// that replaces the dead `publicRead` flag. The row grant still decides which
// rows an anonymous principal may actually see.
export function allowAnonymous() {
  return () => true;
}

// Normalize a declared `{ verb: gateFn }` map into a full per-verb gate, filling
// every unlisted verb with the default-on requireUser(). A non-function gate
// value (a magic word) and an unknown verb name are both load-time errors —
// fail closed.
export function resolveRouteGate(declared = {}) {
  for (const [verb, gate] of Object.entries(declared)) {
    if (!ROUTE_VERBS.includes(verb)) {
      throw new Error(
        `unknown verb '${verb}' in route gate. The verbs are ` +
          `${ROUTE_VERBS.join('/')} (fail closed — likely a typo).`,
      );
    }
    if (typeof gate !== 'function') {
      throw new Error(
        `route gate for verb '${verb}' must be a gate function ` +
          `(requireUser() / allowAnonymous()), not a value. Authorization is ` +
          `always functions, never magic words (AGENTS).`,
      );
    }
  }

  const resolved = {};
  for (const verb of ROUTE_VERBS) {
    resolved[verb] = declared[verb] ?? requireUser();
  }
  return Object.freeze(resolved);
}

// The admission decision the dispatcher calls per request: does this principal
// pass the route gate for this verb? An unknown verb cannot be admitted (there is
// no route to admit it to) — fail closed.
export function routeGateFor(resolvedGate, verb, principal) {
  const gate = resolvedGate[verb];
  if (typeof gate !== 'function') {
    throw new Error(
      `unknown verb '${verb}' — no route gate to evaluate. The verbs are ` +
        `${ROUTE_VERBS.join('/')}.`,
    );
  }
  return gate(principal);
}

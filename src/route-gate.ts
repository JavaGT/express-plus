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
// capability that GRANTS route access (allowlist, not denylist), declared on the
// entity next to `grant`:
//
//   entity('Post', { title: text(), grant: ()=>[...], gate: { list: allowAnonymous() } })
//
// relaxes only `list` to admit anonymous; the row grant still runs on every verb.

// The standard CRUD verbs a resource route exposes. A gate declaration may only
// name these; an unknown verb is a load-time typo guard (fail closed).
export const ROUTE_VERBS = ['list', 'read', 'create', 'update', 'remove'] as const;

export type RouteVerb = (typeof ROUTE_VERBS)[number];

export interface PrincipalLike {
  type: string;
  [k: string]: unknown;
}

// Every gate carries a non-enumerable BRAND so the imperative-router varargs peel
// (`r.post(path, allowAnonymous(), handler)`) can tell a gate from a middleware/handler
// deterministically — by the brand, never by argument position or arity (which
// would be a magic convention, and a handler that happens to take one argument
// would be mistaken for a gate). A gate stays a callable `(principal) => boolean`;
// the brand is invisible to callers. This mirrors the pipeline action/event brand.
const GATE_BRAND: unique symbol = Symbol('workbench.gate');

export type Gate = ((principal: PrincipalLike) => boolean) & { [GATE_BRAND]: true };

// brand(fn) — stamp an authorization function as a gate. Internal; the public
// surface is the named gate factories below plus isGate() for the peeler.
function brand(gate: (principal: PrincipalLike) => boolean): Gate {
  Object.defineProperty(gate, GATE_BRAND, { value: true, enumerable: false });
  return gate as Gate;
}

// isGate(value) — the brand check the varargs peeler uses. Only a branded gate
// returns true; a plain handler, an arbitrary function, or a non-function never
// peels as a gate (fail closed — an unbranded leading function is a handler).
export function isGate(value: unknown): value is Gate {
  return typeof value === 'function' && (value as { [GATE_BRAND]?: unknown })[GATE_BRAND] === true;
}

// requireUser() — admit any authenticated (non-anonymous) ACTIVE principal;
// reject anonymous. Two-valued admission (S5/A1): a non-'active' status
// principal is treated exactly like anonymous — denied — so a revoked, expired,
// or disabled caller is indistinguishable from an unauthenticated one (no
// status oracle). Absent status is the model default ('active'), so pre-status
// principal shapes keep admitting. This is the default-on route gate: the
// smoothest path is authed and active.
export function requireUser(): Gate {
  return brand((principal) => {
    if (principal.type === 'anonymous') return false;
    const status = (principal as { status?: unknown }).status;
    return status == null || status === 'active';
  });
}

// allowAnonymous() — admit everyone, including the first-class `anonymous`
// principal. The public-read path (a published blog post, the reddit front page)
// that replaces the dead `publicRead` flag. The row grant still decides which
// rows an anonymous principal may actually see. This is the one explicit opt-out
// name for both entity verb maps and imperative routes.
export function allowAnonymous(): Gate {
  return brand(() => true);
}

export type RouteGateDeclaration = Partial<Record<RouteVerb, Gate>>;

// Normalize a declared `{ verb: gateFn }` map into a full per-verb gate, filling
// every unlisted verb with the default-on requireUser(). A non-function gate
// value (a magic word) and an unknown verb name are both load-time errors —
// fail closed.
export function resolveRouteGate(declared: RouteGateDeclaration = {}): Readonly<Record<RouteVerb, Gate>> {
  for (const [verb, gate] of Object.entries(declared) as [string, unknown][]) {
    if (!(ROUTE_VERBS as readonly string[]).includes(verb)) {
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

  const resolved: Record<RouteVerb, Gate> = {} as Record<RouteVerb, Gate>;
  for (const verb of ROUTE_VERBS) {
    resolved[verb] = declared[verb] ?? requireUser();
  }
  return Object.freeze(resolved);
}

// The admission decision the dispatcher calls per request: does this principal
// pass the route gate for this verb? An unknown verb cannot be admitted (there is
// no route to admit it to) — fail closed.
export function routeGateFor(resolvedGate: Readonly<Record<RouteVerb, Gate>>, verb: string, principal: PrincipalLike): boolean {
  const gate = resolvedGate[verb as RouteVerb];
  if (typeof gate !== 'function') {
    throw new Error(
      `unknown verb '${verb}' — no route gate to evaluate. The verbs are ` +
        `${ROUTE_VERBS.join('/')}.`,
    );
  }
  return gate(principal);
}

// The principal model — a closed union with `anonymous` first-class
// (SPEC §6.2; ADRs #11, #20).
//
// The principal-type union is CLOSED: user | link | system | anonymous | apiKey. A
// principal of any other shape is a construction-time error — fail-closed, the
// same discipline as a non-compilable scope or a grant-less entity. There is no
// app-defined type: domain identities (Patron, Reader, Player) are sub-account
// entities owned by `User` via a typed FK (ADR #20), resolved through the compiled
// scope JOIN, never minted as a new principal kind.
//
// `apiKey` is a project-scoped bearer-token principal. It carries the ApiKey row
// id (not the plain token), an optional entityName (scope), and an optional role
// (capabilities). It participates in the SAME authorization engine as user
// principals — no second auth path.
//
// `anonymous` is the one principal a request can carry with NO identity:
// `{ type: 'anonymous', id: null }`. It is admitted only by identity-free
// checks (e.g. `published`), never by a flag — so it is a value here, the
// canonical instance every unauthenticated request shares.

// A typed construction-time failure, sibling to NonCompilableError and
// UnawaitedCheckError. Raised when a principal's declared type is outside the
// closed union, or when a type's invariant (anonymous ⇒ id null) is violated.
export class UnknownPrincipalTypeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnknownPrincipalTypeError';
  }
}

const PRINCIPAL_TYPES = Object.freeze(['user', 'link', 'system', 'anonymous', 'apiKey']);

// Build a frozen principal from a declared shape. `attributes` defaults to an
// empty frozen object (a link principal carries `{ token }`; a user typically
// carries none at this layer). The id/type invariants are checked here so an
// ill-formed principal can never reach the grant engine.
export function principal({ type, id = null, attributes = {} } = {}) {
  if (!PRINCIPAL_TYPES.includes(type)) {
    throw new UnknownPrincipalTypeError(
      `unknown principal type '${String(type)}'. The union is closed: ` +
        `${PRINCIPAL_TYPES.join(' | ')}. Domain identities are sub-accounts ` +
        `owned by User via a typed FK (ADR #20), not new principal types.`,
    );
  }
  if (type === 'anonymous' && id !== null) {
    throw new UnknownPrincipalTypeError(
      `an anonymous principal must have id null (got '${String(id)}'). ` +
        `Anonymous is identity-free by construction (SPEC §6.2).`,
    );
  }
  return Object.freeze({ type, id, attributes: Object.freeze({ ...attributes }) });
}

// The canonical unauthenticated principal. Every anonymous request shares this
// frozen value; there is nothing per-request to vary (it has no identity).
export const anonymous = principal({ type: 'anonymous', id: null });

// Mint a bounded system principal tagged with a source identifier. Used by the
// scheduler/tick analogue to re-enter dispatch with a traceable system identity.
// Fail-closed: source must be a non-empty string (Error otherwise).
// NOTE: This uses `attributes.source` — distinct from effects which use
// `attributes.effect` (effect-compiler.mjs:282) to avoid breaking effect tests.
export function principalFrom(source) {
  if (typeof source !== 'string' || source === '') {
    throw new Error('principalFrom(source): source must be a non-empty string');
  }
  return principal({ type: 'system', attributes: { source } });
}

// A check-expression helper that admits a principal whose `attributes.source`
// matches the given source. Returns a function: ({principal}) => boolean.
// Fail-closed at construction (source must be non-empty string) AND at runtime:
// returns false for nullish principal, non-system principal, or mismatched source.
// Intended use inside admitsEffects:
//   admitsEffects: ({principal}) => effectSource('Blog.publish')({principal})
export function effectSource(source) {
  if (typeof source !== 'string' || source === '') {
    throw new Error('effectSource(source): source must be a non-empty string');
  }
  return ({ principal }) => {
    if (!principal || typeof principal !== 'object') return false;
    if (principal.type !== 'system') return false;
    return principal.attributes?.source === source;
  };
}

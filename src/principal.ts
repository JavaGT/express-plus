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
//
// `status` is the principal's lifecycle state (S5/A1). Admission is TWO-VALUED:
// only `'active'` principals are admitted; a non-`'active'` principal must
// COLLAPSE to `anonymous` at the admission seam so a revoked and an unknown
// principal are indistinguishable to a caller (no status oracle). The REAL
// status rides on the principal only for audit/diagnostic contexts — never on
// the admission decision's public surface. `statusOf()` is that audit reader.

export type PrincipalType = 'user' | 'link' | 'system' | 'anonymous' | 'apiKey';

// The closed principal-status union. The default (and the only status
// `anonymous` may carry) is `'active'`; the non-active statuses exist so a
// session/principal store can express disabled/expired/revoked without minting
// a brand-new principal type per state.
export type PrincipalStatus = 'active' | 'disabled' | 'expired' | 'revoked';

export interface PrincipalBase {
  readonly type: PrincipalType;
  readonly id: string | null;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly status: PrincipalStatus;
}

export interface AnonymousPrincipal extends PrincipalBase {
  readonly type: 'anonymous';
  readonly id: null;
}

export interface AttributedPrincipal extends PrincipalBase {
  readonly type: Exclude<PrincipalType, 'anonymous'>;
  readonly id: string;
}

// A principal carries an id for every type except `anonymous` (identity-free).
export type Principal = AnonymousPrincipal | AttributedPrincipal;

// A typed construction-time failure, sibling to NonCompilableError and
// UnawaitedCheckError. Raised when a principal's declared type is outside the
// closed union, or when a type's invariant (anonymous ⇒ id null) is violated.
export class UnknownPrincipalTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnknownPrincipalTypeError';
  }
}

// Sibling to UnknownPrincipalTypeError, for a status outside the closed union
// (S5/A1). An unknown status must never silently construct a principal the
// admission engine could misread as active — fail closed.
export class UnknownPrincipalStatusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnknownPrincipalStatusError';
  }
}

const PRINCIPAL_TYPES = Object.freeze(['user', 'link', 'system', 'anonymous', 'apiKey'] as const);
export const PRINCIPAL_STATUSES = Object.freeze(['active', 'disabled', 'expired', 'revoked'] as const);

// Type guard for the closed status union. The one place a DB cell or other
// `unknown` value is narrowed to a PrincipalStatus BEFORE it crosses into the
// typed principal seam — narrower than asserting, fail closed on anything else.
export function isPrincipalStatus(value: unknown): value is PrincipalStatus {
  return PRINCIPAL_STATUSES.includes(value as (typeof PRINCIPAL_STATUSES)[number]);
}

export function principalKeyOf(value: unknown): string | null {
  const candidate = value as { type?: unknown; id?: unknown } | null | undefined;
  if (candidate?.id == null) return null;
  if (
    !PRINCIPAL_TYPES.includes(candidate.type as typeof PRINCIPAL_TYPES[number])
    || typeof candidate.id !== 'string'
    || (candidate.id as string).length === 0
  ) {
    throw new UnknownPrincipalTypeError('an attributed principal requires a closed type and non-empty string id');
  }
  return `${String(candidate.type)}:${candidate.id}`;
}

export interface PrincipalOptions {
  type: Exclude<PrincipalType, 'anonymous' | 'user'>;
  id?: string | null;
  attributes?: Record<string, unknown>;
  status?: PrincipalStatus;
}

// Build a frozen principal from a declared shape. `attributes` defaults to an
// empty frozen object (a link principal carries `{ token }`; a user typically
// carries none at this layer). `status` defaults to `'active'`, so existing
// principal literals keep compiling and behaving unchanged. The id/type/status
// invariants are checked here so an ill-formed principal can never reach the
// grant engine.
export function principal(options?: {
  type: 'user';
  id: string;
  attributes?: Record<string, unknown>;
  status?: PrincipalStatus;
}): AttributedPrincipal;
export function principal(options: {
  type: 'anonymous';
  id?: null;
  attributes?: Record<string, unknown>;
  status?: PrincipalStatus;
}): AnonymousPrincipal;
export function principal(options?: {
  type?: PrincipalType;
  id?: string | null;
  attributes?: Record<string, unknown>;
  status?: PrincipalStatus;
}): Principal;
export function principal({ type, id = null, attributes = {}, status = 'active' }: {
  type?: unknown;
  id?: string | null;
  attributes?: Record<string, unknown>;
  status?: PrincipalStatus;
} = {}): Principal {
  if (!PRINCIPAL_TYPES.includes(type as typeof PRINCIPAL_TYPES[number])) {
    throw new UnknownPrincipalTypeError(
      `unknown principal type '${String(type)}'. The union is closed: ` +
        `${PRINCIPAL_TYPES.join(' | ')}. Domain identities are sub-accounts ` +
        `owned by User via a typed FK (ADR #20), not new principal types.`,
    );
  }
  if (!PRINCIPAL_STATUSES.includes(status as typeof PRINCIPAL_STATUSES[number])) {
    throw new UnknownPrincipalStatusError(
      `unknown principal status '${String(status)}'. The union is closed: ` +
        `${PRINCIPAL_STATUSES.join(' | ')}. Non-active statuses collapse to ` +
        `anonymous for admission decisions (two-valued rule); the real status ` +
        `is carried here for audit only.`,
    );
  }
  if (type === 'anonymous' && id !== null) {
    throw new UnknownPrincipalTypeError(
      `an anonymous principal must have id null (got '${String(id)}'). ` +
        `Anonymous is identity-free by construction (SPEC §6.2).`,
    );
  }
  if (type === 'anonymous' && status !== 'active') {
    throw new UnknownPrincipalStatusError(
      `an anonymous principal must have status 'active' (got '${String(status)}'). ` +
        `Anonymous is the collapse target for non-active principals; a ` +
        `non-active anonymous is meaningless (S5/A1).`,
    );
  }
  return Object.freeze({
    type,
    id: id as string | null,
    attributes: Object.freeze({ ...attributes }),
    status,
  }) as Principal;
}

// The canonical unauthenticated principal. Every anonymous request shares this
// frozen value; there is nothing per-request to vary (it has no identity, and
// its status is always `'active'` — the collapse target for non-active
// principals).
export const anonymous: Principal = principal({ type: 'anonymous', id: null });

// The REAL status of a principal (S5/A1). This is the audit/diagnostic reader:
// `statusOf` returns `'active'` for anonymous and the true status for a
// non-active principal. Admission callers (the A2 seam) must NOT use it for a
// decision — they collapse any non-`'active'` principal to `anonymous` BEFORE
// calling into row/field gates, so the admission surface never exposes which
// non-active status applied (a revoked and an unknown principal are
// indistinguishable to a caller — no status oracle).
export function statusOf(principal: Principal): PrincipalStatus {
  return principal.status;
}

// The two-valued admission collapse (S5/A1) — applied AT the admission
// boundary (the route-gate/serve seam). Returns the canonical `anonymous` for
// any non-'active' principal, so admission sees a revoked caller exactly as it
// sees an unauthenticated one (no status oracle); an 'active' principal passes
// through unchanged (identity preserved). The REAL status stays on the original
// principal for statusOf() — this never keys a decision off which non-active
// status applied. An absent status is 'active' by the model default, so
// pre-#79 principal shapes pass through unchanged.
export function collapseForAdmission(principal: Principal): Principal {
  if (principal.status == null || principal.status === 'active') return principal;
  return anonymous;
}

// principalFrom — REMOVED (S5/A5 kill decision, workbench#75). The scheduler
// clock dispatch previously minted an ID-LESS `system` principal via
// principalFrom; it now mints an attributable `machinePrincipal({ id, operations })`
// (machine-principal.mjs), so no id-less system principal reaches an admission
// decision as an implicit grant. Effects keep their own mint
// (`principal({ type: 'system', attributes: { effect } })`), which is a
// distinct mechanism with its own explicit admission.

// A check-expression helper that admits a principal whose `attributes.source`
// matches the given source. Returns a function: ({principal}) => boolean.
// Fail-closed at construction (source must be non-empty string) AND at runtime:
// returns false for nullish principal, non-system principal, or mismatched source.
// Intended use inside admitsEffects:
//   admitsEffects: ({principal}) => effectSource('Blog.publish')({principal})
export function effectSource(source: string): (ctx: { principal?: Principal | null }) => boolean {
  if (typeof source !== 'string' || source === '') {
    throw new Error('effectSource(source): source must be a non-empty string');
  }
  return ({ principal: p }) => {
    if (!p || typeof p !== 'object') return false;
    if (p.type !== 'system') return false;
    return (p.attributes as Record<string, unknown>)?.effect === source;
  };
}

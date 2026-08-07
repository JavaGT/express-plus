// Capability tokens and grant decisions (Phase 1, SPEC §6).
//
// Authorization is always functions, never magic strings (AGENTS Authorization).
// The capabilities a grant can confer are typed singleton tokens, not string
// literals: a `.can` body returns `grant(read, write)` or `deny(reason)`, never
// `'read'`. Comparing tokens by identity keeps capability references typed.

export type Capability = { readonly capability: string };

export type GrantDecision =
  | { readonly granted: true; readonly capabilities: readonly Capability[] }
  | { readonly granted: false; readonly reason: string | null };

// Each capability is a frozen unique token. `description` is for diagnostics
// only; identity (not the string) is what the engine compares.
function capability(name: string): Capability {
  return Object.freeze({ capability: name });
}

export const read: Capability = capability('read');
export const write: Capability = capability('write');
export const subscribe: Capability = capability('subscribe');
// `admin` — the management capability (rename, reshare, delete, change owner).
// A distinct token, not a derived super-set of the others: an OWNER grant lists
// it explicitly (`grant(read, write, subscribe, admin)`), so a capability check
// stays an identity match, never an implied hierarchy.
export const admin: Capability = capability('admin');

// A grant decision: the set of capabilities conferred. `grant()` with no
// capabilities is a deliberate empty grant (distinct from `deny`, which carries
// a reason for the dev diagnostic).
export function grant(...capabilities: Capability[]): Extract<GrantDecision, { granted: true }> {
  return Object.freeze({ granted: true, capabilities: Object.freeze(capabilities) });
}

export function deny(reason?: string | null): Extract<GrantDecision, { granted: false }> {
  return Object.freeze({ granted: false, reason: reason ?? null });
}

// Capability tokens and grant decisions (Phase 1, SPEC §6).
//
// Authorization is always functions, never magic strings (AGENTS Authorization).
// The capabilities a grant can confer are typed singleton tokens, not string
// literals: a `.can` body returns `grant(read, write)` or `deny(reason)`, never
// `'read'`. Comparing tokens by identity keeps capability references typed.

// Each capability is a frozen unique token. `description` is for diagnostics
// only; identity (not the string) is what the engine compares.
function capability(name) {
  return Object.freeze({ capability: name });
}

export const read = capability('read');
export const write = capability('write');
export const subscribe = capability('subscribe');
// `admin` — the management capability (rename, reshare, delete, change owner).
// A distinct token, not a derived super-set of the others: an OWNER grant lists
// it explicitly (`grant(read, write, subscribe, admin)`), so a capability check
// stays an identity match, never an implied hierarchy.
export const admin = capability('admin');

// A grant decision: the set of capabilities conferred. `grant()` with no
// capabilities is a deliberate empty grant (distinct from `deny`, which carries
// a reason for the dev diagnostic).
export function grant(...capabilities) {
  return Object.freeze({ granted: true, capabilities: Object.freeze(capabilities) });
}

export function deny(reason) {
  return Object.freeze({ granted: false, reason: reason ?? null });
}

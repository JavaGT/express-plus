// The grant's two halves: `scope(predicate).can(fn)` (SPEC §6.1, ADRs #2/#7).
//
// `scope(...)` is the READ grant, and only the read grant. Its predicate is
// destined to compile to a SQL WHERE clause (a predicate that cannot compile is
// a load-time error — Phase 1's compiler enforces that when it lowers the
// predicate to SQL). It is therefore NEVER executed as JavaScript, which is why
// a scope predicate's `is.*` calls are not awaited and are not subject to the
// runtime-await static guard — that guard is for `.can` bodies, which DO run as
// JS per row at runtime.
//
// `.can(fn)` is every other capability (edit, delete, custom verbs): a runtime,
// per-row function that may call async cross-entity checks. Read intent is never
// derived from compilability (ADR #2) — you declare read by putting a predicate
// in `scope`, and edit/etc. by putting a function in `.can`.

// A grant clause: the read predicate (for SQL lowering) plus the runtime
// capability function. Frozen — a declared grant is immutable.
function makeClause(predicate, can) {
  return Object.freeze({ predicate, can });
}

export function scope(predicate) {
  return Object.freeze({
    predicate,
    // .can attaches the runtime capability half and closes the clause.
    can: (fn) => makeClause(predicate, fn),
  });
}

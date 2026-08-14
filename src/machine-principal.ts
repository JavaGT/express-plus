// The attributable machine/system principal (S5/A5). Operational work — the
// schedule clock dispatch (`admitSystemMutation`), the job-queue worker, and a
// consuming app's operational runtime — runs under an attributable machine
// identity with an EXPLICIT granted operation allowlist. There is no "internal"
// grant: a machine principal admits exactly the operations its allowlist names,
// and an operation outside the allowlist is denied (fail closed).
//
// A machine principal may NOT impersonate a human. Its type is always `system`
// (the constructor takes no type — it can never mint `user`), and its
// attributes are derived ONLY from `{ id, operations }` and frozen, so no
// caller can attach a token/role/capability that a user-identity check reads.
// The one identity a machine principal carries is its `id` (the bounded
// schedule source or worker identity), also reflected as `attributes.source`
// for the schedule receipt/seam compatibility.
//
// The operation allowlist stores the closed operation-category NAMES
// (operation.ts), normalized at construction so an unknown name is a
// construction-time error (fail closed loudly at setup, silently at runtime).

import { principal, type Principal } from './principal.ts';
import { operationCategory, type OperationCategory } from './operation.ts';

// The machine-principal brand. A MODULE-PRIVATE symbol minted only inside
// machinePrincipal() below and stamped onto the returned object BEFORE it is
// frozen, so a machine principal is UNFORGEABLE: no caller can construct a
// principal-shaped object (matching id/source/operations) that isMachinePrincipal
// accepts — the brand is the only admission key, and it never leaves this module.
const MACHINE_BRAND = Symbol('workbench.machinePrincipal');

export type MachinePrincipal = Principal & {
  readonly type: 'system';
  readonly id: string;
  readonly attributes: Readonly<{
    // The bounded identity (schedule source / worker identity) — the same
    // `attributes.source` the schedule runtime and receipt seams read.
    source: string;
    // Discriminator: an attributable machine identity with an explicit
    // allowlist. Present on every MINTED principal; admission keys on the
    // module-private brand, never on this (a forged copy still fails).
    machine: true;
    // The explicit granted operation allowlist (closed-vocabulary names).
    operations: readonly string[];
  }>;
};

export interface MachinePrincipalInput {
  // Stable, attributable identity — never null (a machine principal is an
  // attributed principal; `anonymous` is identity-free by construction).
  id: string;
  // The explicit granted operation set. Every entry must be a closed-vocabulary
  // operation name; an unknown name is a construction-time error (fail closed).
  operations: readonly string[];
}

// Mint a machine principal. Fail closed on a missing/empty id, a non-array
// operations list, or an operation name outside the closed vocabulary. The
// minted principal is frozen; `attributes.source` = id keeps the schedule
// source-binding seam working unchanged.
export function machinePrincipal({ id, operations }: MachinePrincipalInput): MachinePrincipal {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('machinePrincipal: id must be a non-empty string (a machine principal is attributed)');
  }
  if (!Array.isArray(operations)) {
    throw new Error('machinePrincipal: operations must be an explicit array (the granted operation allowlist)');
  }
  if (operations.length === 0) {
    throw new Error('machinePrincipal: operations must be non-empty — an allowlist of zero is a misconfiguration (fail closed)');
  }
  // Normalize + validate every declared operation name. Unknown vocabulary is a
  // construction-time error — a machine principal never carries a fabricated
  // operation label (fail closed).
  const normalized = Object.freeze(
    operations.map((operation, index) => {
      if (typeof operation !== 'string' || operation.length === 0) {
        throw new Error(`machinePrincipal: operations[${index}] must be a non-empty operation name`);
      }
      return operationCategory(operation).operation;
    }),
  );
  return Object.freeze({
    ...principal({
      type: 'system',
      id,
      attributes: Object.freeze({
        source: id,
        machine: true,
        operations: normalized,
      }),
      status: 'active',
    }),
    // The unforgeable brand: stamped here (before the freeze above) so only this
    // constructor ever produces a principal isMachinePrincipal accepts.
    [MACHINE_BRAND]: true,
  }) as unknown as MachinePrincipal;
}

// Type guard — true ONLY for a machine principal minted by machinePrincipal()
// (carrying the module-private brand). A hand-rolled object that mimics every
// readable field (type:'system', id, source, machine:true, a matching
// operations allowlist) still lacks the brand and is NOT a machine principal —
// fail closed. This is the sole admission key every runtime seam reads.
export function isMachinePrincipal(principalLike: unknown): principalLike is MachinePrincipal {
  if (!principalLike || typeof principalLike !== 'object') return false;
  return (principalLike as { [MACHINE_BRAND]?: unknown })[MACHINE_BRAND] === true;
}

// The explicit allowlist of a machine principal, or null when the principal is
// not a machine principal. A null result is a DENY in every check that reads it
// — an unattributed principal has no granted operations ("internal" is never an
// implicit grant).
export function machineOperations(principalLike: Principal | null | undefined): readonly string[] | null {
  if (!isMachinePrincipal(principalLike)) return null;
  const operations = principalLike.attributes.operations;
  return Array.isArray(operations) ? operations : null;
}

// Runtime allowlist check: is `operation` (a closed-vocabulary name or category
// token) in the machine principal's explicit grant? Fail closed — a non-machine
// principal, an unknown operation name, or an operation outside the allowlist
// all return false (deny); this never throws.
export function machineAllows(principalLike: Principal | null | undefined, operation: string | OperationCategory | null | undefined): boolean {
  const allowed = machineOperations(principalLike);
  if (!allowed) return false;
  let name: string;
  if (typeof operation === 'string') {
    try {
      name = operationCategory(operation).operation;
    } catch {
      return false;
    }
  } else if (operation && typeof operation.operation === 'string') {
    name = operation.operation;
  } else {
    return false;
  }
  return allowed.includes(name);
}

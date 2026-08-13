// The authorization adapter seam (S5/A2): the injectable, dependency-free
// AUTHORIZATION half of the auth/authz split. Authentication (request →
// principal, src/auth/session.ts) stays where it is; AUTHORIZATION (principal →
// admission) funnels through ONE adapter instance instead of module-global
// calls spread across REST dispatch, the route gate, and live delivery.
//
// The adapter's vocabulary is GENERIC — never app nouns (no ProjectMember/Scope
// names). Resources are keyed by `resourceCategory` (entity / blob / search /
// action / subscription / principal / policy) and denials carry a closed
// `reasonCode`, never row content.
//
// Two admission rules are enforced here at the boundary:
//
//   - TWO-VALUED status (S5/A1): a non-'active' principal collapses to
//     `anonymous` before any row/field gate runs, so a revoked and an unknown
//     principal are indistinguishable on the decision surface (no status
//     oracle). The REAL status rides the principal for statusOf() — the audit
//     reader — never on AdmissionDecision. The trace records only whether the
//     status check PASSED (a boolean), never which non-active status applied.
//   - FAIL CLOSED: a policy body (a `.can`/`scope` implementation) that throws
//     yields admitted:false with reasonCode 'policy-error', never a 500 leak.
//
// The default adapter keeps the existing row-grant function signatures as its
// implementation (mayRow / mayVerb / fieldCapabilities), so current callers of
// those module functions are unchanged; transports that already inject a
// mayVerb (live delivery) keep that injection shape untouched. The factory
// accepts overrides so a policy adapter is buildable and testable with zero
// HTTP, sockets, or global DB state.
//
// Non-entity resources (search/blob/action/plain live tables) admit through
// the SAME seam, keyed by resourceCategory. A resource's row scope must
// compile to constrained SQL AT REGISTRATION — a non-compilable scope throws
// there, never falling back to loading every row and filtering in JS.

import { getLog } from './log.ts';
import type { Capability } from './grant.ts';
import { operationCategory, type OperationCategory } from './operation.ts';
import { collapseForAdmission, statusOf, type Principal } from './principal.ts';
import type { Gate, PrincipalLike } from './route-gate.ts';
import { requireUser } from './route-gate.ts';
import {
  mayRow as moduleMayRow,
  mayVerb as moduleMayVerb,
  fieldCapabilities as moduleFieldCapabilities,
  rowCapabilities,
  type EntityRecord,
} from './row-grant.ts';
import { buildCheckRegistry } from './registry.ts';
import { compileReadScope, type ReadScopeTemplate } from './scope-sql.ts';
import { DecisionTrace } from './decision-trace.ts';
import type { DecisionTraceEntry } from './decision-trace.ts';

// The generic resource categories. A decision's resourceCategory is always one
// of these — framework nouns, never app nouns. `entity` is a Workbench entity
// row; `blob`/`search`/`subscription`/`policy` are plugin resources admitted
// through the same seam (keyed by category + registered name); `action` is a
// composite (registered action) admission; `principal` is the route-gate /
// principal-status admission.
export type ResourceCategory =
  | 'entity'
  | 'blob'
  | 'search'
  | 'action'
  | 'subscription'
  | 'principal'
  | 'policy';

export type PluginResourceCategory = Exclude<ResourceCategory, 'entity' | 'principal' | 'action'>;

// The closed reason-code vocabulary. A denial carries exactly one generic code
// — never an app-domain name, never row content, never which non-active status
// applied. `principal-status` is reserved for policy adapters operating under
// an explicit audit context (A4); the default adapter's collapse path NEVER
// emits it, so a revoked and an unknown principal stay indistinguishable.
export type AdmissionReasonCode =
  | 'anonymous'
  | 'principal-status'
  | 'no-row-scope'
  | 'no-capability'
  | 'no-field-access'
  | 'no-resource'
  | 'unknown-category'
  | 'policy-error';

// The frozen decision every admit() returns. `trace` is null in the production
// default and a readonly check list when tracing is enabled (env/test flag).
export interface AdmissionDecision {
  readonly admitted: boolean;
  readonly operation: OperationCategory;
  readonly resourceCategory: ResourceCategory;
  readonly resourceId: string | null;
  readonly reasonCode: AdmissionReasonCode | null;
  readonly capabilities: readonly Capability[];
  readonly trace: readonly DecisionTraceEntry[] | null;
}

// The operation an admit() input names: a category TOKEN or a verb/category
// NAME string (normalized through operationCategory, fail closed on unknown).
export type AdmissionOperation = OperationCategory | string;

// Entity-row admission: a materialized row (or null when the principal's read
// scope excluded it) plus the transport verb. A field admission (fieldName +
// capability) runs the field `.can` seam instead of the row verb.
export interface EntityAdmitInput {
  readonly category: 'entity';
  readonly verb: string;
  readonly principal: Principal;
  readonly entity: EntityRecord;
  readonly row: unknown;
  readonly operation?: AdmissionOperation;
  readonly fieldName?: string;
  readonly capability?: Capability;
  readonly resourceId?: string | null;
}

// Route-gate admission: does this principal pass the (per-verb) route gate?
// The gate defaults to requireUser(). Non-active principals collapse to
// anonymous BEFORE the gate runs, so a revoked and an unauthenticated caller
// are denied identically ('anonymous').
export interface PrincipalAdmitInput {
  readonly category: 'principal';
  readonly principal: Principal;
  readonly operation?: AdmissionOperation;
  readonly gate?: Gate;
  readonly resourceId?: string | null;
}

// One row a composite (registered) action must admit against.
export interface RowRequirement {
  readonly entity: EntityRecord;
  readonly verb: string;
  readonly row: unknown;
  readonly capability?: Capability;
}

// Composite admission: a registered action must admit against EVERY affected
// capability and row. All requirements are evaluated through ONE admit() call;
// any single denial denies the whole action.
export interface ActionAdmitInput {
  readonly category: 'action';
  readonly principal: Principal;
  readonly requirements: readonly RowRequirement[];
  readonly operation?: AdmissionOperation;
  readonly resourceId?: string | null;
}

// Plugin-resource admission (blob / search / subscription / policy): keyed by
// category, optionally naming a resource registered on this adapter. A named
// but unregistered resource denies ('no-resource'); an absent row denies
// ('no-row-scope'). The row's visibility is decided by the caller under the
// resource's REGISTERED (compiled) scope — this seam never loads rows itself.
export interface ResourceAdmitInput {
  readonly category: PluginResourceCategory;
  readonly principal: Principal;
  readonly operation?: AdmissionOperation;
  readonly resourceName?: string;
  readonly row?: unknown;
  readonly resourceId?: string | null;
}

export type AdmitInput =
  | EntityAdmitInput
  | PrincipalAdmitInput
  | ActionAdmitInput
  | ResourceAdmitInput;

// Resource registration for the non-entity categories. The scope predicate
// must compile to constrained SQL here (a non-compilable scope throws
// NonCompilableError at registration, never a silent load-all-then-filter
// fallback). `fields`/`checks` supply the compile registry the scope may use.
export interface ResourceRegistration {
  readonly category: PluginResourceCategory;
  readonly name: string;
  readonly scope: (ctx: { is: unknown; fields: unknown }) => unknown;
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly checks?: Readonly<Record<string, (ctx: unknown) => boolean>>;
}

export type MayRowFn = (entity: EntityRecord, verb: string, row: unknown, principal: unknown) => Promise<boolean>;
export type MayVerbFn = (entity: EntityRecord, verb: string, row: unknown, principal: unknown) => Promise<boolean>;

export interface AuthorizationAdapterOptions {
  trace?: boolean;
  mayRow?: MayRowFn;
  mayVerb?: MayVerbFn;
  fieldCapabilities?: (entity: EntityRecord, fieldName: string, row: unknown, principal: Principal) => Promise<{ granted: boolean; capabilities: readonly Capability[] }>;
}

export interface AuthorizationAdapter {
  admit(input: AdmitInput): Promise<AdmissionDecision>;
  registerResource(input: ResourceRegistration): void;
}

// The env/test flag that turns dev decision traces on for the default adapter.
// An explicit `trace` option overrides it; the production default is null
// traces and generic failure strings only.
function traceDefault(): boolean {
  return typeof process !== 'undefined' && process.env?.WORKBENCH_AUTH_TRACE === '1';
}

const RESOURCE_KEY_SEPARATOR = '\u0000';
const resourceKey = (category: PluginResourceCategory, name: string): string => `${category}${RESOURCE_KEY_SEPARATOR}${name}`;

export function createAuthorizationAdapter(options: AuthorizationAdapterOptions = {}): AuthorizationAdapter {
  const traceEnabled = options.trace ?? traceDefault();
  const resources = new Map<string, ReadScopeTemplate>();

  // The row-admission engine: an injected mayRow wins outright; otherwise the
  // module default mayRow with an injected mayVerb as its per-verb capability
  // engine (the default mayRow already defaults to the module mayVerb).
  const runMayRow = options.mayRow
    ? (entity: EntityRecord, verb: string, row: unknown, principal: Principal) => options.mayRow!(entity, verb, row, principal)
    : (entity: EntityRecord, verb: string, row: unknown, principal: Principal) => moduleMayRow(entity, verb, row, principal, options.mayVerb ?? moduleMayVerb);
  const runFieldCapabilities = options.fieldCapabilities ?? moduleFieldCapabilities;

  function settle(
    input: AdmitInput,
    trace: DecisionTrace,
    admitted: boolean,
    reasonCode: AdmissionReasonCode | null,
    capabilities: readonly Capability[],
    resourceId: string | null,
  ): AdmissionDecision {
    return Object.freeze({
      admitted,
      operation: operationOf(input),
      resourceCategory: input.category,
      resourceId,
      reasonCode: admitted ? null : reasonCode,
      capabilities: Object.freeze(capabilities),
      trace: trace.take(),
    });
  }

  // Normalize the input operation to a category token. The operation on the
  // decision is metadata (the checks carry the authority), so an unparseable
  // operation is an informational fallback to the read category — never a
  // throw that would mask the denial underneath.
  function operationOf(input: AdmitInput): OperationCategory {
    try {
      if (input.operation == null) {
        if (input.category === 'entity' && input.verb) return operationCategory(input.verb);
        return anonymousOperation(input);
      }
      return typeof input.operation === 'string'
        ? operationCategory(input.operation)
        : operationCategory(input.operation.operation);
    } catch {
      return anonymousOperation(input);
    }
  }

  function anonymousOperation(_input: AdmitInput): OperationCategory {
    // route-gate admission is an access check, not a CRUD operation — the
    // read category is the closest generic label when none was supplied.
    return operationCategory('read');
  }

  async function admitEntity(input: EntityAdmitInput, collapsed: Principal, trace: DecisionTrace): Promise<AdmissionDecision> {
    const { entity, row } = input;
    trace.record('row.visible', row != null);
    if (row == null) return settle(input, trace, false, 'no-row-scope', [], resourceIdOf(input, row));

    if (input.fieldName) {
      const decision = await runFieldCapabilities(entity, input.fieldName, row, collapsed);
      const capabilityOk = decision.granted && (input.capability == null || decision.capabilities.includes(input.capability));
      trace.record(`field.can.${input.fieldName}`, capabilityOk);
      if (!capabilityOk) return settle(input, trace, false, 'no-field-access', [], resourceIdOf(input, row));
      return settle(input, trace, true, null, decision.capabilities, resourceIdOf(input, row));
    }

    const allowed = await runMayRow(entity, input.verb, row, collapsed);
    trace.record(`row.may.${input.verb}`, allowed);
    if (!allowed) return settle(input, trace, false, 'no-capability', [], resourceIdOf(input, row));
    // Report the conferred capability set (informational). mayRow decided the
    // admission; rowCapabilities only reads the grant again for the report.
    const caps = await rowCapabilities(entity, row, collapsed);
    return settle(input, trace, true, null, caps.granted ? caps.capabilities : [], resourceIdOf(input, row));
  }

  function admitPrincipal(input: PrincipalAdmitInput, collapsed: Principal, trace: DecisionTrace): AdmissionDecision {
    const gate = input.gate ?? requireUser();
    const allowed = gate(collapsed as unknown as PrincipalLike);
    trace.record('route.gate', allowed);
    if (!allowed) return settle(input, trace, false, 'anonymous', [], input.resourceId ?? null);
    return settle(input, trace, true, null, [], input.resourceId ?? null);
  }

  async function admitAction(input: ActionAdmitInput, collapsed: Principal, trace: DecisionTrace): Promise<AdmissionDecision> {
    const { requirements } = input;
    trace.record('action.requirements', requirements.length > 0);
    if (requirements.length === 0) return settle(input, trace, false, 'no-row-scope', [], input.resourceId ?? null);
    const grantedCapabilities: Capability[] = [];
    for (const requirement of requirements) {
      const label = `${requirement.entity?.name ?? 'row'}.${requirement.verb}`;
      trace.record(`requirement.${label}.visible`, requirement.row != null);
      if (requirement.row == null) return settle(input, trace, false, 'no-row-scope', [], input.resourceId ?? null);
      const allowed = await runMayRow(requirement.entity, requirement.verb, requirement.row, collapsed);
      trace.record(`requirement.${label}.may`, allowed);
      if (!allowed) return settle(input, trace, false, 'no-capability', [], input.resourceId ?? null);
      if (requirement.capability) grantedCapabilities.push(requirement.capability);
    }
    return settle(input, trace, true, null, grantedCapabilities, input.resourceId ?? null);
  }

  function admitResource(input: ResourceAdmitInput, _collapsed: Principal, trace: DecisionTrace): AdmissionDecision {
    if (input.resourceName != null) {
      const registered = resources.get(resourceKey(input.category, input.resourceName));
      trace.record('resource.registered', registered !== undefined);
      if (!registered) return settle(input, trace, false, 'no-resource', [], input.resourceId ?? null);
    }
    trace.record('resource.row', input.row != null);
    if (input.row == null) return settle(input, trace, false, 'no-row-scope', [], input.resourceId ?? null);
    return settle(input, trace, true, null, [], input.resourceId ?? null);
  }

  async function admit(input: AdmitInput): Promise<AdmissionDecision> {
    const trace = new DecisionTrace(traceEnabled);
    try {
      // TWO-VALUED status collapse at the boundary: the principal entering
      // every check below is anonymous unless 'active'. statusOf reads the
      // REAL status for the trace boolean only (diagnostic — never a decision
      // input and never on the decision surface; it reports only whether the
      // check PASSED, never which non-active status applied).
      trace.record('principal.status', statusOf(input.principal) === 'active');
      const collapsed = collapseForAdmission(input.principal);

      switch (input.category) {
        case 'entity': return await admitEntity(input, collapsed, trace);
        case 'principal': return admitPrincipal(input, collapsed, trace);
        case 'action': return await admitAction(input, collapsed, trace);
        case 'blob':
        case 'search':
        case 'subscription':
        case 'policy': return admitResource(input, collapsed, trace);
        default: return settle(input as AdmitInput, trace, false, 'unknown-category', [], null);
      }
    } catch {
      // A policy body (a .can/scope implementation) threw — fail CLOSED. Never
      // a 500 leak and never a silent admit: the caller sees admitted:false
      // with a closed reason code. The exception message is intentionally not
      // logged: it can embed row or principal data that must not leave the
      // server.
      getLog().debug('auth', 'authorization adapter policy error; denying', {
        category: input.category,
        operation: operationOf(input).operation,
      });
      return settle(input, trace, false, 'policy-error', [], input.resourceId ?? null);
    }
  }

  function registerResource(input: ResourceRegistration): void {
    const category = input.category as string;
    if (category === 'entity' || category === 'principal' || category === 'action') {
      throw new Error(
        `cannot register resource under category '${category}' — ` +
          'entity/principal/action admission is not registration-keyed',
      );
    }
    if (typeof input.name !== 'string' || input.name.length === 0) {
      throw new Error('resource registration requires a non-empty name');
    }
    if (typeof input.scope !== 'function') {
      throw new Error(
        `resource '${input.category}/${input.name}' registration requires a scope predicate — ` +
          'a resource with no row scope would load every row and filter in JS (forbidden). ' +
          'Provide a scope that compiles to constrained SQL, or register none at all.',
      );
    }
    const fields = input.fields ?? {};
    const registry = buildCheckRegistry({
      fields,
      declaredChecks: input.checks as Record<string, (ctx: unknown) => boolean> | undefined,
      entityName: input.name,
    });
    const template = compileReadScope(input.scope, {
      fields,
      where: `authorization adapter resource '${input.category}/${input.name}'`,
      registry: registry as unknown as Record<string, unknown>,
      entityName: input.name,
    });
    resources.set(resourceKey(input.category, input.name), template);
  }

  return Object.freeze({ admit, registerResource });
}

function resourceIdOf(input: EntityAdmitInput, row: unknown): string | null {
  if (input.resourceId != null) return input.resourceId;
  const id = (row as { id?: unknown } | null | undefined)?.id;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : null;
}

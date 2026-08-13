import { read, write, subscribe, admin } from './grant.ts';
import type { Capability } from './grant.ts';
import { readScopedRow, type CrudAppLike, type CrudEntity } from './http-crud-dispatch.ts';
import { createAuthorizationAdapter, type AuthorizationAdapter, type RowRequirement } from './authorization-adapter.ts';
import type { EntityRecord } from './row-grant.ts';
import type { Principal } from './principal.ts';

const AUTHORIZED_ROWS: unique symbol = Symbol('workbench.authorizedRows');
const VERB = new Map<Capability, string>([[read, 'read'], [write, 'update'], [subscribe, 'subscribe'], [admin, 'admin']]);

// The default adapter composite actions use when no adapter is injected (the
// kernel's action gate). It wraps the framework row-grant — behavior identical
// to the pre-adapter bindAuthorizedRows loop, but through the ONE admit seam.
const DEFAULT_AUTHORIZATION: AuthorizationAdapter = createAuthorizationAdapter();

interface AuthorizedRowRequirement {
  readonly entity: string | { readonly name: string };
  readonly id: string;
  readonly capability: Capability;
}

type AuthorizeContext = { readonly payload: unknown; readonly principal: Principal };

type AuthorizedRowsResolver = (context: AuthorizeContext) =>
  readonly AuthorizedRowRequirement[] | Promise<readonly AuthorizedRowRequirement[]>;

type AuthorizedRowsDeclaration = ((context: AuthorizeContext) =>
  readonly AuthorizedRowRequirement[] | Promise<readonly AuthorizedRowRequirement[]>) & {
  readonly [AUTHORIZED_ROWS]: true;
};

type AuthorizedRowsMarker = { readonly [AUTHORIZED_ROWS]?: true };

// The resolver selects rows; it cannot decide authorization. Every selected row
// is evaluated by Workbench's existing row-grant/check registry under the same
// principal. This keeps cross-project admission in the one authorization engine.
export function authorizedRows(resolve: AuthorizedRowsResolver): AuthorizedRowsDeclaration {
  if (typeof resolve !== 'function') throw new TypeError('authorizedRows requires a resolver function');
  const declaration = (({ payload, principal }: AuthorizeContext) => resolve({ payload, principal })) as AuthorizedRowsDeclaration;
  Object.defineProperty(declaration, AUTHORIZED_ROWS, { value: true });
  return Object.freeze(declaration) as AuthorizedRowsDeclaration;
}

export function isAuthorizedRows(value: unknown): value is AuthorizedRowsDeclaration {
  return typeof value === 'function' && (value as AuthorizedRowsMarker)[AUTHORIZED_ROWS] === true;
}

interface RowEntity {
  readonly name: string;
  deserializeRow(row: Record<string, unknown>): unknown;
}

interface WorkbenchAppLike {
  readonly entities?: ReadonlyMap<string, RowEntity>;
}

// Bind a registered action's authorizedRows declaration to a concrete app and
// an authorization adapter (S5/A2). The resolver selects the affected rows;
// authorization evaluates ALL of the resulting requirements through ONE
// adapter.admit() call (category 'action') — a single denied requirement
// denies the whole action, and every requirement must pass its verb's
// capability. With no adapter injected, the framework default is used
// (behavior identical to the pre-adapter per-row mayRow loop).
export function bindAuthorizedRows(
  declaration: AuthorizedRowsDeclaration,
  app: WorkbenchAppLike,
  authorization?: AuthorizationAdapter,
): (context: AuthorizeContext) => Promise<boolean> {
  const adapter = authorization ?? DEFAULT_AUTHORIZATION;
  return async ({ payload, principal }) => {
    const requirements = await declaration({ payload, principal });
    if (!Array.isArray(requirements) || requirements.length === 0) return false;
    const loaded: RowRequirement[] = [];
    for (const requirement of requirements) {
      const name = typeof requirement?.entity === 'string' ? requirement.entity : requirement?.entity?.name;
      const entity = app.entities?.get(name);
      const verb = VERB.get(requirement?.capability);
      if (!entity || !verb || typeof requirement.id !== 'string' || requirement.id.length === 0) return false;
      let row;
      try { row = readScopedRow(app as CrudAppLike, entity as unknown as CrudEntity, requirement.id, principal); } catch { return false; }
      if (row) row = entity.deserializeRow({ ...row });
      loaded.push({
        entity: entity as unknown as EntityRecord,
        verb,
        row,
        capability: requirement.capability,
      });
    }
    const decision = await adapter.admit({ category: 'action', operation: 'execute', principal, requirements: loaded });
    return decision.admitted;
  };
}

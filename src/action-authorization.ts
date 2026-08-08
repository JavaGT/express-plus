import { read, write, subscribe, admin } from './grant.ts';
import type { Capability } from './grant.ts';
import { readScopedRow, type CrudAppLike, type CrudEntity } from './http-crud-dispatch.ts';
import { mayRow } from './row-grant.ts';
import type { Principal } from './principal.ts';

const AUTHORIZED_ROWS: unique symbol = Symbol('workbench.authorizedRows');
const VERB = new Map<Capability, string>([[read, 'read'], [write, 'update'], [subscribe, 'subscribe'], [admin, 'admin']]);

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

export function bindAuthorizedRows(
  declaration: AuthorizedRowsDeclaration,
  app: WorkbenchAppLike,
): (context: AuthorizeContext) => Promise<boolean> {
  return async ({ payload, principal }) => {
    const requirements = await declaration({ payload, principal });
    if (!Array.isArray(requirements) || requirements.length === 0) return false;
    for (const requirement of requirements) {
      const name = typeof requirement?.entity === 'string' ? requirement.entity : requirement?.entity?.name;
      const entity = app.entities?.get(name);
      const verb = VERB.get(requirement?.capability);
      if (!entity || !verb || typeof requirement.id !== 'string' || requirement.id.length === 0) return false;
      let row;
      try { row = readScopedRow(app as CrudAppLike, entity as unknown as CrudEntity, requirement.id, principal); } catch { return false; }
      if (row) row = entity.deserializeRow({ ...row });
      if (!row || !(await mayRow(entity, verb, row, principal))) return false;
    }
    return true;
  };
}

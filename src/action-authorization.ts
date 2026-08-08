// @ts-nocheck
import { read, write, subscribe, admin } from './grant.ts';
import { readScopedRow } from './http-crud-dispatch.ts';
import { mayRow } from './row-grant.ts';

const AUTHORIZED_ROWS = Symbol('workbench.authorizedRows');
const VERB = new Map([[read, 'read'], [write, 'update'], [subscribe, 'subscribe'], [admin, 'admin']]);

// The resolver selects rows; it cannot decide authorization. Every selected row
// is evaluated by Workbench's existing row-grant/check registry under the same
// principal. This keeps cross-project admission in the one authorization engine.
export function authorizedRows(resolve) {
  if (typeof resolve !== 'function') throw new TypeError('authorizedRows requires a resolver function');
  const declaration = ({ payload, principal }) => resolve({ payload, principal });
  Object.defineProperty(declaration, AUTHORIZED_ROWS, { value: true });
  return Object.freeze(declaration);
}

export function isAuthorizedRows(value) {
  return typeof value === 'function' && value[AUTHORIZED_ROWS] === true;
}

export function bindAuthorizedRows(declaration, app) {
  return async ({ payload, principal }) => {
    const requirements = await declaration({ payload, principal });
    if (!Array.isArray(requirements) || requirements.length === 0) return false;
    for (const requirement of requirements) {
      const name = typeof requirement?.entity === 'string' ? requirement.entity : requirement?.entity?.name;
      const entity = app.entities?.get(name);
      const verb = VERB.get(requirement?.capability);
      if (!entity || !verb || typeof requirement.id !== 'string' || requirement.id.length === 0) return false;
      let row;
      try { row = readScopedRow(app, entity, requirement.id, principal); } catch { return false; }
      if (row) row = entity.deserializeRow({ ...row });
      if (!row || !(await mayRow(entity, verb, row, principal))) return false;
    }
    return true;
  };
}

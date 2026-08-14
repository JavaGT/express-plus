import { read, write, subscribe, admin } from './grant.mjs';

import { readScopedRow,                                   } from './http-crud-dispatch.mjs';
import { createAuthorizationAdapter,                                                } from './authorization-adapter.mjs';



const AUTHORIZED_ROWS                = Symbol('workbench.authorizedRows');
const VERB = new Map                    ([[read, 'read'], [write, 'update'], [subscribe, 'subscribe'], [admin, 'admin']]);

// The default adapter composite actions use when no adapter is injected (the
// kernel's action gate). It wraps the framework row-grant — behavior identical
// to the pre-adapter bindAuthorizedRows loop, but through the ONE admit seam.
const DEFAULT_AUTHORIZATION                       = createAuthorizationAdapter();



















// The resolver selects rows; it cannot decide authorization. Every selected row
// is evaluated by Workbench's existing row-grant/check registry under the same
// principal. This keeps cross-project admission in the one authorization engine.
export function authorizedRows(resolve                        )                            {
  if (typeof resolve !== 'function') throw new TypeError('authorizedRows requires a resolver function');
  const declaration = (({ payload, principal }                  ) => resolve({ payload, principal }))                             ;
  Object.defineProperty(declaration, AUTHORIZED_ROWS, { value: true });
  return Object.freeze(declaration)                             ;
}

export function isAuthorizedRows(value         )                                     {
  return typeof value === 'function' && (value                        )[AUTHORIZED_ROWS] === true;
}










// Bind a registered action's authorizedRows declaration to a concrete app and
// an authorization adapter (S5/A2). The resolver selects the affected rows;
// authorization evaluates ALL of the resulting requirements through ONE
// adapter.admit() call (category 'action') — a single denied requirement
// denies the whole action, and every requirement must pass its verb's
// capability. With no adapter injected, the framework default is used
// (behavior identical to the pre-adapter per-row mayRow loop).
export function bindAuthorizedRows(
  declaration                           ,
  app                  ,
  authorization                       ,
)                                                  {
  const adapter = authorization ?? DEFAULT_AUTHORIZATION;
  return async ({ payload, principal }) => {
    const requirements = await declaration({ payload, principal });
    if (!Array.isArray(requirements) || requirements.length === 0) return false;
    const loaded                   = [];
    for (const requirement of requirements) {
      const name = typeof requirement?.entity === 'string' ? requirement.entity : requirement?.entity?.name;
      const entity = app.entities?.get(name);
      const verb = VERB.get(requirement?.capability);
      if (!entity || !verb || typeof requirement.id !== 'string' || requirement.id.length === 0) return false;
      let row;
      try { row = readScopedRow(app               , entity                         , requirement.id, principal); } catch { return false; }
      if (row) row = entity.deserializeRow({ ...row });
      loaded.push({
        entity: entity                           ,
        verb,
        row,
        capability: requirement.capability,
      });
    }
    const decision = await adapter.admit({ category: 'action', operation: 'execute', principal, requirements: loaded });
    return decision.admitted;
  };
}

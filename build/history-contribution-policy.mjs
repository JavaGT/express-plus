// Compile-produced contribution-history policy registry (scope#992 W2/W3).
//
// Replaces the loose `annotatedHistory` classifier object with one registry
// keyed by outer registered action type and annotated contribution handle. The
// registry is compiled at application assembly time from the annotated field
// declarations and the registered compound actions' `operations` handles. It is
// inert data until durable-history movement consults it; it owns NO grant
// decisions — those go through `authorizationRequirements` and the central
// `authorize`/`admitRow` seam (scope#992 rev 2 Finding 9).
//
// Module authority (scope#992 Finding 7): this module is the sole home of
// contribution-policy compilation and classification. There is no second
// contribution classifier on the history engine.
//
// A policy entry is keyed by outer action type. Native annotated insert
// actions and registered compound actions both receive entries here; the
// retired `ANNOTATED_TEXT_COMPENSATION` routing and `annotatedMove` special
// cases are subsumed by this single seam.











/**
 * A compiled contribution policy for one outer action type. The policy owns
 * ordering (which checks run in which phase) but never grant decisions; every
 * authorization requirement is resolved by the central authorization seam.
 */

























































/** Compile a native annotated text-insert contribution policy. */
export function compileNativeInsertContributionPolicy(handle                           , actionType        )                            {
  return compilePolicy({ actionType, handle, nativeInsert: true });
}

/** Compile a registered compound action's contribution policy. */
export function compileCompoundContributionPolicy(handle                    , actionType        , fieldDeclaration          )                            {
  return compilePolicy({ actionType, handle, nativeInsert: false, fieldDeclaration });
}

function compilePolicy(opts                                                                                                       )                            {
  const { actionType, handle, nativeInsert, fieldDeclaration } = opts;
  const policy                            = {
    actionType,
    handle,
    ...(fieldDeclaration === undefined ? {} : { fieldDeclaration }),
    classify(payload) {
      if (nativeInsert) {
        return classifyNativeInsert(handle, payload);
      }
      return documentIdPresent(payload) ? 'eligible' : 'barrier';
    },
    parseOriginFact(fact) {
      return fact                                           ;
    },
    parseTargetFact(fact) {
      return fact                                           ;
    },
    selectAndParseTargetFact({ origin, target, operation, rootActionId, targetFact, receipt }) {
      void origin; void target; void operation; void rootActionId; void receipt;
      return targetFact;
    },
    validateTranslation({ translated, origin, operation, scope }) {
      if (translated.length !== 1 || translated[0].type !== actionType) {
        throw new TypeError('compound history translation must target its outer action');
      }
      void origin; void operation; void scope;
    },
    authorizationRequirements() {
      return 'outer-field';
    },
  };
  return policy;
}

function documentIdPresent(payload         )          {
  return !!payload && typeof payload === 'object'
    && typeof (payload                    ).id === 'string'
    && (payload                  ).id.length > 0;
}

function classifyNativeInsert(_handle                    , payload         )                           {
  if (!documentIdPresent(payload)) return 'barrier';
  // A native annotated-text action is a contribution only when it is a
  // non-empty text insert. Every other edit kind is excluded from history
  // movement through the policy (there is no annotated-move special case).
  const operation = (payload                           ).operation;
  if (operation === 'text.insert') {
    const text = (payload                      ).text;
    if (typeof text === 'string' && text.length > 0) return 'eligible';
    return 'excluded';
  }
  return 'excluded';
}













/**
 * Assemble a contribution-policy registry. `privateHistoryScopes` is the
 * declaration-derived set of annotation entity names used ONLY by the
 * history `actions()`/`events()` read boundary (rev 3 §3) — it has no
 * eligibility, barrier, target-selection, retry, or compensation role.
 */
export function createHistoryContributionPolicyRegistry({
  policies,
  privateHistoryScopes,
}


 )                                    {
  const map = new Map(policies.map((policy) => [policy.actionType, policy]));
  const scopes = new Set(privateHistoryScopes);
  const registry                                    = {
    policies: map,
    hasAny: map.size > 0,
    policyFor(actionType                           ) {
      if (typeof actionType !== 'string') return null;
      return map.get(actionType) ?? null;
    },
    classify({ type, payload }                                                       ) {
      const policy = type == null ? null : map.get(type);
      if (!policy) return null;
      return policy.classify(payload);
    },
    privateHistoryScopes: scopes,
  };
  return Object.freeze(registry);
}

// Re-exported for the move engine's authorization seam.


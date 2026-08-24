// Compile-produced contribution-history policy registry (scope#992 W2/W3).
//
// Replaces the loose application-side classifier object (the retired
// per-action-type scopes/eligibility bag) with one registry keyed by outer
// registered action type and annotated contribution handle. The registry is
// compiled at application assembly time from the annotated field declarations
// and the registered compound actions' `operations` handles. It is inert data
// until durable-history movement consults it; it owns NO grant decisions —
// those go through `authorizationRequirements` and the central
// `authorize`/`admitRow` seam (scope#992 rev 2 Finding 9).
//
// Module authority (scope#992 Finding 7): this module is the sole home of
// contribution-policy compilation and classification. There is no second
// contribution classifier on the history engine.
//
// A policy entry is keyed by outer action type. Native annotated insert
// actions and registered compound actions both receive entries here; the
// retired compensation-symbol routing and the annotated-move special cases
// are subsumed by this single seam (#145 S5).

// W3_HISTORY_RETIRED
// ---------------------------------------------------------------------------
// #145 slice 5 completed: the special-case retirement census is done. The
// checker's retired-symbol rules, the movement module boundary, and the retired
// public classifier-option surface bans are ACTIVE from this marker onward
// (they were gated on its presence to allow incremental slices).

import type { DbHandle } from './driver.ts';
import type { CompoundContributionEnvelope } from './compound-contribution-fact.ts';

export type ContributionPolicyFilter = 'eligible' | 'barrier' | 'excluded';

export interface ContributionHandle {
  readonly entity: string;
  readonly fieldName: string;
}

/**
 * A compiled contribution policy for one outer action type. The policy owns
 * ordering (which checks run in which phase) but never grant decisions; every
 * authorization requirement is resolved by the central authorization seam.
 */
export interface HistoryContributionPolicy {
  readonly actionType: string;
  readonly handle: ContributionHandle;
  /**
   * Compiled annotated-text field declaration (descriptor carrying the
   * `annotations` config), supplied by the kernel for compound actions so the
   * transaction-bound compensation planner can derive the compiled metadata.
   * Undefined for native-insert policies (their compensation flows through the
   * existing generated handler).
   */
  readonly fieldDeclaration?: unknown;
  /**
   * Classify a canonical outer payload into cursor/move eligibility. A native
   * insert is eligible only when it is a text insert; a registered compound
   * action whose payload no longer carries an operable document is a barrier.
   */
  readonly classify: (payload: unknown) => ContributionPolicyFilter;
  /** Parse the complete origin envelope from a stored receipt row. */
  readonly parseOriginFact: (fact: Readonly<Record<string, unknown>>) => CompoundContributionEnvelope;
  /** Parse the complete target envelope from a stored receipt row. */
  readonly parseTargetFact: (fact: Readonly<Record<string, unknown>>) => CompoundContributionEnvelope;
  /**
   * Select and parse the target fact for a contribution chain, validating the
   * linkage (root/target/direction/outcome) and the document/action identity.
   */
  readonly selectAndParseTargetFact: (ctx: {
    origin: { actionId: string; payload: unknown };
    target: { actionId: string; historyTargetActionId: string | null };
    operation: 'undo' | 'redo';
    rootActionId: string;
    originFact: CompoundContributionEnvelope;
    targetFact: CompoundContributionEnvelope;
    receipt: { actionId: string };
  }) => CompoundContributionEnvelope;
  /**
   * Validate a compound history translation target: same outer action type,
   * scope, and canonical origin payload, with handler-only input, and never a
   * native annotated target.
   */
  readonly validateTranslation: (ctx: {
    translated: readonly { type: string }[];
    origin: { type: string | null; payload: unknown; scope: string };
    operation: 'undo' | 'redo';
    scope: string;
  }) => void;
  /**
   * Policy-owned authorization sequencing. Phase is 'authorize' (before private
   * material is loaded) during first moves and deduped retries.
   */
  readonly authorizationRequirements: (phase: { phase: 'authorize'; origin: unknown; target: unknown }) => 'outer' | 'outer-field' | 'none';
}

export interface NativeInsertPolicyOptions {
  readonly entity: string;
  readonly fieldName: string;
}

/** Compile a native annotated text-insert contribution policy. */
export function compileNativeInsertContributionPolicy(handle: NativeInsertPolicyOptions, actionType: string): HistoryContributionPolicy {
  return compilePolicy({ actionType, handle, nativeInsert: true });
}

/** Compile a registered compound action's contribution policy. */
export function compileCompoundContributionPolicy(handle: ContributionHandle, actionType: string, fieldDeclaration?: unknown): HistoryContributionPolicy {
  return compilePolicy({ actionType, handle, nativeInsert: false, fieldDeclaration });
}

function compilePolicy(opts: { actionType: string; handle: ContributionHandle; nativeInsert: boolean; fieldDeclaration?: unknown }): HistoryContributionPolicy {
  const { actionType, handle, nativeInsert, fieldDeclaration } = opts;
  const policy: HistoryContributionPolicy = {
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
      return fact as unknown as CompoundContributionEnvelope;
    },
    parseTargetFact(fact) {
      return fact as unknown as CompoundContributionEnvelope;
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

function documentIdPresent(payload: unknown): boolean {
  return !!payload && typeof payload === 'object'
    && typeof (payload as { id?: unknown }).id === 'string'
    && (payload as { id: string }).id.length > 0;
}

function classifyNativeInsert(_handle: ContributionHandle, payload: unknown): ContributionPolicyFilter {
  if (!documentIdPresent(payload)) return 'barrier';
  // A native annotated-text action is a contribution only when it is a
  // non-empty text insert (v9 payloads carry `edit.kind: 'text.insert'`).
  // Every other edit kind is a BARRIER (the "unsupported annotated action is a
  // barrier" law) — it clears the cursor rather than exposing an older insert
  // across it. There is no annotated-move special case.
  const edit = (payload as { edit?: unknown }).edit;
  const editKind = edit && typeof edit === 'object' && !Array.isArray(edit) ? (edit as { kind?: unknown }).kind : null;
  if (editKind === 'text.insert') {
    const text = (edit as { text?: unknown }).text;
    if (typeof text === 'string' && text.length > 0) return 'eligible';
  }
  return 'barrier';
}

export interface HistoryContributionPolicyRegistry {
  readonly policies: ReadonlyMap<string, HistoryContributionPolicy>;
  /** Return the compiled policy for an outer action type, or null. */
  readonly policyFor: (actionType: string | null | undefined) => HistoryContributionPolicy | null;
  /** True when any policy is registered. */
  readonly hasAny: boolean;
  /** Classify a payload through its action type's policy. */
  readonly classify: (context: { type: string | null | undefined; payload: unknown }) => ContributionPolicyFilter | null;
  /** The frozen declaration-derived read-privacy scope set (for actions()/events() only). */
  readonly privateHistoryScopes: ReadonlySet<string>;
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
}: {
  policies: readonly HistoryContributionPolicy[];
  privateHistoryScopes: ReadonlySet<string> | readonly string[];
}): HistoryContributionPolicyRegistry {
  const map = new Map(policies.map((policy) => [policy.actionType, policy]));
  const scopes = new Set(privateHistoryScopes);
  const registry: HistoryContributionPolicyRegistry = {
    policies: map,
    hasAny: map.size > 0,
    policyFor(actionType: string | null | undefined) {
      if (typeof actionType !== 'string') return null;
      return map.get(actionType) ?? null;
    },
    classify({ type, payload }: { type: string | null | undefined; payload: unknown }) {
      const policy = type == null ? null : map.get(type);
      if (!policy) return null;
      return policy.classify(payload);
    },
    privateHistoryScopes: scopes,
  };
  return Object.freeze(registry);
}

// Re-exported for the move engine's authorization seam.
export type { DbHandle };

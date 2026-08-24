// Compound private-fact envelope (scope#992 W2 / Finding 3 origin + rev 3/4).
//
// A composed annotated-text registered action stores ONE canonical private
// fact envelope that binds the application's narrow `applicationTransition`
// to Workbench's canonical annotated contributions under one receipt. Only the
// application `{ before, after }` half is visible to application projections
// and translators; the package contribution policy receives the complete
// envelope. This module owns the exact-key constructors/parsers and the
// package-owned application-transition validator. It is the SOLE module that
// may construct or parse these envelopes; there is no second compound grammar.
//
// Kinds:
//   - workbench.compound-origin (version 1): the original composed dispatch.
//   - workbench.compound-compensation (version 1): an undo/redo link with
//     linkage { rootActionId, targetActionId, direction, outcome }.

import type { DbHandle } from './driver.ts';

export const COMPOUND_ORIGIN_KIND = 'workbench.compound-origin';
export const COMPOUND_COMPENSATION_KIND = 'workbench.compound-compensation';
export const COMPOUND_ENVELOPE_VERSION = 1;

// Per-scope#992 Finding 10: stored compound private fact soft cap (1 MiB),
// retained alongside the current delete-fact limit.
export const COMPOUND_FACT_MAX_UTF8_BYTES = 1024 * 1024;

export interface CompoundApplicationTransition<ApplicationFact = unknown> {
  readonly before: ApplicationFact | null;
  readonly after: ApplicationFact | null;
}

export interface CompoundContributionLinkage {
  readonly rootActionId: string;
  readonly targetActionId: string;
  readonly direction: 'undo' | 'redo';
  readonly outcome: 'applied' | 'noop';
}

export interface CompoundOriginEnvelope<ApplicationFact = unknown> {
  readonly version: typeof COMPOUND_ENVELOPE_VERSION;
  readonly kind: typeof COMPOUND_ORIGIN_KIND;
  readonly application: CompoundApplicationTransition<ApplicationFact>;
  readonly contributions: readonly unknown[];
}

export interface CompoundCompensationEnvelope<ApplicationFact = unknown> {
  readonly version: typeof COMPOUND_ENVELOPE_VERSION;
  readonly kind: typeof COMPOUND_COMPENSATION_KIND;
  readonly application: CompoundApplicationTransition<ApplicationFact>;
  readonly contributions: readonly unknown[];
  readonly linkage: CompoundContributionLinkage;
}

export type CompoundContributionEnvelope<ApplicationFact = unknown> =
  | CompoundOriginEnvelope<ApplicationFact>
  | CompoundCompensationEnvelope<ApplicationFact>;

export interface CompoundApplicationTransitionInput<ApplicationFact = unknown> {
  readonly version: 1;
  readonly expected: ApplicationFact | null;
  readonly replacement: ApplicationFact | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value) as T;
  }
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value) as T;
}

/** Canonical JSON representation (object keys sorted; arrays keep order). */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw compoundMismatch('application fact must be finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const names = Object.keys(value).sort();
    return `{${names.map((name) => `${JSON.stringify(name)}:${canonicalJson((value as Record<string, unknown>)[name])}`).join(',')}}`;
  }
  throw compoundMismatch('application fact must be JSON-serializable');
}

function compoundMismatch(field: string): TypeError {
  return new TypeError(`compound application transition mismatch: ${field}`);
}

function invalidEnvelope(reason: string): TypeError {
  return new TypeError(`registered action privateFact has invalid compound envelope: ${reason}`);
}

function jsonSerializable(value: unknown, where: string): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalidEnvelope(`${where} must be finite`);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) jsonSerializable(entry, where);
    return;
  }
  if (isPlainObject(value)) {
    for (const child of Object.values(value)) jsonSerializable(child, where);
    return;
  }
  throw invalidEnvelope(`${where} must be JSON-serializable`);
}

export function canonicalTransitionEqual(left: CompoundApplicationTransition, right: CompoundApplicationTransition): boolean {
  return canonicalJson(left.before) === canonicalJson(right.before)
    && canonicalJson(left.after) === canonicalJson(right.after);
}

export function canonicalJsonEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/** Parse a validated canonical delete contribution through the W1 parser. */
import { parseDeleteFact, isDeleteFact } from './annotated-text-delete-history.ts';

/**
 * Construct the compound-origin envelope assigned to the internal
 * `commit.privateFact` by the composed-action adapter in `commitEvents`.
 */
export function constructCompoundOriginEnvelope<ApplicationFact = unknown>({
  application,
  contributions,
}: {
  application: CompoundApplicationTransition<ApplicationFact>;
  contributions: readonly unknown[];
}): CompoundOriginEnvelope<ApplicationFact> {
  validateApplicationTransitionPayload(application.before, application.after, 'application');
  if (!Array.isArray(contributions)) throw invalidEnvelope('contributions must be an array');
  for (let index = 0; index < contributions.length; index += 1) {
    const contribution = contributions[index];
    if (!isDeleteFact(contribution)) throw invalidEnvelope(`contribution[${index}] is not a canonical annotated contribution`);
  }
  const envelope: CompoundOriginEnvelope<ApplicationFact> = deepFreeze({
    version: COMPOUND_ENVELOPE_VERSION,
    kind: COMPOUND_ORIGIN_KIND,
    application: deepFreeze({ before: application.before ?? null, after: application.after ?? null }),
    contributions: Object.freeze([...contributions]),
  });
  assertEnvelopeSize(envelope, 'constructCompoundOriginEnvelope');
  return envelope;
}

/**
 * Construct a compound-compensation envelope for an undo/redo link. The
 * application half is the validated canonical transition; contributions are
 * the validated canonical compensation contributions the policy produced.
 */
export function constructCompoundCompensationEnvelope<ApplicationFact = unknown>({
  application,
  contributions,
  linkage,
}: {
  application: CompoundApplicationTransition<ApplicationFact>;
  contributions: readonly unknown[];
  linkage: CompoundContributionLinkage;
}): CompoundCompensationEnvelope<ApplicationFact> {
  validateApplicationTransitionPayload(application.before, application.after, 'application');
  if (!Array.isArray(contributions)) throw invalidEnvelope('contributions must be an array');
  for (let index = 0; index < contributions.length; index += 1) {
    const contribution = contributions[index];
    if (!isDeleteFact(contribution)) throw invalidEnvelope(`contribution[${index}] is not a canonical annotated contribution`);
  }
  validateLinkage(linkage);
  const envelope: CompoundCompensationEnvelope<ApplicationFact> = deepFreeze({
    version: COMPOUND_ENVELOPE_VERSION,
    kind: COMPOUND_COMPENSATION_KIND,
    application: deepFreeze({ before: application.before ?? null, after: application.after ?? null }),
    contributions: Object.freeze([...contributions]),
    linkage: deepFreeze(linkage),
  });
  assertEnvelopeSize(envelope, 'constructCompoundCompensationEnvelope');
  return envelope;
}

function validateLinkage(linkage: CompoundContributionLinkage): void {
  const { rootActionId, targetActionId, direction, outcome } = linkage;
  if (typeof rootActionId !== 'string' || rootActionId.length === 0
    || typeof targetActionId !== 'string' || targetActionId.length === 0) {
    throw invalidEnvelope('linkage requires non-empty rootActionId and targetActionId');
  }
  if (direction !== 'undo' && direction !== 'redo') throw invalidEnvelope('linkage.direction must be undo or redo');
  if (outcome !== 'applied' && outcome !== 'noop') throw invalidEnvelope('linkage.outcome must be applied or noop');
}

function assertEnvelopeSize(envelope: unknown, where: string): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(envelope);
  } catch {
    throw invalidEnvelope(`${where}: envelope is not JSON-serializable`);
  }
  if (Buffer.byteLength(serialized, 'utf8') > COMPOUND_FACT_MAX_UTF8_BYTES) {
    throw invalidEnvelope(`${where}: envelope exceeds ${COMPOUND_FACT_MAX_UTF8_BYTES} UTF-8 bytes`);
  }
}

export function parseCompoundApplicationTransition(raw: unknown, where: string): CompoundApplicationTransition {
  if (!isPlainObject(raw) || !exactKeys(raw, ['before', 'after'])) {
    throw new TypeError(`compound registered action ${where} must be { before, after }`);
  }
  const before = raw.before === undefined ? null : raw.before;
  const after = raw.after === undefined ? null : raw.after;
  validateApplicationTransitionPayload(before, after, where);
  return deepFreeze({ before, after });
}

/**
 * Parse the exact package grammar a history translator returns when its
 * compound action supplies handler-only input:
 * `{ version: 1, expected, replacement }`. Unknown keys, a non-1 version, or a
 * `{ before, after }`-shaped application fact (instead of expected/replacement)
 * fail closed.
 */
export function parseCompoundApplicationTransitionInput(raw: unknown): CompoundApplicationTransitionInput {
  if (!isPlainObject(raw) || !exactKeys(raw, ['version', 'expected', 'replacement'])) {
    throw new TypeError('compound history translation input must be { version: 1, expected, replacement }');
  }
  if (raw.version !== 1) throw new TypeError('compound history translation input version must be 1');
  const expected = raw.expected === undefined ? null : raw.expected;
  const replacement = raw.replacement === undefined ? null : raw.replacement;
  jsonSerializable(expected, 'translation input.expected');
  jsonSerializable(replacement, 'translation input.replacement');
  return deepFreeze({ version: 1, expected, replacement });
}

function validateApplicationTransitionPayload(before: unknown, after: unknown, where: string): void {
  jsonSerializable(before === undefined ? null : before, `${where}.before`);
  jsonSerializable(after === undefined ? null : after, `${where}.after`);
}

/**
 * The package-owned application transition validator (scope#992 rev 3 Finding 1).
 * Runs inside `coordinatedTxn`, after the document applicability result and
 * handler return, before `_PrivateActionFact` canonicalization and before any
 * projection. Returns the validator's canonical `{ before, after }` — never the
 * raw handler object. A mismatch throws
 * `compound application transition mismatch: <field>` and the caller rolls back
 * everything.
 */
export function validateApplicationTransition({
  originApplication,
  targetApplication,
  translatedInput,
  returnedApplication,
}: {
  originApplication: CompoundApplicationTransition;
  targetApplication: CompoundApplicationTransition;
  translatedInput: CompoundApplicationTransitionInput;
  returnedApplication: CompoundApplicationTransition;
}): CompoundApplicationTransition {
  // 1/2. Exact parsed application transitions for origin and current head. The
  // parse is structural validation of the caller-supplied envelope halves before
  // the semantic equality rules below run.
  parseCompoundApplicationTransition(originApplication, 'originApplication');
  const target = parseCompoundApplicationTransition(targetApplication, 'targetApplication');
  // 3. Input must be the exact compound translation grammar.
  const input = parseCompoundApplicationTransitionInput(translatedInput);
  const returned = parseCompoundApplicationTransition(returnedApplication, 'returnedApplication');
  // 4. expected must equal the target's after.
  if (canonicalJson(input.expected) !== canonicalJson(target.after)) throw compoundMismatch('expected');
  // 5. replacement must equal the target's before.
  if (canonicalJson(input.replacement) !== canonicalJson(target.before)) throw compoundMismatch('replacement');
  // 6. returned.before must equal expected.
  if (canonicalJson(returned.before) !== canonicalJson(input.expected)) throw compoundMismatch('returned.before');
  // 7. returned.after must equal replacement.
  if (canonicalJson(returned.after) !== canonicalJson(input.replacement)) throw compoundMismatch('returned.after');
  // 8. An applied transition must differ (null vs non-null is a valid difference).
  if (canonicalJson(returned.before) === canonicalJson(returned.after)) {
    throw compoundMismatch('application transition before and after must differ for an applied transition');
  }
  return deepFreeze({ before: returned.before, after: returned.after });
}

/**
 * Detect a compound envelope by its closed kind. Returns the kind string for
 * `workbench.compound-origin` / `workbench.compound-compensation`, or null.
 */
export function compoundKindOf(value: unknown): typeof COMPOUND_ORIGIN_KIND | typeof COMPOUND_COMPENSATION_KIND | null {
  if (!isPlainObject(value)) return null;
  const version = value.version;
  const kind = value.kind;
  if (version !== COMPOUND_ENVELOPE_VERSION) return null;
  if (kind === COMPOUND_ORIGIN_KIND || kind === COMPOUND_COMPENSATION_KIND) return kind;
  return null;
}

/**
 * Exact-key compound envelope parser (scope#992 rev 3/4). Validates the
 * version/kind, the fixed-key application transition, unique contribution
 * handles through the W1 annotated contribution parser, linkage/outcome rules,
 * canonical ordering, and JSON/size limits. Rejects unknown keys, duplicate
 * contribution handles, wrong document/action linkage, a non-JSON application
 * fact, and an `applied` contribution without provenance.
 */
export function parseCompoundContributionFact(raw: unknown): CompoundContributionEnvelope {
  if (!isPlainObject(raw)) throw invalidEnvelope('envelope must be an object');
  const version = raw.version;
  const kind = raw.kind;
  if (version !== COMPOUND_ENVELOPE_VERSION) throw invalidEnvelope(`version must be ${COMPOUND_ENVELOPE_VERSION}`);
  if (kind !== COMPOUND_ORIGIN_KIND && kind !== COMPOUND_COMPENSATION_KIND) {
    throw invalidEnvelope(`kind must be ${COMPOUND_ORIGIN_KIND} or ${COMPOUND_COMPENSATION_KIND}`);
  }
  const applicationRaw = raw.application;
  if (!isPlainObject(applicationRaw) || !exactKeys(applicationRaw, ['before', 'after'])) {
    throw invalidEnvelope('application must be { before, after }');
  }
  const application = parseCompoundApplicationTransition(applicationRaw, 'application');
  assertEnvelopeSize(raw, 'parseCompoundContributionFact');

  const contributionsRaw = raw.contributions;
  if (!Array.isArray(contributionsRaw)) throw invalidEnvelope('contributions must be an array');
  const contributions = contributionsRaw.map((entry, index) => {
    const parsed = parseDeleteFact(entry);
    if (parsed.contribution.annotations.some((image, i, array) => array.findIndex((other) => other.id === image.id) !== i)) {
      throw invalidEnvelope(`contribution[${index}] carries a duplicate annotation handle`);
    }
    return parsed;
  });

  if (kind === COMPOUND_ORIGIN_KIND) {
    if (Object.keys(raw).length !== 4 || !exactKeys(raw, ['version', 'kind', 'application', 'contributions'])) {
      throw invalidEnvelope('compound-origin envelope must carry exactly { version, kind, application, contributions }');
    }
    return deepFreeze({ version, kind, application, contributions: Object.freeze(contributions) });
  }

  if (Object.keys(raw).length !== 5 || !exactKeys(raw, ['version', 'kind', 'application', 'contributions', 'linkage'])) {
    throw invalidEnvelope('compound-compensation envelope must carry exactly { version, kind, application, contributions, linkage }');
  }
  const linkageRaw = raw.linkage;
  if (!isPlainObject(linkageRaw) || !exactKeys(linkageRaw, ['rootActionId', 'targetActionId', 'direction', 'outcome'])) {
    throw invalidEnvelope('linkage must carry exactly { rootActionId, targetActionId, direction, outcome }');
  }
  const linkage: CompoundContributionLinkage = deepFreeze({
    rootActionId: linkageRaw.rootActionId as string,
    targetActionId: linkageRaw.targetActionId as string,
    direction: linkageRaw.direction as 'undo' | 'redo',
    outcome: linkageRaw.outcome as 'applied' | 'noop',
  });
  validateLinkage(linkage);
  return deepFreeze({ version, kind, application, contributions: Object.freeze(contributions), linkage });
}

export function isCompoundContributionFact(value: unknown): value is CompoundContributionEnvelope {
  try {
    parseCompoundContributionFact(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Application view of a canonical compound fact: the deep-frozen `application`
 * object for compound kinds; the canonical fact unchanged for every other
 * private fact. Application projections and translators receive ONLY this view
 * (scope#992 rev 4).
 */
export function applicationPrivateFactView(canonicalFact: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const kind = compoundKindOf(canonicalFact);
  if (kind === null) return deepFreeze(canonicalFact);
  const parsed = parseCompoundContributionFact(canonicalFact);
  return deepFreeze(parsed.application) as unknown as Readonly<Record<string, unknown>>;
}

/**
 * Durable-history read path (scope#992 rev 4): parse a stored compound row
 * before the contribution-policy runtime consumes it. Non-compound rows are
 * returned unchanged. The full deep-frozen canonical envelope is returned.
 */
export function privateFactFromReceipt(db: DbHandle, receipt: { scope: string; actionId: string; committedAt: string }): Readonly<Record<string, unknown>> {
  const row = db.prepare(
    'SELECT committedAt, fact FROM _PrivateActionFact WHERE scope = :scope AND actionId = :actionId',
  ).get({ scope: receipt.scope, actionId: receipt.actionId });
  if (!row || row.committedAt !== receipt.committedAt) {
    throw new TypeError('history action private fact is missing or erased');
  }
  let fact: unknown;
  try { fact = JSON.parse(row.fact as string); } catch { throw new TypeError('history action private fact is malformed'); }
  if (!fact || typeof fact !== 'object' || Array.isArray(fact)) {
    throw new TypeError('history action private fact is malformed');
  }
  const kind = compoundKindOf(fact);
  if (kind !== null) return parseCompoundContributionFact(fact) as unknown as Readonly<Record<string, unknown>>;
  return deepFreeze(fact as Record<string, unknown>);
}

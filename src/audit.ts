// The generic audit contract (S5/A4): ONE event schema, TWO retention classes,
// and an injectable sink. This module owns the audit VOCABULARY and the
// classification/retention MODEL; storage is the app adapter's choice.
//
//   - ONE schema (AuditEvent): id, time, actor (the REAL type/id/status),
//     operation, resourceCategory, resourceId?, outcome, reasonCode,
//     classification. An event is a decision LABEL — no payload, body, secret,
//     alias, filename, or excerpt can ride it.
//   - TWO classes: `security` (administrative/security decisions — retained)
//     and `diagnostic` (operational — rotatable). Ordinary no-history
//     collaboration mutations are NOT audit events — they are the committed-log
//     / history tier already; this module never builds a hidden second history.
//   - STATUS IS AN AUDIT INPUT, NOT A DECISION INPUT (owner r2): the audit
//     context carries the REAL principal (statusOf reads the true status) even
//     though admission collapsed it to anonymous. `actor` records the real
//     type/id/status for the security record without weakening the two-valued
//     admission surface — a revoked and an unknown caller stay indistinguishable
//     to the DECISION caller.
//   - RETENTION IS ADAPTER POLICY: the package only exposes a two-class
//     `retentionConfig` and passes the VALUES through untouched; the reference
//     app sets security='12m' / diagnostic='30d'. The package stays generic.
//   - IDS ARE OPAQUE, NEVER CONTENT: actor.id, resourceId, and operation are
//     canonicalized at the emitter boundary (sanitizeOpaqueId) so a token,
//     alias, filename, excerpt, or URL that slips in as an id can never ride
//     the record — see the OpaqueId contract below.
//
// The denial path (rate-limited) lives in src/denial-log.ts and emits
// security-classified events through an Auditor.

import { createHash, randomUUID } from 'node:crypto';
import type { AdmissionReasonCode, ResourceCategory } from './authorization-adapter.ts';
import type { OperationCategory } from './operation.ts';
import { statusOf, type Principal, type PrincipalStatus, type PrincipalType } from './principal.ts';

export type AuditClassification = 'security' | 'diagnostic';
export type AuditOutcome = 'allow' | 'deny';

// The opaque-id shape as a documented alias: ids recorded on events conform to
// isOpaqueId (bounded, whitespace-free, URL/path/alias-free).
export type OpaqueId = string;

// ── Opaque-ID contract ───────────────────────────────────────────────────────
// An audit id (actor.id, resourceId, and the operation string) is an OPAQUE
// identifier, never content: a bounded, whitespace-free lowercase token of
// letters, digits, `-`, and `_` that carries no URL, path, email alias, excerpt,
// or token material. `isOpaqueId` is the validation function;
// `sanitizeOpaqueId` is the emitter-boundary canonicalizer that maps any
// non-conforming string to a deterministic, bounded opaque digest (32 hex chars
// of sha256) so identical inputs still group identically while the original
// content never rides an event. The digest itself is a conforming opaque id, so
// sanitization is idempotent. Empty/null means "no id" and records as null.
const MAX_OPAQUE_ID_LENGTH = 64;
const OPAQUE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const OPAQUE_DIGEST_LENGTH = 32;

export function isOpaqueId(value: string): boolean {
  return (
    value.length > 0
    && value.length <= MAX_OPAQUE_ID_LENGTH
    && OPAQUE_ID_PATTERN.test(value)
  );
}

export function sanitizeOpaqueId(value: string | null | undefined): string | null {
  if (value == null || value === '') return null;
  if (isOpaqueId(value)) return value;
  return createHash('sha256').update(value).digest('hex').slice(0, OPAQUE_DIGEST_LENGTH);
}

// The actor is the REAL principal identity and status (S5/A1 statusOf). This is
// the audit trail — never a decision input: admission collapsed non-active
// principals to anonymous before any gate ran, and the decision surface carries
// only 'anonymous'. The real status lives here so the security record can
// attribute a denial without weakening the two-valued admission rule. The id is
// the opaque canonical form (sanitizeOpaqueId), never raw content.
export interface AuditActor {
  readonly type: PrincipalType;
  readonly id: string | null;
  readonly status: PrincipalStatus;
}

// The one audit event schema. Enumerated fields ONLY — no payload/body/secret/
// alias/filename/excerpt may ride an event. `operation` is the generic
// operation-category name ('read', 'update', ...); `resourceCategory` is a
// generic category (entity/blob/search/action/subscription/principal/policy),
// never a domain noun. `resourceId` is an opaque id when known; `reasonCode` is
// a closed admission code, null when the event records an allow. id/operation/
// resourceId are sanitized to the opaque form at the emitter boundary.
export interface AuditEvent {
  readonly id: string;
  readonly time: number;
  readonly actor: AuditActor;
  readonly operation: string | null;
  readonly resourceCategory: ResourceCategory;
  readonly resourceId: string | null;
  readonly outcome: AuditOutcome;
  readonly reasonCode: AdmissionReasonCode | null;
  readonly classification: AuditClassification;
}

// Retention is ADAPTER policy, not package policy. Values are opaque duration
// strings ('12m' / '30d' in the reference app); the package passes the VALUES
// through untouched and the sink consumes them. The config OBJECT is
// snapshotted at auditor construction (see AuditorOptions.retentionConfig).
export type AuditRetention = string;

export interface RetentionConfig {
  readonly security: AuditRetention;
  readonly diagnostic: AuditRetention;
}

// The raw decision record an emitter classifies. `principal` is the REAL
// (pre-collapse) principal — the emitter records its true type/id/status via
// statusOf, exactly the "status is an audit input" rule.
export interface AuditInput {
  readonly principal: Principal;
  readonly operation: OperationCategory | string | null;
  readonly resourceCategory: ResourceCategory;
  readonly resourceId?: string | null;
  readonly outcome: AuditOutcome;
  readonly reasonCode?: AdmissionReasonCode | null;
}

// The injectable audit sink. The default is a no-op; the app adapter chooses
// storage and consumes the retention value applicable to the event's class
// (read from the auditor's retentionConfig). The event delivered to the sink
// is the FROZEN event with sanitized (opaque) id fields.
export interface AuditSink {
  write(event: AuditEvent, retention: AuditRetention): void;
}

export const noopAuditSink: AuditSink = Object.freeze({ write() {} });

export interface AuditorOptions {
  readonly sink?: AuditSink;
  readonly sinks?: Partial<Record<AuditClassification, AuditSink>>;
  // Value passthrough, snapshot semantics: `retentionConfig` values are opaque
  // duration strings the package never interprets. createAuditor SHALLOW-copies
  // and freezes the object at construction, so later mutation of the caller's
  // object cannot change the auditor's view and the sink always reads a frozen
  // snapshot. Each value passes through the snapshot untouched.
  readonly retentionConfig: RetentionConfig;
  readonly now?: () => number;
  readonly id?: () => string;
}

export interface Auditor {
  readonly retentionConfig: RetentionConfig;
  auditSecurity(input: AuditInput): AuditEvent;
  auditDiagnostic(input: AuditInput): AuditEvent;
}

// Build the audit emitters + retention passthrough for one application. A
// per-class sink (sinks.security / sinks.diagnostic) wins over the shared sink;
// the default sink is a no-op, so unconfigured audit calls are free. The
// retention config is snapshotted (shallow copy, frozen) at construction — the
// `retentionConfig` property is that immutable snapshot. Every emitted event is
// frozen and its id fields are canonicalized to the opaque form: a raw
// token/alias/filename/excerpt/URL passed as actor.id, resourceId, or operation
// is replaced with a deterministic sha256 digest, so content never rides the
// record.
export function createAuditor({
  sink,
  sinks,
  retentionConfig,
  now = Date.now,
  id = randomUUID,
}: AuditorOptions): Auditor {
  const config: RetentionConfig = Object.freeze({ ...retentionConfig });

  function emit(classification: AuditClassification, input: AuditInput): AuditEvent {
    const target = sinks?.[classification] ?? sink ?? noopAuditSink;
    const event: AuditEvent = Object.freeze({
      id: id(),
      time: now(),
      actor: Object.freeze({
        type: input.principal.type,
        id: sanitizeOpaqueId(input.principal.id),
        status: statusOf(input.principal),
      }),
      operation: sanitizeOpaqueId(operationName(input.operation)),
      resourceCategory: input.resourceCategory,
      resourceId: sanitizeOpaqueId(input.resourceId),
      outcome: input.outcome,
      reasonCode: input.reasonCode ?? null,
      classification,
    });
    target.write(event, config[classification]);
    return event;
  }

  return Object.freeze({
    retentionConfig: config,
    auditSecurity: (input: AuditInput): AuditEvent => emit('security', input),
    auditDiagnostic: (input: AuditInput): AuditEvent => emit('diagnostic', input),
  });
}

// Normalize an operation token or name to the generic category NAME recorded on
// the event.
function operationName(operation: OperationCategory | string | null): string | null {
  if (operation == null) return null;
  return typeof operation === 'string' ? operation : operation.operation;
}

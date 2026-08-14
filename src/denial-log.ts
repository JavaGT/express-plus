// Rate-limited denial logging (S5/A4). A denial flood must not flood the audit
// trail: denials are keyed per (actor, reasonCode) — actor type/id/status + a
// closed reason code, NEVER the reason's embedded values or any row/payload
// content — and the log emits ONE representative security audit event per fixed
// window per key, suppressing the rest. The representative rides the real actor
// (owner r2: status is an audit input), so a flood of anonymous-collapsed
// denials still attributes correctly in the security record without weakening
// the two-valued admission surface the decisions themselves saw.

import type { AdmissionReasonCode, ResourceCategory } from './authorization-adapter.ts';
import { sanitizeOpaqueId, type AuditActor, type AuditEvent, type Auditor } from './audit.ts';
import type { OperationCategory } from './operation.ts';
import { type Principal, statusOf } from './principal.ts';
import { createKeyedRateLimiter, type KeyedRateLimiter } from './rate-limit.ts';

// The raw denial record. outcome is always 'deny' and reasonCode is REQUIRED (a
// closed admission code). `principal` is the real (pre-collapse) principal — the
// representative event records its true type/id/status.
export interface DenialInput {
  readonly principal: Principal;
  readonly operation: OperationCategory | string | null;
  readonly resourceCategory: ResourceCategory;
  readonly resourceId?: string | null;
  readonly reasonCode: AdmissionReasonCode;
}

export interface DenialAuditorOptions {
  readonly auditor: Auditor;
  readonly windowMs?: number;
  readonly now?: () => number;
  readonly limiter?: KeyedRateLimiter;
}

export interface DenialAuditor {
  readonly windowMs: number;
  // Emit the representative denial for this (actor, reasonCode) window through
  // the auditor (security-classified); returns the frozen event, or null when
  // this window's representative was already emitted (suppressed).
  auditDenial(input: DenialInput): AuditEvent | null;
  // The (actor, reasonCode) bucket key — actor type/id/status + closed code.
  keyOf(actor: AuditActor, reasonCode: AdmissionReasonCode): string;
}

const KEY_SEPARATOR = '\u0000';

export function createDenialAuditor({
  auditor,
  windowMs = 60_000,
  now,
  limiter = createKeyedRateLimiter({ windowMs, max: 1, now }),
}: DenialAuditorOptions): DenialAuditor {
  function actorOf(principal: Principal): AuditActor {
    return Object.freeze({
      type: principal.type,
      id: sanitizeOpaqueId(principal.id),
      status: statusOf(principal),
    });
  }

  function keyOf(actor: AuditActor, reasonCode: AdmissionReasonCode): string {
    const id = sanitizeOpaqueId(actor.id) ?? 'anon';
    return `${actor.type}:${id}:${actor.status}${KEY_SEPARATOR}${reasonCode}`;
  }

  function auditDenial(input: DenialInput): AuditEvent | null {
    const decision = limiter.check(keyOf(actorOf(input.principal), input.reasonCode));
    if (!decision.allowed) return null;
    return auditor.auditSecurity({
      principal: input.principal,
      operation: input.operation,
      resourceCategory: input.resourceCategory,
      resourceId: input.resourceId,
      outcome: 'deny',
      reasonCode: input.reasonCode,
    });
  }

  return Object.freeze({ windowMs, auditDenial, keyOf });
}

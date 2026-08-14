// Field-level admission (S5/A3 — read projection, write rejection, proposed
// transition).
//
// The field policy rides the SAME authority as the row paths: the injected A2
// authorization adapter decides when one is wired (its fieldCapabilities seam),
// otherwise the framework field `.can` / strong-inherit engine (mayFieldOp /
// mayRow) runs, unchanged. Three concerns live here:
//
//   1. mayReadField / readableFieldNames — the one read-admission authority
//      projectRowForRecipient and its live and snapshot call sites consume.
//      A field the principal cannot read is omitted from every recipient
//      projection (or redacted to an explicit placeholder for annotated text).
//   2. annotatedTextDeniedPlaceholder — the explicit recipient-projection
//      placeholder an unreadable annotated-text field projects to. It is the
//      same frozen wire shape the existing recipient projection
//      (projectAnnotatedTextForRecipient) produces for a fully-restricted
//      document, so clients that understand the recipient grammar already
//      render it; no canonical document facts are loaded or disclosed.
//   3. admitRowTransition — proposed-transition mutation admission. Update and
//      delete admission evaluates the row `.can` / field access against the
//      CURRENT row AND the proposed AFTER row (after when present, else the
//      before row — a delete/revoke keeps its stable anchor as `before`), so an
//      update that moves a row out of the principal's scope is rejected even
//      though the current row is in scope.
//
// Principal-absent (null) is the row-grant's trusted query API convention: not
// a request path — skip field authz (mirrors mayVerb running only in dispatch).

import type { Capability } from './grant.ts';
import { read, write } from './grant.ts';
import { mayFieldOp, mayRow } from './row-grant.ts';
import type { EntityRecord } from './row-grant.ts';
import type { AuthorizationAdapter } from './authorization-adapter.ts';
import type { Principal } from './principal.ts';

function isRequestPrincipal(principal: unknown): boolean {
  return principal !== null && principal !== undefined;
}

function rowId(row: unknown): string | null {
  const id = (row as { id?: unknown } | null | undefined)?.id;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : null;
}

// Field READ admission through the same authority the row paths use (S5/A2):
// the injected adapter decides when one is wired, else the framework field
// `.can` / strong-inherit engine. A null principal is the trusted query API
// convention — bypassed, exactly like mayVerb outside dispatch.
//
// A field WITHOUT `.can` strong-inherits the ROW grant's read capability
// (ADR #4): the row admission (mayRow) is the authority, because it resolves
// every grant shape (bare grant(), scope-only, and inherit clauses) while
// rowCapabilities — the field-`.can` defaults producer — only resolves a
// runtime `.can` clause array. A field WITH `.can` is decided by its own body.
export async function mayReadField(
  entity: EntityRecord,
  fieldName: string,
  row: unknown,
  principal: unknown,
  authorization?: AuthorizationAdapter | null,
): Promise<boolean> {
  if (!isRequestPrincipal(principal)) return true;
  if (authorization) {
    const decision = await authorization.admit({
      category: 'entity',
      verb: 'read',
      operation: 'read',
      principal: principal as Principal,
      entity,
      row,
      fieldName,
      capability: read,
      resourceId: rowId(row),
    });
    return decision.admitted;
  }
  const descriptor = (entity?.fields ?? {})[fieldName] as { access?: unknown } | undefined;
  if (typeof descriptor?.access !== 'function') {
    return mayRow(entity, 'read', row, principal);
  }
  return mayFieldOp(entity, fieldName, read, row, principal);
}

// The declared field names the principal can READ on this row — exactly the
// subset projectRowForRecipient returns (the fields any sort/filter/count or
// excerpt projection may reference).
export async function readableFieldNames(
  entity: EntityRecord,
  row: unknown,
  principal: unknown,
  authorization?: AuthorizationAdapter | null,
): Promise<Set<string>> {
  const fields = (entity?.fields ?? {}) as Record<string, unknown>;
  const readable = new Set<string>();
  for (const fieldName of Object.keys(fields)) {
    if (await mayReadField(entity, fieldName, row, principal, authorization)) readable.add(fieldName);
  }
  return readable;
}

// The explicit recipient-projection placeholder for an unreadable annotated-text
// field. Frozen once; identical wire shape to the existing restricted recipient
// projection (kind 'workbench.annotatedText.recipient', restricted:true) so
// consumers render it without any canonical document facts being loaded.
let deniedPlaceholder: Readonly<Record<string, unknown>> | null = null;
export function annotatedTextDeniedPlaceholder(): Readonly<Record<string, unknown>> {
  deniedPlaceholder ??= Object.freeze({
    kind: 'workbench.annotatedText.recipient',
    version: 1,
    restricted: true,
    text: '',
    ranges: Object.freeze([]),
    annotations: Object.freeze([]),
    measurements: Object.freeze([]),
    capabilityHints: Object.freeze([]),
    orphans: Object.freeze([]),
  });
  return deniedPlaceholder;
}

export interface RowTransitionRequest {
  entity: EntityRecord;
  principal: unknown;
  verb: string;
  before: unknown;
  after?: unknown | null;
  fieldName?: string;
  capability?: Capability;
  authorization?: AuthorizationAdapter | null;
}

// Evaluate one side of a proposed transition. A field op (fieldName set) runs
// field access for the transition capability; a row verb runs the row grant.
async function admitTransitionRow(request: RowTransitionRequest, row: unknown): Promise<boolean> {
  if (row == null || typeof row !== 'object') return false;
  const { entity, principal, authorization } = request;
  if (request.fieldName) {
    const capability = request.capability ?? write;
    if (authorization) {
      const decision = await authorization.admit({
        category: 'entity',
        verb: 'update',
        operation: 'update',
        principal: principal as Principal,
        entity,
        row,
        fieldName: request.fieldName,
        capability,
        resourceId: rowId(row),
      });
      return decision.admitted;
    }
    return mayFieldOp(entity, request.fieldName, capability, row, principal);
  }
  if (authorization) {
    const decision = await authorization.admit({
      category: 'entity',
      verb: request.verb,
      operation: request.verb,
      principal: principal as Principal,
      entity,
      row,
      resourceId: rowId(row),
    });
    return decision.admitted;
  }
  return mayRow(entity, request.verb, row, principal);
}

// Proposed-transition mutation admission: the `.can` / field access runs against
// BOTH rows — the current row (so an in-scope principal keeps its grant) AND the
// proposed after-row (so a transition that moves the row out of scope is
// rejected). When no after-row is present (delete / revoke) the stable anchor
// `before` decides alone. Any absent row fails closed.
export async function admitRowTransition(request: RowTransitionRequest): Promise<boolean> {
  const { before, after } = request;
  if (before == null) return false;
  if (after !== undefined && after !== null) {
    return (await admitTransitionRow(request, before)) && (await admitTransitionRow(request, after));
  }
  return admitTransitionRow(request, before);
}

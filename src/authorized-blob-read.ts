// Authorized blob reads (S6/A4): the framework read seam for blob bytes.
//
// The byte store serves bytes by id; this seam decides WHO may read them. It
// runs the S5 authorization adapter's `blob` resource admission — current
// authorization: requesting principal, owning resource, operation, range, and
// the resource-level policy the app registered on the adapter — BEFORE bytes
// are touched. Every failure collapses into ONE generic denial
// (BlobReadDeniedError, a plain 403 'forbidden'): a denied read, a missing
// owning resource, missing bytes, an expired claim — a caller can never
// distinguish "the blob does not exist" from "you may not read it" (S6
// consideration #11), so an unclaimed blob id leaks no existence signal.
// Content hashes are integrity metadata, never authorization tokens (#24).
//
// The seam is a LIBRARY surface the app (Scope, S8) mounts with its own
// resource-level authorization, replacing direct `blobs.readRange` calls. It
// takes an authoritative `read` callback — the app's claim-gated byte reader
// wired to the byte store / pending-blob claim machinery — and owns the
// admission decision, the generic denial, and the read's attribution to the
// requesting principal (a user principal via S5/A1, or a machine principal via
// S5/A5 — the adapter collapses and the seam logs the attributed identity).
// The /blobs upload route remains the only framework write path; this seam
// never writes.

import { getLog } from './log.ts';
import { failure } from './outcome.ts';
import type { AdmissionOperation, AuthorizationAdapter } from './authorization-adapter.ts';
import { blobRead as blobReadCategory } from './operation.ts';
import { principalKeyOf, type Principal } from './principal.ts';

export interface ReadBlobArgs {
  /** The requesting principal — a user principal (S5/A1) or a machine principal (S5/A5). The read is attributed to it. */
  readonly principal: Principal;
  /**
   * The OWNING resource row (the entity whose blob field holds the bytes), in
   * stored cell form. Null/absent when the owning row is gone — admission
   * denies ('no-row-scope'), never a distinguishable "blob missing".
   */
  readonly resource: unknown;
  /** The declared blob field; names the resource registered on the adapter. */
  readonly field: string;
  /** The operation category; defaults to the `blob-read` category. */
  readonly operation?: AdmissionOperation;
  /** Optional half-open byte range `[start, end)`; passed through to `read`. */
  readonly range?: [start?: number, end?: number];
  /** The S5 authorization adapter — the ONE admission engine. */
  readonly authorize: AuthorizationAdapter;
  /**
   * The claim-gated byte reader the app wires to the byte store / pending-blob
   * claim machinery. It runs only AFTER admission; its own failures (missing
   * bytes, a failed digest attestation) surface as the same generic denial.
   */
  readonly read: (range?: [start?: number, end?: number]) => Buffer;
}

// The generic denial every blob-read failure collapses to. HTTP dispatch maps
// it to a generic 403 'forbidden'. `reasonCode` is server-side diagnostics
// only (the closed adapter vocabulary, or 'blob-unavailable' for a post-
// admission byte failure) — never surfaced to a client, never row content, and
// never a signal that distinguishes denial from absence.
export class BlobReadDeniedError extends Error {
  readonly status = 403;
  readonly failure = failure('denied', 'forbidden');
  readonly reasonCode: string;
  constructor(reasonCode: string) {
    super('forbidden');
    this.name = 'BlobReadDeniedError';
    this.reasonCode = reasonCode;
  }
}

// The authorized blob read. Admits through the S5 adapter under the `blob`
// resource category (the field names the registered resource; the owning row
// binds the scope), then serves bytes through `read`. Both the admission and
// the byte read are attributed to the requesting principal in the auth log.
export async function readBlob({ principal, resource, field, operation, range, authorize, read }: ReadBlobArgs): Promise<Buffer> {
  const resourceId = resourceIdOf(resource);
  const decision = await authorize.admit({
    category: 'blob',
    principal,
    operation: operation ?? blobReadCategory,
    resourceName: field,
    row: resource,
    resourceId,
  });
  if (!decision.admitted) {
    getLog().debug('auth', 'blob read denied', {
      principal: principalLabel(principal),
      field,
      resourceId,
      reason: decision.reasonCode,
    });
    throw new BlobReadDeniedError(decision.reasonCode ?? 'no-blob-access');
  }
  try {
    const bytes = read(range);
    getLog().debug('auth', 'blob read attributed', {
      principal: principalLabel(principal),
      field,
      resourceId,
      operation: decision.operation?.operation ?? blobReadCategory.operation,
      byteLength: bytes.length,
    });
    return bytes;
  } catch {
    // Missing/erased bytes look exactly like a denied read — never a
    // distinguishable existence signal (#11).
    getLog().debug('auth', 'blob read unavailable after admission', {
      principal: principalLabel(principal),
      field,
      resourceId,
    });
    throw new BlobReadDeniedError('blob-unavailable');
  }
}

function resourceIdOf(resource: unknown): string | null {
  const id = (resource as { id?: unknown } | null | undefined)?.id;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : null;
}

function principalLabel(principal: Principal): string {
  return principalKeyOf(principal) ?? 'anonymous';
}

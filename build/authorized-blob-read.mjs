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

import { getLog } from './log.mjs';
import { failure } from './outcome.mjs';

import { blobRead as blobReadCategory } from './operation.mjs';
import { principalKeyOf,                } from './principal.mjs';


                                



                                                                









                                    









// The generic denial every blob-read failure collapses to. HTTP dispatch maps
// it to a generic 403 'forbidden'. `reasonCode` is server-side diagnostics
// only (the closed adapter vocabulary, or 'blob-unavailable' for a post-
// admission byte failure) — never surfaced to a client, never row content, and
// never a signal that distinguishes denial from absence.
export class BlobReadDeniedError extends Error {
           status = 403;
           failure = failure('denied', 'forbidden');
           reasonCode        ;
  constructor(reasonCode        ) {
    super('forbidden');
    this.name = 'BlobReadDeniedError';
    this.reasonCode = reasonCode;
  }
}

// The authorized blob read. Admits through the S5 adapter under the `blob`
// resource category (the field names the registered resource; the owning row
// binds the scope), then serves bytes through `read`. Both the admission and
// the byte read are attributed to the requesting principal in the auth log.
export async function readBlob({ principal, resource, field, operation, range, authorize, read }              )                  {
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

function resourceIdOf(resource         )                {
  const id = (resource                                       )?.id;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : null;
}

function principalLabel(principal           )         {
  return principalKeyOf(principal) ?? 'anonymous';
}

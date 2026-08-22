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
// only (the closed adapter vocabulary, or 'blob-unavailable' for a byte/
// admission failure) — stored NON-ENUMERABLY so the public error surface
// (status, failure, message, name) is byte-identical for every denial kind: a
// caller can never distinguish denial from absence, and serialization (JSON,
// deepEqual, key enumeration) never carries the reason.
export class BlobReadDeniedError extends Error {
           status = 403;
           failure = failure('denied', 'forbidden');
  constructor(reasonCode        ) {
    super('forbidden');
    this.name = 'BlobReadDeniedError';
    // Internal diagnostic only — non-enumerable so it never reaches a client,
    // never row content, and never distinguishes denied from missing (#11).
    Object.defineProperty(this, 'reasonCode', {
      value: reasonCode,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
}

// The authorized blob read. Admits through the S5 adapter under the `blob`
// resource category (the field names the registered resource; the owning row
// binds the scope), then serves bytes through `read`. BOTH the admission and
// the byte read are attributed to the requesting principal in the auth log,
// and BOTH collapse into the same generic denial — a throwing or malformed
// adapter is never distinguishable from a denial or missing bytes (#11).
export async function readBlob({ principal, resource, field, operation, range, authorize, read }              )                  {
  const resourceId = resourceIdOf(resource);
  try {
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
    const bytes = read(range);
    getLog().debug('auth', 'blob read attributed', {
      principal: principalLabel(principal),
      field,
      resourceId,
      operation: decision.operation?.operation ?? blobReadCategory.operation,
      byteLength: bytes.length,
    });
    return bytes;
  } catch (error) {
    // Every failure — a denied read, a throwing/malformed admission, missing
    // or erased bytes — collapses into ONE generic denial (#11): a caller can
    // never distinguish "the blob does not exist" from "you may not read it".
    // An admission denial rethrows as-is (its internal reason survives for the
    // server log); anything else becomes the byte-unavailability denial.
    if (error instanceof BlobReadDeniedError) throw error;
    getLog().debug('auth', 'blob read unavailable', {
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




                                   

                                                     





// The authorized blob read, streaming variant (#738 W1): the SAME admit-then-
// serve ordering as {@link readBlob} — admission completes before `read` is
// called, so no chunk can flow through a denied or unadmitted read — and the
// SAME generic-denial collapse. Because `read` constructs the stream
// synchronously, every conforming backend's typed missing-slot error
// (BlobSlotNotFoundError) is thrown HERE, inside the collapse boundary, before
// any streaming starts: a caller sees only the generic 403, never an existence
// signal. Attribution logs at stream construction (byte length is unknowable
// until consumed); cancellation is the stream's own AbortSignal contract, wired
// by the app into its `read` callback, not a seam concern.
export async function readBlobStream({ principal, resource, field, operation, range, authorize, read }                    )                    {
  const resourceId = resourceIdOf(resource);
  try {
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
    const stream = read(range);
    getLog().debug('auth', 'blob read attributed', {
      principal: principalLabel(principal),
      field,
      resourceId,
      operation: decision.operation?.operation ?? blobReadCategory.operation,
    });
    return stream;
  } catch (error) {
    // Every failure — a denied read, a throwing/malformed admission, missing
    // or erased bytes — collapses into ONE generic denial (#11), identical to
    // the buffered variant: an admission denial rethrows as-is (its internal
    // reason survives for the server log); anything else becomes the
    // byte-unavailability denial. This catches a synchronously throwing stream
    // construction too, so a missing slot denies BEFORE any streaming starts.
    if (error instanceof BlobReadDeniedError) throw error;
    getLog().debug('auth', 'blob read unavailable', {
      principal: principalLabel(principal),
      field,
      resourceId,
    });
    throw new BlobReadDeniedError('blob-unavailable');
  }
}

function principalLabel(principal           )         {
  return principalKeyOf(principal) ?? 'anonymous';
}

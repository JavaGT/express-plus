import { randomBytes } from 'node:crypto';
import { ensureStream, ensureLease, hashClientNonce } from '../src/annotated-text-authoring-stream.mjs';
import { projectAnnotatedTextSnapshot } from '../src/annotated-text-snapshot.mjs';

const TOKEN_BYTES = 32;
function base64url(bytes) {
  return bytes.toString('base64url');
}

export function allocateToken() {
  return base64url(randomBytes(TOKEN_BYTES));
}

export function allocateClientNonce() {
  return base64url(randomBytes(TOKEN_BYTES));
}

/**
 * Set up an authoring stream + lease for a principal on a document, then
 * capture a fresh snapshot that includes the blockless authoring envelope
 * (ONE document-scoped position frame). Returns the stream/lease tokens and
 * the document position token.
 */
export async function withAuthoringBinding({ db, entity, Document, row, principal, fieldName, descriptor }) {
  const prefix = `${entity.name}_${fieldName}`;
  const clientNonce = allocateClientNonce();
  const stream = ensureStream({ db, prefix, documentId: row.id, principalType: principal?.type ?? 'principal', principalId: principal?.id ?? '' });
  const lease = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: hashClientNonce(clientNonce) });
  const authoring = { streamToken: stream.id, leaseToken: lease.id, leaseId: lease.id, clientNonceHash: hashClientNonce(clientNonce) };
  const snapshot = await projectAnnotatedTextSnapshot({ db, entity: Document, row, principal, fieldName, descriptor, authoring });
  const documentPositionToken = snapshot.authoring.positionFrames[0]?.positionToken;
  if (typeof documentPositionToken !== 'string') throw new Error('blockless authoring envelope is missing the document position frame');
  return { streamToken: stream.id, leaseToken: lease.id, leaseId: lease.id, clientNonceHash: hashClientNonce(clientNonce), snapshot, documentPositionToken };
}

export function authoringBinding(streamToken, leaseToken, mutationId) {
  return { version: 1, stream: streamToken, lease: leaseToken, mutationId };
}

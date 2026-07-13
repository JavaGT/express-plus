// Node-only capabilities used to assemble and operate a Workbench application.
// Declaration grammar stays at `workbench`; the zero-import browser runtime
// stays at `workbench/client`. This module deliberately does not expose the
// ambient database, raw kernel, or raw DDL machinery.

export {
  sessionCookie,
  sessionPrincipalOf,
  sessionTokenOf,
  apiKeyPrincipalOf,
  parseCookies,
  SESSION_COOKIE,
} from './auth/session.mjs';
export {
  createInvitationApi,
} from './auth/invitation.mjs';
export { emailSeam, noopTransport } from './email-seam.mjs';
export { frameworkTableNames } from './schema-table-census.mjs';
export { matchRoute } from './http-route-match.mjs';
export { serveStatic } from './views.mjs';
export { createJobQueue } from './job-queue.mjs';
export { createBlobStore } from './blob-store.mjs';
export { runMigrations } from './migrations.mjs';
export { readSeq as readCommittedCursor } from './committed-log.mjs';
import { readSince } from './committed-log.mjs';

export function readCommittedEventsSince(db, scope, cursor) {
  return readSince(db, scope, cursor).map((row) => ({
    type: row.eventType,
    scope: row.scope,
    seq: row.seq,
    actionId: row.actionId,
    committedAt: row.committedAt,
    data: row.data,
  }));
}

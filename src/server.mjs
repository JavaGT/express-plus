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
export { frameworkTableNames, declaredTableNames } from './schema-table-census.mjs';
export { matchRoute } from './http-route-match.mjs';
export { serveStatic } from './views.mjs';
export { createJobQueue } from './job-queue.mjs';
export { createBlobStore } from './blob-store.mjs';
export { runMigrations } from './migrations.mjs';
export { defineSqliteSchema } from './sqlite-schema.mjs';
export { describeEntityStorage, describeSqliteStorage } from './sqlite-storage-description.mjs';
export { readSeq as readCommittedCursor } from './committed-log.mjs';
export { createLiveDelivery } from './live-delivery-public.mjs';
export { operationalConsumerAdmin } from './operational-consumer.mjs';
export { pendingBlobStager, declaredBlobField, readClaimedBlob } from './pending-blob.mjs';

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
} from './auth/session.ts';
export {
  createInvitationApi,
} from './auth/invitation.ts';
export { emailSeam, noopTransport } from './email-seam.ts';
export {
  frameworkTableNames,
  declaredTableNames,
  // App-lint helper: fail closed when SQL names a framework-owned table.
  assertNoFrameworkTableSql,
} from './schema-table-census.ts';
export { matchRoute } from './http-route-match.ts';
export { serveStatic } from './views.ts';
export { createJobQueue } from './job-queue.ts';
export { createBlobStore } from './blob-store.ts';
export { runMigrations } from './migrations.ts';
export { WORKBENCH_MIGRATIONS, ensureWorkbenchMigrationTable, appliedWorkbenchVersion, runWorkbenchMigrations } from './workbench-migrations.ts';
export { defineSqliteSchema } from './sqlite-schema.ts';
export { describeEntityStorage, describeSqliteStorage } from './sqlite-storage-description.ts';
export { readSeq as readCommittedCursor } from './committed-log.ts';
export { createLiveDelivery } from './live-delivery-public.ts';
export { createLiveDeliveryHttpHandler } from './live-delivery-http.ts';
// App-safe operational consumer admin — inspect and retry terminal failures.
// Consumers are registered via `workbench({ operationalConsumers: [...] })` and
// reconciled automatically. See `defineOperationalEvent` / `operationalConsumer`
// in the root package for declaration.
export { operationalConsumerAdmin } from './operational-consumer.ts';
// Advanced: creates a runner for post-commit effects declared via
// `postCommitEffect()` in action handlers. In normal app usage the runner is
// auto-created at `app.postCommitEffects` when a database is configured; this
// export is for custom wiring only.
export { createPostCommitEffectRunner } from './post-commit-effects.ts';
export { pendingBlobStager, declaredBlobField, readClaimedBlob, claimedBlobLifecycle } from './pending-blob.ts';
export { createHistoryReader } from './history-read.ts';

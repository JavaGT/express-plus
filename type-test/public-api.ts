import workbench, {
  action, event, entity, text, date, ref, projected, computed, ephemeral, inherit, log, state,
  schedule, tick,
  principal, read, write, grant, membership, parseCookies, SESSION_COOKIE,
  apiKeyPrincipalOf, createInvitationApi as createRootInvitationApi, emailSeam,
  FAILURE_CATEGORIES, failure, failureOutcome, isWorkbenchFailure, sanitizeUnexpectedFailure,
  matchRoute, noopTransport, serveStatic, sessionCookie, sessionPrincipalOf,
  sessionTokenOf,
  durableHistory,
  type ActionHandle, type BatchAction, type CommittedEvent, type DispatchRequest,
  type DispatchResult, type EventHandle, type FailureCategory, type FailureOutcome,
  type InheritDirective, type Principal, type WorkbenchFailure,
  type WorkbenchApp, type WorkbenchEntity,
} from 'workbench';
import {
  createBlobStore, createInvitationApi, createJobQueue, readCommittedCursor,
  readCommittedEventsSince, runMigrations, describeEntityStorage, describeSqliteStorage,
  type BlobStore, type SqliteStorageDescription,
  type Invitation, type JobQueue, type JobRow, type Migration, type UserPrincipal,
  type WorkbenchDatabase,
} from 'workbench/server';
import {
  LiveChannel, LiveList, WorkbenchFailureError, createAuthClient, createLiveStore, decodeResult,
  type EventsSinceResponse, type LiveStore, type SnapshotResponse,
  type StaleResponse, type WsEnvelope,
} from 'workbench/client';
import { DatabaseSync } from 'node:sqlite';

type ProjectRow = { id: string; name: string; ownerId: string };
const category: FailureCategory = FAILURE_CATEGORIES[0];
const expectedFailure: WorkbenchFailure = failure(category, 'Invalid project.', { field: 'name' });
const expectedOutcome: FailureOutcome = failureOutcome(expectedFailure);
const unexpectedFailure: WorkbenchFailure = sanitizeUnexpectedFailure(new Error('secret'));
const recognizedFailure: boolean = isWorkbenchFailure(expectedFailure);
void [expectedOutcome, unexpectedFailure, recognizedFailure];
const Project: WorkbenchEntity<ProjectRow> = entity('Project', {
  name: text(),
  owner: ref('User'),
  summary: projected.async({
    from: ['Project.created'],
    compute: async (row) => String(row.name ?? ''),
  }),
  grant: grant(read, write),
  routes: (routes) => routes.resource(),
});
// @ts-expect-error projected is a namespace; asynchronous projections use projected.async(...)
projected({ compute: async () => 'invalid' });

const Rename: ActionHandle<{ id: string; name: string }> = action('Project.rename');
const Renamed: EventHandle<ProjectRow, { name: string }> = event(
  'Project.renamed',
  (state, payload) => ({ ...state, name: payload.name }),
);

declare const db: WorkbenchDatabase;
const nativeDb = new DatabaseSync(':memory:');
const nativeApp: WorkbenchApp = workbench({ db: nativeDb });
const declaredStorage: SqliteStorageDescription = describeEntityStorage(Project);
const liveStorage: SqliteStorageDescription = describeSqliteStorage(nativeDb, []);
// @ts-expect-error raw declarations are not compiled entities and have no storage name/fields
describeEntityStorage({ grant: grant(read) });
void [declaredStorage, liveStorage];
void nativeApp;
const migration: Migration = { version: 1, up: (database) => database.exec('SELECT 1') };
const app: WorkbenchApp = workbench({
  db,
  migrations: [migration],
  requireEnv: ['SESSION_SECRET'],
  blobReapIntervalMs: 60_000,
  blobReapTtlMs: 3_600_000,
  logRetentionDays: 30,
  logRetentionIntervalMs: 60_000,
}).mount('/projects', Project);
const startedApp: Promise<WorkbenchApp> = app.start();
app.onShutdown('typed cleanup', () => undefined, { timeoutMs: 1000 });
const stoppedApp: Promise<void> = app.shutdown();
void app.prepareSchema();
const Projects = app.entity(Project);
const namedProjects: PromiseLike<ProjectRow[]> = Projects
  .findAll(Projects.field.name.is('Research'))
  .sort(Projects.field.name, 'asc')
  .limit(10);
const projectedProjects: Array<Pick<ProjectRow, 'id' | 'name'>> = Projects.findAll().select(
  Projects.field.id,
  Projects.field.name,
);
// @ts-expect-error a projection does not contain fields that were not selected
const wronglyFullProjects: ProjectRow[] = projectedProjects;
void [namedProjects, projectedProjects, wronglyFullProjects];
const request: DispatchRequest = {
  actionId: 'action-1',
  type: Rename.type,
  payload: { id: 'project-1', name: 'Research' },
  principal: principal({ type: 'user', id: 'user-1' }),
};
const dispatchResult: Promise<DispatchResult> = app.dispatch(request);

const configuredHistory = durableHistory({
  authorize: ({ operation, scope: historyScope, principal: historyPrincipal }) =>
    operation === 'read' && historyScope.length > 0 && historyPrincipal.id !== null,
  inverse: ({ action: committedAction }) => ({
    type: committedAction.type ?? 'note.restore',
    payload: committedAction.payload as Record<string, unknown>,
    scope: committedAction.scope,
  }),
});
void configuredHistory;
const batchActions: readonly BatchAction[] = [
  { type: Rename.type, payload: { id: 'project-1', name: 'Research' } },
];
const batchResult: Promise<DispatchResult> = app.batch(
  batchActions,
  { principal: request.principal },
);
const plannedBatchResult: Promise<DispatchResult> = app.batch(
  () => batchActions,
  { principal: request.principal },
);
// @ts-expect-error batch planning is synchronous so it stays inside one write-queue turn
app.batch(async () => batchActions, { principal: request.principal });
app.listen(() => undefined);
app.listen({ principalOf: () => request.principal, requestLog: true });
app.listen(0, { onListening: () => undefined, hsts: true });
// @ts-expect-error maintenance belongs to the application runtime, not one HTTP transport
app.listen({ blobReapTtlMs: 1000 });
// @ts-expect-error resource expansion belongs only to an entity routes callback
app.resource();
const maybeServer: import('node:http').Server | undefined = app.httpServer;
const registeredEntities: ReadonlyMap<string, import('workbench').BoundWorkbenchEntity> = app.entities;
void [startedApp, stoppedApp, dispatchResult, batchResult, plannedBatchResult, maybeServer, registeredEntities];

const inherited: InheritDirective = inherit(Project, { via: 'projectId' });
const Child = entity('Child', { projectId: ref(Project), grant: inherited });
void Child;
const AuditedChild = entity('AuditedChild', {
  projectId: ref(Project, { immutable: true }),
  createdAt: date({ readonly: true, default: () => new Date() }),
  updatedAt: date({ touch: true, default: () => new Date() }),
  grant: inherited,
});
void AuditedChild;

const queue: JobQueue = createJobQueue({ db, sharedSecret: 'secret' });
const job: JobRow = queue.enqueue({ kind: 'index', payload: { projectId: 'project-1' } });
const blobs: BlobStore = createBlobStore({ db, bytes: {} as never });
void [job, blobs, runMigrations(db, [migration]), readCommittedCursor(db, 'Project:project-1')];
const committed: CommittedEvent[] = readCommittedEventsSince(db, 'Project:project-1', 0);
void committed;

const actor: Principal = principal({ type: 'apiKey', id: 'key-1' });
void actor;
declare const Invitations: import('workbench').BoundWorkbenchEntity<Invitation>;
const invitationApi = createInvitationApi({ Invitation: Invitations });
const invitationUser: UserPrincipal = principal({ type: 'user', id: 'user-1' });
const createdInvitation: Promise<Invitation> = invitationApi.createInvitation({
  targetEntity: 'Project', targetId: 'project-1', role: 'member',
  principal: invitationUser,
});
const apiKeyActor = principal({ type: 'apiKey', id: 'key-1' });
invitationApi.createInvitation({
  targetEntity: 'Project', targetId: 'project-1', role: 'member',
  // @ts-expect-error only a human user principal can create an invitation
  principal: apiKeyActor,
});
// @ts-expect-error only a human user principal can accept an invitation
invitationApi.acceptInvitation('invite-token', apiKeyActor);
// @ts-expect-error only a human user principal can reject an invitation
invitationApi.rejectInvitation('invite-token', apiKeyActor);
const rejectedInvitation: Promise<void> = invitationApi.rejectInvitation(
  'invite-token',
  invitationUser,
);
// @ts-expect-error only a human user principal can list invitations
invitationApi.listInvitationsForUser(apiKeyActor);
void [createdInvitation, rejectedInvitation];
const channel = new LiveChannel('https://example.test', {
  socketFactory: (url) => new WebSocket(url),
});
const liveFailureError = new WorkbenchFailureError(expectedFailure);
const liveFailure: WorkbenchFailure = liveFailureError.failure;
channel.subscribe('Project', 'project-1', {
  fields: { cursor: true },
  pace: { profile: '15fps' },
  onCheckpoint: ({ currentSeq }) => { void currentSeq; },
}, () => {});
const list: LiveList<ProjectRow> = new LiveList({ id: 'project-1', snapshot: [], cursor: 0 } as never);
const store: LiveStore<ProjectRow> = createLiveStore({
  baseUrl: 'https://example.test', name: 'Project', path: '/projects', channel,
});
const auth = createAuthClient({ baseUrl: 'https://example.test' });
void [list, store, auth.login('researcher', 'password'), decodeResult(new Response(null, { status: 204 }))];

declare const envelope: WsEnvelope;
declare const snapshot: SnapshotResponse<ProjectRow>;
declare const eventsSince: EventsSinceResponse;
declare const stale: StaleResponse<ProjectRow>;
void [envelope, snapshot, eventsSince, stale, Renamed, liveFailure];

const boundWithMembership = membership(app.entity(Project), {
  member: { can: [read] },
});
const stillBound: import('workbench').BoundWorkbenchEntity<ProjectRow> = boundWithMembership;
const parsedCookie: Record<string, string> = parseCookies(`${SESSION_COOKIE}=token`);
const rootInvitationApi = createRootInvitationApi({ Invitation: Invitations });
const routeMatch = matchRoute([], 'GET', '/health');
const staticHandler = serveStatic('/tmp');
const cookieHeader: string = sessionCookie('token');
const sessionToken: string | undefined = sessionTokenOf({ headers: { cookie: cookieHeader } });
const principalFromSession = sessionPrincipalOf(db);
const principalFromApiKey = apiKeyPrincipalOf(db);
const mail = emailSeam({ transport: noopTransport });
void [
  stillBound, parsedCookie, rootInvitationApi, routeMatch, staticHandler,
  sessionToken, principalFromSession, principalFromApiKey, mail,
];

// ── field-constructor contract parity ──────────────────────────────────

// computed({ compute })
const computedPull = computed({ compute: (row) => String(row.name ?? '') });
// @ts-expect-error computed requires a compute function
computed({});
// @ts-expect-error compute must be a function, not a string
computed({ compute: 'not a function' });
void computedPull;

// computed.stored({ compute })
const computedStored = computed.stored({ compute: (row) => Number(row.count) });
// @ts-expect-error computed.stored requires a compute function
computed.stored({});
void computedStored;

// ephemeral({ cell: descriptor })
const ephem = ephemeral({ cursor: text(), selection: text() });
const emptyEphem = ephemeral();
// @ts-expect-error ephemeral requires an object of descriptors, not a bare descriptor
ephemeral(text());
void [ephem, emptyEphem];

// log({ field: descriptor })
const chatLog = log({ sender: ref('User'), body: text() });
const emptyLog = log();
// @ts-expect-error log entry must be an object, not a bare descriptor
log(text());
// @ts-expect-error log has no options argument in the runtime API
log({ body: text() }, {});
void [chatLog, emptyLog];

// state(...).transition(...)
const statusField = state({ values: ['draft', 'shared', 'archived'] });
const tx = state.transition('draft', 'shared');
const transitionType: 'transition:draft->shared' = tx.type;
// @ts-expect-error transition requires two string arguments
state.transition();
void [statusField, tx, transitionType];

// schedule/tick lifecycle guards are synchronous row predicates
const dueAt = date();
schedule.at<{ status: string }>(dueAt, {
  key: 'publish',
  when: ({ row }) => row.status === 'ready',
  with: { status: 'published' },
});
tick.every<{ status: string }>('1m', {
  while: ({ fields }) => fields.status.is('ready'),
  when: ({ row }) => row.status === 'ready',
});
// @ts-expect-error when must be a function
schedule.at(dueAt, { when: 'ready' });
// @ts-expect-error lifecycle guards must return a boolean synchronously
tick.hz(10, { when: async () => true });
// @ts-expect-error trigger keys must be strings
schedule.after(dueAt, '1m', { key: 42 });

// projected.async(...)
const proj = projected.async({
  compute: async (row) => String(row.name ?? ''),
  from: ['Project.created'],
});
// @ts-expect-error projected.async requires a compute function
projected.async({});
// @ts-expect-error projected.async invalid: from should be string array, not number
projected.async({ compute: async () => 'x', from: 42 });
void proj;

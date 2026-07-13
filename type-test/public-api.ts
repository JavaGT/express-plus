import workbench, {
  action, event, entity, text, ref, principal, read, write, grant,
  type ActionHandle, type CommittedEvent, type DispatchRequest,
  type DispatchResult, type EventHandle, type Principal,
  type WorkbenchApp, type WorkbenchEntity,
} from 'workbench';
import {
  createBlobStore, createInvitationApi, createJobQueue, readCommittedCursor,
  readCommittedEventsSince, runMigrations, type BlobStore,
  type Invitation, type JobQueue, type JobRow, type Migration, type WorkbenchDatabase,
} from 'workbench/server';
import {
  LiveChannel, LiveList, createAuthClient, createLiveStore, decodeResult,
  type EventsSinceResponse, type LiveStore, type SnapshotResponse,
  type StaleResponse, type WsEnvelope,
} from 'workbench/client';

type ProjectRow = { id: string; name: string; ownerId: string };
const Project: WorkbenchEntity<ProjectRow> = entity('Project', {
  name: text(),
  owner: ref('User'),
  grant: grant(read, write),
  routes: (routes) => routes.resource(),
});

const Rename: ActionHandle<{ id: string; name: string }> = action('Project.rename');
const Renamed: EventHandle<ProjectRow, { name: string }> = event(
  'Project.renamed',
  (state, payload) => ({ ...state, name: payload.name }),
);

declare const db: WorkbenchDatabase;
const migration: Migration = { version: 1, up: (database) => database.exec('SELECT 1') };
const app: WorkbenchApp = workbench({ db, migrations: [migration] }).mount('/projects', Project);
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
void dispatchResult;

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
const createdInvitation: Promise<Invitation> = invitationApi.createInvitation({
  targetEntity: 'Project', targetId: 'project-1', role: 'member',
  principal: principal({ type: 'user', id: 'user-1' }),
});
void createdInvitation;
const channel = new LiveChannel('https://example.test');
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
void [envelope, snapshot, eventsSince, stale, Renamed];

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  entity,
  everyone,
  grant,
  map,
  membership,
  read,
  ref,
  router,
  scope,
  text,
  subscribe,
  write,
} from '../build/index.mjs';
import { mayRow } from '../build/row-grant.mjs';

function noteDeclaration() {
  return entity('IsolatedNote', {
    title: text(),
    grant: () => [
      scope(() => everyone()).can(() => grant(read, write)),
    ],
  });
}

test('one declaration binds trusted queries independently to two applications', async () => {
  const Note = noteDeclaration();
  const appA = workbench({ db: new DatabaseSync(':memory:') }).mount('/notes', Note);
  const appB = workbench({ db: new DatabaseSync(':memory:') }).mount('/notes', Note);
  await Promise.all([appA.prepareSchema(), appB.prepareSchema()]);

  const notesA = appA.entity(Note);
  const notesB = appB.entity(Note);
  notesA.insert({ id: 'shared-id', title: 'Only in A' });
  notesB.insert({ id: 'shared-id', title: 'Only in B' });

  assert.equal(notesA.getOrFail('shared-id').title, 'Only in A');
  assert.equal(notesB.getOrFail('shared-id').title, 'Only in B');

  notesA.delete('shared-id');
  assert.equal(notesA.findById('shared-id'), null);
  assert.equal(notesB.getOrFail('shared-id').title, 'Only in B');

  assert.equal(
    Note.findById,
    undefined,
    'a declaration must not silently query whichever app was constructed last',
  );

  appA.db.close();
  appB.db.close();
});

test('membership applied through a facade scopes policy to that application', () => {
  const Team = entity('BoundMembershipTeam', {
    members: map(ref('User'), { role: ['member'] }),
    grant: () => [scope(() => everyone()).can(() => grant(read))],
  });
  const app = workbench({ db: new DatabaseSync(':memory:'), entities: [Team] });

  const facade = app.entity(Team);
  const result = membership(facade, {
    member: { can: [read, subscribe] },
  });

  assert.equal(result, facade);
  assert.ok(facade.registry.member);
  assert.notEqual(facade.registry, Team.registry);
  app.db.close();
});

test('membership applied through one app facade does not leak to another app sharing the declaration', () => {
  const Team = entity('IsolatedMembershipTeam', {
    members: map(ref('User'), { role: ['member'] }),
  });
  const appA = workbench({ db: new DatabaseSync(':memory:'), entities: [Team] });
  const appB = workbench({ db: new DatabaseSync(':memory:'), entities: [Team] });

  membership(appA.entity(Team), {
    member: { can: [read, subscribe] },
  });

  const teamA = appA.entity(Team);
  const teamB = appB.entity(Team);
  assert.notEqual(teamA.registry, Team.registry);
  assert.equal(teamB.registry, Team.registry);
  assert.equal(typeof teamA.grant, 'function');
  assert.equal(teamB.grant, undefined);
  assert.match(teamA.readScope.sql, /IsolatedMembershipTeam_members/);
  assert.equal(teamB.readScope, undefined);
  assert.equal(teamB.scopeFilter({ type: 'user', id: 'user-b' }).sql, '1=0');

  appA.db.close();
  appB.db.close();
});

test('the field namespace keeps metadata separate from a field named name', async () => {
  const NamedThing = entity('NamedThing', {
    name: text(),
    grant: () => [scope(() => everyone()).can(() => grant(read, write))],
  });
  const app = workbench({ db: new DatabaseSync(':memory:'), entities: [NamedThing] });
  await app.prepareSchema();
  const Things = app.entity(NamedThing);
  Things.insert({ id: 'thing-1', name: 'Workbench' });

  assert.equal(Things.name, 'NamedThing');
  assert.equal(Things.field.name.fieldName, 'name');
  assert.equal(Things.findOne(Things.field.name.is('Workbench')).id, 'thing-1');
  app.db.close();
});

test('an application memoizes bindings and rejects ambiguous entity names', () => {
  const Note = noteDeclaration();
  const app = workbench({ db: new DatabaseSync(':memory:'), entities: [Note] });

  assert.equal(app.entity(Note), app.entity(Note));
  assert.equal(app.entity('IsolatedNote'), app.entity(Note));

  const ConflictingNote = noteDeclaration();
  assert.throws(
    () => app.register(ConflictingNote),
    /already registered with a different declaration/,
  );
  app.db.close();
});

test('an unknown string reference fails at the application boundary', () => {
  const app = workbench({ db: new DatabaseSync(':memory:') });
  assert.throws(() => app.entity('MissingEntity'), /not registered/);
  app.db.close();
});

test('dispatch exists before startup and fails with an honest lifecycle error', async () => {
  const app = workbench({ db: new DatabaseSync(':memory:') });
  assert.equal(typeof app.dispatch, 'function');
  await assert.rejects(app.dispatch({}), /not started/);
  app.db.close();
});

test('an entity without a grant denies every request-facing verb', async () => {
  const Ungranted = entity('FailClosedEntity', { value: text() });
  const app = workbench({ db: new DatabaseSync(':memory:'), entities: [Ungranted] });
  await app.prepareSchema();
  const Entity = app.entity(Ungranted);
  const row = Entity.insert({ id: 'one', value: 'secret' });
  const actor = { type: 'user', id: 'user-1', attributes: {} };

  assert.equal(Entity.scopeFilter(actor).sql, '1=0');
  for (const verb of ['list', 'read', 'create', 'update', 'remove', 'subscribe']) {
    assert.equal(await mayRow(Entity, verb, row, actor), false, `${verb} must deny`);
  }
  app.db.close();
});

test('a shared router resolves fresh entity bindings for each application', async () => {
  const Note = noteDeclaration();
  const sharedRouter = router().mount('/notes', Note);
  const appA = workbench({ db: new DatabaseSync(':memory:') }).mount('/api', sharedRouter);
  const appB = workbench({ db: new DatabaseSync(':memory:') }).mount('/api', sharedRouter);

  await Promise.all([appA.prepareSchema(), appB.prepareSchema()]);

  const routeA = appA.routes.find((route) => route.path === '/api/notes');
  const routeB = appB.routes.find((route) => route.path === '/api/notes');
  assert.equal(routeA.entity, appA.entity(Note));
  assert.equal(routeB.entity, appB.entity(Note));
  assert.notEqual(routeA.entity, routeB.entity);

  routeA.entity.insert({ id: 'same', title: 'A' });
  routeB.entity.insert({ id: 'same', title: 'B' });
  assert.equal(routeA.entity.getOrFail('same').title, 'A');
  assert.equal(routeB.entity.getOrFail('same').title, 'B');

  appA.db.close();
  appB.db.close();
});

test('registered and nested-router entities share one schema inventory', async () => {
  const Nested = noteDeclaration();
  const Unmounted = entity('UnmountedNote', {
    title: text(),
    grant: () => [scope(() => everyone()).can(() => grant(read, write))],
  });
  const app = workbench({
    db: new DatabaseSync(':memory:'),
    entities: [Unmounted],
  }).mount('/nested', router().mount('/notes', Nested));

  await app.prepareSchema();

  assert.ok(app.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='IsolatedNote'").get());
  assert.ok(app.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='UnmountedNote'").get());
  app.db.close();
});

test('foreign facades and late declarations fail at the application boundary', async () => {
  const Note = noteDeclaration();
  const appA = workbench({ db: new DatabaseSync(':memory:'), entities: [Note] });
  const appB = workbench({ db: new DatabaseSync(':memory:') });

  assert.throws(() => appB.entity(appA.entity(Note)), /different application/);
  await appB.prepareSchema();
  assert.throws(() => appB.register(Note), /after the application schema is prepared/);

  appA.db.close();
  appB.db.close();
});

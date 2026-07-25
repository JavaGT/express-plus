import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  admin,
  ApiKey,
  Invitation,
  entity,
  grant,
  json,
  map,
  membership,
  read,
  ref,
  scope,
  text,
} from '../src/index.mjs';
import { createInvitationApi } from '../src/auth/invitation.mjs';
import { principal } from '../src/principal.mjs';

async function fixture() {
  const Project = entity('InvitationSecurityProject', {
    title: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    members: map(ref('User'), { role: ['member'] }),
    grant: () => [],
  });
  membership(Project, { member: { can: [read] } });

  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, entities: [Project] });
  await app.prepareSchema();
  app.entity(Project).insert({ id: 'p1', title: 'Private', owner: 'owner-1' });
  app.listen(0);
  await app.ready;
  app.httpServer.unref();
  const closeDatabase = db.close.bind(db);
  Object.defineProperty(db, 'close', {
    configurable: true,
    value() {
      app.httpServer.close();
      closeDatabase();
    },
  });
  const api = createInvitationApi({ Invitation: app.entity(Invitation) });
  return { app, db, Project: app.entity(Project), Invitation: app.entity(Invitation), api };
}

const owner = principal({ type: 'user', id: 'owner-1' });
const stranger = principal({ type: 'user', id: 'stranger-1' });
const member = principal({ type: 'user', id: 'member-1' });

test('invitation creation requires admin capability on the target row', async () => {
  const { db, api } = await fixture();
  db.prepare(`
    INSERT INTO InvitationSecurityProject_members
      (InvitationSecurityProject_id, member_id, role)
    VALUES (:owner, :member, 'member')
  `).run({ owner: 'p1', member: stranger.id });
  await assert.rejects(
    api.createInvitation({
      targetEntity: 'InvitationSecurityProject', targetId: 'p1', role: 'member', principal: stranger,
    }),
    (error) => error.failure?.category === 'denied',
  );
  assert.equal(db.prepare('SELECT count(*) AS n FROM Invitation').get().n, 0);
  db.close();
});

test('invitation creation cannot authorize an admin-capable row hidden by its scope', async () => {
  const ScopedProject = entity('InvitationScopedProject', {
    title: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    members: map(ref('User'), { role: ['member'] }),
    grant: () => [scope(({ is }) => is.owner()).can(() => grant(admin))],
  });
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, entities: [ScopedProject] });
  await app.prepareSchema();
  app.entity(ScopedProject).insert({ id: 'private-1', title: 'Private', owner: owner.id });
  const api = createInvitationApi({ Invitation: app.entity(Invitation) });
  app.listen(0);
  await app.ready;
  app.httpServer.unref();

  await assert.rejects(
    api.createInvitation({
      targetEntity: ScopedProject.name, targetId: 'private-1', role: 'member', principal: stranger,
    }),
    (error) => error.failure?.category === 'not-found'
      && db.prepare('SELECT count(*) AS n FROM Invitation').get().n === 0,
  );
  app.httpServer.close();
  db.close();
});

test('invitation admission materializes declared fields before evaluating row capability', async () => {
  const PolicyProject = entity('InvitationPolicyProject', {
    title: text(),
    policy: json(),
    owner: ref('User', { role: 'owner', readonly: true }),
    members: map(ref('User'), { role: ['member'] }),
    grant: () => [scope(({ is }) => is.owner()).can(({ entity: row }) => (
      row.policy?.allowInvites ? grant(admin) : []
    ))],
  });
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, entities: [PolicyProject] });
  await app.prepareSchema();
  app.entity(PolicyProject).insert({
    id: 'policy-1', title: 'Policy', policy: { allowInvites: true }, owner: owner.id,
  });
  await app.start();
  const api = createInvitationApi({ Invitation: app.entity(Invitation) });

  const invitation = await api.createInvitation({
    targetEntity: PolicyProject.name, targetId: 'policy-1', role: 'member', principal: owner,
  });
  assert.ok(invitation.token);
  assert.equal(db.prepare('SELECT count(*) AS n FROM Invitation').get().n, 1);
  await app.shutdown();
  db.close();
});

test('target entity and role are resolved from declarations, never request SQL', async () => {
  const { db, api } = await fixture();
  await assert.rejects(
    api.createInvitation({ targetEntity: 'Invitation; DROP TABLE Invitation;--', targetId: 'p1', role: 'member', principal: owner }),
    (error) => error.failure?.category === 'invalid-input',
  );
  await assert.rejects(
    api.createInvitation({ targetEntity: 'InvitationSecurityProject', targetId: 'p1', role: 'administrator', principal: owner }),
    (error) => error.failure?.category === 'invalid-input',
  );
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'Invitation'").get());
  db.close();
});

test('open invitation tokens are not disclosed by a user inbox listing', async () => {
  const { db, api } = await fixture();
  await api.createInvitation({
    targetEntity: 'InvitationSecurityProject', targetId: 'p1', role: 'member', principal: owner,
  });
  assert.deepEqual(api.listInvitationsForUser(stranger), []);
  db.close();
});

test('acceptance is atomic and a repeated member does not consume another use', async () => {
  const { db, api, Invitation } = await fixture();
  const invitation = await api.createInvitation({
    targetEntity: 'InvitationSecurityProject', targetId: 'p1', role: 'member', maxUses: 1, principal: owner,
  });

  await api.acceptInvitation(invitation.token, member);
  await api.acceptInvitation(invitation.token, member);
  assert.equal(Invitation.findOne(Invitation.token.is(invitation.token)).useCount, 1);

  await assert.rejects(api.acceptInvitation(invitation.token, stranger), /maximum uses/);
  db.close();
});

test('concurrent final-use acceptance grants exactly one new membership', async () => {
  const { db, api, Invitation } = await fixture();
  const invitation = await api.createInvitation({
    targetEntity: 'InvitationSecurityProject', targetId: 'p1', role: 'member',
    maxUses: 1, principal: owner,
  });

  const users = [
    principal({ type: 'user', id: 'racer-1' }),
    principal({ type: 'user', id: 'racer-2' }),
  ];
  const results = await Promise.allSettled(
    users.map((user) => api.acceptInvitation(invitation.token, user)),
  );
  const stored = Invitation.findOne(Invitation.token.is(invitation.token));
  const memberships = db.prepare(`
    SELECT member_id FROM InvitationSecurityProject_members
    WHERE InvitationSecurityProject_id = 'p1'
    ORDER BY member_id
  `).all();

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(stored.useCount, 1);
  assert.equal(memberships.length, 1);
  db.close();
});

test('an exhausted invitation cannot upgrade an existing lower-role membership', async () => {
  const TieredProject = entity('InvitationTieredProject', {
    title: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    members: map(ref('User'), { role: ['viewer', 'editor'] }),
  });
  membership(TieredProject, {
    viewer: { field: { name: 'members', role: 'viewer' }, can: [read] },
    editor: { field: { name: 'members', role: 'editor' }, can: [read] },
  });
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, entities: [TieredProject] });
  await app.prepareSchema();
  app.entity(TieredProject).insert({ id: 'tiered-1', title: 'Private', owner: owner.id });
  app.listen(0);
  await app.ready;
  app.httpServer.unref();
  const closeDatabase = db.close.bind(db);
  Object.defineProperty(db, 'close', {
    configurable: true,
    value() {
      app.httpServer.close();
      closeDatabase();
    },
  });
  const InvitationEntity = app.entity(Invitation);
  const api = createInvitationApi({ Invitation: InvitationEntity });
  const invitation = await api.createInvitation({
    targetEntity: TieredProject.name, targetId: 'tiered-1', role: 'editor',
    maxUses: 1, principal: owner,
  });
  await api.acceptInvitation(invitation.token, principal({ type: 'user', id: 'first-editor' }));
  db.prepare(`
    INSERT INTO InvitationTieredProject_members
      (InvitationTieredProject_id, member_id, role)
    VALUES (:owner, :member, :role)
  `).run({ owner: 'tiered-1', member: member.id, role: 'viewer' });

  await assert.rejects(
    api.acceptInvitation(invitation.token, member),
    (error) => {
      const storedRole = db.prepare(`
        SELECT role FROM InvitationTieredProject_members
        WHERE InvitationTieredProject_id = :owner AND member_id = :member
      `).get({ owner: 'tiered-1', member: member.id }).role;
      const useCount = InvitationEntity.findOne(InvitationEntity.token.is(invitation.token)).useCount;
      return error.status === 400 && /maximum uses/.test(error.message)
        && storedRole === 'viewer' && useCount === 1;
    },
  );
  db.close();
});

test('failed membership insertion rolls back invitation consumption', async () => {
  const { db, api, Invitation } = await fixture();
  const invitation = await api.createInvitation({
    targetEntity: 'InvitationSecurityProject', targetId: 'p1', role: 'member', maxUses: 2, principal: owner,
  });
  db.exec('DROP TABLE InvitationSecurityProject_members');

  await assert.rejects(api.acceptInvitation(invitation.token, member), /failed to grant membership/);
  assert.equal(Invitation.findOne(Invitation.token.is(invitation.token)).useCount, 0);
  db.close();
});

test('acceptance reports a denied batch instead of returning false success', async () => {
  const { app, db, api } = await fixture();
  const invitation = await api.createInvitation({
    targetEntity: 'InvitationSecurityProject', targetId: 'p1', role: 'member', principal: owner,
  });
  app.batch = async () => ({
    ok: false,
    failure: { category: 'denied', message: 'Forbidden.' },
  });

  await assert.rejects(
    api.acceptInvitation(invitation.token, member),
    (error) => error.failure?.category === 'denied',
  );
  db.close();
});

test('rejection reports a denied batch instead of returning false success', async () => {
  const { app, db, api } = await fixture();
  const invitation = await api.createInvitation({
    targetEntity: 'InvitationSecurityProject', targetId: 'p1', role: 'member',
    targetUser: member.id, principal: owner,
  });
  app.batch = async () => ({
    ok: false,
    failure: { category: 'denied', message: 'Forbidden.' },
  });

  await assert.rejects(
    api.rejectInvitation(invitation.token, member),
    (error) => error.failure?.category === 'denied',
  );
  db.close();
});

test('invitation API rejects a database from another application runtime', async () => {
  const { db, Invitation } = await fixture();
  const other = new DatabaseSync(':memory:');
  assert.throws(
    () => createInvitationApi({ db: other, Invitation }),
    /same application runtime/,
  );
  other.close();
  db.close();
});

test('only maps whose members are User rows can be invitation roles', async () => {
  const Team = entity('InvitationSecurityTeam', { name: text(), grant: () => [] });
  const Project = entity('InvitationSecurityWrongMemberProject', {
    title: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    members: map(ref(Team), { role: ['member'] }),
    grant: () => [],
  });
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, entities: [Team, Project] });
  await app.prepareSchema();
  app.entity(Project).insert({ id: 'p1', title: 'Private', owner: owner.id });
  const api = createInvitationApi({ Invitation: app.entity(Invitation) });
  app.listen(0);
  await app.ready;
  app.httpServer.unref();

  await assert.rejects(
    api.createInvitation({
      targetEntity: Project.name, targetId: 'p1', role: 'member', principal: owner,
    }),
    (error) => error.failure?.category === 'invalid-input' && /User/.test(error.failure.message),
  );
  app.httpServer.close();
  db.close();
});

test('expired user-targeted invitation cannot be accepted', async () => {
  const { db, api, Invitation } = await fixture();
  const past = Date.now() - 1000;
  const invitation = await api.createInvitation({
    targetEntity: 'InvitationSecurityProject', targetId: 'p1', role: 'member',
    targetUser: member.id, expiresAt: past, principal: owner,
  });

  await assert.rejects(
    api.acceptInvitation(invitation.token, member),
    (error) => error.status === 400 && /expired/.test(error.message),
  );

  // Targeted invitation was NOT consumed (no delete, no useCount bump)
  const stored = Invitation.findOne(Invitation.token.is(invitation.token));
  assert.ok(stored);
  assert.equal(stored.useCount, 0);

  // No membership row was created
  const memberRow = db.prepare(
    'SELECT role FROM InvitationSecurityProject_members WHERE InvitationSecurityProject_id = :owner AND member_id = :member',
  ).get({ owner: 'p1', member: member.id });
  assert.equal(memberRow, undefined);
  db.close();
});

test('only a human user principal can create an invitation', async () => {
  const { db, api } = await fixture();
  const apiKeyWithOwnerId = principal({ type: 'apiKey', id: owner.id });

  await assert.rejects(
    api.createInvitation({
      targetEntity: 'InvitationSecurityProject', targetId: 'p1', role: 'member',
      principal: apiKeyWithOwnerId,
    }),
    (error) => error.status === 403 && /user principal/.test(error.message),
  );
  assert.equal(db.prepare('SELECT count(*) AS n FROM Invitation').get().n, 0);
  db.close();
});

test('only a human user principal can accept an invitation', async () => {
  const { db, api } = await fixture();
  const invitation = await api.createInvitation({
    targetEntity: 'InvitationSecurityProject', targetId: 'p1', role: 'member', principal: owner,
  });

  await assert.rejects(
    api.acceptInvitation(invitation.token, principal({ type: 'apiKey', id: member.id })),
    (error) => error.status === 403 && /user principal/.test(error.message),
  );
  db.close();
});

test('only a human user principal can reject an invitation', async () => {
  const { db, api } = await fixture();
  const invitation = await api.createInvitation({
    targetEntity: 'InvitationSecurityProject', targetId: 'p1', role: 'member',
    targetUser: member.id, principal: owner,
  });

  await assert.rejects(
    api.rejectInvitation(
      invitation.token,
      principal({ type: 'apiKey', id: member.id }),
    ),
    (error) => error.status === 403 && /user principal/.test(error.message),
  );
  db.close();
});

test('only a human user principal can list invitations', async () => {
  const { db, api } = await fixture();

  assert.throws(
    () => api.listInvitationsForUser(principal({ type: 'apiKey', id: member.id })),
    (error) => error.status === 403 && /user principal/.test(error.message),
  );
  db.close();
});

test('an API-key bearer cannot accept an invitation or consume its use', async (t) => {
  const Project = entity('InvitationBearerProject', {
    title: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    members: map(ref('User'), { role: ['member'] }),
  });
  membership(Project, { member: { can: [read] } });
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, entities: [Project] });
  app.auth();
  await app.prepareSchema();
  app.entity(Project).insert({ id: 'bearer-project', title: 'Private', owner: owner.id });
  const InvitationEntity = app.entity(Invitation);
  const api = createInvitationApi({ Invitation: InvitationEntity });
  app.listen(0);
  await app.ready;
  const invitation = await api.createInvitation({
    targetEntity: Project.name, targetId: 'bearer-project', role: 'member',
    maxUses: 1, principal: owner,
  });
  const key = app.entity(ApiKey).create({ name: 'invitation-key', createdBy: owner.id });

  t.after(() => {
    app.httpServer.close();
    db.close();
  });
  const { port } = app.httpServer.address();
  const response = await fetch(
    `http://127.0.0.1:${port}/auth/invitation/${invitation.token}/accept`,
    { method: 'POST', headers: { authorization: `Bearer ${key.plainToken}` } },
  );
  const stored = InvitationEntity.findOne(InvitationEntity.token.is(invitation.token));
  const membershipCount = db.prepare(
    'SELECT count(*) AS n FROM InvitationBearerProject_members',
  ).get().n;

  assert.deepEqual(
    { status: response.status, useCount: stored.useCount, membershipCount },
    { status: 403, useCount: 0, membershipCount: 0 },
  );
});

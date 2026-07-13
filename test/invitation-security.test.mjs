import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  Invitation,
  entity,
  map,
  membership,
  read,
  ref,
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
  const api = createInvitationApi({ Invitation: app.entity(Invitation) });
  return { app, db, Project: app.entity(Project), Invitation: app.entity(Invitation), api };
}

const owner = principal({ type: 'user', id: 'owner-1' });
const stranger = principal({ type: 'user', id: 'stranger-1' });
const member = principal({ type: 'user', id: 'member-1' });

test('invitation creation requires admin capability on the target row', async () => {
  const { db, api } = await fixture();
  await assert.rejects(
    api.createInvitation({
      targetEntity: 'InvitationSecurityProject', targetId: 'p1', role: 'member', principal: stranger,
    }),
    (error) => error.status === 403,
  );
  assert.equal(db.prepare('SELECT count(*) AS n FROM Invitation').get().n, 0);
  db.close();
});

test('target entity and role are resolved from declarations, never request SQL', async () => {
  const { db, api } = await fixture();
  await assert.rejects(
    api.createInvitation({ targetEntity: 'Invitation; DROP TABLE Invitation;--', targetId: 'p1', role: 'member', principal: owner }),
    (error) => error.status === 400,
  );
  await assert.rejects(
    api.createInvitation({ targetEntity: 'InvitationSecurityProject', targetId: 'p1', role: 'administrator', principal: owner }),
    (error) => error.status === 400,
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

  await assert.rejects(
    api.createInvitation({
      targetEntity: Project.name, targetId: 'p1', role: 'member', principal: owner,
    }),
    (error) => error.status === 400 && /User/.test(error.message),
  );
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

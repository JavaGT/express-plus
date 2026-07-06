// invitation.test.mjs — acceptance tests for the generic invitation flow.
//
// Proves: create (auto-token, link, direct), accept (link increments useCount +
// grants membership, direct removes row), reject (direct only), list, expiry,
// maxUses cap, wrong-user rejection, and full HTTP integration.

import { entity, ref, text, map, membership, grant, read, Invitation } from '../src/index.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import workbench, { executeDDL } from '../src/internal.mjs';
import { setActiveDb } from '../src/db.mjs';
import {
  createInvitation,
  acceptInvitation,
  rejectInvitation,
  listInvitationsForUser,
} from '../src/invitation.mjs';
import { principal } from '../src/principal.mjs';

const owner = principal({ type: 'user', id: 'owner-1' });
const member = principal({ type: 'user', id: 'member-1' });
const otherUser = principal({ type: 'user', id: 'other-1' });

// ---- Test helpers ----

// Set up a db with Invitation + Project tables for unit-level helper tests.
function setupDb() {
  const db = new DatabaseSync(':memory:');
  setActiveDb(db, { replace: true });
  executeDDL(Invitation, db);
  db.exec(`
    CREATE TABLE Project (id TEXT PRIMARY KEY, title TEXT, owner TEXT);
    CREATE TABLE Project_members (Project_id TEXT, member_id TEXT, role TEXT);
  `);
  return db;
}

// Set up a full workbench app with auth + Project entity for HTTP tests.
async function setupApp(t) {
  const db = new DatabaseSync(':memory:');

  const Project = entity('Project', {
    title: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    members: map(ref('User'), { role: ['member'], default: {} }),
  });

  membership(Project, { member: { can: [read] } });

  // Execute DDL before seeding
  executeDDL(Project, db);

  // Seed a project
  db.prepare('INSERT INTO Project (id, title, owner) VALUES (?, ?, ?)')
    .run('p1', 'Test Project', 'owner-1');

  const app = workbench({ db });
  app.mount('/projects', Project);
  app.auth();

  app.listen(0, {
    principalOf: (req) => {
      // Read user identity from a custom header for test control
      const id = req.headers?.['x-test-user'];
      if (!id) return principal({ type: 'anonymous', id: null });
      return principal({ type: 'user', id });
    },
  });
  await app.ready;

  t.after(() => {
    app.httpServer.close();
    db.close();
  });

  const { port } = app.httpServer.address();
  return { origin: `http://127.0.0.1:${port}`, db, app, Project };
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const body = await res.text();
  let json;
  try { json = JSON.parse(body); } catch { json = body; }
  return { status: res.status, body: json };
}

// ---- Unit tests (helpers without HTTP) ----

test('create invitation with auto-generated token', () => {
  const db = setupDb();
  try {
    const inv = createInvitation({
      targetEntity: 'Project',
      targetId: 'p1',
      role: 'member',
      maxUses: 10,
      createdBy: 'owner-1',
    });

    assert.ok(inv, 'invitation created');
    assert.equal(typeof inv.token, 'string', 'token is a string');
    assert.ok(inv.token.length >= 32, 'token is at least 32 chars (base64url of 32 bytes)');
    assert.equal(inv.targetEntity, 'Project');
    assert.equal(inv.targetId, 'p1');
    assert.equal(inv.role, 'member');
    assert.equal(inv.targetUser, null, 'targetUser is null for link invite');
    assert.equal(inv.maxUses, 10);
    assert.equal(inv.useCount, 0);
    assert.equal(inv.expiresAt, null);
    assert.equal(inv.createdBy, 'owner-1');
    assert.ok(inv.createdAt, 'createdAt is set');

    // Can find it by token
    const found = Invitation.findOne(Invitation.token.is(inv.token));
    assert.ok(found, 'can find invitation by token');
    assert.equal(found.id, inv.id);
  } finally {
    db.close();
  }
});

test('create link-type invitation (no targetUser)', () => {
  const db = setupDb();
  try {
    const inv = createInvitation({
      targetEntity: 'Project',
      targetId: 'p1',
      role: 'member',
      createdBy: 'owner-1',
    });

    assert.equal(inv.targetUser, null, 'targetUser is null for link invite');
    assert.equal(inv.maxUses, null, 'maxUses defaults to null (unlimited)');
  } finally {
    db.close();
  }
});

test('create direct invitation (with targetUser)', () => {
  const db = setupDb();
  try {
    const inv = createInvitation({
      targetEntity: 'Project',
      targetId: 'p1',
      role: 'member',
      targetUser: 'member-1',
      createdBy: 'owner-1',
    });

    assert.equal(inv.targetUser, 'member-1', 'targetUser is set');
    assert.equal(inv.maxUses, null);
  } finally {
    db.close();
  }
});

test('accept link invitation → increments useCount, grants membership', () => {
  const db = setupDb();
  try {
    const inv = createInvitation({
      targetEntity: 'Project',
      targetId: 'p1',
      role: 'member',
      maxUses: 10,
      createdBy: 'owner-1',
    });

    const result = acceptInvitation(inv.token, member);

    assert.deepEqual(result, {
      targetEntity: 'Project',
      targetId: 'p1',
      role: 'member',
    });

    // useCount incremented
    const updated = Invitation.findOne(Invitation.token.is(inv.token));
    assert.equal(updated.useCount, 1, 'useCount incremented');

    // Membership row inserted
    const memberRow = db.prepare('SELECT * FROM Project_members WHERE Project_id = ? AND member_id = ?')
      .get('p1', 'member-1');
    assert.ok(memberRow, 'membership row exists');
    assert.equal(memberRow.role, 'member');
  } finally {
    db.close();
  }
});

test('accept link invitation → same user twice is idempotent (INSERT OR IGNORE)', () => {
  const db = setupDb();
  try {
    const inv = createInvitation({
      targetEntity: 'Project',
      targetId: 'p1',
      role: 'member',
      maxUses: 10,
      createdBy: 'owner-1',
    });

    acceptInvitation(inv.token, member);

    // Second accept — still works (idempotent membership insert)
    const result = acceptInvitation(inv.token, member);
    assert.deepEqual(result, { targetEntity: 'Project', targetId: 'p1', role: 'member' });

    const updated = Invitation.findOne(Invitation.token.is(inv.token));
    assert.equal(updated.useCount, 2, 'useCount incremented again');
  } finally {
    db.close();
  }
});

test('accept direct invitation → removes invitation row', () => {
  const db = setupDb();
  try {
    const inv = createInvitation({
      targetEntity: 'Project',
      targetId: 'p1',
      role: 'member',
      targetUser: 'member-1',
      createdBy: 'owner-1',
    });

    const result = acceptInvitation(inv.token, member);

    assert.deepEqual(result, { targetEntity: 'Project', targetId: 'p1', role: 'member' });

    // Invitation row is removed
    const gone = Invitation.findOne(Invitation.token.is(inv.token));
    assert.equal(gone, null, 'direct invitation removed on accept');

    // Membership row inserted
    const memberRow = db.prepare('SELECT * FROM Project_members WHERE Project_id = ? AND member_id = ?')
      .get('p1', 'member-1');
    assert.ok(memberRow, 'membership row exists');
  } finally {
    db.close();
  }
});

test('link invitation reaches maxUses → accept fails with 400', () => {
  const db = setupDb();
  try {
    const inv = createInvitation({
      targetEntity: 'Project',
      targetId: 'p1',
      role: 'member',
      maxUses: 2,
      createdBy: 'owner-1',
    });

    acceptInvitation(inv.token, principal({ type: 'user', id: 'u1' }));
    acceptInvitation(inv.token, principal({ type: 'user', id: 'u2' }));

    // Third accept should fail
    assert.throws(
      () => acceptInvitation(inv.token, principal({ type: 'user', id: 'u3' })),
      (err) => err.message.includes('maximum uses') && err.status === 400,
    );
  } finally {
    db.close();
  }
});

test('expired invitation → accept fails with 400', () => {
  const db = setupDb();
  try {
    const inv = createInvitation({
      targetEntity: 'Project',
      targetId: 'p1',
      role: 'member',
      expiresAt: Date.now() - 1000, // 1 second in the past
      createdBy: 'owner-1',
    });

    assert.throws(
      () => acceptInvitation(inv.token, member),
      (err) => err.message.includes('expired') && err.status === 400,
    );
  } finally {
    db.close();
  }
});

test('reject direct invitation → removes row', () => {
  const db = setupDb();
  try {
    const inv = createInvitation({
      targetEntity: 'Project',
      targetId: 'p1',
      role: 'member',
      targetUser: 'member-1',
      createdBy: 'owner-1',
    });

    rejectInvitation(inv.token, member);

    const gone = Invitation.findOne(Invitation.token.is(inv.token));
    assert.equal(gone, null, 'invitation removed on reject');
  } finally {
    db.close();
  }
});

test('reject direct invitation → wrong user fails with 403', () => {
  const db = setupDb();
  try {
    const inv = createInvitation({
      targetEntity: 'Project',
      targetId: 'p1',
      role: 'member',
      targetUser: 'member-1',
      createdBy: 'owner-1',
    });

    assert.throws(
      () => rejectInvitation(inv.token, otherUser),
      (err) => err.message.includes('different user') && err.status === 403,
    );

    // Invitation still exists
    const still = Invitation.findOne(Invitation.token.is(inv.token));
    assert.ok(still, 'invitation still exists after failed reject');
  } finally {
    db.close();
  }
});

test('cannot reject open link invitation', () => {
  const db = setupDb();
  try {
    const inv = createInvitation({
      targetEntity: 'Project',
      targetId: 'p1',
      role: 'member',
      createdBy: 'owner-1',
    });

    assert.throws(
      () => rejectInvitation(inv.token, member),
      (err) => err.message.includes('cannot reject an open link invitation') && err.status === 400,
    );
  } finally {
    db.close();
  }
});

test('list invitations for user — direct invites', () => {
  const db = setupDb();
  try {
    const inv1 = createInvitation({
      targetEntity: 'Project', targetId: 'p1', role: 'member',
      targetUser: 'member-1', createdBy: 'owner-1',
    });
    const inv2 = createInvitation({
      targetEntity: 'Project', targetId: 'p2', role: 'member',
      targetUser: 'member-1', createdBy: 'owner-1',
    });
    // Another user's invite — should NOT appear for member-1
    createInvitation({
      targetEntity: 'Project', targetId: 'p3', role: 'member',
      targetUser: 'other-1', createdBy: 'owner-1',
    });

    const list = listInvitationsForUser(member);
    assert.equal(list.length, 2, 'only member-1 invites returned');
    const tokens = list.map((r) => r.token);
    assert.ok(tokens.includes(inv1.token));
    assert.ok(tokens.includes(inv2.token));
  } finally {
    db.close();
  }
});

test('list invitations for user — includes open link invites', () => {
  const db = setupDb();
  try {
    const linkInv = createInvitation({
      targetEntity: 'Project', targetId: 'p1', role: 'member',
      createdBy: 'owner-1',
    });
    const directInv = createInvitation({
      targetEntity: 'Project', targetId: 'p2', role: 'member',
      targetUser: 'member-1', createdBy: 'owner-1',
    });

    const list = listInvitationsForUser(member);
    // Should include both: direct invite for member-1 AND open link invite
    assert.ok(list.length >= 2, 'should include both direct and link invites');
    const tokens = list.map((r) => r.token);
    assert.ok(tokens.includes(linkInv.token), 'includes link invite');
    assert.ok(tokens.includes(directInv.token), 'includes direct invite');
  } finally {
    db.close();
  }
});

test('list invitations excludes expired ones', () => {
  const db = setupDb();
  try {
    createInvitation({
      targetEntity: 'Project', targetId: 'p1', role: 'member',
      targetUser: 'member-1', expiresAt: Date.now() - 1000, createdBy: 'owner-1',
    });
    const valid = createInvitation({
      targetEntity: 'Project', targetId: 'p2', role: 'member',
      targetUser: 'member-1', createdBy: 'owner-1',
    });

    const list = listInvitationsForUser(member);
    assert.equal(list.length, 1, 'only non-expired invite returned');
    assert.equal(list[0].token, valid.token);
  } finally {
    db.close();
  }
});

test('acceptInvitation with nonexistent token → 404', () => {
  const db = setupDb();
  try {
    assert.throws(
      () => acceptInvitation('nonexistent-token', member),
      (err) => err.message.includes('not found') && err.status === 404,
    );
  } finally {
    db.close();
  }
});

// ---- HTTP integration tests ----

test('HTTP: create invitation + accept + verify membership', async (t) => {
  const { origin, db } = await setupApp(t);

  // Create an invitation as owner-1
  const createRes = await fetchJson(`${origin}/auth/invitation/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-user': 'owner-1' },
    body: JSON.stringify({ targetEntity: 'Project', targetId: 'p1', role: 'member', maxUses: 5 }),
  });
  assert.equal(createRes.status, 201);
  const token = createRes.body.token;
  assert.ok(token, 'token returned');

  // Accept as member-1
  const acceptRes = await fetchJson(`${origin}/auth/invitation/${token}/accept`, {
    method: 'POST',
    headers: { 'x-test-user': 'member-1' },
  });
  assert.equal(acceptRes.status, 200);
  assert.deepEqual(acceptRes.body, {
    targetEntity: 'Project',
    targetId: 'p1',
    role: 'member',
  });

  // Verify membership row exists in DB
  const memberRow = db.prepare('SELECT * FROM Project_members WHERE Project_id = ? AND member_id = ?')
    .get('p1', 'member-1');
  assert.ok(memberRow, 'membership row created');
  assert.equal(memberRow.role, 'member');
});

test('HTTP: accept by wrong user for direct invite → 403', async (t) => {
  const { origin, db } = await setupApp(t);

  // Create a direct invitation for member-1
  const createRes = await fetchJson(`${origin}/auth/invitation/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-user': 'owner-1' },
    body: JSON.stringify({
      targetEntity: 'Project',
      targetId: 'p1',
      role: 'member',
      targetUser: 'member-1',
    }),
  });
  assert.equal(createRes.status, 201);
  const token = createRes.body.token;

  // Try to accept as other-1 (wrong user)
  const acceptRes = await fetchJson(`${origin}/auth/invitation/${token}/accept`, {
    method: 'POST',
    headers: { 'x-test-user': 'other-1' },
  });
  assert.equal(acceptRes.status, 403);
});

test('HTTP: reject direct invitation → 204', async (t) => {
  const { origin } = await setupApp(t);

  const createRes = await fetchJson(`${origin}/auth/invitation/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-user': 'owner-1' },
    body: JSON.stringify({
      targetEntity: 'Project',
      targetId: 'p1',
      role: 'member',
      targetUser: 'member-1',
    }),
  });
  assert.equal(createRes.status, 201);
  const token = createRes.body.token;

  const rejectRes = await fetchJson(`${origin}/auth/invitation/${token}/reject`, {
    method: 'POST',
    headers: { 'x-test-user': 'member-1' },
  });
  assert.equal(rejectRes.status, 204);
});

test('HTTP: list invitations for user', async (t) => {
  const { origin } = await setupApp(t);

  // Create some invitations for member-1
  await fetchJson(`${origin}/auth/invitation/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-user': 'owner-1' },
    body: JSON.stringify({
      targetEntity: 'Project', targetId: 'p1', role: 'member',
      targetUser: 'member-1',
    }),
  });
  await fetchJson(`${origin}/auth/invitation/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-user': 'owner-1' },
    body: JSON.stringify({
      targetEntity: 'Project', targetId: 'p2', role: 'member',
      targetUser: 'member-1',
    }),
  });

  const listRes = await fetchJson(`${origin}/auth/invitation`, {
    headers: { 'x-test-user': 'member-1' },
  });
  assert.equal(listRes.status, 200);
  assert.ok(Array.isArray(listRes.body), 'returns an array');
  assert.ok(listRes.body.length >= 2, 'at least 2 invitations');
  for (const inv of listRes.body) {
    assert.equal(inv.targetUser, 'member-1', 'each invite is for member-1');
  }
});

test('HTTP: create invitation without required fields → 400', async (t) => {
  const { origin } = await setupApp(t);

  const res = await fetchJson(`${origin}/auth/invitation/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-user': 'owner-1' },
    body: JSON.stringify({ targetEntity: 'Project' }),
  });
  assert.equal(res.status, 400);
});

test('HTTP: unauthenticated requests are denied (requireUser gate)', async (t) => {
  const { origin } = await setupApp(t);

  // No x-test-user header → anonymous
  const res = await fetchJson(`${origin}/auth/invitation`, {
    headers: { 'content-type': 'application/json' },
  });
  assert.ok(res.status === 401 || res.status === 403, `unauthenticated should be denied, got ${res.status}`);
});

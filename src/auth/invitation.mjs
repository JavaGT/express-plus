// invitation.mjs — the framework's generic invitation flow helpers.
//
// Four operations, each one path to the same outcome — no second access
// surface behind the entity query API:
//
//   createInvitation(params)     → creates an Invitation row (with auto-generated token)
//   acceptInvitation(token, user) → validates, increments useCount, grants membership
//   rejectInvitation(token, user) → removes a direct invitation row
//   listInvitationsForUser(user) → pending invites for a user
//
// The accept flow inserts into the target entity's membership map side-table
// (`{Entity}_members` with columns `{Entity}_id`, `member_id`, `role`) using
// the unscoped query API — the same trust class as auth-entity writes.

import { Invitation } from './entities.mjs';
import { getActiveDb } from '../db.mjs';

// createInvitation({ targetEntity, targetId, role, targetUser, maxUses, expiresAt, createdBy })
// → creates an Invitation row with an auto-generated token (32 random bytes, base64url).
// Returns the hydrated invitation row so the caller can read its token.
export function createInvitation({ targetEntity, targetId, role, targetUser, maxUses, expiresAt, createdBy }) {
  if (!targetEntity || !targetId || !role || !createdBy) {
    throw new Error('createInvitation requires targetEntity, targetId, role, and createdBy');
  }
  return Invitation.create({
    targetEntity,
    targetId,
    role,
    targetUser: targetUser ?? null,
    maxUses: maxUses ?? null,
    expiresAt: expiresAt ?? null,
    createdBy,
  });
}

// acceptInvitation(token, user) → validates the token, increments useCount,
// and grants membership on the target entity by inserting into the membership
// map side-table. Returns { targetEntity, targetId, role }.
//
// Validation:
//   - Token must exist
//   - Must not be expired (expiresAt set and in the past)
//   - For link invites (targetUser is null): useCount must be < maxUses (if maxUses is set)
//   - For direct invites (targetUser is set): the accepting user must match targetUser
export function acceptInvitation(token, user) {
  if (!token || !user || !user.id) {
    throw Object.assign(new Error('acceptInvitation requires a token and a user with an id'), { status: 400 });
  }

  const invitation = Invitation.findOne(Invitation.token.is(token));
  if (!invitation) {
    throw Object.assign(new Error('invitation not found'), { status: 404 });
  }

  const now = Date.now();

  // Check expiration
  if (invitation.expiresAt !== null && now > invitation.expiresAt) {
    throw Object.assign(new Error('invitation has expired'), { status: 400 });
  }

  const db = getActiveDb();

  if (invitation.targetUser === null) {
    // Link invitation — anyone with the token can accept
    if (invitation.maxUses !== null && invitation.useCount >= invitation.maxUses) {
      throw Object.assign(new Error('invitation has reached its maximum uses'), { status: 400 });
    }

    // Increment useCount via raw SQL (entity update not available for auth entities)
    db.prepare('UPDATE Invitation SET useCount = useCount + 1 WHERE id = :id')
      .run({ id: invitation.id });
  } else {
    // Direct invitation — must match the target user
    if (String(invitation.targetUser) !== String(user.id)) {
      throw Object.assign(new Error('this invitation is for a different user'), { status: 403 });
    }

    // Remove the direct invitation on accept
    Invitation.delete(invitation.id);
  }

  // Grant membership: insert into the target entity's members side-table.
  // Convention: {Entity}_members with columns {Entity}_id, member_id, role.
  const table = `${invitation.targetEntity}_members`;
  const ownerCol = `${invitation.targetEntity}_id`;

  try {
    db.prepare(`INSERT OR IGNORE INTO ${table} (${ownerCol}, member_id, role) VALUES (:__owner, :__member, :__role)`)
      .run({ __owner: invitation.targetId, __member: user.id, __role: invitation.role });
  } catch (err) {
    // If the side-table doesn't exist (e.g. target entity has no members field),
    // surface a clear error rather than a raw SQLite failure.
    throw Object.assign(
      new Error(`failed to grant membership on ${invitation.targetEntity}: ${err.message}`),
      { status: 500 },
    );
  }

  return {
    targetEntity: invitation.targetEntity,
    targetId: invitation.targetId,
    role: invitation.role,
  };
}

// rejectInvitation(token, user) → for direct invitations, removes the row.
// Open link invitations cannot be rejected (they expire naturally or reach
// maxUses). The rejecting user must match the targetUser on the invitation.
export function rejectInvitation(token, user) {
  if (!token || !user || !user.id) {
    throw Object.assign(new Error('rejectInvitation requires a token and a user with an id'), { status: 400 });
  }

  const invitation = Invitation.findOne(Invitation.token.is(token));
  if (!invitation) {
    throw Object.assign(new Error('invitation not found'), { status: 404 });
  }

  if (invitation.targetUser === null) {
    throw Object.assign(new Error('cannot reject an open link invitation'), { status: 400 });
  }

  if (String(invitation.targetUser) !== String(user.id)) {
    throw Object.assign(new Error('this invitation is for a different user'), { status: 403 });
  }

  Invitation.delete(invitation.id);
}

// listInvitationsForUser(user) → pending invitations for this user.
// Returns both direct invitations (where targetUser === user.id) and open
// link invitations (where targetUser is null), excluding expired ones.
// Results are sorted newest-first by createdAt.
export function listInvitationsForUser(user) {
  if (!user || !user.id) {
    return [];
  }

  const db = getActiveDb();
  const now = Date.now();

  // Use raw SQL for the OR condition (entity query API doesn't support OR)
  const rows = db.prepare(`
    SELECT * FROM Invitation AS t0
    WHERE (t0.targetUser = :userId OR t0.targetUser IS NULL)
      AND (t0.expiresAt IS NULL OR t0.expiresAt > :now)
    ORDER BY t0.createdAt DESC
  `).all({ userId: user.id, now });

  return rows.map((row) => Invitation.hydrate(row));
}

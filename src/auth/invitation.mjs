// Generic invitations are application-scoped. The bound Invitation facade is
// the authority for both the database and the entity registry, which prevents
// a caller from pairing an entity from one application with another database.

import { txn } from '../driver.mjs';
import { admin } from '../grant.mjs';
import { readScopedRow } from '../http-crud-dispatch.mjs';
import { rowCapabilities } from '../row-grant.mjs';
import { MEMBER_COLUMN, membershipOwnerCol, membershipTable } from '../scope-sql.mjs';

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

export function createInvitationApi({ Invitation, db: suppliedDb } = {}) {
  const runtime = Invitation?.runtime;
  if (!Invitation || !runtime?.db || typeof runtime.entityOf !== 'function') {
    throw new Error('createInvitationApi requires an application-bound Invitation entity');
  }
  if (suppliedDb && suppliedDb !== runtime.db) {
    throw new Error('Invitation and db must belong to the same application runtime');
  }
  const db = runtime.db;

  function targetFor(name, role) {
    let target;
    try {
      target = runtime.entityOf(name);
    } catch {
      throw httpError(400, `unknown invitation target entity '${name}'`);
    }

    const roleCandidates = Object.entries(target.fields).filter(([, descriptor]) =>
      descriptor?.kind === 'store'
      && descriptor.type === 'map'
      && descriptor.of?.type === 'ref'
      && Array.isArray(descriptor.roles)
      && descriptor.roles.includes(role));
    const candidates = roleCandidates.filter(([, descriptor]) => {
      try {
        return runtime.entityOf(descriptor.of.target).name === 'User';
      } catch {
        return false;
      }
    });
    if (candidates.length !== 1) {
      throw httpError(
        400,
        candidates.length === 0 && roleCandidates.length > 0
          ? `invitation role '${role}' on ${target.name} must be a map of User references`
          : candidates.length === 0
          ? `role '${role}' is not an invitation role on ${target.name}`
          : `role '${role}' is ambiguous on ${target.name}`,
      );
    }
    const [fieldName] = candidates[0];
    return {
      entity: target,
      fieldName,
      table: membershipTable(target.name, fieldName),
      ownerColumn: membershipOwnerCol(target.name),
    };
  }

  async function createInvitation({
    targetEntity, targetId, role, targetUser, maxUses, expiresAt, principal,
  }) {
    if (!targetEntity || !targetId || !role || !principal?.id) {
      throw httpError(400, 'createInvitation requires targetEntity, targetId, role, and principal');
    }
    if (principal.type !== 'user') {
      throw httpError(403, 'a user principal is required to create an invitation');
    }
    if (maxUses != null && (!Number.isInteger(maxUses) || maxUses < 1)) {
      throw httpError(400, 'maxUses must be a positive integer');
    }

    const target = targetFor(targetEntity, role);
    const row = readScopedRow({ db }, target.entity, targetId, principal);
    if (!row) throw httpError(404, `${target.entity.name} ${targetId} not found`);
    const decision = await rowCapabilities(target.entity, row, principal);
    if (!decision.granted || !decision.capabilities.includes(admin)) {
      throw httpError(403, 'admin capability is required to create an invitation');
    }

    return Invitation.create({
      targetEntity: target.entity.name,
      targetId,
      role,
      targetUser: targetUser ?? null,
      maxUses: maxUses ?? null,
      expiresAt: expiresAt ?? null,
      createdBy: principal.id,
    });
  }

  async function acceptInvitation(token, user) {
    if (!token || !user?.id) {
      throw httpError(400, 'acceptInvitation requires a token and a user with an id');
    }
    if (user.type !== 'user') {
      throw httpError(403, 'a user principal is required to accept an invitation');
    }

    return txn(db, () => {
      const invitation = Invitation.findOne(Invitation.token.is(token));
      if (!invitation) throw httpError(404, 'invitation not found');
      if (invitation.expiresAt !== null && Date.now() > invitation.expiresAt) {
        throw httpError(400, 'invitation has expired');
      }
      if (invitation.targetUser !== null && String(invitation.targetUser) !== String(user.id)) {
        throw httpError(403, 'this invitation is for a different user');
      }

      // Resolve the stored name through the application registry before it can
      // influence an identifier. Only load-time validated declarations supply
      // the table and column names used below.
      const target = targetFor(invitation.targetEntity, invitation.role);
      if (!target.entity.findById(invitation.targetId)) {
        throw httpError(404, `${target.entity.name} ${invitation.targetId} not found`);
      }

      let membershipChanged = false;
      try {
        const existing = db.prepare(
          `SELECT role FROM ${target.table} WHERE ${target.ownerColumn} = :owner AND ${MEMBER_COLUMN} = :member`,
        ).get({ owner: invitation.targetId, member: user.id });
        membershipChanged = !existing || existing.role !== invitation.role;

        if (
          membershipChanged
          && invitation.targetUser === null
          && invitation.maxUses !== null
          && invitation.useCount >= invitation.maxUses
        ) {
          throw httpError(400, 'invitation has reached its maximum uses');
        }

        // An exact-role replay is idempotent and does not exhaust a public link.
        // Applying a different role is a new grant, so it consumes a use and
        // cannot pass an exhausted invitation.
        if (existing) {
          if (membershipChanged) {
            db.prepare(
              `UPDATE ${target.table} SET role = :role WHERE ${target.ownerColumn} = :owner AND ${MEMBER_COLUMN} = :member`,
            ).run({ owner: invitation.targetId, member: user.id, role: invitation.role });
          }
        } else {
          db.prepare(
            `INSERT INTO ${target.table} (${target.ownerColumn}, ${MEMBER_COLUMN}, role) VALUES (:owner, :member, :role)`,
          ).run({ owner: invitation.targetId, member: user.id, role: invitation.role });
        }
      } catch (error) {
        if (error.status) throw error;
        throw httpError(500, `failed to grant membership on ${target.entity.name}: ${error.message}`);
      }

      if (invitation.targetUser === null) {
        if (membershipChanged) {
          db.prepare('UPDATE Invitation SET useCount = useCount + 1 WHERE id = :id')
            .run({ id: invitation.id });
        }
      } else {
        Invitation.delete(invitation.id);
      }

      return {
        targetEntity: target.entity.name,
        targetId: invitation.targetId,
        role: invitation.role,
      };
    });
  }

  function rejectInvitation(token, user) {
    if (!token || !user?.id) {
      throw httpError(400, 'rejectInvitation requires a token and a user with an id');
    }
    if (user.type !== 'user') {
      throw httpError(403, 'a user principal is required to reject an invitation');
    }
    const invitation = Invitation.findOne(Invitation.token.is(token));
    if (!invitation) throw httpError(404, 'invitation not found');
    if (invitation.targetUser === null) {
      throw httpError(400, 'cannot reject an open link invitation');
    }
    if (String(invitation.targetUser) !== String(user.id)) {
      throw httpError(403, 'this invitation is for a different user');
    }
    Invitation.delete(invitation.id);
  }

  function listInvitationsForUser(user) {
    if (!user?.id) {
      throw httpError(400, 'listInvitationsForUser requires a user with an id');
    }
    if (user.type !== 'user') {
      throw httpError(403, 'a user principal is required to list invitations');
    }
    const rows = db.prepare(`
      SELECT * FROM Invitation AS t0
      WHERE t0.targetUser = :userId
        AND (t0.expiresAt IS NULL OR t0.expiresAt > :now)
      ORDER BY t0.createdAt DESC
    `).all({ userId: user.id, now: Date.now() });
    return rows.map((row) => Invitation.hydrate(row));
  }

  return { createInvitation, acceptInvitation, rejectInvitation, listInvitationsForUser };
}

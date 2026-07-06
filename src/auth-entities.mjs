// The framework-provided auth entities: User, Session, Credential, and Inbox.
//
// session.mjs (the binding exemplar) imports these FROM the framework rather than
// declaring them, because authentication is the framework's concern, not the
// app's: the app should not have to hand-roll a user table, a password digest, or
// the session→principal mapping the request pipeline already depends on.
//
//   - User  — username + a one-way hash() password. Served by the generic query
//             API: User.findOne(User.username.is(name)), User.create({...}),
//             user.password.verify(pw), User.findAll().select(...), getOrFail(id).
//   - Session — the minted capability record the request pipeline reads to build
//             a principal. sessionPrincipalOf runs
//             `SELECT principalType, principalId FROM Session WHERE token = ?`,
//             so Session's STORED row is (token, principalType, principalId).
//
// Both carry a fail-closed grant: they are never mounted as request-facing
// entity-CRUD (the exemplar mounts /users and /sessions as imperative routers),
// so their read-scope grants nothing — `never()`/`deny`. The auth layer reaches
// them only through the UNSCOPED, trusted query API, never a request path.

import { randomBytes, createHash } from 'node:crypto';
import { entity } from './entity/compile.mjs';
import { text, hash, ref, date, number } from './field.mjs';
import { scope } from './scope.mjs';
import { never } from './scope-sql.mjs';
import { grant, deny, read, subscribe } from './grant.mjs';
import { schedule } from './schedule.mjs';
import { config } from './config.mjs';
import { generateSecret, generateBackupCodes } from './totp.mjs';

function sha256hex(s) {
  return createHash('sha256').update(s).digest('hex');
}

// A framework auth entity is never request-readable: its rows are reached only
// by trusted server code (login lookup, principal hydration), never dispatched
// to a request principal. The most fail-closed valid grant: a never() scope (no
// row is request-visible) whose .can denies every capability.
const notRequestReadable = (which) =>
  scope(() => never()).can(() =>
    deny(`${which} is a framework auth entity, reached only by trusted server ` +
      `code (the unscoped query API), never request-dispatched`));

export const User = entity('User', {
    username: text(),
  password: hash(),

  grant: () => [notRequestReadable('User')],
});

const SessionCreatedAt = date();

// The two session intents are a CLOSED set, each a named whole mapped to the one
// canonical stored row { token, principalType, principalId, createdAt }:
//   - { userId }            -> a user session   (principalType 'user', principalId = userId)
//   - { kind: 'link', token } -> a link session (principalType 'link', principalId = the share token)
// The minted `token` is a fresh, unguessable SESSION token (distinct from a
// link's share token). Anything else is rejected — fail closed. This create
// policy mints server-side cells it owns, so it does not run validateMutation;
// it composes the entity's trusted `insert` core (one write path).
function mintSession(payload, { insert, mintToken }) {
  const token = mintToken();
  const now = Date.now();
  if (payload && typeof payload.userId !== 'undefined') {
    return insert({ token, principalType: 'user', principalId: String(payload.userId), createdAt: now });
  }
  if (payload && payload.kind === 'link' && typeof payload.token !== 'undefined') {
    // The link principal carries WHICH share granted it: the incoming share
    // token (the grant identity), not the doc id. A fresh session token is minted
    // for the cookie; the share token becomes the principal id.
    return insert({ token, principalType: 'link', principalId: String(payload.token), createdAt: now });
  }
  throw new Error(
    `Session.create accepts a closed set of session intents: { userId } for a ` +
      `user session or { kind: 'link', token } for a link session. Received ` +
      `${JSON.stringify(payload)} (fail closed).`,
  );
}

export const Session = entity('Session', {
  // The stored cells are framework-owned and readonly: an app never writes them
  // by hand; the create policy mints them. Declaring them keeps the table schema
  // typed and inspectable (Session.token.is(...) is a first-class handle).
    token: text({ readonly: true }),
  principalType: text({ readonly: true }),
  principalId: text({ readonly: true }),
  createdAt: SessionCreatedAt,

  grant: () => [notRequestReadable('Session')],
  create: mintSession,
  schedule: {
    remove: schedule.after(SessionCreatedAt, config.sessionDurationMs),
  },
});

// Inbox — the framework's per-user notification store. An app projects rows into
// it via a declared effect (doc.mjs: when a collaborator is added to a Doc, a row
// is created with { recipient: delta.member, doc: entity.id, kind: 'invite' }),
// and a user reads their OWN inbox. Like User/Session it is the framework's
// concern (every collaborative app needs the same per-user notification shape),
// imported FROM workbench, never app-declared.
//
//   - recipient — a User ref carrying the `recipient` role, so the entity
//                 compiler derives is.recipient() and the grant's scope compiles
//                 to `t0.recipient = :principalId`: a user reads ONLY their own
//                 inbox rows (recipient-scoped, fail-closed default-on).
//   - doc       — the Doc the notification is about (a typed FK).
//   - kind      — the notification kind ('invite', ...): a plain text facet.
//
// The grant's SCOPE filters rows to the recipient (compiled to SQL, never run as
// JS, so its is.recipient() is correctly un-awaited); the .can body then confers
// read + subscribe on those already-recipient-scoped rows (a one-shot REST fetch
// and a sustained WS push of new notifications). It needs no is.* call — the row
// is already the principal's own — so it is trivially guard-clean.
export const Inbox = entity('Inbox', {
    recipient: ref('User', { role: 'recipient' }),
  doc: ref('Doc'),
  kind: text(),

  grant: () => [scope(({ is }) => is.recipient()).can(() => grant(read, subscribe))],
  // Inbox EXISTS to receive projected notifications from other entities' effects
  // (e.g. Doc's collaboratorAdded → Inbox invite row). It admits effect
  // principals — the effect is already bounded to its declared `with` template,
  // and the recipient read-scope above still gates WHO may read a row. Admitting
  // the effect principal here is the target's opt-in to the effect (ADR #6).
  admitsEffects: () => true,
});

// Credential — a WebAuthn passkey stored by the framework. Each Credential row
// binds one authenticator's public key to a User. The authenticator holds the
// private key; the server stores the public key (DER/SubjectPublicKeyInfo,
// base64url-encoded) and verifies assertions.
//
// Like User/Session, Credential is not request-readable: it is reached only by
// the trusted auth routes (passkey register/authenticate), never exposed through
// the request-facing CRUD API. The public key is stored as a base64url string
// — it is never transmitted to any request principal through the entity API.
//
// Fields:
//   - credentialId — the authenticator's credential ID, base64url-encoded (unique).
//   - publicKey    — the public key (DER/SPKI, base64url), used to verify assertions.
//   - userId       — the User this credential authenticates (a typed FK, not
//                    request-visible).
//   - signCount    — the last-seen counter from the authenticator (replay protection).
//   - name         — a human-readable device label (from the RP).
//   - transports   — comma-separated transport hints (e.g. "internal,hybrid").
//   - backedUp     — 1 if the credential is synced (multi-device), 0 if single-device.
//   - createdAt    — timestamp of enrollment.
// Invitation — the framework's generic invitation flow. An invitation grants
// membership on a target entity to the accepting user. Two modes:
//
//   - Link invitation (targetUser is null): anyone with the token can accept.
//     Tracked by maxUses (optional cap) and useCount.
//   - Direct invitation (targetUser is set to a User ref): a specific user is
//     invited. On accept, the invitation row is removed — one-time use.
//
// Like User/Session/Credential, Invitation is not request-readable: it is
// reached only by the trusted auth routes (create/accept/reject/list), never
// exposed through the entity CRUD API. The token is auto-generated by the
// create policy (32 random bytes, base64url) if none is provided.
//
// Fields:
//   - token        — the share token (auto-generated, unique)
//   - targetEntity — which entity this grants access to (e.g. 'Project')
//   - targetId     — which row on that entity (e.g. 'p1')
//   - role         — the membership role to grant (e.g. 'member')
//   - targetUser   — the invited user (null = open link)
//   - maxUses      — max accept count for link invites (null = unlimited)
//   - useCount     — current accept count
//   - expiresAt    — epoch ms expiration (null = never)
//   - createdBy    — the User who created this invitation
//   - createdAt    — timestamp

function mintInvitation(payload, { insert }) {
  const token = payload.token || randomBytes(32).toString('base64url');
  const now = new Date();
  return insert({
    token,
    targetEntity: payload.targetEntity,
    targetId: payload.targetId,
    role: payload.role,
    targetUser: payload.targetUser ?? null,
    maxUses: payload.maxUses ?? null,
    useCount: 0,
    expiresAt: payload.expiresAt ?? null,
    createdBy: payload.createdBy,
    createdAt: now,
  });
}

export const Invitation = entity('Invitation', {
          token: text(),
    targetEntity: text(),
        targetId: text(),
            role: text(),
      targetUser: ref('User'),
         maxUses: number(),
        useCount: number(),
       expiresAt: number(),
       createdBy: ref('User'),
       createdAt: date(),

  grant: () => [notRequestReadable('Invitation')],
  create: mintInvitation,
});

export const Credential = entity('Credential', {
      credentialId: text(),
          publicKey: text(),
            userId: ref('User'),
         signCount: number(),
              name: text(),
        transports: text(),
          backedUp: number(),
         createdAt: date(),

  grant: () => [notRequestReadable('Credential')],
});

// ApiKey — a project-scoped bearer-token principal. An ApiKey mints a random
// 32-byte token (base64url), stores only its SHA-256 hash, and exposes the plain
// token ONCE at creation time. The prefix (first 8 chars of the plain token) is
// stored for display. The key resolves to an apiKey principal through the SAME
// authorization engine as user principals — no second auth path.
//
// Like User/Session/Credential/Invitation, ApiKey is not request-readable: it is
// reached only by trusted server code (the Bearer resolution in session.mjs and
// the creation/revocation routes in auth-routes.mjs).
//
// Fields:
//   - tokenHash  — SHA-256 hex digest of the plain token (never stored in plaintext)
//   - prefix     — first 8 base64url chars of the plain token (for display)
//   - name       — a human-readable label for the key
//   - entityName — optional scope: which entity this key is scoped to
//   - role       — optional capabilities role the key confers
//   - createdBy  — the User who created this key
//   - expiresAt  — optional epoch ms expiration
//   - createdAt  — timestamp of creation
function mintApiKey(payload, { insert }) {
  const plainToken = randomBytes(32).toString('base64url');
  const tokenHash = sha256hex(plainToken);
  const prefix = plainToken.slice(0, 8);
  const now = new Date();
  const row = insert({
    tokenHash,
    prefix,
    name: payload.name,
    entityName: payload.entityName ?? null,
    role: payload.role ?? null,
    createdBy: payload.createdBy,
    expiresAt: payload.expiresAt ?? null,
    createdAt: now,
  });
  // The plain token is returned ONCE alongside the row and never stored.
  return { ...row, plainToken };
}

export const ApiKey = entity('ApiKey', {
      tokenHash: text(),
         prefix: text(),
           name: text(),
     entityName: text(),
           role: text(),
      createdBy: ref('User'),
      expiresAt: number(),
      createdAt: date(),

  grant: () => [notRequestReadable('ApiKey')],
  create: mintApiKey,
});

// TwoFactor — TOTP two-factor authentication. One enrollment per user (userId is
// unique). The secret is base32-encoded (RFC 4648, no padding), stored readonly
// so it is never exposed through request paths. Backup codes are stored as a JSON
// array of SHA-256 hashes — the plain codes are returned ONCE at enrollment time
// and never stored.
//
// enabled: 0 = enrolled but not verified yet (first successful verify sets it to 1)
// verifiedAt: set on the first successful TOTP verification after enrollment
//
// Like User/Session/Credential/Invitation/ApiKey, TwoFactor is not
// request-readable: it is reached only by trusted server code (the auth routes),
// never exposed through the entity CRUD API.
function enrollTotp(payload, { insert }) {
  const { secret, uri } = generateSecret(payload.username);
  const { plainCodes, hashedCodes } = generateBackupCodes(8);
  const now = new Date();
  const row = insert({
    userId: payload.userId,
    secret,
    backupCodes: JSON.stringify(hashedCodes),
    enabled: 0,
    verifiedAt: null,
  });
  return { ...row, secret, uri, backupCodes: plainCodes };
}

export const TwoFactor = entity('TwoFactor', {
       userId: ref('User'),
        secret: text({ readonly: true }),
   backupCodes: text({ readonly: true }),
       enabled: number(),
    verifiedAt: date(),

  grant: () => [notRequestReadable('TwoFactor')],
  create: enrollTotp,
});

// Auth coat — product authentication surface on Principal + routes.
// Compile-loop authz stays in src/authz.mjs / scope-sql / row-grant (not here).

export {
  User, Session, Inbox, Credential, Invitation, ApiKey, TwoFactor,
} from './entities.mjs';
export { authRoutes } from './routes.mjs';
export {
  parseCookies, sessionCookie, sessionPrincipalOf, sessionTokenOf,
  apiKeyPrincipalOf, SESSION_COOKIE,
} from './session.mjs';
export {
  createInvitation, acceptInvitation, rejectInvitation, listInvitationsForUser,
} from './invitation.mjs';
export { membership, compileMembershipAuthz } from './membership.mjs';
export {
  generateSecret, generateBackupCodes, verifyTotp, verifyBackupCode,
} from './totp.mjs';

// Auth coat — product authentication surface on Principal + routes.
// Compile-loop authz stays in src/authz.mjs / scope-sql / row-grant (not here).

export {
  User, Session, Inbox, Credential, Invitation, ApiKey, TwoFactor,
} from './entities.ts';
export { authRoutes } from './routes.ts';
export {
  parseCookies, sessionCookie, sessionPrincipalOf, sessionTokenOf,
  apiKeyPrincipalOf, SESSION_COOKIE,
} from './session.ts';
export {
  createInvitationApi,
} from './invitation.ts';
export { membership, compileMembershipAuthz } from './membership.ts';
export {
  generateSecret, generateBackupCodes, verifyTotp, verifyBackupCode,
} from './totp.ts';

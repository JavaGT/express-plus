# W1 Auth Parity Census

**Date:** 2026-07-06 | **Agent:** explore-flash | **Source:** Scope `~/Development/scope`

## Explicit questions answered

**1. Does Scope use OAuth/social login at all?**  
**No.** Scope configures only `emailAndPassword` in better-auth. There is no `socialProviders` block, no OAuth imports, and no `google`/`github` provider strings anywhere in the codebase. The `Account` table exists in Prisma (better-auth creates it unconditionally for OAuth account linking) but is never populated.

**2. Is email verification used? Password reset flows?**  
**Email verification: No.** The `Verification` table exists in Prisma (better-auth artifact) but no verification flow is configured. `emailVerified` on User is never checked.  
**Password reset: Link exists, no implementation.** The `Login.svelte` has a "Forgot password?" link to `/forgot-password` (`src/routes-pages/Login.svelte:48`), but no such page or route handler exists — it's a dead link. The password-change UI (`PasswordChangeModal.svelte`) uses `authClient.changePassword()` which requires the current password (not a reset token).

**3. What do `Invite` vs `ProjectInvitation` each do?**  
- **`Invite`** — token-based sharing link. A project owner generates a link with a random token; anyone with the link can accept (up to `maxUses`). No target user. Used via `/api/invites/:token`. Table: `Invite` (token, role, maxUses, useCount, expiresAt, projectId).  
- **`ProjectInvitation`** — direct user-to-user invitation. A manager invites a specific user by `userId`. The invitee sees it in their Account page and accepts/declines. Used via `/api/invitations/:id`. Table: `ProjectInvitation` (role, projectId, userId), unique on `(userId, projectId)`.  
Both resolve to creating a `ProjectMember` row on accept.

**4. Are passkeys actually used or just configured?**  
**Configured + client plugin loaded, but no management UI mounted.** The server has `passkey()` plugin (`src/lib/server/auth.ts:54-58`). The client has `passkeyClient()` (`src/lib/client/auth-client.ts:1,6`). A `PasskeyManager.svelte` component exists (`src/lib/components/PasskeyManager.svelte`) with add/remove/list UI, but it is **imported nowhere** — not included in Account.svelte or any other page. Login/Register inputs carry `autocomplete="webauthn"` which enables browser passkey autofill, but users cannot enroll or manage passkeys through Scope's UI.

**5. What two-factor mechanisms exist and are they enforced?**  
**TOTP only. Not enforced (opt-in).**  
- Server: `twoFactor()` plugin (`src/lib/server/auth.ts:53`).  
- Client: `twoFactorClient()` plugin (`src/lib/client/auth-client.ts:2,6`).  
- UI: `TotpSection.svelte` embedded in `Account.svelte:185` — enable/disable/verify with authenticator app.  
- Data: `User.twoFactorEnabled` boolean, `TwoFactor` table (secret, backupCodes).  
- Policy: purely voluntary — no route or middleware enforces 2FA.

## Detailed census table

| # | Feature | Scope evidence (file:line) | Workbench equivalent today | Gap class |
|---|---------|---------------------------|---------------------------|-----------|
| 1 | **Email/password sign-in** | `src/lib/server/auth.ts:48-51` (`emailAndPassword.enabled: true`); `src/routes-pages/Login.svelte:15` (`authClient.signIn.email`) | `src/auth-routes.mjs:41-56` (`POST /auth/login`) | exists |
| 2 | **Email/password registration** | `src/lib/server/auth.ts:48-51`; `src/routes-pages/Register.svelte:16` (`authClient.signUp.email`) | `src/auth-routes.mjs:46-49` (first-login auto-creates user) | exists |
| 3 | **Session management (DB-backed)** | `src/lib/server/auth.ts:24-38` (30d expiry, daily update, `cookieCache:false` always-DB); `prisma/schema.prisma:45-57` (`Session` table) | `src/auth-entities.mjs:74-88` (`Session` entity with token, principalType, principalId, createdAt; scheduled removal) | exists |
| 4 | **Session cookie (`better-auth.session_token`)** | `src/lib/server/auth.ts:39-41` (secure cookies on HTTPS); `src/server/handlers/auth.ts:8` (better-auth handler owns cookie) | `src/session.mjs:48-55` (`sessionCookie()` — HttpOnly, SameSite=Lax, Secure, Path=/) | exists |
| 5 | **Session → principal hydration** | `src/lib/server/auth-helpers.ts:26-37` (`requireSession()` calls `auth.api.getSession`) | `src/session.mjs:72-96` (`sessionPrincipalOf()` — SQL lookup by token, builds user/link principal) | exists |
| 6 | **Principal model (closed union)** | `src/lib/wb-scope/types.ts:8-12` (`ScopePrincipal` — id, roles, claims); `src/server/http.ts:151-176` (session→principal in `authProject`) | `src/principal.mjs:33-48` (`principal()` — closed union: user, link, system, anonymous) | exists |
| 7 | **Password hashing** | better-auth built-in (bcrypt, on `Account.password`) | `src/auth-entities.mjs:40` (`password: hash()` — one-way digest on write) | exists |
| 8 | **Rate limiting (auth endpoints)** | `src/lib/server/auth.ts:42-47` (better-auth built-in: 100 req/10s window per IP); `src/lib/server/rate-limit.ts:1-23` (separate per-key limiter for project API calls) | `src/rate-limit.mjs:4-54` (`createRateLimiter` — per-IP + optional per-session windows) | exists |
| 9 | **CSRF protection** | `src/AGENTS/server.md:81` (Origin check on mutating requests) | Not in workbench today (reliant on same-origin from SPA + HttpOnly cookies) | thin-wrap |
| 10 | **CSP nonce** | `src/AGENTS/server.md:82` (per-request `crypto.randomUUID()`, no `unsafe-inline`) | Not in workbench today | thin-wrap |
| 11 | **TOTP 2FA (opt-in)** | `src/lib/server/auth.ts:53` (`twoFactor()`); `src/lib/client/auth-client.ts:2,6` (`twoFactorClient()`); `src/lib/components/TotpSection.svelte:1-121`; `src/routes-pages/Account.svelte:185`; `prisma/schema.prisma:105-113` (`TwoFactor` table) | None | build |
| 12 | **2FA enforcement** | Not enforced — purely opt-in, no middleware gating routes | None | defer-candidate |
| 13 | **Passkeys (WebAuthn)** | `src/lib/server/auth.ts:54-58` (`passkey({rpID, rpName})`); `src/lib/client/auth-client.ts:1,6` (`passkeyClient()`); `src/lib/components/PasskeyManager.svelte:1-121` (component exists, UNIMPORTED); `prisma/schema.prisma:87-103` (`Passkey` table) | None | build |
| 14 | **Project API keys (`scope_*`)** | `src/lib/server/project-api-key.ts:1-124` (generate, hash, authenticate, parse); `src/server/http.ts:154-158` (`parseBearerApiKey` in `authProject`); `src/server/handlers/projects.ts:1157-1192` (create/delete project API keys); `prisma/schema.prisma:267-284` (`ProjectApiKey` table) | Job-queue bearer tokens (`src/job-queue.mjs`) are a primitive precursor | build |
| 15 | **Bearer auth plugin (better-auth)** | `src/lib/server/auth.ts:59` (`bearer()` plugin) — enables `Authorization: Bearer` with better-auth session tokens | None (the API key flow in http.ts is separate) | thin-wrap |
| 16 | **Organizations (with members)** | `prisma/schema.prisma:115-143` (`Organization`, `OrganizationMember` tables); `src/server/handlers/organizations.ts:1-145` (CRUD, members, projects under org); `src/AGENTS/server.md:29-33` ("management visibility, never data access") | None | build |
| 17 | **Personal org per user** | `prisma/schema.prisma:119` (`isPersonal`, `personalOwnerId` on Organization); `src/AGENTS/server.md:38` ("real row, uniform model") | None | build |
| 18 | **Project members (two-plane access)** | `prisma/schema.prisma:286-300` (`ProjectMember` — user, project, role); `src/lib/server/auth-helpers.ts:44-46` (`requireProjectAccess` — data plane); `src/lib/server/auth-helpers.ts:61-63` (`requireProjectManagement` — org plane) | `test/project-membership-inherit.test.mjs` proves two-plane is expressible but not yet a named/defaulted pattern | build |
| 19 | **Direct user invitations (`ProjectInvitation`)** | `prisma/schema.prisma:318-331` (`ProjectInvitation` — userId-scoped); `src/server/handlers/invitations.ts:1-43` (list/accept/cancel); `src/lib/server/database/namespaces/invites.ts:11-48` (CRUD); `src/routes-pages/Account.svelte:71-103` (invitation UI in Account) | None | build |
| 20 | **Token-based invite links (`Invite`)** | `prisma/schema.prisma:302-316` (`Invite` — token, maxUses, expiresAt); `src/server/handlers/invites.ts:1-60` (public GET, accept, manage); `src/lib/server/database/namespaces/invites.ts:50-121` (CRUD + use tracking); `src/routes-pages/MembersPage.svelte:101-120` (create/copy invite in project settings) | None | build |
| 21 | **Password change** | `src/lib/components/PasswordChangeModal.svelte:33` (`authClient.changePassword()`); `src/routes-pages/Account.svelte:148` (mounted in Account) | None (login is create-or-verify only; no password change route) | build |
| 22 | **Forgot-password / reset-password** | `src/routes-pages/Login.svelte:48` (link to `/forgot-password` — **dead link, no page**) | None | defer-candidate |
| 23 | **Email verification** | `prisma/schema.prisma:78-85` (`Verification` table — better-auth artifact, unused); `prisma/schema.prisma:15` (`User.emailVerified` — stored, never enforced) | None | defer-candidate |
| 24 | **App session guard (302 → /login)** | `src/server/index.ts:109` (`app.use('/app', appGuard)`); `src/AGENTS/server.md:103-104` (`/app/*` authenticated) | Workbench has `requireUser` default-on route gate | thin-wrap |
| 25 | **OAuth / social login** | Not configured (no `socialProviders` block in `src/lib/server/auth.ts`). `Account` table exists but unused. | None | defer-candidate |

## Verdict

| Metric | Count |
|--------|-------|
| **Total features** | 25 |
| **exists** (workbench has equivalent or better) | 8 |
| **thin-wrap** (minor gap, quick to port) | 4 |
| **build** (requires new implementation) | 10 |
| **defer-candidate** (not used by Scope / dead code) | 3 |

**Build items (10):** TOTP 2FA, Passkey management UI, Project API keys, Organizations + personal orgs, ProjectMembers (two-plane), ProjectInvitations (user-to-user), Invites (token-based), Password change, two-plane named pattern, bearer auth plugin integration.

**Defer candidates (3):** 2FA enforcement (not used by Scope), forgot-password (dead link), email verification (unused), OAuth/social (not configured).

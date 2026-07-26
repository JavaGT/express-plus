// convergence.mjs — integration proof: one app exercising all four layers.
//
//   W1 passkey auth — .auth() from workbench (login, session cookie, passkeys)
//   W3 job queue — enqueue/claim/complete infrastructure on app.jobs
//   W4 UI kit — bindAction/bindField/bindList/bindConnection adapters
//   W5 client engine — createLiveStore boot → CRUD dispatch → overlay surface
//
// This file is a declaration-only exemplar. It defines
// entities and assertions but does NOT start a server — `test/convergence-
// integration.test.mjs` boots the app for end-to-end acceptance.
//
// The acceptance run exercises: HTTP auth round-trips, entity CRUD, job
// enqueue/claim/complete, client store CRUD surface, bindAction/bindField
// handles, and canUndoField vocabulary — all four wave layers in one run.

import { entity, text, date, owner, grant, deny, read, write, subscribe, scope } from 'workbench';

// ---------------------------------------------------------------------------
// ProjectTask — a Scope-style project task entity.
// Owner-scoped (station B pattern: owner ref with role inferring checks).
// Used in the integration test to verify: login → cookie → authed CRUD.
// ---------------------------------------------------------------------------
export const ProjectTask = entity('ProjectTask', {
  projectId: text(),
  title: text(),
  status: text({ default: 'todo' }),
  createdAt: date({ default: () => new Date() }),

  owner: owner(),
  grant: () => [
    scope(({ is }) => is.owner())
      .can(async ({ is }) => (await is.owner())
        ? grant(read, write, subscribe)
        : deny('not the owner')),
  ],
  routes: (r) => { r.resource(); },
});

// ---------------------------------------------------------------------------
// Job queue kind — the scope import/export pattern.
// Registered as a constant so the test and eventual worker share the string.
// ---------------------------------------------------------------------------
export const IMPORT_JOB_KIND = 'scope.import';
export const EXPORT_JOB_KIND = 'scope.export';

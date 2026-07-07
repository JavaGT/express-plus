// scope-entities.mjs — station B pre-work: workbench-native entity declarations
// for Scope's mechanical-CRUD entities (Source, Note, Theme, ExternalRef).
//
// Currently these live in /Users/server/Development/scope/src/lib/wb-scope/
// as Prisma-backed managed resources. Station B migrates them to native
// workbench entity() declarations so the framework owns the table schema,
// CRUD dispatch, event log, and snapshot projection.
//
// This file is a declaration-only artefact for golden parity verification at
// this stage. Actual cutover: delete Scope's Prisma namespace + wb-scope
// managed-resource wiring, boot workbench with these entities per-project.

import { entity, text, date, ref, number, grant, deny, read, write, subscribe, admin, scope } from '../src/index.mjs';

// Capabilities — a project member reads and writes; eventually admin gates
// specific mutations (e.g. only the project owner can delete a source).
const MEMBER = [read, write, subscribe];

// ---------------------------------------------------------------------------
// Source — a research reference (URL + notes) attached to a project.
// Mirrors Scope's SourceDto: id, name, url, notes, createdAt.
// ---------------------------------------------------------------------------
export const Source = entity('Source', {
  name: text(),
  url: text({ optional: true }),
  notes: text({ optional: true }),
  createdAt: date({ default: () => new Date() }),

  // Station B scaffolding: for now, a simple owner-scope grant. After the
  // membership two-plane (W1) is wired into the Scope boot context, this
  // becomes a project-member grant instead.
  owner: ref('User', { role: 'owner', readonly: true }),
  grant: () => [
    scope(({ is }) => is.owner())
      .can(async ({ is }) => (await is.owner()) ? grant(...MEMBER) : deny('not the owner')),
  ],
  routes: (r) => { r.resource(); },
});

// ---------------------------------------------------------------------------
// Note — a sticky-note within a project.
// Mirrors Scope's NoteDto: id, projectId, title, content, sortOrder, createdAt, updatedAt.
// ---------------------------------------------------------------------------
export const Note = entity('Note', {
  title: text(),
  content: text({ optional: true, default: '' }),
  sortOrder: number({ default: 0 }),
  createdAt: date({ default: () => new Date() }),
  updatedAt: date({ default: () => new Date() }),

  owner: ref('User', { role: 'owner', readonly: true }),
  grant: () => [
    scope(({ is }) => is.owner())
      .can(async ({ is }) => (await is.owner()) ? grant(...MEMBER) : deny('not the owner')),
  ],
  routes: (r) => { r.resource(); },
});

// ---------------------------------------------------------------------------
// Theme — a colour-coded label set (codebook category) within a project.
// Mirrors Scope's Theme DTO: id, projectId, label, colour, note, codeIds, createdAt, updatedAt.
// ---------------------------------------------------------------------------
export const Theme = entity('Theme', {
  label: text(),
  colour: text({ optional: true }),
  note: text({ optional: true }),
  codeIds: text({ optional: true }), // JSON array in Scope; text in workbench
  createdAt: date({ default: () => new Date() }),
  updatedAt: date({ default: () => new Date() }),

  owner: ref('User', { role: 'owner', readonly: true }),
  grant: () => [
    scope(({ is }) => is.owner())
      .can(async ({ is }) => (await is.owner()) ? grant(...MEMBER) : deny('not the owner')),
  ],
  routes: (r) => { r.resource(); },
});

// ---------------------------------------------------------------------------
// ExternalRef — a cross-entity reference (link) attaching metadata to a
// segment, transcript, or artefact within a project.
// Mirrors Scope's ExternalRefDto: id, entityType, entityId, label, url, description.
//
// NOTE: this entity spans entity types (segment/transcript/artefact), so its
// project resolution is indirect. For station B, this is the most complex
// entity. The grant will need a check that resolves the project through the
// linked entity type — deferred until the membership two-plane is wired in.
// ---------------------------------------------------------------------------
export const ExternalRef = entity('ExternalRef', {
  entityType: text(),
  entityId: text(), // the id of the segment/transcript/artefact this ref is attached to
  label: text({ optional: true }),
  url: text({ optional: true }),
  description: text({ optional: true }),

  owner: ref('User', { role: 'owner', readonly: true }),
  grant: () => [
    scope(({ is }) => is.owner())
      .can(async ({ is }) => (await is.owner()) ? grant(...MEMBER) : deny('not the owner')),
  ],
  routes: (r) => { r.resource(); },
});

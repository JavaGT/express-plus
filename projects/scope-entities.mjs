// scope-entities.mjs — station B pre-work: workbench-native entity declarations
// for Scope's entities (Source, Note, Theme, ExternalRef, + 9 more, + Project).
//
// Currently these live in /Users/server/Development/scope/src/lib/wb-scope/
// as Prisma-backed managed resources. Station B migrates them to native
// workbench entity() declarations so the framework owns the table schema,
// CRUD dispatch, event log, and snapshot projection.
//
// This file is a declaration-only artefact for golden parity verification at
// this stage. Actual cutover: delete Scope's Prisma namespace + wb-scope
// managed-resource wiring, boot workbench with these entities per-project.
//
// Two-plane grants (W1 `membership()` pattern, shipped 2026-07-07): Project is
// the membership root — it carries the owner ref + a members side-table of
// User→role (viewer|editor). Every child entity inherits Project's grant via
// `inherit(Project, { via: 'projectId' })`, which lowers to
// `EXISTS (SELECT 1 FROM Project WHERE Project.id = child.projectId AND <Project scope>)`.
// Children store Project.id (the workbench auto PK) in their projectId column.
// NOTE: grants are DECLARATIVE until the Path B cutover (handlers currently
// write via raw SQL bypassing workbench authz); at cutover a one-shot migration
// must populate Project_members from existing ProjectMember Prisma rows.
//
// LIBRARY MODE: import this module to compile the declarations, then call
// `await initScope(db)` with a SQLite connection. It returns the application;
// use `app.entity(Source)` (and the other declarations) to obtain facades bound
// to that application and database.

import workbench, {
  membership,
  entity, text, date, ref, number, map, inherit,
  read, write, subscribe,
} from 'workbench';

// Two-plane membership config — maps Scope's data-plane roles to workbench
// capability tokens. Owner is implicit (auto-detected from Project's owner ref,
// auto-grants read,write,subscribe,admin). Never put `owner` in this config.
//   viewer → read, subscribe          (read snapshot / SSE)
//   editor → read, write, subscribe   (all workbench entity mutations)
// Each key resolves to the `members` map field via role-array match. The
// explicit `field.role` narrows each key's DB-role filter to just that role,
// so is.viewer() matches only viewers and is.editor() only editors — without
// it, dbRoles defaults to ALL map roles and an editor would match the viewer
// branch first (canBody is first-match-wins) and miss write.
const projectMembership = {
  viewer: { can: [read, subscribe], field: { role: 'viewer' } },
  editor: { can: [read, write, subscribe], field: { role: 'editor' } },
};

// ---------------------------------------------------------------------------
// Project — a research project, the top-level container for all other
// entities in Scope. The membership root: owner ref + members side-table.
// ---------------------------------------------------------------------------
export const Project = entity('Project', {
  projectId: text(),
  name: text(),
  description: text({ optional: true }),
  createdAt: date({ default: () => new Date() }),
  updatedAt: date({ default: () => new Date() }),

  owner: ref('User', { role: 'owner', readonly: true }),
  members: map(ref('User'), { role: ['viewer', 'editor'], default: {} }),
  routes: (r) => { r.resource(); },
});
membership(Project, projectMembership);

// ---------------------------------------------------------------------------
// Source — a research reference (URL + notes) attached to a project.
// Mirrors Scope's SourceDto: id, name, url, notes, createdAt.
// ---------------------------------------------------------------------------
export const Source = entity('Source', {
  projectId: text(),
  name: text(),
  url: text({ optional: true }),
  notes: text({ optional: true }),
  createdAt: date({ default: () => new Date() }),

  grant: inherit(Project, { via: 'projectId' }),
  routes: (r) => { r.resource(); },
});

// ---------------------------------------------------------------------------
// Note — a sticky-note within a project.
// Mirrors Scope's NoteDto: id, projectId, title, content, sortOrder, createdAt, updatedAt.
// ---------------------------------------------------------------------------
export const Note = entity('Note', {
  projectId: text(),
  title: text(),
  content: text({ optional: true, default: '' }),
  sortOrder: number({ default: 0 }),
  createdAt: date({ default: () => new Date() }),
  updatedAt: date({ default: () => new Date() }),

  grant: inherit(Project, { via: 'projectId' }),
  routes: (r) => { r.resource(); },
});

// ---------------------------------------------------------------------------
// Theme — a colour-coded label set (codebook category) within a project.
// Mirrors Scope's Theme DTO: id, projectId, label, colour, note, codeIds, createdAt, updatedAt.
// ---------------------------------------------------------------------------
export const Theme = entity('Theme', {
  projectId: text(),
  label: text(),
  colour: text({ optional: true }),
  note: text({ optional: true }),
  codeIds: text({ optional: true }), // JSON array in Scope; text in workbench
  createdAt: date({ default: () => new Date() }),
  updatedAt: date({ default: () => new Date() }),

  grant: inherit(Project, { via: 'projectId' }),
  routes: (r) => { r.resource(); },
});

// ---------------------------------------------------------------------------
// ExternalRef — a cross-entity reference (link) attaching metadata to a
// segment, transcript, or artefact within a project.
// Mirrors Scope's ExternalRefDto: id, entityType, entityId, label, url, description.
//
// NOTE: this entity spans entity types (segment/transcript/artefact), so its
// project resolution is indirect. For station B, this is the most complex
// entity. The grant inherits Project via the projectId column written by
// Scope's handlers; the entity-belongs-to-project consistency check that
// Scope applies at handler level (resolveExternalRefProjectId) is orthogonal
// to the workbench grant and stays on the Scope side.
// ---------------------------------------------------------------------------
export const ExternalRef = entity('ExternalRef', {
  projectId: text(),
  entityType: text(),
  entityId: text(), // the id of the segment/transcript/artefact this ref is attached to
  label: text({ optional: true }),
  url: text({ optional: true }),
  description: text({ optional: true }),

  grant: inherit(Project, { via: 'projectId' }),
  routes: (r) => { r.resource(); },
});

// ---------------------------------------------------------------------------
// Codebook — a named grouping of codes within a project.
// Mirrors Scope's Codebook model: id, name, projectId, codes, createdAt.
// ---------------------------------------------------------------------------
export const Codebook = entity('Codebook', {
  projectId: text(),
  name: text(),
  createdAt: date({ default: () => new Date() }),

  grant: inherit(Project, { via: 'projectId' }),
  routes: (r) => { r.resource(); },
});

// ---------------------------------------------------------------------------
// Code — a label (optionally coloured, with inclusion/exclusion criteria)
// within a codebook, optionally hierarchical via parentId/parentPath.
// ---------------------------------------------------------------------------
export const Code = entity('Code', {
  projectId: text(),
  codebookId: text(),
  label: text(),
  colour: text({ optional: true }),
  description: text({ optional: true }),
  inclusionCriteria: text({ optional: true }),
  exclusionCriteria: text({ optional: true }),
  parentId: text({ optional: true }),
  parentPath: text({ optional: true }),
  createdAt: date({ default: () => new Date() }),

  grant: inherit(Project, { via: 'projectId' }),
  routes: (r) => { r.resource(); },
});

// ---------------------------------------------------------------------------
// Speaker — a named speaker (optionally coloured, with description) within a
// project.
// ---------------------------------------------------------------------------
export const Speaker = entity('Speaker', {
  projectId: text(),
  name: text(),
  colour: text({ optional: true }),
  description: text({ optional: true }),
  createdAt: date({ default: () => new Date() }),
  updatedAt: date({ default: () => new Date() }),

  grant: inherit(Project, { via: 'projectId' }),
  routes: (r) => { r.resource(); },
});

// ---------------------------------------------------------------------------
// Collection — a named grouping of artefacts within a project.
// ---------------------------------------------------------------------------
export const Collection = entity('Collection', {
  projectId: text(),
  name: text(),
  description: text({ optional: true }),
  createdAt: date({ default: () => new Date() }),

  grant: inherit(Project, { via: 'projectId' }),
  routes: (r) => { r.resource(); },
});

// ---------------------------------------------------------------------------
// Artefact — a research item (audio, video, document, etc.) within a project.
// ---------------------------------------------------------------------------
export const Artefact = entity('Artefact', {
  projectId: text(),
  name: text(),
  type: text({ optional: true }),
  description: text({ optional: true }),
  releaseDate: text({ optional: true }), // ISO date string
  recordDate: text({ optional: true }),  // ISO date string
  code: text({ optional: true }),
  createdAt: date({ default: () => new Date() }),

  grant: inherit(Project, { via: 'projectId' }),
  routes: (r) => { r.resource(); },
});

// ---------------------------------------------------------------------------
// Transcript — a transcription record (source label, model) within a project.
// ---------------------------------------------------------------------------
export const Transcript = entity('Transcript', {
  projectId: text(),
  sourceLabel: text({ optional: true }),
  transcriptionModel: text({ optional: true }),
  createdAt: date({ default: () => new Date() }),

  grant: inherit(Project, { via: 'projectId' }),
  routes: (r) => { r.resource(); },
});

// ---------------------------------------------------------------------------
// Comment — a threaded comment on a segment within a project.
// ---------------------------------------------------------------------------
export const Comment = entity('Comment', {
  projectId: text(),
  body: text(),
  segmentId: text(),
  parentId: text({ optional: true }),
  userId: text(),
  createdAt: date({ default: () => new Date() }),
  updatedAt: date({ default: () => new Date() }),

  grant: inherit(Project, { via: 'projectId' }),
  routes: (r) => { r.resource(); },
});

// ---------------------------------------------------------------------------
// File — a stored media file (audio, video, image, document) within a
// project, with hash and size metadata.
// Mirrors Scope's MediaFile model.
// ---------------------------------------------------------------------------
export const File = entity('File', {
  projectId: text(),
  name: text(),
  type: text({ optional: true }),   // 'audio' | 'video' | 'image' | 'document' | 'unknown'
  mime: text({ optional: true }),
  size: number({ optional: true }),
  md5: text({ optional: true }),
  sha256: text({ optional: true }),
  createdAt: date({ default: () => new Date() }),
  updatedAt: date({ default: () => new Date() }),

  grant: inherit(Project, { via: 'projectId' }),
  routes: (r) => { r.resource(); },
});

export const scopeEntities = Object.freeze([
  Source,
  Note,
  Theme,
  ExternalRef,
  Codebook,
  Code,
  Speaker,
  Collection,
  Artefact,
  Transcript,
  Comment,
  File,
  Project,
]);

/**
 * Build one isolated Scope application around the supplied SQLite connection.
 * Schema preparation and entity binding are owned by the application, so two
 * Scope applications can safely use the same declarations with different DBs.
 */
export async function initScope(db) {
  const app = workbench({ db, entities: scopeEntities });
  await app.prepareSchema();
  return app;
}

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
// LIBRARY MODE: import this module to compile entities (sets up DDL, verbs,
// projection). Call `initScope(db)` with a better-sqlite3 DatabaseSync
// instance to run DDL + set active DB so entity CRUD methods work.

import {
  membership, entity, text, date, ref, number, map, inherit, json, boolean,
  grant, deny, read, write, subscribe, admin, scope,
} from 'workbench';
import { setActiveDb } from '../src/db.mjs';
import { generateDDL } from '../src/ddl.mjs';

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
  projectId: text({ immutable: true }),
  name: text({ validate: (value) => (value.length >= 1 && value.length <= 500) || 'expected between 1 and 500 characters' }),
  url: text({ optional: true }),
  notes: text({ optional: true }),
  createdAt: date({ readonly: true, default: () => new Date() }),
  updatedAt: date({ touch: true, default: () => new Date() }),

  grant: inherit(Project, { via: 'projectId' }),
  routes: (r) => { r.resource(); },
});

// ---------------------------------------------------------------------------
// Note — a sticky-note within a project.
// Mirrors Scope's NoteDto: id, projectId, title, content, sortOrder, createdAt, updatedAt.
// ---------------------------------------------------------------------------
export const Note = entity('Note', {
  projectId: text({ immutable: true }),
  title: text({ validate: (value) => (value.length >= 1 && value.length <= 500) || 'expected between 1 and 500 characters' }),
  content: text({ optional: true, default: '', validate: (value) => value.length <= 100_000 || 'expected at most 100000 characters' }),
  sortOrder: number({ default: 0 }),
  createdAt: date({ readonly: true, default: () => new Date() }),
  updatedAt: date({ touch: true, default: () => new Date() }),

  grant: inherit(Project, { via: 'projectId' }),
  routes: (r) => { r.resource(); },
});

// ---------------------------------------------------------------------------
// Theme — a colour-coded label set (codebook category) within a project.
// Mirrors Scope's Theme DTO: id, projectId, label, colour, note, codeIds, createdAt, updatedAt.
// ---------------------------------------------------------------------------
function validateThemeCodeIds(value) {
  if (!Array.isArray(value)) return 'expected an array of code ids';
  if (value.length > 500) return 'expected at most 500 code ids';
  if (value.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 200)) {
    return 'expected every code id to be non-empty text of at most 200 characters';
  }
  return true;
}

export const Theme = entity('Theme', {
  projectId: text({ immutable: true }),
  label: text({ validate: (value) => (value.length >= 1 && value.length <= 500) || 'expected between 1 and 500 characters' }),
  colour: text({ optional: true, nullable: true, validate: (value) => value.length <= 64 || 'expected at most 64 characters' }),
  note: text({ optional: true, nullable: true, validate: (value) => value.length <= 10_000 || 'expected at most 10000 characters' }),
  codeIds: json(null, { optional: true, default: [], validate: validateThemeCodeIds }),
  createdAt: date({ readonly: true, default: () => new Date() }),
  updatedAt: date({ touch: true, default: () => new Date() }),

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
  createdAt: date({ readonly: true, default: () => new Date() }),
  updatedAt: date({ touch: true, default: () => new Date() }),

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
  projectId: text({ immutable: true }),
  name: text({ validate: (value) => (value.trim().length >= 1 && value.length <= 500) || 'expected a non-empty value of at most 500 characters' }),
  description: text({ optional: true, nullable: true }),
  createdAt: date({ readonly: true, default: () => new Date() }),
  updatedAt: date({ touch: true, default: () => new Date() }),

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
  resolved: boolean({ default: false }),
  resolvedAt: text({ optional: true }),
  resolvedBy: text({ optional: true }),
  createdAt: text({ default: () => new Date().toISOString() }),
  updatedAt: text({ default: () => new Date().toISOString() }),

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

/**
 * Library-mode initialisation: run DDL + set active DB so entity CRUD methods
 * (create, findById, crudHandlers) work on the given SQLite connection.
 * Call once per project boot, passing a better-sqlite3 DatabaseSync instance
 * opened to the project's SQLite file.
 */
export function initScope(db) {
  setActiveDb(db, { replace: true });
  for (const entity of [Source, Note, Theme, ExternalRef, Codebook, Code, Speaker, Collection, Artefact, Transcript, Comment, File, Project]) {
    const ddl = generateDDL(entity);
    for (const stmt of ddl) {
      db.exec(stmt);
    }
  }
}

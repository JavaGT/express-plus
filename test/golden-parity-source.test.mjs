// golden-parity-source.test.mjs — station B pre-work: golden parity proof
// for Scope's Source, Note, Theme, ExternalRef entities as workbench-native
// entity() declarations.
//
// Phase 1 (this test): verify entity shape — name, fields, verbs, grant,
// DDL generation. No workbench boot required.
//
// Phase 2a (initScope + CRUD): boot a :memory: DB with initScope(), then
// exercise entity.create() + crudHandlers in library mode.
//
// Phase 2b (future integration): HTTP-level dispatch + WS fan-out.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { generateDDL } from 'workbench/internal';

// Import scope entities — this triggers entity() compilation which validates
// the declaration shape (field kinds, grant syntax, etc.).
import { Source, Note, Theme, ExternalRef, initScope } from '../projects/scope-entities.mjs';

describe('station-B golden parity: entity shape', () => {
  describe('Source', () => {
    it('has name and verbs', () => {
      assert.equal(Source.name, 'Source');
      assert.ok(Source.verbs.create, 'create verb');
      assert.ok(Source.verbs.update, 'update verb');
      assert.ok(Source.verbs.remove, 'remove verb');
    });

    it('has expected fields', () => {
      const fields = Source.fields;
      assert.ok(fields.name, 'name field');
      assert.equal(fields.name.kind, 'value');
      assert.equal(fields.name.type, 'text');
      assert.ok(fields.url, 'url field');
      assert.ok(fields.notes, 'notes field');
      assert.ok(fields.createdAt, 'createdAt field');
      assert.equal(fields.createdAt.type, 'date');
      assert.ok(fields.projectId, 'projectId field (inherit FK → Project.id)');
    });

    it('inherits Project grant (two-plane, no per-entity owner)', () => {
      // Two-plane: Source has no owner ref of its own; its grant is an
      // inherit() directive joining child.projectId = Project.id.
      assert.equal(Source.fields.owner, undefined, 'no owner field on child');
      assert.ok(Source.grant && Source.grant.inherit, 'grant is an inherit directive');
      assert.equal(Source.grant.inherit.name, 'Project', 'inherits Project');
      assert.equal(Source.grant.via, 'projectId', 'via projectId');
    });

    it('generates DDL', () => {
      const ddl = generateDDL(Source);
      assert.ok(Array.isArray(ddl));
      assert.ok(ddl.length >= 1, 'at least main table');
      const main = ddl[0];
      assert.ok(main.includes('CREATE TABLE'), 'DDL is CREATE TABLE');
      assert.ok(main.includes('name'), 'name column');
      assert.ok(main.includes('url'), 'url column');
      assert.ok(main.includes('notes'), 'notes column');
    });

    it('generates CRUD lifecycle event types matching Scope convention', () => {
      assert.equal(Source.verbs.create.type, 'Source.create');
      assert.equal(Source.verbs.update.type, 'Source.update');
      assert.equal(Source.verbs.remove.type, 'Source.remove');
      assert.equal(Source.verbs.created.type, 'Source.created');
      assert.equal(Source.verbs.updated.type, 'Source.updated');
      assert.equal(Source.verbs.removed.type, 'Source.removed');
    });
  });

  describe('Note', () => {
    it('has expected shape', () => {
      assert.equal(Note.name, 'Note');
      assert.ok(Note.fields.title);
      assert.ok(Note.fields.content);
      assert.ok(Note.fields.sortOrder);
      assert.ok(Note.fields.createdAt);
      assert.ok(Note.fields.updatedAt);
    });
  });

  describe('Theme', () => {
    it('has expected shape', () => {
      assert.equal(Theme.name, 'Theme');
      assert.ok(Theme.fields.label);
      assert.ok(Theme.fields.colour);
      assert.ok(Theme.fields.note);
      assert.ok(Theme.fields.codeIds);
    });
  });

  describe('ExternalRef', () => {
    it('has expected shape', () => {
      assert.equal(ExternalRef.name, 'ExternalRef');
      assert.ok(ExternalRef.fields.entityType);
      assert.ok(ExternalRef.fields.entityId);
      assert.ok(ExternalRef.fields.label);
      assert.ok(ExternalRef.fields.url);
      assert.ok(ExternalRef.fields.description);
    });
  });
});

describe('station-B golden parity: library-mode CRUD', () => {
  let db;

  before(() => {
    db = new DatabaseSync(':memory:');
    initScope(db);
  });

  after(() => {
    db.close();
  });

  it('Source.create inserts a row and Source.findById reads it back', () => {
    const row = Source.create({ name: 'Test Source', url: 'https://example.com', createdAt: new Date() });
    assert.ok(row.id, 'row has an id');
    assert.equal(row.name, 'Test Source');
    assert.equal(row.url, 'https://example.com');

    const found = Source.findById(row.id);
    assert.ok(found);
    assert.equal(found.name, 'Test Source');
  });

  it('Source.update crudHandler emits Source.updated event', () => {
    const created = Source.create({ name: 'Pre Update' });
    const events = Source.crudHandlers['Source.update']({
      payload: { id: created.id, name: 'Post Update' },
      principal: null,
    });
    assert.ok(Array.isArray(events));
    assert.ok(events.length > 0);
    const ev = events[0];
    assert.equal(ev.type, 'Source.updated');
    assert.equal(ev.scope, `Source:${created.id}`);
  });

  it('Source.remove crudHandler emits Source.removed event', () => {
    const created = Source.create({ name: 'To Remove' });
    const events = Source.crudHandlers['Source.remove']({
      payload: { id: created.id },
      principal: null,
    });
    assert.ok(Array.isArray(events));
    const ev = events[0];
    assert.equal(ev.type, 'Source.removed');
    assert.equal(ev.data.id, created.id);
  });

  it('create CRUD handler emits Source.created event with correct shape', () => {
    const events = Source.crudHandlers['Source.create']({
      payload: { name: 'New Source' },
      principal: null,
    });
    assert.ok(Array.isArray(events));
    const ev = events[0];
    assert.equal(ev.type, 'Source.created');
    assert.ok(ev.scope.startsWith('Source:'), 'scope starts with Source:');
    assert.equal(ev.data.name, 'New Source');
    assert.ok(ev.data.id, 'generated id');
  });

  it('update rejects missing id', () => {
    assert.throws(() => {
      Source.crudHandlers['Source.update']({ payload: {}, principal: null });
    }, /id/);
  });

  it('all four entities boot on DB without error', () => {
    // The DDL runs in before() — just verify all entities are queryable
    assert.ok(Source.findAll);
    assert.ok(Note.findAll);
    assert.ok(Theme.findAll);
    assert.ok(ExternalRef.findAll);
  });
});

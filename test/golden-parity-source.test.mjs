// golden-parity-source.test.mjs — station B pre-work: golden parity proof
// for Scope's Source, Note, Theme, ExternalRef entities as workbench-native
// entity() declarations.
//
// Phase 1 (this test): verify entity shape — name, fields, verbs, grant,
// DDL generation. No workbench boot required.
//
// Phase 2 (future): integration test with workbench kernel boot, CRUD through
// HTTP dispatch, and WS event fan-out against a :memory: database.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateDDL } from '../src/internal.mjs';

// Import scope entities — this triggers entity() compilation which validates
// the declaration shape (field kinds, grant syntax, etc.).
import { Source, Note, Theme, ExternalRef } from '../projects/scope-entities.mjs';

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
      assert.ok(fields.owner, 'owner field');
      assert.equal(fields.owner.type, 'ref');
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

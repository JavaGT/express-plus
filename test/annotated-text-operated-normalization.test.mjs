import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  annotatedText, annotation, entity, everyone, executeDDL, executeFrameworkDDL,
  grant, parseEventType, read, ref, scope, write,
} from '../build/internal.mjs';
import { defineSqliteSchema } from '../build/server.mjs';
import {
  constructV15RegionEvent,
  normalizeOperatedEvent,
} from '../build/annotated-text-operated-event.mjs';
import {
  importTextToFamily,
  resolveOffsetToEndpoint,
  serializeCompactTextFamilyCheckpoint,
  textFamilyBasis,
} from '../build/annotated-text-continuous.mjs';
import { attachAnnotationRange } from '../build/annotated-text-storage.mjs';
import { planRegionEdit } from '../build/annotated-text-region-plan.mjs';
import {
  computeAffectedClosure,
  digestAffectedClosure,
} from '../build/annotated-text-region-reducer.mjs';
import { sha256Utf8 } from '../build/annotated-text-region-limits.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures', 'annotated-text-operated');

const ACTOR = 'a'.repeat(32);
const EDIT_ACTOR = 'b'.repeat(32);
const DECLARATIONS = [{ annotationName: 'note', fields: {}, empty: 'delete', cardinality: 'many' }];

function loadJson(rel) {
  return JSON.parse(readFileSync(join(fixtures, rel), 'utf8'));
}

function listJson(dir) {
  return readdirSync(join(fixtures, dir)).filter((name) => name.endsWith('.json'));
}

function unwrapFixture(raw) {
  if (raw && typeof raw === 'object' && raw.event && raw.preimage) return raw;
  return { event: raw, preimage: null };
}

test('v13 fixture maps family to a checkpoint proof and preserves facts', () => {
  const { event: raw } = unwrapFixture(loadJson('v13/text-apply.json'));
  const canonical = normalizeOperatedEvent(raw, { entity: 'ReplayDoc', field: 'body' });
  assert.equal(canonical.kind, 'text.apply');
  assert.equal(canonical.wireVersion, 13);
  assert.equal(canonical.familyProof.kind, 'checkpoint');
  assert.deepEqual(canonical.familyProof.checkpoint, raw.facts.family);
  assert.deepEqual(canonical.facts.emptiedAnnotations, raw.facts.emptiedAnnotations);
  assert.equal(canonical.facts.actorId, raw.facts.actorId);
});

test('v14 fixture maps absent family to derive-and-check-frontier', () => {
  const { event: raw } = unwrapFixture(loadJson('v14/text-apply.json'));
  const canonical = normalizeOperatedEvent(raw, { entity: 'ReplayDoc', field: 'body' });
  assert.equal(canonical.kind, 'text.apply');
  assert.equal(canonical.wireVersion, 14);
  assert.deepEqual(canonical.familyProof, { kind: 'derive-and-check-frontier' });
  assert.equal(canonical.facts.family, null);
});

test('malformed cross-version fixtures reject before any write', () => {
  for (const name of listJson('malformed')) {
    const { event: raw } = unwrapFixture(loadJson(`malformed/${name}`));
    assert.throws(
      () => normalizeOperatedEvent(raw, { entity: 'ReplayDoc', field: 'body' }),
      (error) => {
        assert.match(error.message, /ReplayDoc\.body\.operated v\d+ event has invalid envelope/);
        return true;
      },
      name,
    );
  }
});

function membership(family, start, end) {
  return {
    ordinal: 0,
    start: resolveOffsetToEndpoint(family, start, family.checkpoint.frontier, 'left'),
    end: resolveOffsetToEndpoint(family, end, family.checkpoint.frontier, 'right'),
  };
}

function stored(family, id, start, end) {
  return {
    id,
    family: 'note',
    fields: {},
    protectedTargetIds: [],
    memberships: [membership(family, start, end)],
    prerequisites: [],
    empty: 'delete',
    cardinality: 'many',
  };
}

function v15Envelope() {
  const family = importTextToFamily('doc-1', ACTOR, 'hello world');
  const annotations = [stored(family, 'note-1', 0, 5)];
  const images = annotations.map((image) => ({ ...image, orphan: null }));
  const closure = computeAffectedClosure({
    annotations: images,
    family,
    from: 0,
    to: 5,
    namedIds: ['note-1'],
  });
  const descriptor = {
    version: 10,
    kind: 'region.edit',
    id: 'doc-1',
    basis: textFamilyBasis(family),
    from: 0,
    to: 5,
    coveredTextDigest: sha256Utf8('hello'),
    affectedClosureDigest: digestAffectedClosure(closure),
    expectedCoveredAnnotationIds: ['note-1'],
    replacement: 'hallo',
    transitions: [{ kind: 'range.set', annotationId: 'note-1', ranges: [{ start: 0, end: 5 }] }],
  };
  const plan = planRegionEdit({
    descriptor,
    family,
    structureVersion: 1,
    annotations,
    declarations: DECLARATIONS,
    actor: EDIT_ACTOR,
    lamport: 2,
  });
  return { family, annotations, envelope: constructV15RegionEvent(plan), plan };
}

test('v15 fixture file normalizes through the production constructor', () => {
  const { event: raw } = unwrapFixture(loadJson('v15/region-edit.json'));
  const canonical = normalizeOperatedEvent(raw, { entity: 'ReplayDoc', field: 'body' });
  assert.equal(canonical.kind, 'region.edit');
  assert.equal(canonical.wireVersion, 15);
});

test('v15 region.edit normalizes through the production constructor', () => {
  const { envelope, plan } = v15Envelope();
  const canonical = normalizeOperatedEvent(envelope, { entity: 'ReplayDoc', field: 'body' });
  assert.equal(canonical.kind, 'region.edit');
  assert.equal(canonical.wireVersion, 15);
  assert.deepEqual(canonical.familyProof, { kind: 'derive-and-check-frontier' });
  assert.equal(canonical.beforeDigest, plan.postimage.beforeDigest);
  assert.equal(canonical.afterDigest, plan.postimage.afterDigest);
  assert.deepEqual(canonical.affectedIds, plan.postimage.affectedIds);
  assert.equal(canonical.text.kind, 'replace');
});

const externalReferences = defineSqliteSchema({
  name: 'annotated-text-operated-normalization',
  tables: [],
  externalTables: [{ name: 'Project', columns: ['id'] }],
});

function declaredEntity() {
  return entity('ReplayDoc', {
    project: ref('Project'),
    owner: ref('User', { role: 'owner' }),
    body: annotatedText({
      project: 'project',
      owner: 'owner',
      annotations: [annotation('note', { fields: {} })],
    }),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
}

function installSchema(db) {
  const Project = entity('Project', {
    owner: ref('User', { role: 'owner' }),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY)');
  db.exec("INSERT INTO User (id) VALUES ('u1')");
  executeDDL(Project, db);
  db.exec("INSERT INTO Project (id, owner) VALUES ('p1', 'u1')");
  executeDDL(declaredEntity(), db);
}

const PROJECTION_TABLES = [
  'ReplayDoc',
  'ReplayDoc_body_state',
  'ReplayDoc_body_annotation',
  'ReplayDoc_body_annotation_note',
  'ReplayDoc_body_membership',
  'ReplayDoc_body_range',
  'ReplayDoc_body_annotation_orphan_state',
];

function projectedDump(db) {
  const state = {};
  for (const table of PROJECTION_TABLES) {
    const rows = db.prepare(`SELECT * FROM ${table}`).all()
      .map((row) => Object.entries(row).sort(([a], [b]) => a.localeCompare(b)))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    state[table] = JSON.stringify(rows);
  }
  return state;
}

function seedPreimage(db, preimage) {
  const documentId = preimage.documentId;
  db.prepare('INSERT INTO ReplayDoc (id, project, owner) VALUES (?, ?, ?)').run(documentId, 'p1', 'u1');
  const family = importTextToFamily(documentId, preimage.actor, preimage.text);
  db.prepare('INSERT INTO ReplayDoc_body_state (document_id, structure_version, family_checkpoint) VALUES (?, 1, ?)')
    .run(documentId, serializeCompactTextFamilyCheckpoint(family));
  for (const annotation of preimage.annotations ?? []) {
    db.prepare('INSERT INTO ReplayDoc_body_annotation (id, document_id, project_id, owner_id, family) VALUES (?, ?, ?, ?, ?)')
      .run(annotation.id, documentId, 'p1', 'u1', annotation.family);
    attachAnnotationRange(
      db,
      'ReplayDoc_body',
      documentId,
      annotation.id,
      resolveOffsetToEndpoint(family, annotation.start, family.checkpoint.frontier, 'left'),
      resolveOffsetToEndpoint(family, annotation.end, family.checkpoint.frontier, 'right'),
      0,
    );
  }
  return family;
}

function applyOperated(db, event) {
  const projection = workbench({ db, entities: [declaredEntity()] }).entities.get('ReplayDoc').projection;
  projection.apply({
    handle: parseEventType('ReplayDoc.body.operated'),
    type: 'ReplayDoc.body.operated',
    data: event,
  }, db);
}

function projectFixture(rel) {
  const { event, preimage } = unwrapFixture(loadJson(rel));
  const db = new DatabaseSync(':memory:');
  installSchema(db);
  if (preimage) seedPreimage(db, preimage);
  applyOperated(db, event);
  const dump = projectedDump(db);
  db.close();
  return dump;
}

test('v13 and v14 fixtures project to the same canonical dump', () => {
  const v13 = projectFixture('v13/text-apply.json');
  const v14 = projectFixture('v14/text-apply.json');
  assert.deepEqual(v13, v14, 'operated normalization fixture mismatch: family');
  const rebuilt = projectFixture('v14/text-apply.json');
  assert.deepEqual(rebuilt, v14, 'operated normalization fixture mismatch: replay');
});

test('v15 fixture projects through the production reducer to a stable dump', () => {
  const first = projectFixture('v15/region-edit.json');
  const second = projectFixture('v15/region-edit.json');
  assert.deepEqual(first, second, 'operated normalization fixture mismatch: v15');
  const annotationRows = JSON.parse(first.ReplayDoc_body_annotation);
  assert.equal(annotationRows.length, 1);
});

test('malformed operated events write nothing through the production projector', () => {
  const db = new DatabaseSync(':memory:');
  installSchema(db);
  const projection = workbench({ db, entities: [declaredEntity()] }).entities.get('ReplayDoc').projection;
  const before = projectedDump(db);
  for (const name of listJson('malformed')) {
    const { event: data } = unwrapFixture(loadJson(`malformed/${name}`));
    assert.throws(
      () => projection.apply({
        handle: parseEventType('ReplayDoc.body.operated'),
        type: 'ReplayDoc.body.operated',
        data,
      }, db),
      /invalid envelope/,
      name,
    );
    assert.deepEqual(projectedDump(db), before, `malformed ${name} performed a write`);
  }
  db.close();
});

test('v15 fixture reaches the canonical reducer', () => {
  let canonical;
  try {
    const { event } = unwrapFixture(loadJson('v15/region-edit.json'));
    canonical = normalizeOperatedEvent(event, { entity: 'ReplayDoc', field: 'body' });
  } catch {
    throw new Error('v15 fixture did not reach canonical reducer');
  }
  if (canonical.kind !== 'region.edit') throw new Error('v15 fixture did not reach canonical reducer');
});

test('forged region postimage performs zero writes', () => {
  const { event, preimage } = unwrapFixture(loadJson('v15/region-edit.json'));
  const forged = structuredClone(event);
  forged.operation.afterDigest = '0'.repeat(64);
  const db = new DatabaseSync(':memory:');
  installSchema(db);
  seedPreimage(db, preimage);
  const before = projectedDump(db);
  const projection = workbench({ db, entities: [declaredEntity()] }).entities.get('ReplayDoc').projection;
  let threw = false;
  try {
    projection.apply({
      handle: parseEventType('ReplayDoc.body.operated'),
      type: 'ReplayDoc.body.operated',
      data: forged,
    }, db);
  } catch {
    threw = true;
  }
  const after = projectedDump(db);
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    throw new Error('forged region postimage performed a write');
  }
  assert.equal(threw, true);
  db.close();
});

test('oversized direct v15 replay payloads fail with the region limit and write nothing', () => {
  const fixture = unwrapFixture(loadJson('v15/region-edit.json'));
  const cases = [
    ['text-operation', (event) => { event.operation.text.operations[1][5][2] = 'x'.repeat((1024 * 1024) + 1); }],
    ['memberships', (event) => { event.operation.transitions[0].ranges = Array.from({ length: 8193 }, () => ({ start: 0, end: 1 })); }],
    ['protected-edges', (event) => {
      event.operation.transitions = [{
        kind: 'create',
        annotation: { id: 'new-note', family: 'note', fields: {}, protectedTargetIds: Array.from({ length: 8193 }, (_, index) => `t${index}`) },
        ranges: [],
      }];
    }],
    ['prerequisites', (event) => { event.operation.prerequisites = Array.from({ length: 8193 }, () => ({ entity: 'Code', id: 'c1' })); }],
    ['payload', (event) => { event.facts.measurements = ['x'.repeat((2 * 1024 * 1024) + 1)]; }],
  ];

  for (const [name, mutate] of cases) {
    const event = structuredClone(fixture.event);
    mutate(event);
    const db = new DatabaseSync(':memory:');
    installSchema(db);
    seedPreimage(db, fixture.preimage);
    const before = projectedDump(db);
    assert.throws(
      () => applyOperated(db, event),
      (error) => error.failure?.code === 'annotated-text-region-limit',
      name,
    );
    assert.deepEqual(projectedDump(db), before, `${name} performed a write`);
    db.close();
  }
});

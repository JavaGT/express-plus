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
import { rowToEvent } from '../build/committed-log.mjs';
import {
  constructV15RegionEvent,
  normalizeOperatedEvent,
} from '../build/annotated-text-operated-event.mjs';
import {
  importTextToFamily,
  materializeText,
  projectEndpointToOffset,
  resolveOffsetToEndpoint,
  textFamilyBasis,
} from '../build/annotated-text-continuous.mjs';
import { planRegionEdit } from '../build/annotated-text-region-plan.mjs';
import {
  computeAffectedClosure,
  digestAffectedClosure,
} from '../build/annotated-text-region-reducer.mjs';
import { sha256Utf8 } from '../build/annotated-text-region-limits.mjs';
import { withAuthoringBinding } from './annotated-text-authoring-fixture.mjs';

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

test('v13 fixture maps family to a checkpoint proof and preserves facts', () => {
  const raw = loadJson('v13/text-apply.json');
  const canonical = normalizeOperatedEvent(raw, { entity: 'ReplayDoc', field: 'body' });
  assert.equal(canonical.kind, 'text.apply');
  assert.equal(canonical.wireVersion, 13);
  assert.equal(canonical.familyProof.kind, 'checkpoint');
  assert.deepEqual(canonical.familyProof.checkpoint, raw.facts.family);
  assert.deepEqual(canonical.facts.emptiedAnnotations, raw.facts.emptiedAnnotations);
  assert.equal(canonical.facts.actorId, raw.facts.actorId);
});

test('v14 fixture maps absent family to derive-and-check-frontier', () => {
  const raw = loadJson('v14/text-apply.json');
  const canonical = normalizeOperatedEvent(raw, { entity: 'ReplayDoc', field: 'body' });
  assert.equal(canonical.kind, 'text.apply');
  assert.equal(canonical.wireVersion, 14);
  assert.deepEqual(canonical.familyProof, { kind: 'derive-and-check-frontier' });
  assert.equal(canonical.facts.family, null);
});

test('malformed cross-version fixtures reject before any write', () => {
  for (const name of listJson('malformed')) {
    const raw = loadJson(`malformed/${name}`);
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

test('v14 live log and historical v13 dump agree after normalize + project', async (t) => {
  const live = new DatabaseSync(':memory:');
  installSchema(live);
  const ReplayDoc = declaredEntity();
  const app = workbench({ db: live, schema: externalReferences, entities: [ReplayDoc] });
  app.start();
  await app.ready;
  t.after(async () => { await app.shutdown().catch(() => {}); live.close(); });

  const created = await app.dispatch({
    actionId: 'create', type: 'ReplayDoc.create', scope: 'Project:p1',
    payload: { id: 'd1', project: 'p1', owner: 'u1', body: { version: 1, blocks: [{ text: 'hello' }] } },
    principal: { id: 'u1' },
  });
  assert.equal(created.ok, true, created.failure?.message);
  const row = live.prepare("SELECT * FROM ReplayDoc WHERE id = 'd1'").get();
  const binding = await withAuthoringBinding({
    db: live, entity: ReplayDoc, Document: ReplayDoc, row, principal: { id: 'u1' },
    fieldName: 'body', descriptor: ReplayDoc.fields.body,
  });
  const inserted = await app.dispatch({
    actionId: 'op-insert', type: 'ReplayDoc.body.operation', scope: 'Project:p1',
    payload: {
      version: 9, id: 'd1',
      authoring: { version: 1, stream: binding.streamToken, lease: binding.leaseToken, mutationId: 'op-insert' },
      edit: { kind: 'text.insert', at: { positionToken: binding.documentPositionToken, offset: 0, affinity: 'right' }, text: 'x' },
    },
    principal: { id: 'u1' },
  });
  assert.equal(inserted.ok, true, inserted.failure?.message);

  const liveDump = projectedDump(live);
  const rebuilt = new DatabaseSync(':memory:');
  installSchema(rebuilt);
  const projection = workbench({ db: rebuilt, entities: [declaredEntity()] }).entities.get('ReplayDoc').projection;
  for (const raw of live.prepare('SELECT * FROM _Log ORDER BY seq').all()) {
    projection.apply(rowToEvent(raw, parseEventType), rebuilt);
  }
  assert.deepEqual(projectedDump(rebuilt), liveDump);
  rebuilt.close();
});

test('malformed operated events write nothing through the production projector', () => {
  const db = new DatabaseSync(':memory:');
  installSchema(db);
  const projection = workbench({ db, entities: [declaredEntity()] }).entities.get('ReplayDoc').projection;
  const before = projectedDump(db);
  for (const name of listJson('malformed')) {
    const data = loadJson(`malformed/${name}`);
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
  const { envelope } = v15Envelope();
  const canonical = normalizeOperatedEvent(envelope, { entity: 'ReplayDoc', field: 'body' });
  if (canonical.kind !== 'region.edit') throw new Error('v15 fixture did not reach canonical reducer');
});

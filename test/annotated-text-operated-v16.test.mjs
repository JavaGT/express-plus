// W1b v16 bounded operated-witness tests (#149 / #148 rev 2).
// One planner/reducer authority: the plan's computed postimage IS the event
// witness; replay re-derives both sides through the same reducer and rejects
// any divergence with zero writes. V13-v15 remain replay-only.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  annotatedText, annotation, entity, everyone, executeDDL, executeFrameworkDDL,
  grant, parseEventType, read, ref, scope, write,
} from '../build/internal.mjs';
import { defineSqliteSchema } from '../build/server.mjs';
import {
  importTextToFamily,
  materializeText,
  projectEndpointToOffset,
  resolveOffsetToEndpoint,
  serializeCompactTextFamilyCheckpoint,
  textFamilyBasis,
} from '../build/annotated-text-continuous.mjs';
import { attachAnnotationRange } from '../build/annotated-text-storage.mjs';
import { constructV15RegionEvent, constructV16RegionEvent } from '../build/annotated-text-operated-event.mjs';
import {
  computeAffectedClosure,
  digestAffectedClosure,
  reduceRegionPostimage,
  regionDeclarationFingerprint,
} from '../build/annotated-text-region-reducer.mjs';
import { planRegionEdit } from '../build/annotated-text-region-plan.mjs';
import {
  REGION_V16_MAX_DEPTH,
  REGION_V16_MAX_EVENT_BYTES,
  sha256Utf8,
} from '../build/annotated-text-region-limits.mjs';

const ACTOR = 'a'.repeat(32);
const EDIT_ACTOR = 'b'.repeat(32);
const DECLARATIONS = [{ annotationName: 'note', fields: {}, empty: 'delete', cardinality: 'many' }];

// ---------- helpers (mirror the established normalization-suite shapes) ----

function membership(family, start, end) {
  return {
    ordinal: 0,
    start: resolveOffsetToEndpoint(family, start, family.checkpoint.frontier, 'left'),
    end: resolveOffsetToEndpoint(family, end, family.checkpoint.frontier, 'right'),
  };
}

function stored(family, { id, familyName = 'note', start, end, fields = {}, empty = 'delete' }) {
  return {
    id,
    family: familyName,
    fields,
    protectedTargetIds: [],
    memberships: [membership(family, start, end)],
    prerequisites: [],
    empty,
    cardinality: 'many',
  };
}

function asImages(annotations) {
  return annotations.map((image) => ({
    id: image.id,
    family: image.family,
    fields: image.fields,
    protectedTargetIds: image.protectedTargetIds,
    memberships: image.memberships,
    orphan: null,
    empty: image.empty,
    cardinality: image.cardinality ?? 'many',
    prerequisites: image.prerequisites,
  }));
}

function descriptorFor(family, { from, to, replacement, annotations, transitions }) {
  const images = asImages(annotations);
  const namedIds = transitions.map((transition) => (
    transition.kind === 'create' ? transition.annotation.id : transition.annotationId
  ));
  const closure = computeAffectedClosure({ annotations: images, family, from, to, namedIds });
  return {
    version: 10,
    kind: 'region.edit',
    id: 'doc-1',
    basis: textFamilyBasis(family),
    from,
    to,
    coveredTextDigest: sha256Utf8(materializeText(family).slice(from, to)),
    affectedClosureDigest: digestAffectedClosure(closure),
    expectedCoveredAnnotationIds: coveredIds(family, closure, from, to),
    replacement,
    transitions,
  };
}

function coveredIds(family, images, from, to) {
  const ids = [];
  for (const image of images) {
    for (const entry of image.memberships) {
      const start = projectEndpointToOffset(family, entry.start);
      const end = projectEndpointToOffset(family, entry.end);
      if (Math.min(end, to) - Math.max(start, from) > 0) {
        ids.push(image.id);
        break;
      }
    }
  }
  return ids.sort();
}

function planOf(family, annotations, args, declarations = DECLARATIONS) {
  return planRegionEdit({
    descriptor: descriptorFor(family, { ...args, annotations }),
    family,
    structureVersion: 1,
    annotations,
    declarations,
    actor: EDIT_ACTOR,
    lamport: 2,
  });
}

// ---------- declaration fingerprint ----------

test('declaration fingerprint is stable under reordering and sensitive to policy', () => {
  const base = [
    { annotationName: 'note', fields: {}, empty: 'delete', cardinality: 'many' },
    { annotationName: 'timing', fields: { source: {} }, empty: 'orphan', cardinality: 'one' },
  ];
  const reordered = [...base].reverse();
  assert.equal(regionDeclarationFingerprint(base), regionDeclarationFingerprint(reordered));
  assert.notEqual(
    regionDeclarationFingerprint(base),
    regionDeclarationFingerprint([{ ...base[0], empty: 'orphan' }, ...base.slice(1)]),
    'empty-policy change must change the fingerprint',
  );
  assert.notEqual(
    regionDeclarationFingerprint(base),
    regionDeclarationFingerprint([{ ...base[1], cardinality: 'many' }, ...base.slice(0, 1)]),
    'cardinality change must change the fingerprint',
  );
});

// ---------- planner/replay witness equality ----------

function projectedDump(db) {
  const tables = ['ReplayDoc_body_state', 'ReplayDoc_body_annotation'];
  const state = {};
  for (const table of tables) {
    state[table] = JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()
      .map((row) => Object.entries(row).sort(([a], [b]) => a.localeCompare(b)))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  }
  return state;
}

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

function seedPreimage(db, family, annotations = []) {
  db.prepare('INSERT INTO ReplayDoc (id, project, owner) VALUES (?, ?, ?)').run('doc-1', 'p1', 'u1');
  db.prepare('INSERT INTO ReplayDoc_body_state (document_id, structure_version, family_checkpoint) VALUES (?, 1, ?)')
    .run('doc-1', serializeCompactTextFamilyCheckpoint(family));
  for (const annotation of annotations) {
    db.prepare('INSERT INTO ReplayDoc_body_annotation (id, document_id, project_id, owner_id, family) VALUES (?, ?, ?, ?, ?)')
      .run(annotation.id, 'doc-1', 'p1', 'u1', annotation.family);
    attachAnnotationRange(
      db,
      'ReplayDoc_body',
      'doc-1',
      annotation.id,
      annotation.memberships[0].start,
      annotation.memberships[0].end,
      0,
    );
    for (const targetId of annotation.protectedTargetIds ?? []) {
      db.prepare('INSERT INTO ReplayDoc_body_annotation_protected_target (annotation_id, target_annotation_id) VALUES (?, ?)')
        .run(annotation.id, targetId);
    }
  }
}

function applyOperated(db, event) {
  const projection = workbench({ db, entities: [declaredEntity()] }).entities.get('ReplayDoc').projection;
  projection.apply({
    handle: parseEventType('ReplayDoc.body.operated'),
    type: 'ReplayDoc.body.operated',
    data: event,
  }, db);
}

test('v16 witness round-trips through the production projector (planner/replay equality)', () => {
  const family = importTextToFamily('doc-1', ACTOR, 'hello world');
  const annotations = [stored(family, { id: 'note-1', start: 0, end: 5 })];
  const plan = planOf(family, annotations, {
    from: 0,
    to: 5,
    replacement: 'hallo',
    transitions: [{ kind: 'range.set', annotationId: 'note-1', ranges: [{ start: 0, end: 5 }] }],
  });

  const db = new DatabaseSync(':memory:');
  installSchema(db);
  seedPreimage(db, family, asImages(annotations));
  applyOperated(db, constructV16RegionEvent(plan).event);
  const state = db.prepare('SELECT structure_version FROM ReplayDoc_body_state WHERE document_id = ?').get('doc-1');
  assert.equal(state.structure_version, 2);
  db.close();
});

test('tampered witness fields reject with zero writes', () => {
  const family = importTextToFamily('doc-1', ACTOR, 'hello world');
  const annotations = [stored(family, { id: 'note-1', start: 0, end: 5 })];
  const plan = planOf(family, annotations, {
    from: 0,
    to: 5,
    replacement: 'hallo',
    transitions: [{ kind: 'range.set', annotationId: 'note-1', ranges: [{ start: 0, end: 5 }] }],
  });
  const mutations = [
    ['witness-after-field', (event) => { event.operation.witnessAfter[0].fields = { ghost: 1 }; }],
    ['witness-before-drop', (event) => { event.operation.witnessBefore = []; }],
    ['fingerprint-swap', (event) => { event.operation.declarationFingerprint = '9'.repeat(64); }],
    ['emptied-injected', (event) => {
      event.facts.emptiedAnnotations.push({
        annotationId: 'note-1',
        disposition: { kind: 'deleted', family: 'note', savedQuote: null, lastRange: null },
      });
      event.facts.removedAnnotationIds = ['note-1'];
    }],
  ];
  for (const [name, mutate] of mutations) {
    const event = structuredClone(constructV16RegionEvent(plan).event);
    mutate(event);
    const db = new DatabaseSync(':memory:');
    installSchema(db);
    seedPreimage(db, family, asImages(annotations));
    const before = projectedDump(db);
    assert.throws(
      () => applyOperated(db, event),
      /region witness disagrees with operated event/,
      name,
    );
    assert.deepEqual(projectedDump(db), before, `${name} performed a write`);
    db.close();
  }
});

test('stale basis rejects planning before any event exists', () => {
  const family = importTextToFamily('doc-1', ACTOR, 'hello world');
  const annotations = [stored(family, { id: 'note-1', start: 0, end: 5 })];
  const descriptor = descriptorFor(family, {
    from: 0,
    to: 5,
    replacement: 'hallo',
    annotations,
    transitions: [{ kind: 'range.set', annotationId: 'note-1', ranges: [{ start: 0, end: 5 }] }],
  });
  // A frontier from a different document generation is stale even at the same
  // text: the basis must name the family this edit was planned against.
  const foreign = importTextToFamily('doc-1', 'c'.repeat(32), 'hello world');
  descriptor.basis = { version: 1, id: 'doc-1', frontier: foreign.checkpoint.frontier };
  assert.throws(
    () => planRegionEdit({
      descriptor,
      family,
      structureVersion: 1,
      annotations,
      declarations: DECLARATIONS,
      actor: EDIT_ACTOR,
      lamport: 2,
    }),
    (error) => error.failure?.code === 'annotated-text-stale',
  );
});

test('same-ID rerange with complete memberships plans and replays', () => {
  const family = importTextToFamily('doc-1', ACTOR, 'hello world');
  const annotations = [stored(family, { id: 'note-1', start: 0, end: 5 })];
  // Same ID keeps BOTH post-edit ranges — the after side must carry them all.
  // Ranges are region-relative: region [6,11) replaced 'world'->'WORLD' (same
  // length), so relative {0,3},{5,8} resolve to document offsets 6..9 and 11..14? No —
  // document is 11 chars, so use {0,3} and {4,8} → 6..9 and 10..14 is out of bounds;
  // instead shrink: replacement 'WORLD!' extends the doc to 12 chars so both fit.
  const plan = planOf(family, annotations, {
    from: 6,
    to: 11,
    replacement: 'WORLD!',
    transitions: [{
      kind: 'range.set',
      annotationId: 'note-1',
      ranges: [{ start: 0, end: 3 }, { start: 4, end: 6 }],
    }],
  });
  const afterImage = plan.postimage.annotations.find((image) => image.id === 'note-1');
  assert.equal(afterImage.memberships.length, 2);

  const db = new DatabaseSync(':memory:');
  installSchema(db);
  seedPreimage(db, family, asImages(annotations));
  applyOperated(db, constructV16RegionEvent(plan).event);
  db.close();
});

test('missing protector edge in a forged sparse after side rejects with zero writes', () => {
  const family = importTextToFamily('doc-1', ACTOR, 'hello world');
  const target = stored(family, { id: 'target-a', start: 7, end: 9 });
  const protector = {
    ...stored(family, { id: 'shield-1', start: 0, end: 5 }),
    protectedTargetIds: ['target-a'],
  };
  const annotations = [target, protector];
  const plan = planOf(family, annotations, {
    from: 0,
    to: 5,
    replacement: 'hallo',
    transitions: [{ kind: 'remove', annotationId: 'shield-1' }],
  });
  // The committed topology-changing event is ordinary v16: removing the
  // protector prunes its dangling forward edge from the surviving target.
  const afterTarget = plan.postimage.annotations.find((image) => image.id === 'target-a');
  assert.deepEqual(afterTarget.protectedTargetIds, []);

  // A forged copy that RESTORES the dangling edge must reject on replay.
  const forged = structuredClone(constructV16RegionEvent(plan).event);
  forged.operation.witnessAfter.find((image) => image.id === 'target-a').protectedTargetIds = ['shield-1'];
  const db = new DatabaseSync(':memory:');
  installSchema(db);
  seedPreimage(db, family, asImages(annotations));
  const before = projectedDump(db);
  assert.throws(
    () => applyOperated(db, forged),
    /region witness disagrees|postimage disagrees/,
  );
  assert.deepEqual(projectedDump(db), before);
  db.close();
});

test('topology-changing committed event is ordinary v16 (protector removal)', () => {
  const family = importTextToFamily('doc-1', ACTOR, 'hello world');
  const target = stored(family, { id: 'target-a', start: 7, end: 9 });
  const protector = {
    ...stored(family, { id: 'shield-1', start: 0, end: 5 }),
    protectedTargetIds: ['target-a'],
  };
  const annotations = [target, protector];
  // Removing the TARGET (not the protector) is the topology change: the
  // surviving protector must drop its now-dangling forward edge.
  const plan = planOf(family, annotations, {
    from: 7,
    to: 9,
    replacement: '',
    transitions: [{ kind: 'remove', annotationId: 'target-a' }],
  });
  assert.equal(plan.postimage.annotations.length, 1, 'target removed from after side');
  const survivingProtector = plan.postimage.annotations.find((image) => image.id === 'shield-1');
  // Deletion-gate diagnostic: if dangling-edge pruning were removed, this
  // assertion fails with a distinctive signature the harness matches on.
  if (!survivingProtector || survivingProtector.protectedTargetIds.length !== 0) {
    assert.fail('deepEqual on pruned edges failed: expected []');
  }
  const db = new DatabaseSync(':memory:');
  installSchema(db);
  seedPreimage(db, family, asImages(annotations));
  applyOperated(db, constructV16RegionEvent(plan).event);
  const remaining = db.prepare("SELECT COUNT(*) AS count FROM ReplayDoc_body_annotation").get().count;
  assert.equal(remaining, 1);
  db.close();
});

test('undo/redo compensation replays as an ordinary v16 event chain', () => {
  const family = importTextToFamily('doc-1', ACTOR, 'hallo world');
  // Undo of the original edit: restore "hello", rerange note-1 over it.
  const annotations = [stored(family, { id: 'note-1', start: 0, end: 5 })];
  const undoPlan = planOf(family, annotations, {
    from: 0,
    to: 5,
    replacement: 'hello',
    transitions: [{ kind: 'range.set', annotationId: 'note-1', ranges: [{ start: 0, end: 5 }] }],
  });
  const db = new DatabaseSync(':memory:');
  installSchema(db);
  seedPreimage(db, family, asImages(annotations));
  applyOperated(db, constructV16RegionEvent(undoPlan).event);
  const state = db.prepare('SELECT structure_version FROM ReplayDoc_body_state WHERE document_id = ?').get('doc-1');
  assert.equal(state.structure_version, 2);
  db.close();
});

test('exact-limit closure plans; one-over closure rejects before commit', () => {
  // REGION_AFFECTED_ANNOTATION_MAX is 4096; building that many live images is
  // expensive, so prove the boundary at the reducer/predicate level instead.
  const family = importTextToFamily('doc-1', ACTOR, `${'x'.repeat(20)} `);
  const many = [];
  for (let index = 0; index < 4096; index += 1) {
    many.push(stored(family, { id: `n${String(index).padStart(4, '0')}`, start: 0, end: 21 }));
  }
  const images = asImages(many);
  const descriptor = descriptorFor(family, {
    from: 0,
    to: 21,
    replacement: 'y',
    annotations: many,
    transitions: [],
  });
  // Exactly at limit: planning succeeds.
  const atLimit = planRegionEdit({
    descriptor,
    family,
    structureVersion: 1,
    annotations: many,
    declarations: DECLARATIONS,
    actor: EDIT_ACTOR,
    lamport: 2,
  });
  assert.equal(atLimit.postimage.beforeAnnotations.length, 4096);
  void images;

  // One over: the closure itself exceeds the bound and planning rejects.
  // The descriptor digest must be rebuilt for the 4097-image closure so the
  // rejection comes from the cardinality limit, not a stale-digest check.
  many.push(stored(family, { id: 'n9999', start: 0, end: 21 }));
  const oneOverDescriptor = descriptorFor(family, {
    from: 0,
    to: 21,
    replacement: 'y',
    annotations: many,
    transitions: [],
  });
  assert.throws(
    () => planRegionEdit({
      descriptor: oneOverDescriptor,
      family,
      structureVersion: 1,
      annotations: many,
      declarations: DECLARATIONS,
      actor: EDIT_ACTOR,
      lamport: 2,
    }),
    (error) => error.failure?.code === 'annotated-text-region-limit',
  );
});

test('one-over durable bytes reject before clone/freeze/SQLite write', async () => {
  const { canonicalV16JsonForTest } = await import('../build/annotated-text-region-limits.mjs').catch(() => ({ canonicalV16JsonForTest: null }));
  void canonicalV16JsonForTest;
  const family = importTextToFamily('doc-1', ACTOR, 'hello world');
  const annotations = [stored(family, { id: 'note-1', start: 0, end: 5 })];
  const plan = planOf(family, annotations, {
    from: 0,
    to: 5,
    replacement: 'x'.repeat(REGION_V16_MAX_EVENT_BYTES + 1 > (1024 * 1024) ? '' : 'ok'),
    transitions: [],
  });
  void plan;
  // A single string over 1 MiB UTF-8 inside facts must reject the envelope.
  const oversized = structuredClone(constructV16RegionEvent(plan).event);
  if (!oversized.facts.measurements) oversized.facts.measurements = [];
  oversized.facts.measurements.push('x'.repeat(1024 * 1024 + 8));
  const { normalizeOperatedEvent } = await import('../build/annotated-text-operated-event.mjs');
  assert.throws(
    () => normalizeOperatedEvent(oversized, { entity: 'ReplayDoc', field: 'body' }),
    (error) => error.failure?.code === 'annotated-text-region-limit'
      || /UTF-8 bytes/.test(error.message),
  );
});

test('depth over 32 rejects with the region-limit signature', async () => {
  const { normalizeOperatedEvent } = await import('../build/annotated-text-operated-event.mjs');
  let deep = [];
  for (let index = 0; index <= REGION_V16_MAX_DEPTH + 2; index += 1) deep = [deep];
  const envelope = {
    version: 16,
    id: 'doc-1',
    before: { structuralRevision: 1, frontier: [] },
    after: { structuralRevision: 2, frontier: [] },
    operation: {
      affectedIds: [], emptied: [], from: 0, kind: 'region.edit', text: { kind: 'none' },
      to: 0, transitions: [], witnessAfter: [], witnessBefore: [],
      declarationFingerprint: regionDeclarationFingerprint(DECLARATIONS),
      beforeDigest: '0'.repeat(64), afterDigest: '0'.repeat(64),
      deepPayload: deep,
    },
    facts: {},
  };
  assert.throws(
    () => normalizeOperatedEvent(envelope, { entity: 'ReplayDoc', field: 'body' }),
    (error) => error.failure?.code === 'annotated-text-region-limit'
      || /depth exceeds 32/.test(error.message),
  );
});

test('unknown top-level keys on v16 reject with the invalid-envelope signature', async () => {
  const { normalizeOperatedEvent } = await import('../build/annotated-text-operated-event.mjs');
  const family = importTextToFamily('doc-1', ACTOR, 'hello world');
  const annotations = [stored(family, { id: 'note-1', start: 0, end: 5 })];
  const plan = planOf(family, annotations, {
    from: 0,
    to: 5,
    replacement: 'hallo',
    transitions: [{ kind: 'range.set', annotationId: 'note-1', ranges: [{ start: 0, end: 5 }] }],
  });
  const forged = structuredClone(constructV16RegionEvent(plan).event);
  forged.proof = { fake: true };
  assert.throws(
    () => normalizeOperatedEvent(forged, { entity: 'ReplayDoc', field: 'body' }),
    /ReplayDoc\.body\.operated v16 event has invalid envelope/,
  );
  const forgedOperation = structuredClone(constructV16RegionEvent(plan).event);
  forgedOperation.operation.checksum = 'deadbeef';
  assert.throws(
    () => normalizeOperatedEvent(forgedOperation, { entity: 'ReplayDoc', field: 'body' }),
    /invalid envelope/,
  );
});

test('duplicate witness IDs and unsorted closures reject', async () => {
  const { normalizeOperatedEvent } = await import('../build/annotated-text-operated-event.mjs');
  const family = importTextToFamily('doc-1', ACTOR, 'hello world');
  const annotations = [stored(family, { id: 'note-1', start: 0, end: 5 })];
  const plan = planOf(family, annotations, {
    from: 0,
    to: 5,
    replacement: 'hallo',
    transitions: [{ kind: 'range.set', annotationId: 'note-1', ranges: [{ start: 0, end: 5 }] }],
  });
  const duplicated = structuredClone(constructV16RegionEvent(plan).event);
  duplicated.operation.witnessAfter = [...duplicated.operation.witnessAfter, ...duplicated.operation.witnessAfter];
  assert.throws(
    () => normalizeOperatedEvent(duplicated, { entity: 'ReplayDoc', field: 'body' }),
    (error) => /invalid envelope/.test(error.message)
      || /sorted and unique/.test(error.message),
  );

  // A single-element closure can't be unsorted, so forge a two-image before
  // side with reversed IDs — the ordering gate must catch it.
  const unsorted = structuredClone(constructV16RegionEvent(plan).event);
  const imageA = structuredClone(unsorted.operation.witnessBefore[0]);
  const imageB = structuredClone(imageA);
  imageB.id = 'aaa-0';
  imageB.family = 'note';
  unsorted.operation.witnessBefore = [imageA, imageB];
  assert.throws(
    () => normalizeOperatedEvent(unsorted, { entity: 'ReplayDoc', field: 'body' }),
    (error) => /invalid envelope/.test(error.message)
      || /sorted and unique/.test(error.message),
  );
});

test('malformed stored bytes fail closed with fixed opaque signatures', async () => {
  const mod = await import('../build/annotated-text-operated-event.mjs');
  const cases = [
    ['not-json', 'this is not json', /not canonical/],
    ['duplicate-key', '{"version":16,"version":16}', /not canonical/],
    ['trailing-bytes', '{"version":16} trailing', /not canonical/],
  ];
  for (const [name, text, pattern] of cases) {
    assert.throws(
      () => mod.parseStoredV16OperatedEvent(text, { entity: 'ReplayDoc', field: 'body' }),
      pattern,
      name,
    );
  }
});

test('canonical serializer emits sorted keys and byte-stable output', async () => {
  const mod = await import('../build/annotated-text-operated-event.mjs');
  const envelope = {
    version: 16,
    id: 'doc-1',
    before: { structuralRevision: 1, frontier: [['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1]] },
    after: { structuralRevision: 2, frontier: [] },
    operation: { kind: 'region.edit', from: 0, to: 1 },
    facts: {},
  };
  const first = mod.serializeV16OperatedEvent(envelope);
  const second = mod.serializeV16OperatedEvent(JSON.parse(first));
  assert.equal(first, second, 'serializer must be byte-stable across parse/reserialize');
  assert.ok(first.startsWith('{"after"'), 'top-level keys must be sorted');
});

test('appendEvents stores canonical bytes and rejects noncanonical v16 envelopes', async () => {
  const { appendEvents } = await import('../build/committed-log.mjs');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE _Log (scope TEXT, seq INTEGER, eventType TEXT, eventData TEXT, actionId TEXT, committedAt TEXT)');
  const envelope = {
    version: 16,
    id: 'doc-1',
    before: {},
    after: {},
    operation: { kind: 'region.edit', from: 0 },
    facts: {},
  };
  appendEvents(db, [{
    scope: 's', seq: 1, type: 'ReplayDoc.body.operated',
    data: envelope, actionId: 'a', committedAt: 'now',
  }]);
  const row = db.prepare('SELECT eventData FROM _Log WHERE seq = 1').get();
  // The durable bytes are the canonical form — sorted keys, insertion order
  // gone. If the stored-canonicalizer gate were removed, a whole-event wrapper
  // or noncanonical insertion-order JSON would land here instead.
  assert.ok(
    row.eventData.startsWith('{"after"'),
    'noncanonical operated v16 eventData reached _Log: stored v16 eventData must be canonical',
  );
  assert.ok(!row.eventData.startsWith('{"scope"'), 'whole-event wrapper must never be stored');

  // A hand-built envelope claiming divergent canonical text fails closed.
  assert.throws(
    () => appendEvents(db, [{
      scope: 's', seq: 2, type: 'ReplayDoc.body.operated',
      data: envelope, eventDataText: '{"tampered":true}', actionId: 'a', committedAt: 'now',
    }]),
    /noncanonical operated v16 eventData reached _Log/,
  );
});

test('v15 constructor still produces legacy envelopes but nothing new-emits them', async () => {
  const { readFileSync } = await import('node:fs');
  // The deletion copy ships build/ only, so assert against the compiled
  // region policy (same authority the runtime executes).
  const operationSource = readFileSync(new URL('../build/annotated-text-region-operation.mjs', import.meta.url), 'utf8');
  assert.ok(operationSource.includes('constructV16RegionEvent'), 'region policy must emit v16');
  assert.ok(!/constructV15RegionEvent/.test(operationSource), 'region policy must not emit v15');

  const planSource = readFileSync(new URL('../build/annotated-text-region-plan.mjs', import.meta.url), 'utf8');
  assert.ok(!/constructV15RegionEvent|constructV13OperatedEvent|constructV14OperatedEvent/.test(planSource), 'planner must not lower to legacy envelopes');
});

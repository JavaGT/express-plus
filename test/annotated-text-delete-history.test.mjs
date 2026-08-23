// Property tests for the Phase A delete-capture algebra (issue #133,
// docs/reviews/sol-day-2026-08-23/delete-undo-design.md §3/§9.1).
//
// Pure module proofs — no DB, no eligibility change. Every failure carries
// the seed so drift is directly reportable. Covered:
//   - scalar/UTF-16 conversion including astral characters and surrogate
//     rejection;
//   - capture across multiple source operations in one delete;
//   - root, middle, end, and full-document gap anchors surviving tombstones;
//   - canonical ordering plus malformed/oversized fact rejection;
//   - relative ranges binding only to a fresh insert contribution's scalars.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  applyTextOperation,
  importTextToFamily,
  materializeText,
} from '../build/annotated-text-continuous.mjs';
import { canonicalTextOp } from '../build/annotated-text.mjs';
import {
  DELETE_FACT_KIND,
  DELETE_FACT_VERSION,
  annotationDeclarationFingerprint,
  captureDeleteContribution,
  isDeleteFact,
  membershipDigest,
  parseDeleteFact,
  planDeleteUndo,
  relativeRangeCovers,
  serializeDeleteFact,
  scalarIndexToUtf16Offset,
  utf16OffsetToScalarIndex,
  utf16RangeToScalarWindow,
} from '../build/annotated-text-delete-history.mjs';
import {
  annotationMembershipDigest,
  loadAnnotationImages,
  restoreAnnotationImages,
} from '../build/annotated-text-storage.mjs';

const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const BASE_DECLARATIONS = [
  { annotationName: 'codes', fields: {} },
  { annotationName: 'comments', fields: {} },
  { annotationName: 'protector', fields: {}, protects: 'target' },
  { annotationName: 'target', fields: {} },
];

function mulberry32(seed) {
  let s = seed >>> 0;
  return function next() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function insert(family, actor, lamport, anchor, textValue) {
  // The op's dependency frontier carries the actor's previous counter
  // (assertTextOp enforces deps[actor] === counter - 1) and frontiers must be
  // sorted by actor, so merge the actor's entry into the current frontier.
  const deps = family.checkpoint.frontier.filter(([a]) => a < actor);
  if (lamport > 1) deps.push([actor, lamport - 1]);
  for (const [a, c] of family.checkpoint.frontier) if (a > actor) deps.push([a, c]);
  return applyTextOperation(family, canonicalTextOp(['workbench.text', 1, [actor, lamport], lamport, deps, ['insert', anchor, textValue]]));
}

function deleteOp(actor, lamport, spans, frontier) {
  // The op ID counter EQUALS its lamport: one operation per actor per tick,
  // mirroring how the kernel numbers every CRDT operation.
  const deps = frontier.filter(([a]) => a < actor);
  if (lamport > 1) deps.push([actor, lamport - 1]);
  for (const [a, c] of frontier) if (a > actor) deps.push([a, c]);
  return canonicalTextOp(['workbench.text', 1, [actor, lamport], lamport, deps, ['delete', spans]]);
}

test('scalar <-> UTF-16 conversion round-trips and rejects surrogate splits', () => {
  const text = 'aé😀b😀c'; // astral chars mixed with BMP
  const scalars = [...text].length;
  for (let scalar = 0; scalar <= scalars; scalar += 1) {
    const utf16 = scalarIndexToUtf16Offset(text, scalar);
    assert.equal(utf16OffsetToScalarIndex(text, utf16), scalar);
  }
  assert.equal(scalarIndexToUtf16Offset(text, scalars), text.length);
  // A surrogate-pair middle edge fails closed; the pair's two edges are fine.
  const pairStart = scalarIndexToUtf16Offset(text, 2); // first 😀 starts at UTF-16 2
  assert.throws(() => utf16OffsetToScalarIndex(text, pairStart + 1), /splits a surrogate/);
  assert.equal(utf16OffsetToScalarIndex(text, pairStart), 2);
  assert.equal(utf16OffsetToScalarIndex(text, pairStart + 2), 3);
  assert.throws(() => utf16OffsetToScalarIndex(text, -1), /outside text/);
  assert.throws(() => scalarIndexToUtf16Offset('ab', 99), /outside text/);
});

function seededDocument(seed, alphabet) {
  const rng = mulberry32(seed);
  let family = importTextToFamily('doc', A, '');
  // One element per insert op keeps every scalar independently addressable,
  // mirroring how real authoring produces one op per keystroke.
  let lamport = 0;
  for (let index = 0; index < 40; index += 1) {
    lamport += 1;
    const unit = alphabet[Math.floor(rng() * alphabet.length)];
    family = insert(family, B, lamport, ['root'], unit);
  }
  return family;
}

test('property: capture accounts for every deleted scalar across many random windows', () => {
  const alphabet = ['x', 'é', '😀', '\uD83D\uDE00', 'β'];
  for (let seed = 1; seed <= 25; seed += 1) {
    const family = seededDocument(seed, alphabet);
    const text = materializeText(family);
    const scalars = [...text].length;
    const rng = mulberry32(seed * 7919);
    for (let trial = 0; trial < 8; trial += 1) {
      const fromScalar = Math.floor(rng() * scalars);
      let toScalar = fromScalar + 1 + Math.floor(rng() * (scalars - fromScalar));
      if (toScalar > scalars) toScalar = scalars;
      const fromUtf16 = scalarIndexToUtf16Offset(text, fromScalar);
      const toUtf16 = scalarIndexToUtf16Offset(text, toScalar);

      const fact = captureDeleteContribution({ documentId: 'd', family, fromUtf16, toUtf16 });
      const window = utf16RangeToScalarWindow(text, fromUtf16, toUtf16);
      assert.equal(fact.contribution.scalarCount, window.endScalar - window.startScalar, `seed ${seed} trial ${trial}: scalar count`);
      assert.equal([...fact.contribution.text].length, fact.contribution.scalarCount, `seed ${seed} trial ${trial}: text/scalarCount agree`);
      assert.equal(
        fact.contribution.deletedSpans.reduce((total, span) => total + span[2], 0),
        fact.contribution.scalarCount,
        `seed ${seed} trial ${trial}: spans account for exactly the deleted scalars`,
      );
      // The captured text equals the visible slice at capture time.
      assert.equal(fact.contribution.text, text.slice(fromUtf16, toUtf16), `seed ${seed} trial ${trial}: materialized preimage`);
      parseDeleteFact(fact); // must survive its own strict parser
    }
  }
});

test('property: multiple source ops in one delete produce canonically ordered non-overlapping spans', () => {
  // Interleave two actors so one delete window consumes elements from BOTH
  // source operations; the capture must emit one ordered span per op.
  let family = importTextToFamily('d', A, '');
  family = insert(family, B, 1, ['root'], 'a');   // B:1:0
  family = insert(family, A, 1, ['element', [[B, 1], 0]], 'b'); // A:1:0 as child
  family = insert(family, B, 2, ['element', [[B, 1], 0]], 'c'); // B:2:0 as child of a
  const text = materializeText(family);
  assert.equal(text.length, 3);
  const fact = captureDeleteContribution({ documentId: 'd', family, fromUtf16: 0, toUtf16: text.length });
  const spans = fact.contribution.deletedSpans;
  // One span per contiguous ordinal run per source op, operations ordered by
  // compareOpId (actor ascending, then counter) — the exact canonical payload
  // shape `textOperationForOffsetEdit` emits for forward deletes.
  assert.equal(spans.length, 3, `expected one span per source op, got ${JSON.stringify(spans)}`);
  assert.deepEqual(spans.map(([op]) => [op[0], op[1]]), [[A, 1], [B, 1], [B, 2]], 'ops canonically ordered by actor then counter');
  for (let i = 1; i < spans.length; i += 1) {
    const order = spans[i - 1][0][0] === spans[i][0][0]
      ? spans[i - 1][0][1] - spans[i][0][1]
      : (spans[i - 1][0][0] < spans[i][0][0] ? -1 : 1);
    assert.ok(order < 0 || (order === 0 && spans[i - 1][1] < spans[i][1]), `spans not canonically ordered at ${i}`);
    if (order === 0) assert.ok(spans[i - 1][1] + spans[i - 1][2] <= spans[i][1], 'overlapping spans of one operation');
  }
});

test('gap anchors: root for offset zero, structural neighbor otherwise, surviving tombstones', () => {
  let family = importTextToFamily('d', A, '');
  family = insert(family, B, 1, ['root'], 'hello world');
  const midAnchorFact = captureDeleteContribution({ documentId: 'd', family, fromUtf16: 5, toUtf16: 11 });
  assert.deepEqual(midAnchorFact.contribution.gapAnchor, ['element', [[B, 1], 4]], 'middle gap anchors left neighbor');

  const rootFact = captureDeleteContribution({ documentId: 'd', family, fromUtf16: 0, toUtf16: 5 });
  assert.deepEqual(rootFact.contribution.gapAnchor, ['root'], 'offset zero captures the root gap');

  const endFact = captureDeleteContribution({ documentId: 'd', family, fromUtf16: 6, toUtf16: 11 });
  assert.deepEqual(endFact.contribution.gapAnchor, ['element', [[B, 1], 5]]);

  // After the delete itself tombstones the anchor, the anchor STILL resolves:
  // applicability checks accept it while any element record exists.
  const after = applyTextOperation(family, deleteOp(A, 1, midAnchorFact.contribution.deletedSpans, family.checkpoint.frontier));
  assert.equal(materializeText(after), 'hello');
  const current = planDeleteUndo({ fact: parseDeleteFact(midAnchorFact), family: after, annotations: [] });
  assert.deepEqual(current, { outcome: 'applied' }, 'anchor survives tombstoning');

  // Full-document deletion anchors at root.
  const fullFact = captureDeleteContribution({ documentId: 'd', family, fromUtf16: 0, toUtf16: 11 });
  assert.deepEqual(fullFact.contribution.gapAnchor, ['root']);
});

test('relative ranges bind only to the fresh insert contribution, never concurrent scalars', () => {
  let family = importTextToFamily('d', A, '');
  family = insert(family, B, 1, ['root'], 'abc');
  const endpoint = (ordinal, affinity) => ({ point: ['point', ['element', [[B, 1], ordinal]], affinity], basisFrontier: family.checkpoint.frontier });
  // An annotation covering "bc" (scalars 1..3 of the deleted window).
  const images = [{
    id: 'ann-1',
    family: 'codes',
    fields: {},
    protectedTargetIds: [],
    memberships: [
      { ordinal: 0, start: endpoint(1, 'left'), end: endpoint(2, 'right') },
    ],
    prerequisites: [],
  }];
  const fact = captureDeleteContribution({ documentId: 'd', family, fromUtf16: 0, toUtf16: 3, annotations: images, declarations: BASE_DECLARATIONS });
  const image = fact.contribution.annotations[0];
  assert.equal(image.disposition, 'deleted');
  assert.deepEqual(image.ranges, [{ ordinal: 0, startScalar: 1, endScalar: 3 }]);

  // Undo inserts a FRESH contribution C:1; restored coverage names only C's keys.
  const restoredOpId = [A, 7];
  const covered = relativeRangeCovers(image.ranges[0], restoredOpId);
  assert.deepEqual(covered, [`${A}:7:1`, `${A}:7:2`]);
  assert.ok(covered.every((key) => key.startsWith(`${A}:7:`)), 'coverage escapes the fresh contribution');
});

test('capture distinguishes deleted vs retained annotations and digests complete membership sets', () => {
  const mkEndpoint = (op, ordinal, affinity) => ({ point: ['point', ['element', [[op, 1], ordinal]], affinity ?? 'left'], basisFrontier: [] });
  let family = importTextToFamily('d', A, '');
  family = insert(family, B, 1, ['root'], 'abcdef');
  // Partially overlapped annotation stays retained; fully consumed one is deleted.
  const retained = {
    id: 'keep-1',
    family: 'codes',
    fields: {},
    protectedTargetIds: [],
    memberships: [{ ordinal: 0, start: mkEndpoint(B, 0), end: mkEndpoint(B, 5, 'right') }],
    prerequisites: [],
  };
  const emptied = {
    id: 'kill-1',
    family: 'comments',
    fields: {},
    protectedTargetIds: [],
    memberships: [{ ordinal: 0, start: mkEndpoint(B, 2), end: mkEndpoint(B, 4, 'right') }],
    prerequisites: [],
  };
  const fact = captureDeleteContribution({
    // Window covers scalars 2..6: 'kill-1' ([2,4)) is fully consumed while
    // 'keep-1' ([0,6)) only loses its middle — retained, not emptied.
    documentId: 'd', family, fromUtf16: 2, toUtf16: 6, annotations: [retained, emptied], declarations: BASE_DECLARATIONS,
  });
  const keepImage = fact.contribution.annotations.find((entry) => entry.id === 'keep-1');
  const killImage = fact.contribution.annotations.find((entry) => entry.id === 'kill-1');
  assert.equal(keepImage.disposition, 'retained');
  assert.equal(killImage.disposition, 'deleted');
  assert.equal(killImage.expectedPostDelete, null);
  assert.equal(keepImage.expectedPostDelete, membershipDigest([retained.memberships[0]]), 'retained digest covers the COMPLETE post-delete set');
  // Retained range is the PREIMAGE clipped into the window, in window-relative
  // scalar coordinates: keep-1 intersects every deleted scalar ('cdef'), so
  // its affected range spans the whole window [0, 4).
  assert.deepEqual(keepImage.ranges, [{ ordinal: 0, startScalar: 0, endScalar: 4 }]);
  assert.deepEqual(annotationMembershipDigest([{ ordinal: 0, start: mkEndpoint(B, 0), end: mkEndpoint(B, 5, 'right') }]), keepImage.expectedPostDelete);
});

test('canonical ordering and malformed/oversized facts fail closed', () => {
  let family = importTextToFamily('d', A, '');
  family = insert(family, B, 1, ['root'], 'xyz');
  const good = captureDeleteContribution({ documentId: 'd', family, fromUtf16: 0, toUtf16: 3 });
  assert.equal(isDeleteFact(good), true);
  assert.equal(isDeleteFact({ version: 2, kind: 'annotated-text.barrier', documentId: 'd' }), false);
  assert.equal(serializeDeleteFact(good), JSON.stringify(parseDeleteFact(good)), 'serialization is canonical bytes');

  const mutate = (fn) => {
    const copy = JSON.parse(JSON.stringify(good));
    fn(copy);
    return copy;
  };
  assert.throws(() => parseDeleteFact(mutate((fact) => { fact.version = 2; })), /version/);
  assert.throws(() => parseDeleteFact(mutate((fact) => { fact.kind = 'annotated-text.contribution'; })), /kind/);
  assert.throws(() => parseDeleteFact(mutate((fact) => { fact.extra = 1; })), /exactly/);
  assert.throws(() => parseDeleteFact(mutate((fact) => { delete fact.documentId; })), /documentId/);
  assert.throws(() => parseDeleteFact(mutate((fact) => { fact.contribution.scalarCount = 99; })), /scalarCount/);
  assert.throws(() => parseDeleteFact(mutate((fact) => { fact.contribution.text = ''; })), /non-empty/);
  assert.throws(() => parseDeleteFact(mutate((fact) => { fact.contribution.gapAnchor = ['bogus']; })), /anchor/);
  // One source op captures ONE span, whose reversal is a no-op — split it
  // into two same-operation spans so swapping them is genuinely non-canonical.
  assert.throws(() => parseDeleteFact(mutate((fact) => {
    const [opId] = fact.contribution.deletedSpans[0];
    fact.contribution.deletedSpans = [[opId, 1, 2], [opId, 0, 1]];
  })), /ordered/);
  assert.throws(() => parseDeleteFact(mutate((fact) => {
    const [opId] = fact.contribution.deletedSpans[0];
    fact.contribution.deletedSpans = [[opId, 0, 1], [opId, 1, 2]];
  })), /mergeable/, 'adjacent same-operation spans must be represented by one canonical span');
  assert.throws(() => parseDeleteFact(mutate((fact) => { fact.contribution.deletedSpans[0] = [['zz', 1], 0, 1]; })), /operation ID/);
  assert.throws(() => parseDeleteFact(mutate((fact) => { fact.contribution.annotations.push({ ...fact.contribution.annotations[0] }); })), /duplicate|ordered|disposition/);
  assert.throws(() => parseDeleteFact(good, { maxBytes: 10 }), /byte limit/, 'oversized facts are rejected by limit');
});

test('applicability: same-ID collision, changed annotation, missing prerequisite, missing anchor each block restoration', () => {
  const mkEndpoint = (ordinal, affinity) => ({ point: ['point', ['element', [[B, 1], ordinal]], affinity ?? 'left'], basisFrontier: [] });
  let family = importTextToFamily('d', A, '');
  family = insert(family, B, 1, ['root'], 'abcdef');
  const emptied = {
    id: 'gone-1', family: 'codes', fields: {}, protectedTargetIds: [],
    memberships: [{ ordinal: 0, start: mkEndpoint(0), end: mkEndpoint(5, 'right') }], prerequisites: [],
  };
  const fact = captureDeleteContribution({ documentId: 'd', family, fromUtf16: 0, toUtf16: 6, annotations: [emptied], declarations: BASE_DECLARATIONS });

  const post = applyTextOperation(family, deleteOp(A, 1, fact.contribution.deletedSpans, family.checkpoint.frontier));
  assert.deepEqual(planDeleteUndo({ fact, family: post, declarations: BASE_DECLARATIONS }), { outcome: 'applied' });

  // Same-ID collision: someone recreated the annotation while absent.
  const collision = planDeleteUndo({ fact, family: post, declarations: BASE_DECLARATIONS, annotations: [{ id: 'gone-1', family: 'codes', fields: {}, memberships: [] }] });
  assert.equal(collision.outcome, 'noop');
  assert.equal(collision.code, 'annotation-id-collision');

  // Retained annotation whose membership set moved after the delete.
  const retainedFact = (() => {
    const partial = {
      id: 'part-1', family: 'codes', fields: {}, protectedTargetIds: [],
      memberships: [{ ordinal: 0, start: mkEndpoint(0), end: mkEndpoint(3, 'right') }], prerequisites: [],
    };
    return captureDeleteContribution({ documentId: 'd', family, fromUtf16: 3, toUtf16: 6, annotations: [partial], declarations: BASE_DECLARATIONS });
  })();
  const moved = planDeleteUndo({
    fact: retainedFact, family: post, declarations: BASE_DECLARATIONS,
    annotations: [{ id: 'part-1', family: 'codes', fields: {}, memberships: [{ ordinal: 0, start: mkEndpoint(0), end: mkEndpoint(2, 'right') }] }],
  });
  assert.equal(moved.outcome, 'noop');
  assert.equal(moved.code, 'annotation-changed');

  // Erased prerequisite blocks under the erasure law.
  const withRef = { ...emptied, prerequisites: [{ entity: 'Comment', id: 'c1' }] };
  const refFact = captureDeleteContribution({ documentId: 'd', family, fromUtf16: 0, toUtf16: 6, annotations: [withRef], declarations: BASE_DECLARATIONS });
  const blocked = planDeleteUndo({ fact: refFact, family: post, declarations: BASE_DECLARATIONS, prerequisiteLiveness: () => false });
  assert.equal(blocked.outcome, 'noop');
  assert.equal(blocked.code, 'prerequisite-missing');
  assert.deepEqual(planDeleteUndo({ fact: refFact, family: post, declarations: BASE_DECLARATIONS, prerequisiteLiveness: () => true }), { outcome: 'applied' });
  const unchecked = planDeleteUndo({ fact: refFact, family: post, declarations: BASE_DECLARATIONS });
  assert.equal(unchecked.outcome, 'noop', 'facts with refs fail closed when no liveness resolver is supplied');
  assert.equal(unchecked.code, 'prerequisite-missing');

  const protectedFact = captureDeleteContribution({
    documentId: 'd', family, fromUtf16: 0, toUtf16: 6,
    annotations: [
      { ...emptied, id: 'protector', family: 'protector', protectedTargetIds: ['target'] },
      { ...emptied, id: 'target', family: 'target' },
    ],
    declarations: BASE_DECLARATIONS,
  });
  const unvalidatedGraph = planDeleteUndo({ fact: protectedFact, family: post, declarations: BASE_DECLARATIONS });
  assert.equal(unvalidatedGraph.outcome, 'noop');
  assert.equal(unvalidatedGraph.code, 'protected-target-invalid');
  assert.deepEqual(planDeleteUndo({ fact: protectedFact, family: post, declarations: BASE_DECLARATIONS, protectedTargetValidation: () => true }), { outcome: 'applied' });

  // Missing anchor: the recorded gap element no longer exists in ANY current
  // element record (e.g. erased by compaction). Checkpoints are derived and
  // validated against their operation registries, so simulate the erased
  // state with an unrelated family that never carried the anchor.
  const midFact = captureDeleteContribution({ documentId: 'd', family, fromUtf16: 3, toUtf16: 6 });
  assert.deepEqual(midFact.contribution.gapAnchor, ['element', [[B, 1], 2]]);
  const anchorless = importTextToFamily('elsewhere', A, '');
  const noAnchor = planDeleteUndo({ fact: midFact, family: anchorless });
  assert.equal(noAnchor.outcome, 'noop');
  assert.equal(noAnchor.code, 'missing-anchor');
});

test('fact parser rejects non-canonical annotation and field-key ordering while capture canonicalizes both', () => {
  const endpoint = (ordinal, affinity) => ({ point: ['point', ['element', [[B, 1], ordinal]], affinity], basisFrontier: [] });
  let family = importTextToFamily('d', A, '');
  family = insert(family, B, 1, ['root'], 'xy');
  const annotations = ['z', 'a'].map((id) => ({
    id,
    family: 'codes',
    fields: { z: 1, a: 2 },
    protectedTargetIds: [],
    memberships: [{ ordinal: 0, start: endpoint(0, 'left'), end: endpoint(1, 'right') }],
    prerequisites: [],
  }));
  const declarations = [{ annotationName: 'codes', fields: { a: { type: 'number' }, z: { type: 'number' } } }];
  const captured = captureDeleteContribution({ documentId: 'd', family, fromUtf16: 0, toUtf16: 2, annotations, declarations });
  assert.deepEqual(captured.contribution.annotations.map(({ id }) => id), ['a', 'z']);
  assert.deepEqual(Object.keys(captured.contribution.annotations[0].fields), ['a', 'z']);

  const reversed = JSON.parse(JSON.stringify(captured));
  reversed.contribution.annotations.reverse();
  assert.throws(() => parseDeleteFact(reversed), /annotations must be canonically ordered/);
  const reversedFields = JSON.parse(JSON.stringify(captured));
  reversedFields.contribution.annotations[0].fields = { z: 1, a: 2 };
  assert.throws(() => parseDeleteFact(reversedFields), /fields keys must be canonically ordered/);
});

function storageDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE doc_annotation (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      family TEXT NOT NULL,
      UNIQUE (id, document_id)
    );
    CREATE TABLE doc_annotation_target (annotation_id TEXT PRIMARY KEY REFERENCES doc_annotation(id) ON DELETE CASCADE);
    CREATE TABLE doc_annotation_protector (annotation_id TEXT PRIMARY KEY REFERENCES doc_annotation(id) ON DELETE CASCADE);
    CREATE TABLE doc_annotation_jsonFamily (annotation_id TEXT PRIMARY KEY REFERENCES doc_annotation(id) ON DELETE CASCADE, payload TEXT);
    CREATE TABLE doc_annotation_refFamily (annotation_id TEXT PRIMARY KEY REFERENCES doc_annotation(id) ON DELETE CASCADE, related_id TEXT);
    CREATE TABLE doc_annotation_protected_target (
      annotation_id TEXT NOT NULL REFERENCES doc_annotation(id) ON DELETE CASCADE,
      target_annotation_id TEXT NOT NULL REFERENCES doc_annotation(id) ON DELETE RESTRICT,
      PRIMARY KEY (annotation_id, target_annotation_id)
    );
    CREATE TABLE doc_range (
      id INTEGER PRIMARY KEY,
      document_id TEXT NOT NULL,
      start_point TEXT NOT NULL,
      end_point TEXT NOT NULL,
      UNIQUE (document_id, start_point, end_point)
    );
    CREATE TABLE doc_membership (
      annotation_id TEXT NOT NULL,
      range_id INTEGER NOT NULL,
      document_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      PRIMARY KEY (annotation_id, ordinal),
      FOREIGN KEY (annotation_id) REFERENCES doc_annotation(id) ON DELETE CASCADE,
      FOREIGN KEY (range_id) REFERENCES doc_range(id)
    );
  `);
  return db;
}

test('storage restores linked annotations graph-safely and creates fieldless extension rows', () => {
  const db = storageDb();
  const declarations = [
    { annotationName: 'target', fields: {} },
    { annotationName: 'protector', fields: {}, protects: 'target' },
  ];
  restoreAnnotationImages(db, {
    prefix: 'doc', documentId: 'd', projectId: 'p', ownerId: 'o',
    declarations,
    declarationFingerprint: annotationDeclarationFingerprint(declarations, ['protector', 'target']),
    // Protector sorts before its jointly restored target, pinning the old FK failure.
    images: [
      { id: 'a-protector', family: 'protector', fields: {}, protectedTargetIds: ['z-target'] },
      { id: 'z-target', family: 'target', fields: {} },
    ],
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM doc_annotation_protected_target').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM doc_annotation_protector').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM doc_annotation_target').get().n, 1);
});

test('storage capture keeps canonical serialized field-cell images by default', () => {
  const db = storageDb();
  db.prepare('INSERT INTO doc_annotation VALUES (?, ?, ?, ?, ?)').run('json-1', 'd', 'p', 'o', 'jsonFamily');
  db.prepare('INSERT INTO doc_annotation_jsonFamily VALUES (?, ?)').run('json-1', '{"z":1,"a":[2]}');
  const [image] = loadAnnotationImages(db, {
    prefix: 'doc', documentId: 'd', declarations: [{ annotationName: 'jsonFamily', fields: { payload: { type: 'json' } } }],
  });
  assert.equal(image.fields.payload, '{"z":1,"a":[2]}');
});

test('storage detects cross-document same-ID collisions before any restore write', () => {
  const db = storageDb();
  db.prepare('INSERT INTO doc_annotation VALUES (?, ?, ?, ?, ?)').run('occupied', 'other-document', 'p', 'o', 'target');
  const declarations = [{ annotationName: 'target', fields: {} }];
  const restored = restoreAnnotationImages(db, {
    prefix: 'doc', documentId: 'd', projectId: 'p', ownerId: 'o',
    declarations,
    declarationFingerprint: annotationDeclarationFingerprint(declarations, ['target']),
    images: [
      { id: 'fresh', family: 'target', fields: {} },
      { id: 'occupied', family: 'target', fields: {} },
    ],
  });
  assert.equal(restored, false, 'global collision is planned as a whole-move no-op');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM doc_annotation WHERE document_id = 'd'").get().n, 0, 'collision is a whole-move preflight no-op');
});

test('storage restores declaration-legal cyclic protector graphs after all base rows exist', () => {
  const db = storageDb();
  const declarations = [
    { annotationName: 'target', fields: {}, protects: 'protector' },
    { annotationName: 'protector', fields: {}, protects: 'target' },
  ];
  restoreAnnotationImages(db, {
    prefix: 'doc', documentId: 'd', projectId: 'p', ownerId: 'o',
    declarations,
    declarationFingerprint: annotationDeclarationFingerprint(declarations, ['target', 'protector']),
    images: [
      { id: 'a', family: 'target', fields: {}, protectedTargetIds: ['b'] },
      { id: 'b', family: 'protector', fields: {}, protectedTargetIds: ['a'] },
    ],
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM doc_annotation').get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM doc_annotation_protected_target').get().n, 2);
});

test('declaration drift is an explicit not-applicable undo verdict', () => {
  let family = importTextToFamily('d', A, 'x');
  const endpoint = (affinity) => ({ point: ['point', ['element', [[A, 1], 0]], affinity], basisFrontier: family.checkpoint.frontier });
  const capturedDeclarations = [{ annotationName: 'codes', fields: { label: { kind: 'value', type: 'text' } } }];
  const fact = captureDeleteContribution({
    documentId: 'd', family, fromUtf16: 0, toUtf16: 1, declarations: capturedDeclarations,
    annotations: [{
      id: 'code-1', family: 'codes', fields: { label: 'old' }, protectedTargetIds: [], prerequisites: [],
      memberships: [{ ordinal: 0, start: endpoint('left'), end: endpoint('right') }],
    }],
  });
  const post = applyTextOperation(family, deleteOp(B, 1, fact.contribution.deletedSpans, family.checkpoint.frontier));
  const driftedDeclarations = [{ annotationName: 'codes', fields: {
    label: { kind: 'value', type: 'text' },
    category: { kind: 'value', type: 'text', optional: true },
  } }];
  const verdict = planDeleteUndo({ fact, family: post, declarations: driftedDeclarations });
  assert.equal(verdict.outcome, 'noop');
  assert.equal(verdict.code, 'declaration-drift');
  assert.match(verdict.reason, /declaration drift/);
});

test('ref fingerprints distinguish target project fields and drift on mismatch', () => {
  // Same target ENTITY name, different project column — the generated project
  // guard trigger (src/annotated-text-field.ts) differs, so the fingerprint
  // must differ too.
  const refField = (projectField) => ({
    annotationName: 'codes', fields: {
      related_id: { kind: 'value', type: 'ref', target: { name: 'Related', project: { fieldName: projectField } } },
    },
  });
  const underProjectA = refField('project_a');
  const underProjectB = refField('project_b');
  assert.notEqual(annotationDeclarationFingerprint([underProjectA], ['codes']), annotationDeclarationFingerprint([underProjectB], ['codes']), 'same entity, different project column → different fingerprints');

  // A fact captured under one project binding fails declaration-drift when
  // validated against the other.
  let family = importTextToFamily('d', A, 'x');
  const endpoint = (affinity) => ({ point: ['point', ['element', [[A, 1], 0]], affinity], basisFrontier: family.checkpoint.frontier });
  const fact = captureDeleteContribution({
    documentId: 'd', family, fromUtf16: 0, toUtf16: 1, declarations: [underProjectA],
    annotations: [{
      id: 'code-1', family: 'codes', fields: { related_id: 'r1' }, protectedTargetIds: [],
      prerequisites: [{ entity: 'Related', id: 'r1' }],
      memberships: [{ ordinal: 0, start: endpoint('left'), end: endpoint('right') }],
    }],
  });
  const post = applyTextOperation(family, deleteOp(B, 1, fact.contribution.deletedSpans, family.checkpoint.frontier));
  const verdict = planDeleteUndo({ fact, family: post, declarations: [underProjectB] });
  assert.equal(verdict.outcome, 'noop');
  assert.equal(verdict.code, 'declaration-drift');
  assert.match(verdict.reason, /declaration drift/);
});

test('nullable ref cells add no fake prerequisite and remain applicable', () => {
  const db = storageDb();
  db.prepare('INSERT INTO doc_annotation VALUES (?, ?, ?, ?, ?)').run('ref-1', 'd', 'p', 'o', 'refFamily');
  db.prepare('INSERT INTO doc_annotation_refFamily VALUES (?, ?)').run('ref-1', null);
  const declarations = [{ annotationName: 'refFamily', fields: {
    related_id: { kind: 'value', type: 'ref', target: 'Related', optional: true, nullable: true },
  } }];
  const [loaded] = loadAnnotationImages(db, { prefix: 'doc', documentId: 'd', declarations });
  assert.deepEqual(loaded.prerequisites, []);

  let family = importTextToFamily('d', A, 'x');
  const endpoint = (affinity) => ({ point: ['point', ['element', [[A, 1], 0]], affinity], basisFrontier: family.checkpoint.frontier });
  const fact = captureDeleteContribution({
    documentId: 'd', family, fromUtf16: 0, toUtf16: 1, declarations,
    annotations: [{ ...loaded, memberships: [{ ordinal: 0, start: endpoint('left'), end: endpoint('right') }] }],
  });
  const post = applyTextOperation(family, deleteOp(B, 1, fact.contribution.deletedSpans, family.checkpoint.frontier));
  assert.deepEqual(planDeleteUndo({ fact, family: post, declarations }), { outcome: 'applied' });
});

test('fact header constants pin the v3 private-fact contract', () => {
  assert.equal(DELETE_FACT_VERSION, 3);
  assert.equal(DELETE_FACT_KIND, 'annotated-text.delete-contribution');
  const fact = captureDeleteContribution({ documentId: 'd', family: importTextToFamily('d', A, 'x'), fromUtf16: 0, toUtf16: 1 });
  assert.match(fact.declarationFingerprint, /^[0-9a-f]{64}$/);
});

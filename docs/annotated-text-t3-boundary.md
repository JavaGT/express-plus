# Annotated Text T3 Boundary

> Superseded (issue #33): annotated text is now **blockless continuous text**.
> The physical schema described below — block relation/table, block rows,
> `(block_id, family)` measurement uniqueness, "logical blocks, whole-block
> memberships" snapshots — is historical. The current model is one continuous
> family per document plus character-range annotations; the canonical document
> carries `text`, `annotations`, `ranges`, `measurements` (`{id, family,
> formatVersion, payload}` — no blockId), `capabilityHints`, and optional
> `orphans` (see `src/annotated-text-recipient-projection.ts`).

## Delivery Cutover

- `src/annotated-text-field.mjs` owns T3 declaration validation and physical schema. Its frozen declarative constructors (`annotation`, `protectingAnnotation`, `measurement`, `annotationAction`) make duplicate family names detectable before application startup.
- `validateAnnotatedTextDeclaration` accepts `annotations: [annotation(...), ...]` and `measurements: [measurement(...), ...]`. It validates names, supported child-field shapes, protecting contracts, registered semantic contracts, unknown keys, and rejects handlers, reducers, and SQL callbacks. T3 declares contracts only; it does not bind a mutation implementation.
- `annotatedTextDDL` generates one canonical per-document family-state relation, block, annotation, family, membership, orphan, and generic opaque measurement-payload relations. `<prefix>_state` owns the only full family checkpoint and its structural revision; block rows are ordered derived projections and never store a competing body checkpoint. Its primary-key/foreign-key pair enforces at most one state row per document. T4's create-event projector will atomically insert the parent, state row, and replay-stable initial block, enforcing at least one state row for every supported committed entity projection; direct SQL projection writes are unsupported. One generic one-to-one orphan table (`<prefix>_annotation_orphan_state`) preserves annotation-owned state outside active memberships without colliding with a declared family; actions do not produce it at T3. Measurement uniqueness is enforced by a unique index on `(block_id, family)`. These fresh-schema T4 prerequisites intentionally include no T3-to-T4 migration because the release contract has no production annotated-text databases. The public API never names those relations or exposes checkpoint, order-key, or payload encoding details.
- The compiler retains declaration metadata in a private WeakMap. Entity field handles expose only frozen semantic annotation action identifiers, declared measurement query facades, and declared capability identifiers; annotated text cannot be used as a scalar scope predicate.
- `materializeAnnotatedTextSnapshot` in the browser client accepts only a compiled static field handle (from `Entity.field`) and a v1 projected snapshot. It validates declared annotation, measurement, and capability names from the handle's public `annotations`, `measurements`, and `capabilities` properties, rejecting raw descriptors. It returns frozen logical blocks, annotations, whole-block memberships, opaque measurements, and capabilities. It neither folds T4 events nor exposes internal anchors, positions, checkpoints, or table identities.
- `registerAnnotatedTextContract` is public for semantic contract registration. The deterministic structural-extension registry was subsequently promoted to the root and `workbench/annotated-text` public entries for consumer measurement declarations; its frozen, closed `{ version: 1, validate, edit, partition, combine }` shape remains reserved to atomic split/merge orchestration.
- T3 declares metadata/contracts only. No T4 actions, handlers, projections, or SQL callbacks are accepted.

## Declarative API

```js
import { annotation, protectingAnnotation, measurement, annotationAction } from 'workbench';

// Annotation families
const note = annotation('note', { fields: { severity: number() } });
const full = protectingAnnotation('full', { fields: {}, protects: 'base' });

// Measurements
const audio = measurement('audio', { extension: 'speech', formatVersion: 2, queries: ['transcript'] });

// Annotation actions (contract-bound)
const resolve = annotationAction('resolve');

// Entity declaration
const Doc = entity('Doc', {
  project: ref('Project'),
  owner: ref('User'),
  body: annotatedText({
    project: 'project',
    owner: 'owner',
    block: { source: text() },
    annotations: [note, full],
    measurements: [audio],
    capabilities: { readTranscript: Object.freeze({}) },
  }),
});
```

## Registers

```js
registerAnnotatedTextContract('speech', Object.freeze({ kind: 'measurement' }));
registerAnnotatedTextContract('transcript', Object.freeze({ kind: 'measurement-query' }));
registerAnnotatedTextStructuralExtension('speech', Object.freeze({
  version: 1,
  validate: function validate(input) { /* validate extension payload */ },
  edit: function edit(input) { /* reserved: input and result are unknown */ },
  partition: function partition(input) { /* split block */ },
  combine: function combine(input) { /* merge blocks */ },
}));
```

## T3 Boundary Rules

- Callbacks (`handler`, `reducer`, `SQL`) are rejected at compile time; T4 owns action handlers and event folding.
- Only `annotation`, `protectingAnnotation`, `measurement`, and `annotationAction` descriptors are accepted in arrays.
- Each action must be a frozen `annotationAction` descriptor with exactly `kind` and `actionName` keys; wrong kinds, missing `kind`, unfrozen objects, and extra keys are rejected.
- Extensions and queries must reference registered contracts.
- Protecting annotation references must name a declared annotation family.
- `project_id` and `owner_id` foreign keys on block and annotation tables cascade on delete, so Project/User deletion propagates.
- Compiled metadata is private framework state; applications use the entity field handle and browser materializer instead.

## Status

[IMPLEMENTED — TERRA APPROVED 2026-07-25] T4 prerequisite schema contract adds a canonical per-document family checkpoint, block projections without competing checkpoint authority, closed annotation empty lifecycle policies, generic orphan state, and one packed measurement run per block/family. It is verified through focused declaration, DDL, cascade, static-handle, and browser-snapshot tests. The T2 boundary doc (`annotated-text-t2-boundary.md`) is unchanged.

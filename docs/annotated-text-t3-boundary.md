# Annotated Text T3 Boundary

## Delivery Cutover

- `src/annotated-text-field.mjs` owns T3 declaration validation and physical schema. Its frozen declarative constructors (`annotation`, `protectingAnnotation`, `measurement`, `annotationAction`) make duplicate family names detectable before application startup.
- `validateAnnotatedTextDeclaration` accepts `annotations: [annotation(...), ...]` and `measurements: [measurement(...), ...]`. It validates names, supported child-field shapes, protecting contracts, registered semantic contracts, unknown keys, and rejects handlers, reducers, and SQL callbacks. T3 declares contracts only; it does not bind a mutation implementation.
- `annotatedTextDDL` generates block, annotation, family, membership, and generic opaque measurement-payload relations. Block order is unique per document. The public API never names those relations or exposes checkpoint, order-key, or payload encoding details.
- The compiler retains declaration metadata in a private WeakMap. Entity field handles expose only frozen semantic annotation action identifiers, declared measurement query facades, and declared capability identifiers; annotated text cannot be used as a scalar scope predicate.
- `materializeAnnotatedTextSnapshot` in the browser client accepts only a compiled static field handle (from `Entity.field`) and a v1 projected snapshot. It validates declared annotation, measurement, and capability names from the handle's public `annotations`, `measurements`, and `capabilities` properties, rejecting raw descriptors. It returns frozen logical blocks, annotations, whole-block memberships, opaque measurements, and capabilities. It neither folds T4 events nor exposes internal anchors, positions, checkpoints, or table identities.
- `registerAnnotatedTextContract` is public for semantic contract registration. The deterministic structural-extension registry is internal-only: registered frozen `{ version, validate, partition, combine }` adapters are reserved for T4's atomic split/merge orchestration.
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
  validate: function validate(spec) { /* validate extension payload */ },
  partition: function partition(spec, block) { /* split block */ },
  combine: function combine(spec, left, right) { /* merge blocks */ },
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

[IMPLEMENTED — TERRA APPROVED 2026-07-24] Implemented and verified through focused declaration, DDL, cascade, static-handle, and browser-snapshot tests. The T2 boundary doc (`annotated-text-t2-boundary.md`) is unchanged.

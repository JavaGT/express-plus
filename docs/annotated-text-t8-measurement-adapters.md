# Annotated Text T8 — Measurement Structural Adapters

## Status

[IMPLEMENTED — TERRA APPROVED 2026-07-25] T8 establishes the structural adapter contract and declaration-time validation but does not attach runtime actions or Scope integration.

## Delivery Cutover

- `registerAnnotatedTextStructuralExtension(name, spec)` is exported from both `workbench` and `workbench/annotated-text` as the supported consumer registry for structural measurement adapters. Each spec is a frozen plain object with exactly five enumerable own data properties: `{version: 1, validate, edit, partition, combine}`. Every callback is made frozen at registration and must be a named direct synchronous function; async, bound, and proxied callbacks are rejected.
- The structural adapter name must match a registered semantic contract of kind `'measurement'`. Declaration validation enforces a dual check: the extension name must resolve in the semantic `contractRegistry` (with kind `'measurement'`) **and** in the `structuralExtensions` registry. An extension with a semantic contract but no structural adapter, or a structural adapter but no semantic contract, is rejected at compile time.
- Measurement declarations with `extension: null` are rejected at compile time. An extension is mandatory for every measurement.
- No lifecycle, family history, or Scope changes are introduced at T8. The adapter registry exists for T4 atomic split/merge orchestration.

## Structural Adapter Contract

```js
import {
  registerAnnotatedTextContract,
  registerAnnotatedTextStructuralExtension,
} from 'workbench/annotated-text';

registerAnnotatedTextContract('myExt', Object.freeze({ kind: 'measurement' }));
registerAnnotatedTextStructuralExtension('myExt', Object.freeze({
  version: 1,
  validate: function validate(input) { /* synchronous, frozen input */ },
  edit: function edit(input) { /* synchronous, frozen input */ },
  partition: function partition(input) { /* synchronous, frozen input */ },
  combine: function combine(input) { /* synchronous, frozen input */ },
}));
```

### Required Keys

| Key         | Value                       |
|-------------|-----------------------------|
| `version`   | `1` (exact)                 |
| `validate`  | Named synchronous function  |
| `edit`      | Named synchronous function  |
| `partition` | Named synchronous function  |
| `combine`   | Named synchronous function  |

### Rejection Rules

- `version !== 1` → `requires version exactly 1`
- Unknown, missing, or symbolic key → `must have exactly version, validate, edit, partition, and combine own properties`
- Non-enumerable or accessor required key → `must be an enumerable own data property`
- Unnamed function → `must be a named function`
- Async, bound, or proxied callback → `must be a direct synchronous function`
- Non-function value → `requires a named '...' function`
- Unfrozen spec → `requires a frozen spec object`
- Duplicate name → `already registered`
- Invalid identifier → `not a valid identifier`

## Declaration Dual Validation

Measurement declarations at compile time require:

1. `extension` must be non-null (not `null`)
2. `extension` must name a registered semantic contract of kind `'measurement'`
3. `extension` must name a registered structural adapter

If any check fails, the declaration is rejected with an error message identifying the `measurements.<name>.extension` path.

## Runtime Contract

Adapters receive frozen inputs and opaque JSON payloads packed in the `measurement` payload column.

- `validate({ version: 1, formatVersion, blockText, payload })` returns `undefined` or throws.
- `partition({ version: 1, formatVersion, blockText, utf16Offset, payload })` returns `{ version: 1, leftPayload, rightPayload }`.
- `combine({ version: 1, formatVersion, blockText, left, right })` returns `{ version: 1, payload }`; each non-null side is `{ blockText, payload }`.
- `edit` remains a required reserved callback, but is not currently invoked by the runtime. Its named public input and result aliases are both `unknown`; consumers must not depend on an edit input shape or result behavior until a supported edit contract is introduced.

Partition and combine are called twice and must return deterministic JSON-compatible results. Outputs are validated before persistence. Structural split/merge admission invokes the adapters; projection never does.

## Runtime

`resolveDeclarationMeasurementExtension(descriptor)` returns the registered structural spec for a measurement descriptor, or `null` if the descriptor is not a measurement kind or the extension is not registered.

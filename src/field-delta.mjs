// P6e-2 Slice A — pure delta-computation core for durable-field-delta-live.
//
// `computeDelta` diffs two committed rows field-by-field and produces a
// `{[fieldName]: deltaObj}` map. Only diff-eligible kinds (value, state, crdt,
// struct) are checked — kinds whose events ride the `<Entity>.updated` channel.
// Kinds that emit their own native delta events (store, ordered, map) or whose
// delta is meaningless (hash) are skipped.
//
// PURE: no side effects, no DB reads, no mutation of args.

import { resolveStrategy } from './field-strategy.mjs';

// The kinds whose diff is meaningful on the `.updated` envelope.
const DIFF_ELIGIBLE = new Set(['value', 'state', 'crdt', 'struct']);

/**
 * Computes the per-field delta map for one committed update.
 *
 * @param {object} entityRecord — the compiled entity (has .fields: {fieldName: descriptor})
 * @param {object|null|undefined} prevRow — the prior committed row, or {} / null / undefined for cold
 * @param {object|null|undefined} nextRow — the new committed row
 * @param {Iterable<string>|null|undefined} changedFieldNames — optional iterable of field names to check;
 *        if omitted/null, iterate ALL fields in entityRecord.fields
 * @returns {object} — { [fieldName]: deltaObj } only for diff-eligible kinds with non-null deltas. May be {}.
 */
export function computeDelta(entityRecord, prevRow, nextRow, changedFieldNames) {
  const prev = prevRow ?? {};
  const next = nextRow ?? {};
  const fields = entityRecord.fields ?? {};
  const result = {};

  // Determine which field names to iterate.
  const fieldNames = changedFieldNames != null
    ? changedFieldNames
    : Object.keys(fields);

  for (const fieldName of fieldNames) {
    const descriptor = fields[fieldName];
    if (!descriptor) continue; // defensive: unknown field name in changedFieldNames

    const kind = descriptor.kind;
    if (!DIFF_ELIGIBLE.has(kind)) continue; // skip excluded kinds

    const strategy = resolveStrategy(kind);
    const delta = strategy.diff(prev[fieldName], next[fieldName], descriptor);

    if (delta != null) {
      result[fieldName] = delta;
    }
  }

  return result;
}

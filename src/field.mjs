// The field-type plugin contract (Phase 1, SPEC §5.1 / §5.4, ADR #9).
//
// A field constructor returns an immutable FIELD DESCRIPTOR. The descriptor is
// the seam every later layer attaches to: the mutation pipeline reads its
// persistence strategy and validate; the entity compiler reads its kind, target
// FK, and derived-check role; the access engine reads its `.can` function (or,
// when absent, strong-inherits the row grant per ADR #4).
//
// The four KINDS are named wholes, not a flag enum (ADR #9): `value` (single
// stored value, whole-value diff), `store` (internally-keyed owned collection),
// `crdt` (custom merge with per-element deltas), `ordered` (fractional-index
// keyspace). Phase 1's blog spine uses `value` and `crdt`; `store`/`ordered`
// ship as the registry grows.

// A field descriptor is frozen so no later layer can mutate a declared field.
// `.can(fn)` returns a NEW frozen descriptor carrying the access function — it
// never mutates the original (declarations are immutable).
function makeDescriptor(props) {
  const descriptor = { access: undefined, ...props };
  descriptor.can = (fn) => {
    const { can, ...fields } = descriptor;
    return makeDescriptor({ ...fields, access: fn });
  };
  return Object.freeze(descriptor);
}

// `value` kind — a single stored value with whole-value diff. The default
// mechanism (the bare kind is the sensible default per the naming rule).
export function text(options = {}) {
  return makeDescriptor({ kind: 'value', type: 'text', ...options });
}
// `text.crdt()` — the `crdt` kind instance for collaborative text. One instance
// of the crdt contract, not a privileged special case (ADR #9).
text.crdt = (options = {}) =>
  makeDescriptor({ kind: 'crdt', type: 'text', ...options });

export function boolean(options = {}) {
  return makeDescriptor({ kind: 'value', type: 'boolean', ...options });
}

export function date(options = {}) {
  return makeDescriptor({ kind: 'value', type: 'date', ...options });
}

// `ref(Target)` — a typed foreign key. `target` is explicit (no opaque sugar).
// `role` lets the entity compiler derive `is.<role>()` from the FK (the only
// thing the FK derives — no zero-to-one default grant, ADR #7).
export function ref(target, options = {}) {
  return makeDescriptor({ kind: 'value', type: 'ref', target, ...options });
}

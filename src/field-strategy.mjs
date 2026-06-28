// The field-type persistence strategy table + the validate pipeline stage.
//
// SPEC §5.1, §7 (stage 1: validate), §7.2 ("the field-type plugin owns the
// persistence strategy"). The four KINDS — value/store/crdt/ordered — are named
// wholes (ADR #9), each owning genuinely distinct {validate, apply, diff}
// machinery. The strategy is resolved by `kind` from ONE framework-owned table;
// a descriptor carries only its kind, never an embedded strategy object. This is
// the deletion test passing: the kind ABSORBS the strategy (no per-field config
// object that merely relocates the machinery behind a name).
//
// Phase 1's blog spine exercises only `value` (whole-value diff: text/ref/
// boolean/date) and the structural-validate half of `crdt` (note.mjs body). The
// crdt/store/ordered MERGE machinery (per-element deltas, fractional index) is
// Phase 2 delta broadcast — registered here as a named whole whose apply/diff
// fail CLOSED with a loud Phase-2 throw, never a silent mis-merge.

// A typed failure for the validate stage. Stage 1 throws this and NOTHING
// downstream runs (no apply, no persist, no emit) — a bad payload never proceeds
// (SPEC §7 stage 1, fail closed). The message names the field path + reason.
export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

// A Phase-2 merge seam that is engaged before its machinery ships fails closed,
// loudly, naming the kind — never a silent wrong merge.
function phase2Merge(kind) {
  return () => {
    throw new Error(
      `the '${kind}' field kind's merge machinery is Phase 2 (per-element ` +
        `deltas / fractional index). It validates structurally in Phase 1 but ` +
        `cannot apply or diff until live delta broadcast lands (SPEC §7.2, §13).`,
    );
  };
}

// Structural validators per kind. These check the SHAPE the kind can store,
// before any declared `validate` runs. A declared validate refines; the
// structural check is the floor.
function isTextValue(v) {
  return typeof v === 'string';
}

// The four named-whole strategies. value is fully implemented (whole-value diff);
// crdt/store/ordered validate structurally and defer their merge to Phase 2.
const STRATEGIES = Object.freeze({
  // `value` — a single stored value with whole-value diff. apply replaces;
  // diff is a whole-value set, null when unchanged.
  value: Object.freeze({
    validate(value, descriptor) {
      switch (descriptor.type) {
        case 'text':
        case 'ref':
          if (!isTextValue(value)) return `expected a ${descriptor.type} value`;
          return true;
        case 'boolean':
          if (typeof value !== 'boolean') return 'expected a boolean';
          return true;
        case 'date':
          if (!(value instanceof Date) && typeof value !== 'number' && typeof value !== 'string') {
            return 'expected a date';
          }
          return true;
        default:
          return true;
      }
    },
    apply(_previous, next) {
      return next;
    },
    diff(previous, next) {
      if (Object.is(previous, next)) return null;
      return { set: next };
    },
    // serialize maps a value-kind value to its stored cell. SQLite has no boolean
    // type and node:sqlite refuses to bind a JS boolean, so a boolean becomes the
    // integer 1/0; a Date becomes epoch millis; text/ref/already-stored values
    // pass through. null/undefined are left untouched (a null cell is null). This
    // is the ONE place "how a value-kind field becomes a stored cell" is decided —
    // used by both the scope-literal baker and the write path (singular system).
    serialize(value, descriptor) {
      if (value === null || value === undefined) return value;
      switch (descriptor.type) {
        case 'boolean':
          return value ? 1 : 0;
        case 'date':
          return value instanceof Date ? value.getTime() : value;
        default:
          return value;
      }
    },
  }),

  // `crdt` — a custom merge with per-element deltas. Validates structurally in
  // Phase 1 (note.mjs body is a string); its merge is Phase 2.
  crdt: Object.freeze({
    validate(value) {
      if (!isTextValue(value)) return 'expected a crdt text value';
      return true;
    },
    apply: phase2Merge('crdt'),
    diff: phase2Merge('crdt'),
  }),

  // `store` — an internally-keyed owned collection. Phase 2.
  store: Object.freeze({
    validate(value) {
      if (value === null || typeof value !== 'object') return 'expected a store value';
      return true;
    },
    apply: phase2Merge('store'),
    diff: phase2Merge('store'),
  }),

  // `ordered` — a fractional-index keyspace. Phase 2.
  ordered: Object.freeze({
    validate(value) {
      if (!Array.isArray(value)) return 'expected an ordered list';
      return true;
    },
    apply: phase2Merge('ordered'),
    diff: phase2Merge('ordered'),
  }),
});

// Resolve a field's strategy by its kind. An unknown kind fails closed — there is
// no silent default strategy (the kind names the contract; an unknown kind is a
// declaration error).
export function resolveStrategy(kind) {
  const strategy = STRATEGIES[kind];
  if (!strategy) {
    throw new Error(
      `unknown field kind '${kind}'. The field kinds are the four named wholes ` +
        `value/store/crdt/ordered (SPEC §5.1, ADR #9).`,
    );
  }
  return strategy;
}

// Serialize a single value to the stored cell its descriptor's kind dictates.
// Resolves the descriptor's strategy and defers to its `serialize` (the value
// kind owns the boolean→1/0, Date→epoch mapping). A kind whose strategy has no
// serialize (Phase 2 merge kinds, never baked into a scope literal in Phase 1)
// passes the value through. This is the seam the scope compiler calls to bake a
// literal (fields.x.is(v)) into a bindable param, and the write path will call to
// store a cell — one mapping, two callers (singular system).
export function serializeField(descriptor, value) {
  const strategy = resolveStrategy(descriptor.kind);
  if (typeof strategy.serialize !== 'function') return value;
  return strategy.serialize(value, descriptor);
}

// Pipeline stage 1 — validate. Runs each payload key against the field-option
// rules the payload itself can decide (readonly, required-clear), then its
// structural strategy check, then its declared `validate` (if any). The first
// failure throws a ValidationError naming `Entity.field` + the reason; a payload
// key that is not a declared field fails closed. Fields absent from the payload
// are untouched (partial update). Returns the payload unchanged on success so the
// stage composes left-to-right in the pipeline.
//
// Field-option ownership by SEAM (the smallest seam that can decide the rule):
//  - `readonly` is an untrusted-payload rule: a client may not set/change the
//    field at all (the framework fills it server-side). Enforced HERE — this seam
//    already sees the untrusted payload.
//  - `required` is a final-record invariant; the part visible to the payload is
//    "may not be explicitly cleared". Enforced HERE for the clear case. Final
//    requiredness on create (supplied by payload OR route OR principal OR default)
//    is the write path's job (Phase 2), where all sources are merged.
//  - `default` is materialization, not validation — it belongs to the write/apply
//    path (Phase 2), never to this accept/reject seam.
export function validateMutation(entityRecord, payload) {
  const { name, fields } = entityRecord;
  for (const [key, value] of Object.entries(payload)) {
    const descriptor = fields[key];
    if (!descriptor) {
      throw new ValidationError(
        `${name}.${key} is not a declared field. A mutation may only touch ` +
          `declared fields (fail closed).`,
      );
    }

    // readonly: the field's mere presence in an untrusted payload is rejected —
    // the client cannot set it; the framework assigns it server-side.
    if (descriptor.readonly === true) {
      throw new ValidationError(
        `${name}.${key} is readonly: a client may not set or change it. It is ` +
          `assigned server-side (e.g. from the authenticated principal).`,
      );
    }

    // required: the payload may not explicitly CLEAR a required field. (Whether a
    // required field is present at all on create is the write path's concern.)
    if (descriptor.required === true && (value === null || value === undefined)) {
      throw new ValidationError(
        `${name}.${key} is required and may not be cleared (set to null).`,
      );
    }

    const { validate } = resolveStrategy(descriptor.kind);
    const structural = validate(value, descriptor);
    if (structural !== true) {
      throw new ValidationError(`${name}.${key}: ${structural}`);
    }

    if (typeof descriptor.validate === 'function') {
      const declared = descriptor.validate(value);
      if (declared !== true) {
        const reason = typeof declared === 'string' ? declared : 'failed validate';
        throw new ValidationError(`${name}.${key}: ${reason}`);
      }
    }
  }
  return payload;
}

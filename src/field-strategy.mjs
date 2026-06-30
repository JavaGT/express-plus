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
// Phase 1's blog spine exercises `value` (whole-value diff: text/ref/
// boolean/date) and the structural-validate half of `crdt` (note.mjs body). The
// crdt/store/ordered/struct MERGE machinery (per-element deltas, fractional
// index, per-sub-cell diff) lands in Phase 2 — registered here as named wholes
// whose diff produces element-level deltas (consult #18/#20).

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// A typed failure for the validate stage. Stage 1 throws this and NOTHING
// downstream runs (no apply, no persist, no emit) — a bad payload never proceeds
// (SPEC §7 stage 1, fail closed). The message names the field path + reason.
export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

// Structural validators per kind. These check the SHAPE the kind can store,
// before any declared `validate` runs. A declared validate refines; the
// structural check is the floor.
function isTextValue(v) {
  return typeof v === 'string';
}

// crdt text diff — common-prefix + common-suffix detection yields the minimal
// per-element delta. A pure insert → {insert:{at,text}}; a replace →
// {delete:{at,length}, insert:{at,text}}. Never a whole-value `{ set }` (consult
// #18: real per-element merge, not the deferred concurrent toolkit #33).
function crdtTextDiff(previous, next) {
  if (Object.is(previous, next)) return null;
  const p = previous == null ? '' : String(previous);
  const n = next == null ? '' : String(next);
  const minLen = Math.min(p.length, n.length);
  let pre = 0;
  while (pre < minLen && p[pre] === n[pre]) pre++;
  const maxSuf = minLen - pre;
  let suf = 0;
  while (suf < maxSuf && p[p.length - 1 - suf] === n[n.length - 1 - suf]) suf++;
  const delStart = pre;
  const delEnd = p.length - suf;
  const insStart = pre;
  const insEnd = n.length - suf;
  const deleted = delEnd > delStart ? p.slice(delStart, delEnd) : null;
  const inserted = insEnd > insStart ? n.slice(insStart, insEnd) : null;
  if (!deleted && !inserted) return null;
  const delta = {};
  if (deleted) delta.delete = { at: delStart, length: delEnd - delStart };
  if (inserted) delta.insert = { at: insStart, text: inserted };
  return delta;
}

// store (map) membership diff over { member: role } materializations. A member
// add → added; a member gone → removed; a same-member role change → changed
// (NOT added — only a NEW member fires onAdded, DECISIONLOG #57).
function storeMapDiff(previous, next) {
  const prev = previous && typeof previous === 'object' ? previous : {};
  const nxt = next && typeof next === 'object' ? next : {};
  const added = [], removed = [], changed = [];
  for (const [member, role] of Object.entries(nxt)) {
    if (!(member in prev)) added.push({ member, role });
    else if (!Object.is(prev[member], role)) changed.push({ member, role });
  }
  for (const member of Object.keys(prev)) {
    if (!(member in nxt)) removed.push(member);
  }
  if (!added.length && !removed.length && !changed.length) return null;
  return { added, removed, changed };
}

// ordered (list) diff over keyed-element lists { key, ...item }. The delta is
// computed by KEY: a sibling keeps its key across an insert/move (no renumber).
// Moves are reported only on a pure reorder (key set unchanged) — index shifts
// caused by a structural add are NOT moves (consult #20: fractional-index).
function orderedListDiff(previous, next) {
  const prev = Array.isArray(previous) ? previous : [];
  const nxt = Array.isArray(next) ? next : [];
  const prevByKey = new Map(prev.map((e, i) => [e.key, i]));
  const nextByKey = new Map(nxt.map((e, i) => [e.key, i]));
  const added = [], removed = [], moved = [];
  for (let i = 0; i < nxt.length; i++) {
    const { key, ...item } = nxt[i];
    if (!prevByKey.has(key)) added.push({ at: i, key, item });
  }
  for (const e of prev) {
    if (!nextByKey.has(e.key)) removed.push({ key: e.key });
  }
  if (added.length === 0 && removed.length === 0) {
    for (let i = 0; i < nxt.length; i++) {
      const from = prevByKey.get(nxt[i].key);
      if (from !== i) moved.push({ key: nxt[i].key, from, to: i });
    }
  }
  if (!added.length && !removed.length && !moved.length) return null;
  return { added, removed, moved };
}

// struct per-sub-cell diff. Only changed declared sub-cells appear in `cells`
// as { set: value }; an unchanged sub-cell is absent. A cleared cell → { set: null }.
function structDiff(previous, next, descriptor) {
  const prev = previous && typeof previous === 'object' ? previous : {};
  const nxt = next && typeof next === 'object' ? next : {};
  const declared = descriptor?.cells ?? {};
  const cells = {};
  for (const name of Object.keys(nxt)) {
    if (Object.prototype.hasOwnProperty.call(declared, name) && !Object.is(prev[name], nxt[name])) {
      cells[name] = { set: nxt[name] };
    }
  }
  for (const name of Object.keys(prev)) {
    if (Object.prototype.hasOwnProperty.call(declared, name) && !(name in nxt) && prev[name] != null) {
      cells[name] = { set: null };
    }
  }
  if (Object.keys(cells).length === 0) return null;
  return { cells };
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
          if (!isTextValue(value)) return 'expected a text value';
          return true;
        case 'ref':
          if (typeof value !== 'string' && typeof value !== 'number') return 'expected a ref value';
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
        case 'ref':
          return String(value);
        default:
          return value;
      }
    },
  }),

  // `hash` — a one-way salted password digest. A plaintext string in, a salted
  // scrypt digest (`salt:digest`, hex) stored. apply replaces (whole-value); diff
  // compares the STORED cells, so re-storing the same plaintext (a fresh salt)
  // reads as a change — passwords are write-only, never diffed for equality of
  // plaintext. verify is exposed on the hydrated row, not here.
  hash: Object.freeze({
    validate(value) {
      if (!isTextValue(value)) return 'expected a password string';
      return true;
    },
    apply(_previous, next) {
      return next;
    },
    diff(previous, next) {
      if (Object.is(previous, next)) return null;
      return { set: next };
    },
    // serialize digests the plaintext: random 16-byte salt + scrypt(64) →
    // `saltHex:digestHex`. null/undefined pass through (a null cell is null).
    serialize(value) {
      if (value === null || value === undefined) return value;
      const salt = randomBytes(16);
      const digest = scryptSync(value, salt, 64);
      return `${salt.toString('hex')}:${digest.toString('hex')}`;
    },
  }),

  // `crdt` — a custom merge with per-element deltas. Validates structurally
  // (note.mjs body is a string); diff is a per-element text delta (insert /
  // delete) computed from common prefix + suffix, NOT a whole-value `{ set }`.
  // Single-writer dispatch stores `next` (apply = replace); the per-element DELTA
  // is the broadcast artifact — the "merge machinery" consult #18 names. The
  // concurrent-merge toolkit (reconciling concurrent edits) is deferred (#33).
  crdt: Object.freeze({
    validate(value) {
      if (!isTextValue(value)) return 'expected a crdt text value';
      return true;
    },
    apply(_previous, next) {
      return next;
    },
    diff(previous, next) {
      return crdtTextDiff(previous, next);
    },
  }),

  // `store` — an internally-keyed owned collection (map). diff is a membership
  // delta: {added, removed, changed}. A role change is `changed`, NOT `added` —
  // only a NEW member fires onAdded (idempotent re-share, DECISIONLOG #57).
  store: Object.freeze({
    validate(value) {
      if (value === null || typeof value !== 'object') return 'expected a store value';
      return true;
    },
    apply(_previous, next) {
      return next;
    },
    diff(previous, next) {
      return storeMapDiff(previous, next);
    },
  }),

  // `ordered` — a fractional-index keyspace (list). diff is an element delta
  // {added, removed, moved} computed by KEY: a sibling keeps its key across an
  // insert/move (no renumber). Moves are reported only on a pure reorder (key set
  // unchanged); an insert/move's index shifts of siblings are a CONSEQUENCE of
  // the structural add, not reported as moves.
  ordered: Object.freeze({
    validate(value) {
      if (!Array.isArray(value)) return 'expected an ordered list';
      return true;
    },
    apply(_previous, next) {
      return next;
    },
    diff(previous, next) {
      return orderedListDiff(previous, next);
    },
  }),

  // `struct` — a namespace of named value sub-cells (the `link` field is the
  // first instance). The struct does not store a value of its own; it stores
  // ONE flat cell per declared sub-cell. diff is a PER-SUB-CELL delta — only
  // changed sub-cells appear in `cells` (an unchanged sub-cell is absent). The
  // Phase 1 write path flattens a struct payload into per-cell columns via
  // flattenStruct; serialize/apply of the WHOLE struct replace it.
  struct: Object.freeze({
    validate(value, descriptor) {
      if (value === null || value === undefined) return true;
      if (typeof value !== 'object') return 'expected a structured value';
      // every supplied sub-key must be a declared, stored sub-cell (fail closed)
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(descriptor.cells, key)) {
          return `'${key}' is not a stored sub-cell of this structured field`;
        }
        const structural = STRATEGIES[descriptor.cells[key].kind].validate(value[key], descriptor.cells[key]);
        if (structural !== true) return `${key}: ${structural}`;
      }
      return true;
    },
    apply(_previous, next) {
      return next;
    },
    diff(previous, next, descriptor) {
      return structDiff(previous, next, descriptor);
    },
  }),

  // `state` — a finite-state-machine field: a closed domain of string values plus
  // a declared legal-transition graph. validate checks membership in the declared
  // values set. diff reports `{ from, to }` on change (never a whole-value set).
  // apply replaces. No serialize needed (the value is already a domain string).
  // The transition guard (reject illegal moves at update time) lives in the CRUD
  // handler — this strategy validates shape only.
  state: Object.freeze({
    validate(value, descriptor) {
      if (!descriptor.values.includes(value)) {
        return `expected one of [${descriptor.values.join(', ')}]`;
      }
      return true;
    },
    apply(_previous, next) {
      return next;
    },
    diff(previous, next) {
      if (previous === next) return null;
      return { from: previous, to: next };
    },
  }),
});

// The generated column name for a structured field's sub-cell. Derived from the
// declared shape (no magic strings): `<field>__<cell>`. The double underscore is
// a visibly-generated separator; a load-time guard (entity compiler) forbids a
// declared field/cell name containing it, so the generated name never collides
// with a hand-declared field. This ONE function is the sole authority on the
// name — the scope handle, the write path, and hydration all derive through it.
export function structCellColumn(fieldName, cellName) {
  return `${fieldName}__${cellName}`;
}

// Flatten a struct payload value into its per-cell stored columns. Used by the
// write path so a single declared struct field becomes several flat columns.
// Only declared sub-cells are emitted (validateMutation already rejected any
// undeclared sub-key); each cell is serialized by its own value strategy.
export function flattenStruct(fieldName, descriptor, value) {
  const cells = {};
  if (value === null || value === undefined) return cells;
  for (const [cellName, cellDescriptor] of Object.entries(descriptor.cells)) {
    if (!Object.prototype.hasOwnProperty.call(value, cellName)) continue;
    cells[structCellColumn(fieldName, cellName)] = serializeField(cellDescriptor, value[cellName]);
  }
  return cells;
}

// Resolve a field's strategy by its kind. An unknown kind fails closed — there is
// no silent default strategy (the kind names the contract; an unknown kind is a
// declaration error).
export function resolveStrategy(kind) {
  const strategy = STRATEGIES[kind];
  if (!strategy) {
    throw new Error(
      `unknown field kind '${kind}'. The field kinds are: ` +
        `value, crdt, hash, store, ordered, struct, state, ephemeral.`,
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

// verifyHash(candidate, stored) — the one-way check behind a hydrated hash
// field's `.verify(plaintext)`. Recomputes scrypt over the candidate with the
// stored salt and compares in constant time. Fail closed: a missing/malformed
// stored cell, or a non-string candidate, is `false` (never a thrown 500 on the
// login path, never a permissive default).
export function verifyHash(candidate, stored) {
  if (typeof candidate !== 'string' || typeof stored !== 'string') return false;
  const sep = stored.indexOf(':');
  if (sep <= 0) return false;
  const salt = Buffer.from(stored.slice(0, sep), 'hex');
  const expected = Buffer.from(stored.slice(sep + 1), 'hex');
  if (salt.length === 0 || expected.length === 0) return false;
  const actual = scryptSync(candidate, salt, expected.length);
  return timingSafeEqual(actual, expected);
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

    // Derived fields are computed on read — a client may not set them.
    if (descriptor.derived) {
      throw new ValidationError(
        `${name}.${key} is a derived field and may not be set by the client.`,
      );
    }

    // readonly: the field's mere presence in an untrusted payload is rejected —
    // the client cannot set it; the framework assigns it server-side.
    if (descriptor.readonly === true || descriptor.touch === true) {
      throw new ValidationError(
        `${name}.${key} is ${descriptor.touch ? 'a touch field' : 'readonly'}: a client may not set or ` +
          `change it. It is assigned server-side${descriptor.touch ? ' on every mutation' : ''}.`,
      );
    }

    // map fields cannot be written via create/update payload — they are
    // membership collections that must be mutated through the row handle
    // (row.<field>.set(...)/.remove(...)). Accepting a map payload would
    // try to store an object literal as a main-table cell (fail closed).
    if (descriptor.kind === 'store' && descriptor.type === 'map') {
      throw new ValidationError(
        `${name}.${key} is a map field and cannot be set via payload. ` +
          `Mutate it through the row handle: row.${key}.set(memberId, { role }).`,
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

// Per-subscriber PACE/COALESCING registry, orthogonal to the persistence
// STRATEGIES (DECISIONLOG #61). Ephemeral fields have no persistence strategy
// but DO have a pace entry. Kinds without a pace entry resolve to a synthetic
// pass-through descriptor — no coalescing is lawful, only verbatim delivery.
//
// SPEC §8.2 P6e-1b: per-subscriber pace/coalescing for ephemeral fields. An
// ephemeral field is a per-connection write handle (drawing-canvas stroke at
// 60Hz) whose events coalesce to ~15fps per subscriber.

const coalescers = Object.freeze({
  // latest-wins: position data is loss-tolerant — the latest snapshot wins.
  // Matches the ephemeral projection (INSERT OR REPLACE latest-snapshot).
  'latest-wins': Object.freeze((_acc, event) => event),
});

function reduceSpan(events) {
  return {
    seq: events[events.length - 1].seq,
    seqSpan: [events[0].seq, events[events.length - 1].seq],
  };
}

const profiles = Object.freeze({
  'pass-through': Object.freeze({ window: 0, by: null }),
  '15fps': Object.freeze({ window: 66, by: 'latest-wins' }),
});

const bounds = Object.freeze({
  allowedBy: Object.freeze(['latest-wins']),
  maxWindow: 1000,
});

// The pace strategy registry, keyed by field-kind. Only `ephemeral` for now.
// Other field-kinds (value, text, etc.) have no entry — see resolvePace for
// the synthetic pass-through they resolve to.
export const PACE_STRATEGIES = Object.freeze({
  ephemeral: Object.freeze({
    coalescers,
    reduceSpan,
    profiles,
    bounds,
  }),
});

// Resolve the pace strategy for a field kind. If the kind has no explicit
// entry, returns a synthetic pass-through descriptor — pass-through only, no
// coalescing is lawful. This is NOT an error: an absent entry means "only
// verbatim delivery."
export function resolvePace(kind) {
  const entry = PACE_STRATEGIES[kind];
  if (entry) return entry;
  return Object.freeze({
    coalescers: {},
    reduceSpan: null,
    profiles: { 'pass-through': Object.freeze({ window: 0, by: null }) },
    bounds: Object.freeze({ allowedBy: [], maxWindow: 0 }),
  });
}

// Validate a subscriber's pace selection at subscribe time (fail-closed).
// `pace` may be null/undefined (→ pass-through, valid for any kind), or
// { profile: '<name>' }, or { coalesce: { window: <ms>, by: '<name>' } }.
// Returns the resolved effective { window, by } on success.
export function validatePaceSelection(kind, pace) {
  // Reject closures — SPEC §8: pace must be data, not code.
  if (typeof pace === 'function') {
    throw Object.assign(new Error('pace must be data, not a closure'), { status: 400 });
  }

  // null/undefined → pass-through, valid for any kind.
  if (pace === null || pace === undefined) {
    return { window: 0, by: null };
  }

  // Reject closures in any sub-value.
  if (typeof pace.profile === 'function' || typeof pace.coalesce === 'function') {
    throw Object.assign(new Error('pace must be data, not a closure'), { status: 400 });
  }

  const kindPace = resolvePace(kind);

  // If pace.profile is given, validate it's a known profile for this kind.
  if (pace.profile !== undefined) {
    const profile = kindPace.profiles[pace.profile];
    if (!profile) {
      throw Object.assign(
        new Error(`unknown pace profile '${pace.profile}' for kind '${kind}'`),
        { status: 400 },
      );
    }
    return { window: profile.window, by: profile.by };
  }

  // If pace.coalesce is given, validate explicitly.
  if (pace.coalesce !== undefined) {
    const { window: w, by } = pace.coalesce;

    // Reject closures in by.
    if (typeof by === 'function') {
      throw Object.assign(new Error('pace must be data, not a closure'), { status: 400 });
    }

    // by must be in the kind's allowedBy.
    if (!kindPace.bounds.allowedBy.includes(by)) {
      throw Object.assign(
        new Error(`coalescer '${by}' not lawful for kind '${kind}'`),
        { status: 400 },
      );
    }

    // window must be a positive number ≤ maxWindow.
    if (typeof w !== 'number' || w <= 0 || w > kindPace.bounds.maxWindow) {
      throw Object.assign(
        new Error(`pace window ${w} exceeds bounds for kind '${kind}'`),
        { status: 400 },
      );
    }

    return { window: w, by };
  }

  // Unknown pace shape — reject.
  throw Object.assign(new Error('invalid pace selection'), { status: 400 });
}

// P6d Spine A: time-driven sources (ADR #10). Import-surface only —
// constructuring + entity-slot acceptance. Firing/dispatch/reaper wiring
// lands in step 4; while/when discovery in step 2; tick in step 5.

const MS = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 };

function parseDelay(delay) {
  if (typeof delay === 'number' && Number.isFinite(delay) && delay >= 0) return delay;
  if (typeof delay === 'string') {
    const m = /^(\d+)([dhms])$/.exec(delay.trim());
    if (m) return Number(m[1]) * MS[m[2]];
  }
  throw new Error(`schedule.after: invalid delay ${JSON.stringify(delay)} (expected a non-negative number ms or a '<n><d|h|m|s>' string)`);
}

export const schedule = Object.freeze({
  at(field, options = {}) {
    if (!field || typeof field !== 'object') throw new Error('schedule.at: field must be a field descriptor');
    const { while: whilePredicate } = options;
    if (whilePredicate !== undefined && typeof whilePredicate !== 'function') {
      throw new Error('schedule.at: while must be a function');
    }
    return Object.freeze({ kind: 'schedule.at', field, while: whilePredicate ?? undefined });
  },
  after(field, delay, options = {}) {
    if (!field || typeof field !== 'object') throw new Error('schedule.after: field must be a field descriptor');
    const { while: whilePredicate } = options;
    if (whilePredicate !== undefined && typeof whilePredicate !== 'function') {
      throw new Error('schedule.after: while must be a function');
    }
    // Deferral note: Spine A step 5 (tick) implements the runtime-guard fallback
    // for non-compilable while predicates (SPEC §10), the 'when' lifecycle guard
    // (Spine C8 state runtime), and the "empty while forbidden for row-set ticks"
    // guard. For schedule.at/after, strict compile of 'while' is fail-closed;
    // absent 'while' is valid (the date field IS the discovery).
    return Object.freeze({ kind: 'schedule.after', field, delay: parseDelay(delay), while: whilePredicate ?? undefined });
  },
});

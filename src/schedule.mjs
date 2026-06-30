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
  at(field) {
    if (!field || typeof field !== 'object') throw new Error('schedule.at: field must be a field descriptor');
    return Object.freeze({ kind: 'schedule.at', field });
  },
  after(field, delay) {
    if (!field || typeof field !== 'object') throw new Error('schedule.after: field must be a field descriptor');
    return Object.freeze({ kind: 'schedule.after', field, delay: parseDelay(delay) });
  },
});

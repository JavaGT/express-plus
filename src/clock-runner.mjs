// Shared clock/setInterval setup — schedule.mjs (startClockTriggers) and
// simulate.mjs share timer-driver boilerplate. This extracts the common
// branching (clock.add vs setInterval) + unref + stop pattern.

import { getLog } from './log.mjs';

/**
 * Creates a clock-driven or setInterval-based periodic runner.
 *
 * When a shared clock is provided, registers `fn` as a watcher (single
 * setTimeout with nearest-deadline scheduling). Otherwise starts its own
 * setInterval with `timer.unref()` so the test process exits without leaks.
 *
 * `fn` may be sync or async — errors are caught and logged identically either
 * way (the setInterval path uses an async wrapper; the clock path delegates to
 * the clock's own error swallowing).
 *
 * @param {object} opts
 * @param {object} [opts.clock] - Shared clock (from createClock()). When
 *   provided, `fn` is registered as a watcher instead of a setInterval.
 * @param {number} opts.intervalMs - Interval in milliseconds (>0).
 * @param {function} opts.fn - The function to call each tick. Receives
 *   `Date.now()` as its argument on the setInterval path (ignored by callers
 *   that don't use it). May be sync or async.
 * @param {string} opts.name - Name for the clock watcher / log labels.
 * @returns {{stop(): void}} A handle whose `.stop()` is idempotent.
 */
export function createClockRunner({ clock, intervalMs, fn, name }) {
  if (clock) {
    const watcher = clock.add({ name, intervalMs, fn });
    return { stop() { watcher?.remove(); } };
  }

  const timer = setInterval(() => {
    (async () => {
      try {
        await fn(Date.now());
      } catch (err) {
        getLog().warn('system', `${name} tick failed`, { err });
      }
    })();
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}

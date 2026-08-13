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
 */
export function createClockRunner({ clock, intervalMs, fn, name }                    )               {
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

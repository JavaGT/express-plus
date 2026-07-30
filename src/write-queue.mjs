// write-queue.mjs — single-writer async mutex with bounded wait and depth.

import { AsyncLocalStorage } from 'node:async_hooks';

export function createWriteQueue({ maxDepth = 64, maxWaitMs = 5000, now = Date.now } = {}) {
  const ownership = new AsyncLocalStorage();
  let waiters = 0;
  let running = false;
  let closed = false;
  let lock = Promise.resolve();

  function invoke(fn) {
    const owner = { active: true };
    return Promise.resolve().then(() => ownership.run(owner, fn)).finally(() => {
      owner.active = false;
    });
  }
  
  function run(fn) {
    if (closed) {
      const err = new Error('write queue is closed');
      err.status = 503;
      return Promise.reject(err);
    }
    if (ownership.getStore()?.active) {
      return Promise.resolve().then(fn);
    }
    if (waiters + 1 >= maxDepth) {
      const err = new Error('write queue: depth limit exceeded');
      err.status = 503;
      return Promise.reject(err);
    }
    
    if (!running && waiters === 0) {
      running = true;
      let releaseNext;
      const completion = new Promise((r) => { releaseNext = r; });
      
      const result = invoke(fn);
      const wrapped = result.finally(() => {
        running = false;
        releaseNext();
      });
      lock = completion;
      return wrapped;
    }

    waiters++;
    
    let cancelled = false;
    let acquired = false;
    let releaseNext;
    const completion = new Promise((r) => { releaseNext = r; });
    
    const waitForLock = new Promise((resolve) => {
      lock = lock.then(() => {
        if (cancelled) {
          waiters--;
          releaseNext();
          return;
        }
        acquired = true;
        waiters--;
        running = true;
        resolve();
        return completion;
      });
    });
    
    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        if (!acquired) {
          // Set cancelled and reject fast (client gets 503 immediately). Do NOT
          // decrement `waiters` or releaseNext here — the lock-chain's
          // `if (cancelled)` branch does both, exactly once, when the held lock
          // releases. The waiters counter over-reports a dead waiter until then
          // (fail-closed: maxDepth guard trips earlier under starvation, never
          // later), avoiding the double-decrement drift that weakened it.
          cancelled = true;
          const err = new Error('write queue: wait timeout');
          err.status = 503;
          reject(err);
        }
      }, maxWaitMs);
    });
    
    return Promise.race([waitForLock, timeout]).finally(() => {
      clearTimeout(timeoutId);
    }).then(
      () => {
        return invoke(fn).finally(() => {
          running = false;
          releaseNext();
        });
      },
      (err) => {
        throw err;
      },
    );
  }

  // Stop admitting new writes and resolve once every already-admitted write has
  // released the mutex. Shutdown uses this to avoid closing durable resources
  // under an in-flight transaction.
  function close() {
    closed = true;
    return Promise.resolve(lock);
  }
  
  return {
    run,
    close,
    get depth() {
      return waiters;
    },
    get running() {
      return running;
    },
    get closed() {
      return closed;
    },
    get owned() {
      return ownership.getStore()?.active === true;
    },
  };
}

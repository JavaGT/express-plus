// write-queue.mjs — single-writer async mutex with bounded wait and depth.

export function createWriteQueue({ maxDepth = 64, maxWaitMs = 5000, now = Date.now } = {}) {
  let waiters = 0;
  let running = false;
  let lock = Promise.resolve();
  
  function run(fn) {
    if (waiters + 1 >= maxDepth) {
      const err = new Error('write queue: depth limit exceeded');
      err.status = 503;
      return Promise.reject(err);
    }
    
    if (!running && waiters === 0) {
      running = true;
      let releaseNext;
      const completion = new Promise((r) => { releaseNext = r; });
      
      try {
        const result = fn();
        if (result instanceof Promise) {
          const wrapped = result.finally(() => {
            running = false;
            releaseNext();
          });
          lock = completion;
          return wrapped;
        }
        running = false;
        releaseNext();
        return result;
      } catch (err) {
        running = false;
        releaseNext();
        throw err;
      }
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
    
    const timeout = new Promise((_, reject) => {
      setTimeout(() => {
        if (!acquired) {
          cancelled = true;
          waiters--;
          releaseNext();
          const err = new Error('write queue: wait timeout');
          err.status = 503;
          reject(err);
        }
      }, maxWaitMs);
    });
    
    return Promise.race([waitForLock, timeout]).then(
      () => {
        return Promise.resolve(fn()).finally(() => {
          running = false;
          releaseNext();
        });
      },
      (err) => {
        throw err;
      },
    );
  }
  
  return {
    run,
    get depth() {
      return waiters;
    },
    get running() {
      return running;
    },
  };
}

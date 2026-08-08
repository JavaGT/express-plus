// write-queue.mjs — single-writer async mutex with bounded wait and depth.

import { AsyncLocalStorage } from 'node:async_hooks';

export type WriteQueueOptions = {
  maxDepth?: number;
  maxWaitMs?: number;
  now?: () => number;
};

export type WriteQueue = {
  run<T>(fn: () => T): Promise<T>;
  close(): Promise<unknown>;
  readonly depth: number;
  readonly running: boolean;
  readonly closed: boolean;
  readonly owned: boolean;
};

export function createWriteQueue({
  maxDepth = 64,
  maxWaitMs = 5000,
  now = Date.now,
}: WriteQueueOptions = {}): WriteQueue {
  void now; // accepted option; timeout still uses wall-clock setTimeout (pre-existing)
  const ownership = new AsyncLocalStorage<{ active: boolean }>();
  let waiters = 0;
  let running = false;
  let closed = false;
  let lock: Promise<unknown> = Promise.resolve();

  function invoke(fn: () => unknown) {
    const owner = { active: true };
    return Promise.resolve()
      .then(() => ownership.run(owner, fn))
      .finally(() => {
        owner.active = false;
      });
  }

  function run<T>(fn: () => T): Promise<T> {
    if (closed) {
      const err = new Error('write queue is closed') as Error & { status: number };
      err.status = 503;
      return Promise.reject(err);
    }
    if (ownership.getStore()?.active) {
      return Promise.resolve().then(fn);
    }
    if (waiters + 1 >= maxDepth) {
      const err = new Error('write queue: depth limit exceeded') as Error & { status: number };
      err.status = 503;
      return Promise.reject(err);
    }

    if (!running && waiters === 0) {
      running = true;
      let releaseNext: () => void;
      const completion = new Promise<void>((r) => {
        releaseNext = r;
      });

      const result = invoke(fn);
      const wrapped = result.finally(() => {
        running = false;
        releaseNext();
      });
      lock = completion;
      return wrapped as Promise<T>;
    }

    waiters++;

    let cancelled = false;
    let acquired = false;
    let releaseNext: () => void;
    const completion = new Promise<void>((r) => {
      releaseNext = r;
    });

    const waitForLock = new Promise<void>((resolve) => {
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

    let timeoutId: NodeJS.Timeout;
    const timeout = new Promise<void>((_, reject) => {
      timeoutId = setTimeout(() => {
        if (!acquired) {
          // Set cancelled and reject fast (client gets 503 immediately). Do NOT
          // decrement `waiters` or releaseNext here — the lock-chain's
          // `if (cancelled)` branch does both, exactly once, when the held lock
          // releases. The waiters counter over-reports a dead waiter until then
          // (fail-closed: maxDepth guard trips earlier under starvation, never
          // later), avoiding the double-decrement drift that weakened it.
          cancelled = true;
          const err = new Error('write queue: wait timeout') as Error & { status: number };
          err.status = 503;
          reject(err);
        }
      }, maxWaitMs);
    });

    return Promise.race([waitForLock, timeout])
      .finally(() => {
        clearTimeout(timeoutId);
      })
      .then(
        () => {
          return (invoke(fn) as Promise<T>).finally(() => {
            running = false;
            releaseNext();
          });
        },
        (err: unknown) => {
          throw err;
        },
      );
  }

  // Stop admitting new writes and resolve once every already-admitted write has
  // released the mutex. Shutdown uses this to avoid closing durable resources
  // under an in-flight transaction.
  function close(): Promise<unknown> {
    closed = true;
    return Promise.resolve(lock);
  }

  return {
    run,
    close,
    get depth(): number {
      return waiters;
    },
    get running(): boolean {
      return running;
    },
    get closed(): boolean {
      return closed;
    },
    get owned(): boolean {
      return ownership.getStore()?.active === true;
    },
  };
}

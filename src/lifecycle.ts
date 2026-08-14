// Process lifecycle — graceful shutdown, signal traps, and live app registry.
//
// These traps belong to the PROCESS, not an app — installing them per app would
// accumulate listeners (a leak, and a MaxListeners warning). They are installed
// ONCE; the signal handler closes every registered app.

import { getLog } from './log.ts';

interface ShutdownHook {
  name: string;
  fn: () => unknown;
  timeoutMs: number;
}

interface AppLike {
  _shutdownHooks?: ShutdownHook[];
  onShutdown?: (name: string, fn: () => unknown, options?: { timeoutMs?: number }) => void;
  shutdown?: () => Promise<unknown>;
  _shutdownFromStartFailure?: () => Promise<unknown>;
  _shutdownStarted?: boolean;
  _startPromise?: Promise<unknown> | null;
  httpServer?: {
    listening?: boolean;
    close(callback?: () => void): unknown;
    closeIdleConnections?(): void;
    closeAllConnections?(): void;
  } | null;
  live?: { close?(): unknown } | null;
  writeQueue?: { close?(): unknown } | null;
  // The db adapter: either an opened database (close()) or — until the deferred
  // open completes (A1 contract) — the pending DbAdapter itself (no close, with
  // `_dbOpen` carrying the open). Closed on shutdown (checkpoint-then-close).
  _dbAdapter?: { close?: () => unknown } | null;
  _dbOpen?: () => Promise<unknown>;
  _detachJobLive?: (() => unknown) | null;
}

// The set of live apps to close on a shutdown signal.
const liveApps = new Set<AppLike>();
let processTrapsInstalled = false;
const PROCESS_SHUTDOWN_DEADLINE_MS = 10_000;

export function installProcessTraps() {
  if (processTrapsInstalled) return;
  processTrapsInstalled = true;

  let draining = false;
  const onSignal = () => {
    // A second signal is an explicit operator request to stop waiting. This
    // remains available while the first signal drains application owners.
    if (draining) {
      process.exit(1);
      return;
    }
    draining = true;
    const deadline = setTimeout(() => process.exit(1), PROCESS_SHUTDOWN_DEADLINE_MS);
    Promise.allSettled(
      [...liveApps].map((app) => Promise.resolve().then(() => app.shutdown!())),
    ).then((results) => {
      for (const result of results) {
        if (result.status !== 'rejected') continue;
        getLog().error('system', 'application shutdown failed', { err: result.reason });
        process.stderr.write(`application shutdown failed: ${(result.reason as { stack?: unknown } | null | undefined)?.stack ?? result.reason}\n`);
      }
    }).finally(() => {
      clearTimeout(deadline);
      process.exit(0);
    });
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  process.on('unhandledRejection', (reason) => {
    if (isBrokenPipeError(reason)) {
      process.exit(1);
      return;
    }
    const log = getLog();
    log.error('system', 'unhandledRejection', { reason });
    process.stderr.write(`unhandledRejection: ${reason}\n`);
  });
  process.on('uncaughtException', (err) => {
    // A write to a dead stdio pipe surfaces here as an async EPIPE error.
    // Every attempt to log it fails the same way and re-enters this handler
    // (stderr.write -> EPIPE -> uncaughtException -> ...), spinning the event
    // loop at full CPU on an orphaned process. There is nothing left to log
    // to, so exit — the same fate plain SIGPIPE would have delivered.
    if (isBrokenPipeError(err)) {
      process.exit(1);
      return;
    }
    const log = getLog();
    log.error('system', 'uncaughtException', { err });
    process.stderr.write(`uncaughtException: ${err?.stack ?? err}\n`);
  });
}

// A write to a closed pipe/socket raises EPIPE (or ECONNRESET) on the stream;
// unhandled it arrives here as an uncaughtException/rejection. Detect it so
// the trap cannot loop forever logging into a broken stderr.
function isBrokenPipeError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null | undefined)?.code;
  return code === 'EPIPE' || code === 'ECONNRESET';
}

// The graceful-shutdown seam. `app.shutdown()` closes the live server (resolving
// once it has stopped accepting connections) and unregisters the app. SIGTERM/
// SIGINT close every registered app; an unhandledRejection/uncaughtException is
// trapped so a stray rejection cannot crash the process silently. The framework
// owns these — an app that mounted its own would be a leak.
//
// onShutdown registry (eng-review #16): apps register named hooks with deadlines.
// Hooks run in registration order on shutdown; each bounded by its timeoutMs.
// A hook exceeding its deadline is force-abandoned (resolve with timeout error, log,
// continue to next).
export function prepareGracefulShutdown(app: AppLike): AppLike {
  if (!app._shutdownHooks) {
    app._shutdownHooks = [];
  }
  const hooks = app._shutdownHooks;
  if (!app.onShutdown) {
    app.onShutdown = (name, fn, { timeoutMs = 5000 } = {}) => {
      hooks.push({ name, fn, timeoutMs });
    };
  }
  if (!app.shutdown) {
    let shutdownPromise: Promise<unknown> | undefined;
    const beginShutdown = ({ waitForStart }: { waitForStart: boolean }): Promise<unknown> => {
      if (shutdownPromise) return shutdownPromise;
      app._shutdownStarted = true;
      shutdownPromise = (async () => {
        // Stop transport ingress first. Live owns its connections and paced
        // timers; the HTTP close promise resolves after accepted requests end.
        try { app.live?.close?.(); } catch { /* best-effort transport close */ }
        try { app._detachJobLive?.(); } catch { /* best-effort listener detach */ }
        const serverClosed = new Promise<void>((resolve) => {
          const server = app.httpServer;
          if (!server?.listening) return resolve();
          server.close(() => resolve());
          server.closeIdleConnections?.();
        });

        // A user may shut down immediately after listen() while asynchronous
        // route/schema boot is still running. Let that singular boot promise
        // reach a safe stop point before releasing its application owners. A
        // boot failure uses the private no-wait path below to avoid awaiting
        // itself from inside its own rejection handler.
        if (waitForStart) {
          await app._startPromise?.catch(() => {});
        }

        // Stop application-owned background producers before closing the write
        // queue. Each hook has a real, cleared deadline timer and cannot prevent
        // later owners from being released.
        for (const hook of hooks) {
          let timeoutId: NodeJS.Timeout | undefined;
          const deadline = new Promise<unknown>((_, reject) => {
            timeoutId = setTimeout(
              () => reject(new Error(`onShutdown hook '${hook.name}' exceeded ${hook.timeoutMs}ms deadline`)),
              hook.timeoutMs,
            );
          });
          try {
            await Promise.race([Promise.resolve().then(() => hook.fn()), deadline]);
          } catch (err) {
            getLog().warn('system', `onShutdown hook '${hook.name}' failed`, { err, hook: hook.name });
            process.stderr.write(`onShutdown hook '${hook.name}' failed: ${(err as Error).message}\n`);
          } finally {
            clearTimeout(timeoutId);
          }
        }

        await app.writeQueue?.close?.();
        // Checkpoint + close the db adapter after the write queue has drained
        // (S1/A2): close() runs wal_checkpoint(TRUNCATE) then releases the
        // OS-backed ownership lock, so the durable resource is never closed
        // under an in-flight transaction. A DEFERRED adapter (A1 contract — the
        // app received a DbAdapter, not an opened database) is opened first so
        // its opened database can be closed. Close failures are recorded and
        // re-thrown once cleanup completes: a checkpoint/close failure surfaces
        // to app.shutdown()'s caller instead of being silently swallowed.
        let shutdownFailure: unknown;
        let dbAdapter = app._dbAdapter;
        if (app._dbOpen && typeof dbAdapter?.close !== 'function') {
          try {
            dbAdapter = (await app._dbOpen()) as AppLike['_dbAdapter'];
          } catch (err) {
            // The open itself failed (already surfaced through app.ready / the
            // boot promise) — there is no opened database to close.
            shutdownFailure = err;
          }
        }
        if (typeof dbAdapter?.close === 'function') {
          try {
            await dbAdapter.close();
          } catch (err) {
            shutdownFailure ??= err;
            getLog().error('system', 'database adapter close failed', { err });
            process.stderr.write(`database adapter close failed: ${(err as { stack?: unknown }).stack ?? err}\n`);
          }
        }
        // After hooks release application-owned producers (including live
        // delivery), destroy any sockets that remain. closeIdleConnections at
        // the top only drops idle keep-alives — an active SSE stream is not
        // idle and would pin server.close() forever without this backstop.
        try { app.httpServer?.closeAllConnections?.(); } catch { /* best-effort */ }
        await serverClosed;
        liveApps.delete(app);
        if (shutdownFailure) throw shutdownFailure;
      })();
      return shutdownPromise;
    };
    app.shutdown = () => beginShutdown({ waitForStart: true });
    app._shutdownFromStartFailure = () => beginShutdown({ waitForStart: false });
  }
  return app;
}

export function installGracefulShutdown(app: AppLike): void {
  prepareGracefulShutdown(app);
  liveApps.add(app);
  installProcessTraps();
}

// Process lifecycle — graceful shutdown, signal traps, and live app registry.
//
// These traps belong to the PROCESS, not an app — installing them per app would
// accumulate listeners (a leak, and a MaxListeners warning). They are installed
// ONCE; the signal handler closes every registered app.

import { getLog } from './log.mjs';

// The set of live apps to close on a shutdown signal.
const liveApps = new Set();
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
      [...liveApps].map((app) => Promise.resolve().then(() => app.shutdown())),
    ).then((results) => {
      for (const result of results) {
        if (result.status !== 'rejected') continue;
        getLog().error('system', 'application shutdown failed', { err: result.reason });
        process.stderr.write(`application shutdown failed: ${result.reason?.stack ?? result.reason}\n`);
      }
    }).finally(() => {
      clearTimeout(deadline);
      process.exit(0);
    });
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  process.on('unhandledRejection', (reason) => {
    const log = getLog();
    log.error('system', 'unhandledRejection', { reason });
    process.stderr.write(`unhandledRejection: ${reason}\n`);
  });
  process.on('uncaughtException', (err) => {
    const log = getLog();
    log.error('system', 'uncaughtException', { err });
    process.stderr.write(`uncaughtException: ${err?.stack ?? err}\n`);
  });
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
export function prepareGracefulShutdown(app) {
  if (!app._shutdownHooks) {
    app._shutdownHooks = [];
  }
  if (!app.onShutdown) {
    app.onShutdown = (name, fn, { timeoutMs = 5000 } = {}) => {
      app._shutdownHooks.push({ name, fn, timeoutMs });
    };
  }
  if (!app.shutdown) {
    let shutdownPromise;
    const beginShutdown = ({ waitForStart }) => {
      if (shutdownPromise) return shutdownPromise;
      app._shutdownStarted = true;
      shutdownPromise = (async () => {
        // Stop transport ingress first. Live owns its connections and paced
        // timers; the HTTP close promise resolves after accepted requests end.
        try { app.live?.close?.(); } catch { /* best-effort transport close */ }
        try { app._detachJobLive?.(); } catch { /* best-effort listener detach */ }
        const serverClosed = new Promise((resolve) => {
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
        for (const hook of app._shutdownHooks) {
          let timeoutId;
          const deadline = new Promise((_, reject) => {
            timeoutId = setTimeout(
              () => reject(new Error(`onShutdown hook '${hook.name}' exceeded ${hook.timeoutMs}ms deadline`)),
              hook.timeoutMs,
            );
          });
          try {
            await Promise.race([Promise.resolve().then(() => hook.fn()), deadline]);
          } catch (err) {
            getLog().warn('system', `onShutdown hook '${hook.name}' failed`, { err, hook: hook.name });
            process.stderr.write(`onShutdown hook '${hook.name}' failed: ${err.message}\n`);
          } finally {
            clearTimeout(timeoutId);
          }
        }

        await app.writeQueue?.close?.();
        // After hooks release application-owned producers (including live
        // delivery), destroy any sockets that remain. closeIdleConnections at
        // the top only drops idle keep-alives — an active SSE stream is not
        // idle and would pin server.close() forever without this backstop.
        try { app.httpServer?.closeAllConnections?.(); } catch { /* best-effort */ }
        await serverClosed;
        liveApps.delete(app);
      })();
      return shutdownPromise;
    };
    app.shutdown = () => beginShutdown({ waitForStart: true });
    app._shutdownFromStartFailure = () => beginShutdown({ waitForStart: false });
  }
  return app;
}

export function installGracefulShutdown(app) {
  prepareGracefulShutdown(app);
  liveApps.add(app);
  installProcessTraps();
}

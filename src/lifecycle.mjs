// Process lifecycle — graceful shutdown, signal traps, and live app registry.
//
// These traps belong to the PROCESS, not an app — installing them per app would
// accumulate listeners (a leak, and a MaxListeners warning). They are installed
// ONCE; the signal handler closes every registered app.

import { getLog } from './log.mjs';

// The set of live apps to close on a shutdown signal.
const liveApps = new Set();
let processTrapsInstalled = false;

export function installProcessTraps() {
  if (processTrapsInstalled) return;
  processTrapsInstalled = true;

  const onSignal = () => {
    Promise.all([...liveApps].map((a) => a.shutdown())).then(() => process.exit(0));
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
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
export function installGracefulShutdown(app) {
  if (!app._shutdownHooks) {
    app._shutdownHooks = [];
  }
  if (!app.onShutdown) {
    app.onShutdown = (name, fn, { timeoutMs = 5000 } = {}) => {
      app._shutdownHooks.push({ name, fn, timeoutMs });
    };
  }
  if (!app.shutdown) {
    app.shutdown = () =>
      new Promise((resolve) => {
        // Run registered hooks first, each bounded by its deadline
        const runHooks = async () => {
          for (const hook of app._shutdownHooks) {
            const timer = new Promise((_, reject) => {
              const t = setTimeout(() => {
                clearTimeout(t);
                reject(new Error(`onShutdown hook '${hook.name}' exceeded ${hook.timeoutMs}ms deadline`));
              }, hook.timeoutMs);
            });
            try {
              await Promise.race([hook.fn(), timer]);
            } catch (err) {
              getLog().warn('system', `onShutdown hook '${hook.name}' failed`, { err, hook: hook.name });
              process.stderr.write(`onShutdown hook '${hook.name}' failed: ${err.message}\n`);
              // Continue to next hook (force-abandon on timeout)
            }
          }
        };
        // Close http server and live server, then resolve
        const closeServer = () => new Promise((resolveClose) => {
          if (app.httpServer && app.httpServer.listening) {
            app.httpServer.close(() => {
              liveApps.delete(app);
              resolveClose();
            });
          } else {
            liveApps.delete(app);
            resolveClose();
          }
        });
        // Run hooks then close
        runHooks().then(closeServer).then(resolve);
      });
  }
  liveApps.add(app);
  installProcessTraps();
}

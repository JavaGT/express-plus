// Framework-wide structured logger. Agents and humans can read it.
//
// DESIGN:
//   One logger per application runtime. Nested asynchronous work resolves the
//   logger from its owning application context.
//   Every channel (auth, dispatch, http, live, projected, system) has its own
//   minimum level; messages below that level are dropped.  Output is configurable
//   — stderr (default), a file stream, or a callback for custom sinks.
//
// LEVELS (ascending severity):
//   trace < debug < info < warn < error
//
//   trace — ultra-verbose, every single step (only for deep debugging)
//   debug — internal decisions: scope compiled, dispatch result, hydrate shape
//   info  — operational milestones: server started, entity created, row removed
//   warn  — something went wrong but recovered: compute failed, blob reap failed
//   error — a hard failure the operator should investigate: dispatch error, auth bypass
//
// FORMAT:
//   JSON lines to stderr by default (one JSON object per line). An agent can read
//   stderr as newline-delimited JSON and feed it into any log parser.  In 'human'
//   mode, each entry is a colorized single-line summary for terminal readers.
//
// CHANNELS:
//   auth       — scope compilation, row-grant decisions, principal construction
//   dispatch   — kernel.dispatch, action dedup, event finalization
//   http       — request/response lifecycle (method, path, status, duration)
//   live       — WebSocket subscribe/unsubscribe, re-auth, emit
//   projected  — post-commit consumer: compute, serialize, cursor advance
//   system     — server start/stop, shutdown hooks, tick/reaper sweeps
//
// CONFIG:
//   Every framework module imports `getLog()` to reach the logger selected by
//   the current application operation. `withLog()` establishes that context at
//   application boundaries (request, dispatch, schema preparation). The fallback
//   logger is process-wide only for work that has no owning application.
//
//   const log = createLog({
//     level: 'info',               // global floor — channels override
//     channels: { auth: 'debug', dispatch: 'warn' },
//     format: 'json',              // 'json' | 'human'
//     output: process.stderr,      // writable stream or callback
//   });
//
// USAGE:
//   import { getLog } from './log.mjs';
//   const log = getLog();
//   log.info('http', 'GET /notes/abc 200', { method: 'GET', path: '/notes/abc', status: 200, durationMs: 12 });
//   log.warn('auth', 'update denied', { entity: 'Note', id: 'n1', principal: 'bob', verb: 'update', reason: 'not owner' });
//   log.error('dispatch', 'dispatch failed', { err, actionId: '...', entity: 'Note', type: 'Note.create' });
//
//   The context object is serialized as-is into the JSON `ctx` field. Error objects
//   are keyed as `err` with { message, code, stack } expansion.

import { AsyncLocalStorage } from 'node:async_hooks';





















const applicationLog = new AsyncLocalStorage              ();
let fallbackLog                      = null;

const LEVELS                         = Object.freeze({ error: 0, warn: 1, info: 2, debug: 3, trace: 4 });

function numericLevel(name        )         {
  return LEVELS[name] ?? LEVELS.info;
}

// Color escape codes (terminal). Only used in 'human' format.
const ANSI                         = Object.freeze({ red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m', dim: '\x1b[2m', reset: '\x1b[0m' });

function colorForLevel(level        )         {
  switch (level) {
    case 'error': return ANSI.red;
    case 'warn':  return ANSI.yellow;
    case 'info':  return ANSI.cyan;
    case 'debug': return ANSI.dim;
    case 'trace': return ANSI.dim;
    default:      return '';
  }
}

function isoNow()         {
  return new Date().toISOString();
}

// Upgrade an Error-like object into a safe { message, code, stack } record.
// Null/undefined/plain values pass through — only Error instances are expanded.
function serializeError(err         )          {
  if (!err) return err;
  if (err instanceof Error) {
    return { message: err.message, code: (err                     ).code ?? undefined, stack: err.stack ?? undefined };
  }
  return err;
}

function formatHuman(level        , channel        , message        , ctx                        , _at        )         {
  const c = colorForLevel(level);
  const tag = `${c}[${level.padEnd(5).toUpperCase()} ${channel.padEnd(8)}]${ANSI.reset}`;
  let line = `${tag} ${message}`;
  if (ctx && Object.keys(ctx).length > 0) {
    const parts           = [];
    for (const [k, v] of Object.entries(ctx)) {
      if (k === 'err' || k === 'error') {
        parts.push(`${k}=${(serializeError(v)                                    )?.message ?? v}`);
      } else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        parts.push(`${k}=${v}`);
      }
    }
    if (parts.length) line += ` ${ANSI.dim}${parts.join(' ')}${ANSI.reset}`;
  }
  return line;
}

export function createLog({ level = 'info', channels = {}, format = 'json', output = process.stderr }                   = {})               {
  const globalFloor = numericLevel(level);
  const channelFloors                         = {};
  for (const [ch, lvl] of Object.entries(channels)) {
    channelFloors[ch] = numericLevel(lvl);
  }

  function shouldLog(channel        , msgLevel        )          {
    const floor = channelFloors[channel] ?? globalFloor;
    return numericLevel(msgLevel) <= floor;
  }

  function emit(levelName        , channel        , message        , ctx                         = {}) {
    if (!shouldLog(channel, levelName)) return;

    if (typeof output === 'function') {
      output(levelName, channel, message, ctx);
      return;
    }

    if (format === 'json') {
      const entry                          = { level: levelName, channel, at: isoNow(), msg: message };
      if (ctx && Object.keys(ctx).length > 0) {
        const safeCtx                          = {};
        for (const [k, v] of Object.entries(ctx)) {
          safeCtx[k] = k === 'err' || k === 'error' ? serializeError(v) : v;
        }
        entry.ctx = safeCtx;
      }
      output.write(JSON.stringify(entry) + '\n', 'utf8');
    } else {
      output.write(formatHuman(levelName, channel, message, ctx, isoNow()) + '\n', 'utf8');
    }
  }

  const log               = {
    level: globalFloor,
    channels,
    format,
    trace(channel, message, ctx) { emit('trace', channel, message, ctx); },
    debug(channel, message, ctx) { emit('debug', channel, message, ctx); },
    info(channel, message, ctx)  { emit('info', channel, message, ctx); },
    warn(channel, message, ctx)  { emit('warn', channel, message, ctx); },
    error(channel, message, ctx) { emit('error', channel, message, ctx); },
  };

  return log;
}

// Retained for compatibility with callers that configure framework work lacking
// an application owner. Application construction never calls this function.
export function setAmbientLog(log                     ) { fallbackLog = log; }

export function withLog(log                                 , operation               )          {
  if (!log) return operation();
  return applicationLog.run(log, operation);
}

export function getLog()               {
  const ownedLog = applicationLog.getStore();
  if (ownedLog) return ownedLog;
  if (!fallbackLog) {
    fallbackLog = createLog({ level: 'warn', format: 'json', output: process.stderr });
  }
  return fallbackLog;
}

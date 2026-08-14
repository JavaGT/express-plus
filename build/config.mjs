// config.mjs — the environment-override surface (SPEC §3).
//
// The framework owns the boilerplate every server repeats; `config` is the one
// place an app reads deployment knobs (port, env) instead of re-implementing
// them. Values are sourced from the process environment with sensible defaults,
// so an app that sets nothing still runs.
//
// `env` remains process-level and never client-controlled. Unexpected errors
// are opaque on the wire in every mode; environment belongs in server logs and
// other deployment behavior, not in the public failure grammar.








function readPort(raw                             )         {
  const n = Number.parseInt(String(raw ?? ''), 10);
  return Number.isInteger(n) && n >= 0 ? n : 3000;
}

// resolveConfig — the per-app config surface (SPEC §3). An app passes
// `{ port, env, viewsDir, session: { durationMs } }` to `workbench()` and every
// option overrides its env fallback; an option left absent behaves exactly like
// the process-wide singleton below (env-sourced defaults). The frozen shape is
// the same four keys every consumer reads, so `app.config` and the singleton
// are interchangeable to readers — only the values differ per app.
export function resolveConfig(options




 )                  {
  return Object.freeze({
    port: readPort(options?.port ?? process.env.PORT),
    env: options?.env ?? process.env.NODE_ENV ?? 'production',
    viewsDir: options?.viewsDir ?? process.env.VIEWS_DIR ?? null, // null → framework default (cwd/views)
    sessionDurationMs: options?.session?.durationMs ?? 7 * 86_400_000, // 7 days — Session schedule.after expiry
  });
}

// The process-wide singleton: env-sourced defaults for the consumers that have
// no app in reach (module-level helpers in session/middleware/field-delta) and
// the fallback `listen()`/`makeRequestHandler` read when an app omits an option.
// Identical to `resolveConfig()` with no args — one mechanism, not two.
export const config                  = resolveConfig();

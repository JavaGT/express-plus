// config.mjs — the environment-override surface (SPEC §3).
//
// The framework owns the boilerplate every server repeats; `config` is the one
// place an app reads deployment knobs (port, env) instead of re-implementing
// them. Values are sourced from the process environment with sensible defaults,
// so an app that sets nothing still runs.
//
// `env` drives the error renderer's mode (a dev stack trace vs an opaque
// prod-safe body). It is process-level, never client-controlled — a client must
// never be able to force a stack trace.

function readPort(raw) {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isInteger(n) && n >= 0 ? n : 3000;
}

export const config = Object.freeze({
  port: readPort(process.env.PORT),
  env: process.env.NODE_ENV ?? 'development',
  viewsDir: process.env.VIEWS_DIR ?? null, // null → framework default (cwd/views)
});

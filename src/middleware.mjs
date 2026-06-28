// middleware.mjs — the baked-in default behaviors the framework applies to every
// response (SPEC §3). The app mounts none of this by hand; if it had to, that
// would be a leak (AGENTS.md → Defaults). Each default here is fail-closed and
// needs no per-app knowledge.

import { config } from './config.mjs';

// Security headers set on EVERY response — including 401/404/500. These are the
// safe-without-per-app-knowledge defaults: stop MIME sniffing, deny framing
// (clickjacking), and never leak the URL in a referrer. Policies that need
// per-app input (CSP, HSTS) are deliberately NOT baked in — they are app
// declarations, not framework defaults, and a wrong default there breaks apps.
const SECURITY_HEADERS = Object.freeze({
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'x-dns-prefetch-control': 'off',
});

// Apply the security headers to a response before its head is written. Idempotent
// and unconditional — every exit path runs through here.
export function applySecurityHeaders(res) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(name, value);
  }
}

// The single error renderer — the SPEC §3 "4-argument JSON error handler". It is
// the ONE place an unexpected exception becomes a client response, so dev/prod
// behavior is decided in one spot. In development it includes the stack to aid
// debugging; in production it is opaque (no stack, no internal message) so an
// internal failure never leaks implementation detail. `env` is server-owned
// (a listen option, defaulting to config.env) — never client-controlled.
export function renderError(res, err, { env = config.env } = {}) {
  const body =
    env === 'production'
      ? { error: 'internal error' }
      : { error: 'internal error', message: String(err?.message ?? err), stack: err?.stack };
  const payload = JSON.stringify(body);
  if (!res.headersSent) {
    res.writeHead(500, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
    });
  }
  res.end(payload);
}

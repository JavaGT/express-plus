// middleware.mjs — the baked-in default behaviors the framework applies to every
// response (SPEC §3). The app mounts none of this by hand; if it had to, that
// would be a leak (AGENTS.md → Defaults). Each default here is fail-closed and
// needs no per-app knowledge.

import { config } from './config.mjs';
import { canWriteResponse, warnLateResponse } from './http-response.mjs';

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
export const applySecurityHeaders = (res) => Object.entries(SECURITY_HEADERS).forEach(([name, value]) => res.setHeader(name, value));

// Same-origin verification — the ONE implementation used by both transports:
// the REST CSRF guard (serve.mjs) and the WebSocket upgrade handshake (live.mjs).
// A single mechanism so the two can never drift (AGENTS.md → no second auth path).
//
// `sameOriginAsHost` returns the verdict of ONE header against the request Host:
//   null  — header absent (caller decides the fallback)
//   true  — present and same-origin
//   false — present and foreign OR unparseable (fail closed)
export function sameOriginAsHost(headerValue, host) {
  if (!headerValue) return null; // absent — caller falls back / allows
  try {
    return new URL(headerValue).host === host;
  } catch {
    return false; // present but unparseable → treat as foreign (fail closed)
  }
}

// The composed same-origin admission used by state-changing transports. An
// Origin header, when present, is authoritative; a Referer is the fallback;
// neither present → a non-browser client (no CSRF/CSWSH vector) is allowed.
// Browsers ALWAYS attach Origin to a cross-origin WebSocket handshake, so an
// absent Origin cannot be a cross-site attack — the allow is safe.
export function isSameOriginRequest(req) {
  const host = req.headers.host;
  const origin = sameOriginAsHost(req.headers.origin, host);
  if (origin !== null) return origin;   // Origin present → its verdict stands
  const referer = sameOriginAsHost(req.headers.referer, host);
  if (referer !== null) return referer; // no Origin; Referer present → its verdict
  return true;                          // neither present → non-browser client, allow
}

// The single error renderer — the SPEC §3 "4-argument JSON error handler". It is
// the ONE place an error becomes a client response, so the dev/prod and
// deliberate/unexpected decisions are all made in one spot.
//
// Two shapes reach here, distinguished by a NUMERIC `status`:
//   * a DELIBERATE client error — `next({ status, message })` from a handler, a
//     thrown error carrying a numeric `status` — is the handler SAYING WHAT TO
//     SEND. Its status and message are client-visible by intent (e.g. 401 "bad
//     credentials"), in every environment.
//   * an UNEXPECTED exception — a thrown Error with no numeric `status` — is a
//     failure the handler did not anticipate. It is opaque in production (no
//     stack, no internal message, so an internal failure never leaks
//     implementation detail) and a 500-with-stack in development.
//
// `env` is server-owned (a listen option, defaulting to config.env) — never
// client-controlled.
export function renderError(res, err, { env = config.env } = {}) {
  if (!canWriteResponse(res, 'renderError', err)) return;
  const deliberate = typeof err?.status === 'number';
  const status = deliberate ? err.status : 500;
  const body = deliberate
    ? { error: String(err.message ?? '') }
    : env === 'production'
      ? { error: 'internal error' }
      : { error: 'internal error', message: String(err?.message ?? err), stack: err?.stack };
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

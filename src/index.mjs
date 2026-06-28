// express-plus — public entry point.
//
// Built phase by phase against the canonical SPEC.md. Each export lands with a
// failing test first (TDD iron law). Phase 0: the async `is.*` guard.

export { check, resolveDecision, UnawaitedCheckError } from './check.mjs';
export { assertGuarded } from './guard/static.mjs';
export { text, boolean, date, ref, hash } from './field.mjs';
export { resolveStrategy, validateMutation, ValidationError } from './field-strategy.mjs';
export { read, write, subscribe, grant, deny } from './grant.mjs';
export { scope } from './scope.mjs';
export { entity } from './entity.mjs';
export { everyone, never, anyOf, inherit, NonCompilableError, bindReadScope } from './scope-sql.mjs';
export { principal, anonymous, UnknownPrincipalTypeError } from './principal.mjs';
export { requireUser, allowAnonymous, open, isGate, resolveRouteGate, routeGateFor, ROUTE_VERBS } from './route-gate.mjs';
export { action, event, createServer, createClient } from './pipeline.mjs';
export { config } from './config.mjs';
export { parseCookies, sessionCookie, sessionPrincipalOf, SESSION_COOKIE } from './session.mjs';
export { default, router } from './app.mjs';

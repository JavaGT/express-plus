// express-plus — public entry point.
//
// Built phase by phase against the canonical SPEC.md. Each export lands with a
// failing test first (TDD iron law). Phase 0: the async `is.*` guard.

export { check, resolveDecision, UnawaitedCheckError } from './check.mjs';
export { assertGuarded } from './guard/static.mjs';
export { text, boolean, date, number, ref, hash, blob, link, map, list, log, presence, ephemeral, state } from './field.mjs';
export { now } from './deferred.mjs';
export { resolveStrategy, validateMutation, ValidationError } from './field-strategy.mjs';
export { read, write, subscribe, admin, grant, deny } from './grant.mjs';
export { scope } from './scope.mjs';
export { entity } from './entity.mjs';
export { User, Session, Inbox } from './auth-entities.mjs';
export { everyone, never, anyOf, inherit, NonCompilableError, bindReadScope } from './scope-sql.mjs';
export { principal, anonymous, UnknownPrincipalTypeError, principalFrom, effectSource } from './principal.mjs';
export { requireUser, allowAnonymous, open, isGate, resolveRouteGate, routeGateFor, ROUTE_VERBS } from './route-gate.mjs';
export { action, event, createServer, createClient, NOW } from './pipeline.mjs';
export { createLiveServer } from './live.mjs';
export { upgradeWebSocket, FrameSender, FrameParser } from './websocket.mjs';
export { resolveTemplate, matchExtension, isSafePath } from './views.mjs';
export { mayVerb, mayFieldOp } from './row-grant.mjs';
export { generateDDL, executeDDL, generateFrameworkDDL, executeFrameworkDDL } from './ddl.mjs';
export { config } from './config.mjs';
export { parseCookies, sessionCookie, sessionPrincipalOf, SESSION_COOKIE } from './session.mjs';
export { default, router } from './app.mjs';
export { inc, dec, self, many, effect, validateEffectDeclaration, createEffectContext, checkEffectDepth, executeEffectsForEvent, buildEffectsRegistry, buildEffectsGraph, validateEffects, verifyAdmissionHandshake, detectCrossEntityCycles, compileEntityEffects } from './effect-compiler.mjs';
export { schedule, tick, tickSource, discoverTickedRows, admitTickedMutation, discoverDueSchedules } from './schedule.mjs';
export { startTickEngine } from './tick-engine.mjs';
export { startReaper } from './reaper.mjs';

// Type-level contract for the grammar modules (replay decision, scope handle,
// event identity handle). These are internal-only runtime exports (src/internal.mjs)
// and are NOT on any public package export, so consumers type-check against the
// underlying `.ts` modules directly (mirroring src/internal.mjs which re-exports them).
//
// Positive cases assert the shapes; `@ts-expect-error` cases pin the brands and
// discriminants so refactors cannot silently loosen them.

import {
  decideReplay,
  normalizeSeqSpan,
  type ReplayDecision,
  type SeqSpan,
} from '../src/replay-decision.ts';
import {
  isScopeHandle,
  parseScopeKey,
  scopeOf,
  tryParseScopeKey,
  type ScopeHandle,
} from '../src/scope-handle.ts';
import {
  created,
  EventKind,
  lifecycleVerb,
  native,
  parseEventType,
  updated,
  type EventIdentityHandle,
} from '../src/event-handle.ts';

// ── Seq span ────────────────────────────────────────────────────────────

const single: SeqSpan = normalizeSeqSpan(5);
const ranged: SeqSpan = normalizeSeqSpan([1, 5]);
const rangedArray: SeqSpan = normalizeSeqSpan([1, 5] as number[]);
void [single, ranged, rangedArray];

// ── Replay decision discriminant keys ───────────────────────────────────

const nextDecision: ReplayDecision = decideReplay(0, 1);
const gapDecision: ReplayDecision = decideReplay(1, 5);
const dupDecision: ReplayDecision = decideReplay(5, 1);
const nextCursor: number = nextDecision.kind === 'next' ? nextDecision.cursor : 0;
// @ts-expect-error duplicate decisions carry no cursor
if (dupDecision.kind === 'duplicate') dupDecision.cursor;
// @ts-expect-error gap decisions carry no cursor
if (gapDecision.kind === 'gap') gapDecision.cursor;
// @ts-expect-error next decisions carry no cursor when narrowed to duplicate
if (nextDecision.kind === 'duplicate') nextDecision.cursor;
void [nextCursor, gapDecision, dupDecision];

// ── Scope handle brand ──────────────────────────────────────────────────

const scope: ScopeHandle = scopeOf('Project', 'project-1');
const projectScope: ScopeHandle = scopeOf('Project', 42);
const keyScope: string = projectScope.key;
const parsedScope: ScopeHandle = parseScopeKey('Project:project-1');
const maybeScope: ScopeHandle | null = tryParseScopeKey('Project:project-1');
const nullScope: ScopeHandle | null = tryParseScopeKey('not-a-key');
const recognizedScope: boolean = isScopeHandle(scope);
const recognizedScopeString: boolean = isScopeHandle('Project:project-1');
// @ts-expect-error a scope handle must carry the scope-handle brand
const forgedScope: ScopeHandle = { entity: 'Project', id: '1', key: 'Project:1' };
// @ts-expect-error a scope handle cannot omit its entity
const missingEntityScope: ScopeHandle = { brand: 'scope-handle', id: '1', key: ':1', toString: () => ':1' };
void [keyScope, parsedScope, maybeScope, nullScope, recognizedScope, recognizedScopeString, forgedScope, missingEntityScope];

// ── Event identity handle brand ─────────────────────────────────────────

const createdHandle: EventIdentityHandle = created('Project');
const updatedHandle: EventIdentityHandle = updated('Project');
const nativeHandle: EventIdentityHandle = native('Project', 'name', 'set');
const parsedHandle: EventIdentityHandle = parseEventType('Project.created');
const lifecycleVerbOfCreated: 'create' | 'update' | 'remove' | undefined = lifecycleVerb(createdHandle);
const lifecycleVerbOfNative: 'create' | 'update' | 'remove' | undefined = lifecycleVerb(nativeHandle);
const eventKindLiteral: 'created' | 'updated' | 'removed' | 'fieldSet' | 'native' = EventKind.created;
void [updatedHandle, nativeHandle, parsedHandle, lifecycleVerbOfCreated, lifecycleVerbOfNative, eventKindLiteral];
// @ts-expect-error lifecycle (created) handles carry no field
createdHandle.field;
// @ts-expect-error lifecycle (created) handles carry no nativeName
createdHandle.nativeName;
// @ts-expect-error a native handle must carry field and nativeName
const forgedNative: EventIdentityHandle = { brand: 'event-handle', entity: 'Project', kind: EventKind.native, type: 'Project.x.y', toString: () => '' };
void forgedNative;

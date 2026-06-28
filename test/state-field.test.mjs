import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entity, state, text, date, scope, everyone, grant, read } from '../src/index.mjs';

// `state({ values, transitions, effects, auto })` — a finite-state-machine field.
// It is its own KIND (`state`): a closed value domain plus a declared legal-
// transition graph. The values/transitions are config (the legal moves), never
// a free-form column the app may set to anything (fail closed: a move not in the
// graph is rejected). `state.transition(from, to)` is a STATIC method returning a
// typed, stringifiable transition handle usable as a COMPUTED OBJECT KEY in the
// `effects` map (never a magic string — a typed handle, AGENTS no-magic-strings).
// Import-surface scope: deliver the descriptor the entity compiler accepts; the
// transition enforcement, effect wiring, and `auto` scheduler are deferred behavior.

test('state() returns a frozen state-kind descriptor', () => {
  const field = state({ values: ['draft', 'shared', 'archived'] });
  assert.equal(field.kind, 'state');
  assert.equal(field.type, 'state');
  assert.ok(Object.isFrozen(field));
});

test('state carries its declared values, transitions, effects, and auto', () => {
  const field = state({
    values: ['draft', 'shared', 'archived'],
    transitions: { draft: ['shared'], shared: ['archived', 'draft'], archived: ['draft'] },
    auto: { when: 'shared', after: '90d', to: 'archived' },
  });
  assert.deepEqual(field.values, ['draft', 'shared', 'archived']);
  assert.deepEqual(field.transitions, {
    draft: ['shared'],
    shared: ['archived', 'draft'],
    archived: ['draft'],
  });
  assert.deepEqual(field.auto, { when: 'shared', after: '90d', to: 'archived' });
  assert.ok(Object.isFrozen(field.values));
  assert.ok(Object.isFrozen(field.transitions));
});

test('state.transition(from, to) is a static method returning a stable, stringifiable handle', () => {
  const handle = state.transition('shared', 'archived');
  // it must be usable as a computed object key — i.e. stringify stably, and two
  // calls for the same pair must produce the SAME key (not a fresh identity).
  const a = state.transition('shared', 'archived');
  const b = state.transition('shared', 'archived');
  assert.equal(String(a), String(b));
  // it must encode the from/to pair (not a magic string the app authored)
  assert.notEqual(String(handle), 'shared');
  assert.match(String(handle), /shared/);
  assert.match(String(handle), /archived/);
  // a different pair must produce a different key
  assert.notEqual(String(state.transition('draft', 'shared')), String(handle));
});

test('a transition handle works as a computed key in an effects map', () => {
  const effects = {
    [state.transition('shared', 'archived')]: { with: { archivedAt: 'now' } },
  };
  const key = String(state.transition('shared', 'archived'));
  assert.deepEqual(effects[key], { with: { archivedAt: 'now' } });
});

test('.can(fn) returns a new frozen state descriptor carrying the access fn', () => {
  const fn = async () => true;
  const field = state({ values: ['draft', 'shared'] }).can(fn);
  assert.equal(field.access, fn);
  assert.equal(field.kind, 'state');
  assert.equal(field.type, 'state');
  assert.ok(Object.isFrozen(field));
});

test('a state field compiles into an entity at import', () => {
  const Doc = entity('DocWithState', {
    grant: scope(() => everyone()).can(() => grant(read)),
    fields: {
      status: state({
        values: ['draft', 'shared', 'archived'],
        transitions: { draft: ['shared'], shared: ['archived', 'draft'], archived: ['draft'] },
        effects: { [state.transition('shared', 'archived')]: { with: { archivedAt: date() } } },
        auto: { when: 'shared', after: '90d', to: 'archived' },
      }),
    },
  });
  assert.ok(Doc);
});

test('a state handle cannot be compared in scope (fail closed)', () => {
  const Doc = entity('DocStateScopeGuard', {
    grant: scope(() => everyone()).can(() => grant(read)),
    fields: {
      status: state({ values: ['draft', 'shared'] }),
    },
  });
  assert.throws(
    () => Doc.status.is('draft'),
    /state field and cannot be compared/,
  );
});

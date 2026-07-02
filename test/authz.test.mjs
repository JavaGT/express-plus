import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compileEntityAuthz } from '../src/authz.mjs';
import {
  text, ref, map, scope, grant, deny, read, write, subscribe, inherit,
  NonCompilableError,
} from '../src/index.mjs';

const ownerCan = async ({ is }) => (await is.owner()) ? grant(read, write, subscribe) : deny('no');

const ownerFields = () => ({ body: text(), owner: ref('User', { role: 'owner' }) });

test('compileEntityAuthz returns a frozen { registry, readScope, scopeAst, clauses }', () => {
  const out = compileEntityAuthz('Doc', {
    fields: ownerFields(),
    grant: () => [scope(({ is }) => is.owner()).can(ownerCan)],
  });
  assert.ok(Object.isFrozen(out));
  assert.equal(typeof out.registry, 'object');
  assert.equal(typeof out.readScope, 'object');
  assert.equal(typeof out.scopeAst, 'object');
  assert.ok(Array.isArray(out.clauses));
});

test('a grant with two scope clauses throws (one read-scope per grant, fail-closed)', () => {
  assert.throws(
    () => compileEntityAuthz('TwoScopes', {
      fields: {
        body: text(),
        owner: ref('User', { role: 'owner' }),
        editor: ref('User', { role: 'editor' }),
      },
      grant: () => [
        scope(({ is }) => is.owner()).can(ownerCan),
        scope(({ is }) => is.editor()).can(ownerCan),
      ],
    }),
    /one scope|single read-scope|one read-scope/i,
  );
});

test('an unguarded `.can` body throws at compile time (ADR #16 static guard)', () => {
  assert.throws(
    () => compileEntityAuthz('Leaky', {
      fields: ownerFields(),
      grant: () => [scope(({ is }) => is.owner()).can(({ is }) => is.owner() ? grant(write) : deny('no'))],
    }),
    /await/i,
  );
});

test('own-scope grant compiles a readScope SQL template and retains the scopeAst', () => {
  const out = compileEntityAuthz('Doc', {
    fields: ownerFields(),
    grant: () => [scope(({ is }) => is.owner()).can(ownerCan)],
  });
  assert.match(out.readScope.sql, /owner/);
  // the AST is the durable artifact retained for child re-lowering
  assert.equal(out.scopeAst.node, 'eq');
  assert.equal(out.scopeAst.field, 'owner');
});

test('an inherit directive dispatches through compileInheritScope and retains a join scopeAst', () => {
  const Doc = compileEntityAuthz('Doc', {
    fields: ownerFields(),
    grant: () => [scope(({ is }) => is.owner()).can(ownerCan)],
  });
  const parentEntity = { name: 'Doc', scopeAst: Doc.scopeAst };
  const child = compileEntityAuthz('Comment', {
    fields: { doc: ref('Doc', { required: true }), body: text() },
    grant: inherit(parentEntity, { via: 'doc' }),
  });
  assert.match(child.readScope.sql, /EXISTS \(/i);
  assert.equal(child.scopeAst.node, 'join');
  assert.equal(child.scopeAst.parentName, 'Doc');
  assert.equal(child.scopeAst.via, 'doc');
});

test('an inherit directive whose parent has no scopeAst throws (fail-closed)', () => {
  const parentEntity = { name: 'Scopeless', scopeAst: undefined };
  assert.throws(
    () => compileEntityAuthz('Child', {
      fields: { doc: ref('Scopeless', { required: true }), body: text() },
      grant: inherit(parentEntity, { via: 'doc' }),
    }),
    NonCompilableError,
  );
});

test('a non-compilable scope predicate throws NonCompilableError (no silent runtime fallback)', () => {
  assert.throws(
    () => compileEntityAuthz('Bad', {
      fields: {
        owner: ref('User', { role: 'owner' }),
        members: map(ref('User'), { role: ['viewer', 'editor'], default: {} }),
      },
      grant: () => [scope(({ is }) => is.editor()).can(() => grant(read))],
    }),
    (err) => {
      assert.ok(err instanceof NonCompilableError);
      assert.match(err.message, /runtime-only|cannot be used in scope|cannot compile/i);
      return true;
    },
  );
});

test('declared checks land in the registry with both harvest and run faces', () => {
  const out = compileEntityAuthz('Doc', {
    fields: ownerFields(),
    grant: () => [scope(({ is }) => is.owner()).can(ownerCan)],
    declaredChecks: {
      ownerTeam: ({ entity: row, principal }) => row.owner === principal.id,
    },
  });
  const entry = out.registry.ownerTeam;
  assert.equal(typeof entry.run, 'function');
  assert.equal(typeof entry.harvest, 'function');
});

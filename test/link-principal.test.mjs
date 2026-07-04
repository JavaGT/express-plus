// #1: the link-principal read path — a SYMBOLIC principal-attribute bind so
// `is.linkHolder()` compiles to a REBINDABLE equality on `linkShare__token`
// (filled per-request from `principal.attributes.token`), not SQL FALSE.
//
// Before this fix the linkHolder harvest face compiled to FALSE (a #58
// discriminator), so a link principal could never be admitted by scope — the
// link read path was inert, and a link principal reaching the grant `.can` link
// arm crashed on `entity.linkShare.tier` (entity was undefined in
// rowCapabilities). This test proves the symbolic bind end-to-end: a link
// principal reads exactly what its token grants, and everyone else is
// fail-closed (SQL NULL semantics + a runtime false).

import { ref, text, map, link, scope, grant, deny, read, write, subscribe, anyOf } from '../src/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  entity, executeDDL, bindReadScope } from '../src/internal.mjs';
import { mayVerb } from '../src/row-grant.mjs';
import { principal } from '../src/principal.mjs';
import { setActiveDb } from '../src/db.mjs';

const norm = (sql) => sql.replace(/\s+/g, ' ').trim();
const COMMENT = [read, subscribe];

// A stand-in Doc with the SAME link-principal grant shape as the binding
// `doc.mjs` exemplar (owner ref + collaborators map + linkShare struct +
// linkHolder/editor/viewer checks). Self-contained so the test exercises the
// mechanism without coupling to doc.mjs's full schema.
function makeDoc() {
  return entity('Doc', {
        title: text(),
    owner: ref('User', { role: 'owner' }),
    collaborators: map(ref('User'), { role: ['viewer', 'editor'], default: {} }),
    linkShare: link({ tiers: ['view', 'comment', 'edit'], tier: 'view', token: 'autogen' }),

    checks: {
      collaborator: ({ Doc, principal }) => Doc.collaborators.has(principal.id),
      linkHolder: ({ Doc, principal }) => Doc.linkShare.token.is(principal.attributes?.token),
      editor: ({ Doc, principal }) => Doc.collaborators.get(principal.id)?.role === 'editor',
      viewer: ({ Doc, principal }) => Doc.collaborators.get(principal.id)?.role === 'viewer',
    },
    grant: () => [
      scope(({ is }) => anyOf(is.owner(), is.collaborator(), is.linkHolder()))
        .can(async ({ is, entity }) => {
          if (await is.owner()) return grant(read, write, subscribe);
          if (await is.editor()) return grant(read, write, subscribe);
          if (await is.viewer()) return grant(read, subscribe);
          if (await is.linkHolder()) {
            const tier = entity.linkShare.tier;          // 'view'|'comment'|'edit'
            return grant(...(tier === 'edit' ? [read, write, subscribe]
                       : tier === 'comment' ? COMMENT : [read]));
          }
          return deny('no capability for this principal');
        }),
    ],
  });
}

function setup() {
  const db = new DatabaseSync(':memory:');
  setActiveDb(db, { replace: true });
  const Doc = makeDoc();
  executeDDL(Doc, db);
  // Seed a doc owned by alice, shared by link token 'share-xyz' at tier comment.
  db.prepare(
    "INSERT INTO Doc (id, title, owner, linkShare__token, linkShare__tier) " +
    "VALUES ('1', 'Shared Doc', 'alice', 'share-xyz', 'comment')",
  ).run();
  return { db, Doc };
}

// ---- compile (scope→SQL) face ----------------------------------------------

test('linkHolder compiles to a rebindable eq on linkShare__token (not FALSE)', () => {
  const { Doc } = setup();
  const s = norm(Doc.readScope.sql);
  // The linkHolder check now lowers through the symbolic attribute bind:
  // `linkShare__token = :p<n>_principalAttrToken`, filled per request with the
  // link principal's token (or NULL for a non-link principal).
  assert.match(s, /linkShare__token = :p\d+_principalAttrToken/);
});

test('the principalAttrToken placeholder is null in the compiled template', () => {
  const { Doc } = setup();
  // The placeholder stays null in the stored template (bindReadScope fills it),
  // exactly like the principalId placeholder — one compiled scope per request.
  const vals = Object.values(Doc.readScope.params);
  assert.ok(vals.every((v) => v === null), 'all template params must be null');
});

// ---- request-time binding --------------------------------------------------

test('bindReadScope fills the token param from principal.attributes.token', () => {
  const { Doc } = setup();
  const link = principal({ type: 'link', id: 'share-xyz', attributes: { token: 'share-xyz' } });
  const user = principal({ type: 'user', id: 'bob' });

  const linkBound = bindReadScope(Doc.readScope, link).params;
  const linkTokenParam = Object.entries(linkBound).find(([k]) => k.endsWith('_principalAttrToken'));
  assert.ok(linkTokenParam, 'link principal must bind the token param');
  assert.equal(linkTokenParam[1], 'share-xyz');

  const userBound = bindReadScope(Doc.readScope, user).params;
  const userTokenParam = Object.entries(userBound).find(([k]) => k.endsWith('_principalAttrToken'));
  // A non-link principal has no attributes.token → NULL → SQL `col = NULL` is
  // false → the linkHolder arm of the OR never admits a row. Fail-closed.
  assert.ok(userTokenParam, 'placeholder must exist for every principal');
  assert.equal(userTokenParam[1], null);
});

// ---- runtime (per-row) face ------------------------------------------------

test('a link principal may read a doc their token grants (tier=comment)', async () => {
  const { Doc, db } = setup();
  const doc = Doc.findById('1');           // hydrated: doc.linkShare = {token,tier}
  const link = principal({ type: 'link', id: 'share-xyz', attributes: { token: 'share-xyz' } });
  assert.equal(await mayVerb(Doc, 'read', doc, link), true);
  // tier 'comment' grants read+subscribe, NOT write.
  assert.equal(await mayVerb(Doc, 'write', doc, link), false);
  // sanity: the row really is hydrated into the struct namespace.
  assert.equal(doc.linkShare.tier, 'comment');
  assert.equal(doc.linkShare.token, 'share-xyz');
});

test('a link principal with the WRONG token is denied (fail-closed)', async () => {
  const { Doc } = setup();
  const doc = Doc.findById('1');
  const wrong = principal({ type: 'link', id: 'other', attributes: { token: 'nope' } });
  assert.equal(await mayVerb(Doc, 'read', doc, wrong), false);
});

test('a non-link principal (not owner/collaborator) is denied', async () => {
  const { Doc } = setup();
  const doc = Doc.findById('1');
  const user = principal({ type: 'user', id: 'bob' });
  assert.equal(await mayVerb(Doc, 'read', doc, user), false);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { entity, grant, read, subscribe, text, write, normalizeTierDeclaration, tierOf, isDataTier, isEntityTier, DATA_TIERS, ENTITY_TIERS, TIER_DESCRIPTIONS } from '../build/index.mjs';

// S3/A1 — tier model + entity tier declaration. Covers the ticket test list:
// tier normalization (default history; history mode sub-flags; live flag),
// live+history conflict rejection, derived/operational category vs entity tier,
// and zero behavior change for existing entity declarations.

function declaration(name, extra = {}) {
  return entity(name, {
    title: text(),
    grant: () => grant(read, write, subscribe),
    ...extra,
  });
}

test('vocabulary: the four data tiers exist with closed descriptions; entity tiers are a two-value subset', () => {
  assert.deepEqual(DATA_TIERS, ['history', 'live', 'derived', 'operational']);
  assert.deepEqual(ENTITY_TIERS, ['history', 'live']);
  assert.ok(Object.isFrozen(DATA_TIERS), 'DATA_TIERS is frozen');
  assert.ok(Object.isFrozen(ENTITY_TIERS), 'ENTITY_TIERS is frozen');
  assert.ok(Object.isFrozen(TIER_DESCRIPTIONS), 'TIER_DESCRIPTIONS is frozen');
  for (const tier of DATA_TIERS) {
    const description = TIER_DESCRIPTIONS[tier];
    assert.equal(typeof description, 'string');
    assert.ok(description.length > 0, `tier '${tier}' has a closed description`);
  }
  assert.match(TIER_DESCRIPTIONS.history, /event history/);
  assert.match(TIER_DESCRIPTIONS.live, /no domain event history/);
  assert.match(TIER_DESCRIPTIONS.derived, /rebuildable/);
  assert.match(TIER_DESCRIPTIONS.operational, /never collaborative history/);
});

test('vocabulary: the published tier predicates classify exactly their tier sets', () => {
  for (const tier of DATA_TIERS) assert.equal(isDataTier(tier), true, `${tier} is a data tier`);
  for (const tier of ENTITY_TIERS) assert.equal(isEntityTier(tier), true, `${tier} is an entity tier`);
  for (const tier of ENTITY_TIERS) assert.equal(isDataTier(tier), true, `${tier} is also a data tier`);
  for (const tier of DATA_TIERS.filter((tier) => !ENTITY_TIERS.includes(tier))) {
    assert.equal(isEntityTier(tier), false, `${tier} is not an entity tier`);
  }
  assert.equal(isDataTier('archival'), false);
  assert.equal(isDataTier(42), false);
  assert.equal(isEntityTier('derived'), false);
  assert.equal(isEntityTier(null), false);
});

test('normalization: default tier is history with full history mode (zero behavior change)', () => {
  assert.deepEqual(normalizeTierDeclaration({}), { tier: 'history', historyMode: 'full' });
  assert.deepEqual(normalizeTierDeclaration({ live: false }), { tier: 'history', historyMode: 'full' });
});

test('normalization: history declaration maps to history tier with a historyMode sub-flag', () => {
  // Existing conditional declarations keep their exact semantics.
  assert.deepEqual(normalizeTierDeclaration({ history: { update: 'conditional' } }), { tier: 'history', historyMode: 'conditional' });
  assert.deepEqual(normalizeTierDeclaration({ history: { create: 'conditional' } }), { tier: 'history', historyMode: 'conditional' });
  // Mixed per-verb declarations: any conditional verb makes the mode conditional.
  assert.deepEqual(normalizeTierDeclaration({ history: { create: 'conditional', update: 'full' } }), { tier: 'history', historyMode: 'conditional' });
  // The explicit `full` spelling is the default full-log mode.
  assert.deepEqual(normalizeTierDeclaration({ history: { update: 'full' } }), { tier: 'history', historyMode: 'full' });
  // An empty history declaration is the full-log default.
  assert.deepEqual(normalizeTierDeclaration({ history: {} }), { tier: 'history', historyMode: 'full' });
});

test('normalization: live flag / tier option marks the live tier', () => {
  assert.deepEqual(normalizeTierDeclaration({ live: true }), { tier: 'live' });
  assert.deepEqual(normalizeTierDeclaration({ tier: 'live' }), { tier: 'live' });
  assert.deepEqual(normalizeTierDeclaration({ live: true, tier: 'live' }), { tier: 'live' });
  assert.deepEqual(normalizeTierDeclaration({ tier: 'history' }), { tier: 'history', historyMode: 'full' });
});

test('normalization: a live entity that requests durable history (or undo) is a hard error', () => {
  assert.throws(() => normalizeTierDeclaration({ live: true, history: { update: 'conditional' } }), /live entity.*hard error/);
  assert.throws(() => normalizeTierDeclaration({ tier: 'live', history: {} }), /live entity.*hard error/);
  assert.throws(() => normalizeTierDeclaration({ live: true, history: { create: 'conditional' } }), /hard error/);
});

test('normalization: malformed declarations fail closed at declaration compile', () => {
  assert.throws(() => normalizeTierDeclaration({ history: 'oops' }), /history must be an object/);
  assert.throws(() => normalizeTierDeclaration({ history: { remove: 'conditional' } }), /unknown/);
  assert.throws(() => normalizeTierDeclaration({ history: { update: 'sometimes' } }), /'conditional' \| 'full' \| 'none'/);
  assert.throws(() => normalizeTierDeclaration({ live: 'yes' }), /live must be a boolean/);
  assert.throws(() => normalizeTierDeclaration({ tier: 'archival' }), /one of history \| live \| derived \| operational/);
  assert.throws(() => normalizeTierDeclaration({ tier: 'history', live: true }), /contradictory/);
  assert.throws(() => normalizeTierDeclaration({ tier: 'live', live: false }), /contradictory/);
  // `none` is reserved for the no-history mutation variant (S3/A2) — use live: true today.
  assert.throws(() => normalizeTierDeclaration({ history: { update: 'none' } }), /'none' is reserved.*live: true/);
});

test('derived/operational are resource categories, not entity tiers', () => {
  // Representable as resources via tierOf (their producer + staleness
  // completeness contract is owned by S2/A6 #92 and S4/A1 #110 — see the
  // live-tier.ts module header); classification is A1's job, validation is the
  // owning lane's.
  assert.equal(tierOf({ tier: 'derived', producer: 'search', staleness: 'projected' }), 'derived');
  assert.equal(tierOf({ tier: 'operational', producer: 'scheduler' }), 'operational');
  // ...but rejected as ordinary mutation targets.
  assert.throws(() => normalizeTierDeclaration({ tier: 'derived' }), /resource category, not an entity tier/);
  assert.throws(() => normalizeTierDeclaration({ tier: 'operational' }), /resource category, not an entity tier/);
  assert.throws(() => declaration('DerivedThing', { tier: 'derived' }), /resource category, not an entity tier/);
  assert.throws(() => declaration('OperationalThing', { tier: 'operational' }), /resource category, not an entity tier/);
});

test('tierOf resolves existing entities to history (default) and live/live-tagged to live', () => {
  assert.equal(tierOf(null), 'history');
  assert.equal(tierOf(undefined), 'history');
  assert.equal(tierOf('not an object'), 'history');
  assert.equal(tierOf({}), 'history');
  assert.equal(tierOf({ title: text() }), 'history');
  assert.equal(tierOf({ history: { update: 'conditional' } }), 'history');
  assert.equal(tierOf({ live: true }), 'live');
  assert.equal(tierOf({ tier: 'live' }), 'live');
  assert.equal(tierOf({ tier: 'history' }), 'history');
});

test('tierOf runs the same validation as normalizeTierDeclaration: contradictory or malformed raw objects fail closed', () => {
  assert.throws(() => tierOf({ tier: 'history', live: true }), /contradictory/);
  assert.throws(() => tierOf({ tier: 'live', live: false }), /contradictory/);
  assert.throws(() => tierOf({ live: true, history: { update: 'conditional' } }), /hard error/);
  assert.throws(() => tierOf({ live: 'yes' }), /live must be a boolean/);
  assert.throws(() => tierOf({ history: 'oops' }), /history must be an object/);
  assert.throws(() => tierOf({ tier: 'archival' }), /one of history \| live \| derived \| operational/);
  // A resource category carrying entity tier flags is a contradictory raw object.
  assert.throws(() => tierOf({ tier: 'derived', live: true }), /resource category.*cannot be combined/);
  assert.throws(() => tierOf({ tier: 'operational', history: { update: 'conditional' } }), /resource category.*cannot be combined/);
});

test('entity declarations: zero behavior change — existing entities resolve to history/full with the old flags intact', () => {
  const plain = declaration('Note');
  assert.equal(plain.tier, 'history');
  assert.equal(plain.historyMode, 'full');
  assert.equal(plain.conditionalHistory, false);
  assert.equal(plain.conditionalCreateHistory, false);

  const conditional = declaration('ConditionalNote', { history: { update: 'conditional' } });
  assert.equal(conditional.tier, 'history');
  assert.equal(conditional.historyMode, 'conditional');
  assert.equal(conditional.conditionalHistory, true, 'existing conditional update flag preserved');
  assert.equal(conditional.conditionalCreateHistory, false);

  const conditionalCreate = declaration('CreatedNote', { history: { create: 'conditional' } });
  assert.equal(conditionalCreate.tier, 'history');
  assert.equal(conditionalCreate.historyMode, 'conditional');
  assert.equal(conditionalCreate.conditionalCreateHistory, true, 'existing conditional create flag preserved');

  const explicitFull = declaration('ExplicitFullNote', { history: { update: 'full' } });
  assert.equal(explicitFull.tier, 'history');
  assert.equal(explicitFull.historyMode, 'full');
  assert.equal(explicitFull.conditionalHistory, false);
});

test('entity declarations: live tier is representable and recorded; live+history rejected at compile', () => {
  const live = declaration('LiveNote', { live: true });
  assert.equal(live.tier, 'live');
  assert.equal(live.historyMode, undefined);

  const tiered = declaration('TieredLiveNote', { tier: 'live' });
  assert.equal(tiered.tier, 'live');

  assert.throws(() => declaration('BrokenLiveNote', { live: true, history: { update: 'conditional' } }), /live entity.*hard error/);
  assert.throws(() => declaration('BrokenLiveNote2', { tier: 'live', history: {} }), /live entity.*hard error/);
});

test('reserved slots: a field named live or tier is a declaration compile error, not a silent drop', () => {
  assert.throws(() => entity('CollisionNote', { live: text(), grant: () => grant(read, write, subscribe) }), /reserved declaration slot/);
  assert.throws(() => entity('CollisionNote2', { tier: text(), grant: () => grant(read, write, subscribe) }), /reserved declaration slot/);
});

test('tierOf classifies a compiled entity record through its resolved tier', () => {
  assert.equal(tierOf(declaration('HistoryThing')), 'history');
  assert.equal(tierOf(declaration('LiveThing', { live: true })), 'live');
});

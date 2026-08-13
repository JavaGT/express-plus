// Gate #1 for the podcast platform V1 data model:
// does multi-hop `inherit` COMPOSE? A child grants-inherits a parent whose OWN
// grant is itself an `inherit` directive — so the child's read-scope is a
// correlated EXISTS over a parent scope which is ITSELF a correlated EXISTS,
// recursively. inherit.test.mjs proves ONE hop (Comment inherits Doc). The
// podcast spine needs a 3-hop chain:
//
//   Feed            (own scope: is.subscriber() over a map field)
//     └ Episode        inherit(Feed,   { via: 'feed' })        — 1 hop
//         └ AudioAsset   inherit(Episode, { via: 'episode' })   — 2 hops
//             └ WordTimings inherit(AudioAsset,{via:'audioAsset'}) — 3 hops
//
// The compiler stores `scopeAst` on each entity (entity.mjs); `compileInheritScope`
// builds a `join` node referencing the PARENT's `scopeAst`, and the `join` lowering
// recurses through `lower2(parentAst, …)` (scope-sql.mjs). So composition SHOULD
// fall out for free — but it is unexercised until this test. If this is green, the
// whole read-security stack for audio/transcript/timings rides on a proven path
// and the data model's inherit chains are sound. If red, the fallback (decided in
// data-model-v1.md) is to denormalize a `feed: ref('Feed')` FK onto AudioAsset /
// Transcript / WordTimings and inherit Feed ONE hop each.
//
// What we assert (mirrors membership-acceptance.test.mjs + inherit.test.mjs):
//   1. the chain loads without a NonCompilableError (composition compiles);
//   2. exactly one principalId placeholder survives the whole 3-hop tree;
//   3. the LOAD-BEARING one: a scoped read at EVERY depth returns exactly the
//      rows whose Feed ancestor the principal subscribes to — for a subscriber,
//      a different feed's subscriber, and a stranger/anonymous (fail-closed).
//   4. the parent (Feed) still admits its subscriber through BOTH layers
//      (SQL scope AND runtime mayVerb) — inherit children resolve capabilities
//      by recursing through the parent seam.

import { text, map, ref, scope, grant, read, write, subscribe, deny, inherit } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { bindReadScope } from '../build/scope-sql.mjs';
import { mayVerb } from '../build/row-grant.mjs';
import { entity } from '../build/index.mjs';
import workbench from '../build/app.mjs';
import { principal, anonymous } from '../build/principal.mjs';

// The parent: Feed is readable only by a subscriber (membership recorded in the
// Feed_subscribers side-table). This is the exact shape the data model lands on
// for the cross-entity subscriber check — a denormalized map, compiled through
// the proven map.has path (the build-flag fix from the council verdict).
function makeFeed() {
  return entity('Feed', {
        title: text(),
    subscribers: map(ref('User'), { default: {} }),

    checks: {
      subscriber: ({ Feed, principal: p }) => Feed.subscribers.has(p.id),
    },
    grant: () => [
      scope(({ is }) => is.subscriber())
        .can(async ({ is }) =>
          (await is.subscriber()) ? grant(read, write, subscribe) : deny('not a subscriber')),
    ],
  });
}

// The chain: each child grants-inherits its immediate parent. The FK target IS
// the parent (the rule from inherit.test.mjs / DECISIONLOG #26). If multi-hop
// composes, AudioAsset's scope nests Episode's join which nests Feed's join.
function makeChain() {
  const Feed = makeFeed();
  const Episode = entity('Episode', {
        feed: ref('Feed', { required: true }), title: text(),

    grant: inherit(Feed, { via: 'feed' }),
  });
  const AudioAsset = entity('AudioAsset', {
        episode: ref('Episode', { required: true }), contentHash: text(),

    grant: inherit(Episode, { via: 'episode' }),
  });
  const WordTimings = entity('WordTimings', {
        audioAsset: ref('AudioAsset', { required: true }),

    grant: inherit(AudioAsset, { via: 'audioAsset' }),
  });
  return { Feed, Episode, AudioAsset, WordTimings };
}

const norm = (s) => s.replace(/\s+/g, ' ').trim();

function seed() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE Feed (id TEXT PRIMARY KEY, title TEXT)');
  db.exec('CREATE TABLE Feed_subscribers (Feed_id TEXT, member_id TEXT)');
  db.exec('CREATE TABLE Episode (id TEXT PRIMARY KEY, feed TEXT, title TEXT)');
  db.exec('CREATE TABLE AudioAsset (id TEXT PRIMARY KEY, episode TEXT, contentHash TEXT)');
  db.exec('CREATE TABLE WordTimings (id TEXT PRIMARY KEY, audioAsset TEXT)');

  // Two feeds, each subscribed by a different user.
  db.exec("INSERT INTO Feed (id, title) VALUES ('F1','feed-one'),('F2','feed-two')");
  db.exec("INSERT INTO Feed_subscribers (Feed_id, member_id) VALUES ('F1','user-A'),('F2','user-B')");
  // One episode per feed.
  db.exec("INSERT INTO Episode (id, feed, title) VALUES ('E1','F1','ep-on-F1'),('E2','F2','ep-on-F2')");
  // One audio asset per episode.
  db.exec("INSERT INTO AudioAsset (id, episode, contentHash) VALUES ('A1','E1','hash-A'),('A2','E2','hash-B')");
  // One word-timings row per audio asset.
  db.exec("INSERT INTO WordTimings (id, audioAsset) VALUES ('W1','A1'),('W2','A2')");
  return db;
}

// Which rows does the compiled read-scope admit for this principal, at this depth?
function scopedIds(db, Entity, who) {
  const bound = bindReadScope(Entity.readScope, who);
  const where = bound ? bound.sql : '1=1';
  const params = bound ? bound.params : {};
  return db
    .prepare(`SELECT id FROM ${Entity.name} AS t0 WHERE ${where}`)
    .all(params)
    .map((r) => r.id)
    .sort();
}

test('the 3-hop inherit chain loads without a NonCompilableError (composition compiles)', () => {
  assert.doesNotThrow(() => makeChain(), 'a child inheriting a parent whose own scope is itself inherited must compile');
});

test('exactly one principalId placeholder survives the whole 3-hop tree', () => {
  const { WordTimings } = makeChain();
  const keys = Object.keys(WordTimings.readScope.params).filter((k) => k.endsWith('_principalId'));
  assert.equal(keys.length, 1, 'one principalId placeholder, threaded through every nested EXISTS, bound once per request');
});

test('the compiled 3-hop scope is a nested EXISTS reaching the Feed_subscribers membership table', () => {
  const { WordTimings } = makeChain();
  const s = norm(WordTimings.readScope.sql);
  // the chain of joins: AudioAsset ← Episode ← Feed ← Feed_subscribers
  assert.match(s, /FROM AudioAsset/i, 'outermost join reaches AudioAsset');
  assert.match(s, /FROM Episode/i, 'second join reaches Episode');
  assert.match(s, /FROM Feed/i, 'third join reaches Feed');
  assert.match(s, /FROM Feed_subscribers/i, 'innermost join reaches the membership side-table');
  // the FK chain: t0.audioAsset → jN.episode → jM.feed → membership
  assert.match(s, /\.id = t0\.audioAsset/, 'outer join on the audioAsset FK');
  assert.match(s, /\.id = j\d+\.episode/, 'middle join on the episode FK');
  assert.match(s, /\.id = j\d+\.feed/, 'inner join on the feed FK');
});

test('LOAD-BEARING: a scoped read at EVERY depth admits exactly the rows whose Feed ancestor the principal subscribes to', () => {
  const db = seed();
  const { Feed, Episode, AudioAsset, WordTimings } = makeChain();

  const userA = principal({ type: 'user', id: 'user-A' });  // subscribes to F1
  const userB = principal({ type: 'user', id: 'user-B' });  // subscribes to F2
  const stranger = principal({ type: 'user', id: 'stranger' });

  // Depth 0 — Feed (own scope).
  assert.deepEqual(scopedIds(db, Feed, userA), ['F1']);
  assert.deepEqual(scopedIds(db, Feed, userB), ['F2']);
  assert.deepEqual(scopedIds(db, Feed, stranger), []);

  // Depth 1 — Episode inherits Feed (1-hop EXISTS).
  assert.deepEqual(scopedIds(db, Episode, userA), ['E1']);
  assert.deepEqual(scopedIds(db, Episode, userB), ['E2']);
  assert.deepEqual(scopedIds(db, Episode, stranger), []);

  // Depth 2 — AudioAsset inherits Episode (2-hop nested EXISTS).
  assert.deepEqual(scopedIds(db, AudioAsset, userA), ['A1']);
  assert.deepEqual(scopedIds(db, AudioAsset, userB), ['A2']);
  assert.deepEqual(scopedIds(db, AudioAsset, stranger), []);

  // Depth 3 — WordTimings inherits AudioAsset (3-hop nested EXISTS). This is the
  // gate: if composition fails here, the whole read-security stack for the
  // podcast spine's transcript/timings layer is unsound.
  assert.deepEqual(scopedIds(db, WordTimings, userA), ['W1']);
  assert.deepEqual(scopedIds(db, WordTimings, userB), ['W2']);
  assert.deepEqual(scopedIds(db, WordTimings, stranger), []);

  // Anonymous (no id) admits nothing at any depth — fail-closed, no special case.
  assert.deepEqual(scopedIds(db, WordTimings, anonymous), []);
  assert.deepEqual(scopedIds(db, Feed, anonymous), []);

  db.close();
});

test('the parent (Feed) admits its subscriber through BOTH the SQL scope and the runtime mayVerb', async () => {
  const db = seed();
  const { Feed } = makeChain();
  const app = workbench({ db, entities: [Feed] });
  const Feed_b = app.entity(Feed);

  const userA = principal({ type: 'user', id: 'user-A' });
  const stranger = principal({ type: 'user', id: 'stranger' });

  // A Feed row user-A subscribes to: admitted by scope, granted read by .can.
  const f1 = Feed_b.findById('F1');
  assert.equal(await mayVerb(Feed_b, 'read', f1, userA), true);
  // A Feed row user-A does NOT subscribe to: scope hides it; .can denies read.
  const f2 = Feed_b.findById('F2');
  assert.equal(await mayVerb(Feed_b, 'read', f2, userA), false);
  // A stranger is denied on both.
  assert.equal(await mayVerb(Feed_b, 'read', f1, stranger), false);

  db.close();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { rosterState } from '../js/recommend.js';

const SPOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DST',
               'BN', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN'];

const p = (pos, rank) => ({ pos, rank, name: `${pos}${rank}` });

test('empty roster reports every starting slot open', () => {
  const s = rosterState(SPOTS, []);
  assert.equal(s.openStarters.QB, 1);
  assert.equal(s.openStarters.RB, 2);
  assert.equal(s.openStarters.WR, 2);
  assert.equal(s.openStarters.TE, 1);
  assert.equal(s.openFlex, 1);
  assert.equal(s.picksRemaining, 16);
});

test('drafted players close their starting slots', () => {
  const s = rosterState(SPOTS, [p('RB', 5), p('RB', 20), p('QB', 30)]);
  assert.equal(s.openStarters.RB, undefined);
  assert.equal(s.openStarters.QB, undefined);
  assert.equal(s.openStarters.WR, 2);
  assert.equal(s.posCounts.RB, 2);
  assert.equal(s.picksRemaining, 13);
});

test('a third RB overflows into FLEX, not a starting slot', () => {
  const s = rosterState(SPOTS, [p('RB', 5), p('RB', 20), p('RB', 40)]);
  assert.equal(s.openFlex, 0);
  assert.equal(s.posCounts.RB, 3);
});

test('K/DEF urgency is false early and true inside the buffer', () => {
  const early = rosterState(SPOTS, []);
  assert.equal(early.kdefNeeded, 2);
  assert.equal(early.kdefUrgent, false);

  // 13 players drafted, none of them K or DST -> 3 picks left, 2 slots needed.
  const thirteen = Array.from({ length: 13 }, (_, i) => p('WR', i + 1));
  const late = rosterState(SPOTS, thirteen);
  assert.equal(late.picksRemaining, 3);
  assert.equal(late.kdefUrgent, true);
});

test('urgency stays false once K and DST are filled', () => {
  const players = [...Array.from({ length: 12 }, (_, i) => p('WR', i + 1)),
                   p('K', 200), p('DST', 210)];
  const s = rosterState(SPOTS, players);
  assert.equal(s.kdefNeeded, 0);
  assert.equal(s.kdefUrgent, false);
});

test('over-full roster floors picksRemaining at zero', () => {
  const many = Array.from({ length: 20 }, (_, i) => p('WR', i + 1));
  assert.equal(rosterState(SPOTS, many).picksRemaining, 0);
});

test('missing arguments do not throw', () => {
  const s = rosterState();
  assert.equal(s.picksRemaining, 0);
  assert.equal(s.openFlex, 0);
  assert.deepEqual(s.openStarters, {});
});

import { scorePlayer, STARTER_BONUS, FLEX_BONUS } from '../js/recommend.js';

const LIMITS = { QB: 3, RB: 6, WR: 6, TE: 3, K: 2, DST: 3 };

test('an empty starting slot earns the starter bonus', () => {
  const s = rosterState(SPOTS, []);
  const r = scorePlayer(p('TE', 55), s, LIMITS);
  assert.equal(r.score, 55 - STARTER_BONUS);
  assert.equal(r.reason, 'FILLS TE');
  assert.equal(r.excluded, false);
});

test('a large talent gap beats the need bonus', () => {
  // RB starters AND flex full (3 RBs drafted), TE slot empty. RB 38 should
  // still outrank TE 55, since the extra RB draws no bonus at all here.
  const s = rosterState(SPOTS, [p('RB', 5), p('RB', 20), p('RB', 30)]);
  const rb = scorePlayer(p('RB', 38), s, LIMITS);
  const te = scorePlayer(p('TE', 55), s, LIMITS);
  assert.equal(rb.score, 38);
  assert.equal(te.score, 43);
  assert.ok(rb.score < te.score, 'the better player wins a 17-rank gap');
});

test('a small talent gap loses to the need bonus', () => {
  const s = rosterState(SPOTS, [p('RB', 5), p('RB', 20), p('RB', 30)]);
  const rb = scorePlayer(p('RB', 38), s, LIMITS);
  const te = scorePlayer(p('TE', 45), s, LIMITS);
  assert.ok(te.score < rb.score, 'need breaks a 7-rank gap');
});

test('FLEX bonus applies only once own-position slots are full', () => {
  const empty = rosterState(SPOTS, []);
  assert.equal(scorePlayer(p('RB', 50), empty, LIMITS).reason, 'FILLS RB');

  const rbFull = rosterState(SPOTS, [p('RB', 5), p('RB', 20)]);
  const r = scorePlayer(p('RB', 50), rbFull, LIMITS);
  assert.equal(r.reason, 'FILLS FLEX');
  assert.equal(r.score, 50 - FLEX_BONUS);
});

test('a filled roster spot scores as bench depth', () => {
  const full = rosterState(SPOTS, [p('RB', 5), p('RB', 20), p('RB', 25)]);
  const r = scorePlayer(p('RB', 50), full, LIMITS);
  assert.equal(r.reason, 'BENCH');
  assert.equal(r.score, 50);
});

test('position limit excludes and labels', () => {
  const s = rosterState(SPOTS, [p('QB', 5), p('QB', 60), p('QB', 90)]);
  const r = scorePlayer(p('QB', 10), s, LIMITS);
  assert.equal(r.excluded, true);
  assert.equal(r.reason, 'QB LIMIT (3)');
  assert.equal(r.score, Infinity);
});

test('exclusion wins over an open starting slot', () => {
  // TE limit of 1 reached, but the TE starting slot is somehow still open.
  const s = rosterState(SPOTS, [p('TE', 5)]);
  const r = scorePlayer(p('TE', 10), s, { TE: 1 });
  assert.equal(r.excluded, true);
});

test('K and DST are buried until urgent, then jump', () => {
  const early = rosterState(SPOTS, []);
  const earlyK = scorePlayer(p('K', 150), early, LIMITS);
  assert.equal(earlyK.reason, 'WAIT');
  assert.ok(earlyK.score > 1000, 'buried below every real player');

  const thirteen = Array.from({ length: 13 }, (_, i) => p('WR', i + 1));
  const late = rosterState(SPOTS, thirteen);
  const lateK = scorePlayer(p('K', 150), late, LIMITS);
  assert.equal(lateK.reason, 'FILLS K');
  assert.equal(lateK.score, 150 - STARTER_BONUS);
});

test('injected weights override the module constants', () => {
  const s = rosterState(SPOTS, []);
  const heavy = scorePlayer(p('TE', 55), s, LIMITS, { starterBonus: 20 });
  const light = scorePlayer(p('TE', 55), s, LIMITS, { starterBonus: 6 });
  assert.equal(heavy.score, 35);
  assert.equal(light.score, 49);
  // Omitted weights fall back to the constants.
  assert.equal(scorePlayer(p('TE', 55), s, LIMITS, {}).score, 55 - STARTER_BONUS);
});

test('positions absent from the limits map are unlimited', () => {
  const s = rosterState(SPOTS, [p('RB', 1), p('RB', 2), p('RB', 3)]);
  assert.equal(scorePlayer(p('RB', 50), s, {}).excluded, false);
});

test('a player with no rank sorts last without throwing', () => {
  const s = rosterState(SPOTS, []);
  const r = scorePlayer({ pos: 'WR', name: 'Unranked' }, s, LIMITS);
  assert.ok(Number.isFinite(r.score));
  assert.ok(r.score > 1000);
});

test('a player with no position is bench depth, never excluded', () => {
  const s = rosterState(SPOTS, []);
  const r = scorePlayer({ pos: '', rank: 40, name: 'Mystery' }, s, LIMITS);
  assert.equal(r.excluded, false);
  assert.equal(r.reason, 'BENCH');
});

import { recommendOrder } from '../js/recommend.js';

test('orders by score, excluded players last', () => {
  const state = rosterState(SPOTS, [p('QB', 1), p('QB', 2), p('QB', 3)]);
  const board = [p('QB', 4), p('WR', 60), p('K', 150), p('TE', 55)];
  const ranked = recommendOrder(board, state, LIMITS);

  assert.equal(ranked[0].player.pos, 'TE', 'TE 55 - 12 = 43 wins');
  assert.equal(ranked[1].player.pos, 'WR', 'WR 60 - 12 = 48');
  assert.equal(ranked[2].player.pos, 'K', 'K is buried but not excluded');
  assert.equal(ranked[3].player.pos, 'QB', 'QB is at its limit, so dead last');
  assert.equal(ranked[3].excluded, true);
});

test('ties break toward the better rank', () => {
  const state = rosterState(SPOTS, []);
  // Equal scores by construction: WR 36 fills a starting slot (36-12=24) and
  // an unrostered-position player at 24 gets no bonus (24). Different ranks,
  // so the tie-break direction is actually exercised.
  const ranked = recommendOrder([p('WR', 36), { pos: 'P', rank: 24, name: 'Punter' }], state, LIMITS);
  assert.equal(ranked[0].score, ranked[1].score, 'scores must actually tie');
  assert.equal(ranked[0].player.rank, 24, 'better raw rank wins the tie');
  assert.equal(ranked[1].player.rank, 36);
});

test('two excluded players still sort by rank without NaN', () => {
  const state = rosterState(SPOTS, [p('QB', 1), p('QB', 2), p('QB', 3)]);
  const ranked = recommendOrder([p('QB', 80), p('QB', 20)], state, LIMITS);
  assert.equal(ranked[0].player.rank, 20);
  assert.equal(ranked[1].player.rank, 80);
});

test('an empty board returns an empty array', () => {
  assert.deepEqual(recommendOrder([], rosterState(SPOTS, []), LIMITS), []);
});

test('does not mutate the input array', () => {
  const board = [p('WR', 60), p('TE', 55)];
  const copy = [...board];
  recommendOrder(board, rosterState(SPOTS, []), LIMITS);
  assert.deepEqual(board, copy);
});

import { byeShortfall, BYE_PENALTY } from '../js/recommend.js';

test('BYE_PENALTY is half a starter bonus', () => {
  assert.equal(BYE_PENALTY, 6);
  assert.equal(BYE_PENALTY * 2, STARTER_BONUS);
});

test('a first player at a position costs one shortfall week', () => {
  // Nothing to spread against yet; every candidate costs the same, so no bye
  // differentiates a first RB. required caps at 1, not the 2 slots.
  assert.equal(byeShortfall(7, [], 2), 1);
});

test('a fresh bye against covered slots costs nothing', () => {
  assert.equal(byeShortfall(12, [7, 10], 2), 0);
});

test('doubling up on an existing bye costs one week', () => {
  assert.equal(byeShortfall(7, [7, 10], 2), 1);
});

test('both starters sharing a bye costs two weeks', () => {
  assert.equal(byeShortfall(7, [7], 2), 2);
});

test('required caps at the slots, not the roster', () => {
  // Three RBs all on bye 7 against two slots: you lose two starter-weeks, not
  // three, because you were only ever starting two.
  assert.equal(byeShortfall(7, [7, 7], 2), 2);
});

test('a null candidate bye takes no penalty', () => {
  // An unknown week cannot be reasoned about, so it cannot be shown to conflict.
  assert.equal(byeShortfall(null, [7, 7], 2), 0);
  assert.equal(byeShortfall(undefined, [7, 7], 2), 0);
});

test('null rostered byes count toward depth but never toward a conflict', () => {
  // A Sleeper-synced player missing from the CSV has bye null. They are a real
  // body at the position, so they raise `total` and are treated as available in
  // every week — optimistic, but we do not know otherwise.
  assert.equal(byeShortfall(7, [null], 2), 1);   // total 2, wk7 available 1, required 2
  assert.equal(byeShortfall(7, [null, null], 2), 0); // total 3, wk7 available 2, required 2
});

test('an all-null roster with a null candidate is zero', () => {
  assert.equal(byeShortfall(null, [null, null], 2), 0);
});

test('single-slot positions always cost their own bye week', () => {
  // K and DST: one slot, one rostered, so their own bye is always a shortfall.
  assert.equal(byeShortfall(7, [], 1), 1);
  // A second one with a different bye covers it.
  assert.equal(byeShortfall(10, [7], 1), 0);
});

test('degenerate inputs do not throw', () => {
  assert.equal(byeShortfall(7, [], 0), 0);
  assert.equal(byeShortfall(7, undefined, 2), 1);
  assert.equal(byeShortfall(7, [], undefined), 0);
});

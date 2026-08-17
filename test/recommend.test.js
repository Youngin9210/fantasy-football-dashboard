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

test('deep depth never produces a negative shortfall', () => {
  // Guards the Math.max(0, ...) floor. Three bodies against ONE required starter
  // leaves slack 2 in every week, so each week's raw figure is negative. No other
  // fixture reaches slack >= 2, so without this the floor is unverified: removing
  // it returns -3 here while the rest of the suite still passes.
  assert.equal(byeShortfall(7, [10, 12], 1), 0);
  assert.equal(byeShortfall(7, [10, 12, 14], 1), 0);
});

test('a bye of 0 is a real week, not missing data', () => {
  // 0 is finite but falsy. Swapping Number.isFinite for a truthiness check would
  // silently treat week 0 as "no bye" and skip the penalty entirely; nothing else
  // in the suite uses 0, so that mutation would otherwise ship undetected.
  assert.equal(byeShortfall(0, [], 2), 1, 'a lone bye-0 player is short in week 0');
  assert.equal(byeShortfall(0, [0], 2), 2, 'two players both on bye 0');
  assert.equal(byeShortfall(0, [7], 2), 2, 'bye 0 counts as its own distinct week');
  assert.equal(byeShortfall(7, [0], 2), 2, 'a rostered bye-0 is a real body AND a real week');
});

test('degenerate inputs do not throw', () => {
  assert.equal(byeShortfall(7, [], 0), 0);
  assert.equal(byeShortfall(7, undefined, 2), 1);
  assert.equal(byeShortfall(7, [], undefined), 0);
});

test('posByes lists every rostered bye at a position, nulls included', () => {
  const s = rosterState(SPOTS, [
    { pos: 'RB', rank: 5, bye: 7 },
    { pos: 'RB', rank: 20, bye: 10 },
    { pos: 'RB', rank: 40, bye: null },
    { pos: 'WR', rank: 8, bye: 7 },
  ]);
  assert.deepEqual(s.posByes.RB, [7, 10, null]);
  assert.deepEqual(s.posByes.WR, [7]);
  assert.equal(s.posByes.QB, undefined);
});

test('posByes coerces every non-finite bye to null, not just null itself', () => {
  // The only non-numeric fixture elsewhere is already `null`, so pushing
  // player.bye RAW produces an identical array and the coercion goes unverified.
  // undefined, NaN and a numeric string must all land as null, or a bad value
  // propagates into byeShortfall's `total` and week matching.
  const s = rosterState(SPOTS, [
    { pos: 'RB', rank: 5, bye: 7 },
    { pos: 'RB', rank: 20, bye: undefined },
    { pos: 'RB', rank: 30, bye: NaN },
    { pos: 'RB', rank: 40, bye: '9' },
    { pos: 'RB', rank: 50, bye: 0 },
  ]);
  assert.deepEqual(s.posByes.RB, [7, null, null, null, 0],
    'a bye of 0 survives as a real week; every non-finite value becomes null');
});

test('posSlots counts dedicated starting slots and excludes FLEX and BN', () => {
  // SPOTS is QB,RB,RB,WR,WR,TE,FLEX,K,DST + 7 BN
  const s = rosterState(SPOTS, []);
  assert.equal(s.posSlots.RB, 2);
  assert.equal(s.posSlots.WR, 2);
  assert.equal(s.posSlots.QB, 1);
  assert.equal(s.posSlots.TE, 1);
  assert.equal(s.posSlots.K, 1);
  assert.equal(s.posSlots.DST, 1);
  assert.equal(s.posSlots.FLEX, undefined, 'FLEX is not a dedicated slot');
  assert.equal(s.posSlots.BN, undefined, 'BN is not a starting slot');
});

test('posSlots is constant as the roster fills, unlike openStarters', () => {
  // This is the trap: openStarters shrinks to 0 once both RB slots are filled.
  // If posSlots did the same, every bye shortfall would collapse to 0 at exactly
  // the point byes start mattering.
  const empty = rosterState(SPOTS, []);
  const full = rosterState(SPOTS, [
    { pos: 'RB', rank: 5, bye: 7 },
    { pos: 'RB', rank: 20, bye: 10 },
  ]);
  assert.equal(empty.posSlots.RB, 2);
  assert.equal(full.posSlots.RB, 2, 'posSlots must not shrink');
  assert.equal(full.openStarters.RB, undefined, 'openStarters does shrink');
});

test('posSlots reflects a custom roster shape', () => {
  const s = rosterState(['QB', 'QB', 'RB', 'FLEX', 'BN'], []);
  assert.equal(s.posSlots.QB, 2);
  assert.equal(s.posSlots.RB, 1);
});

import { KDEF_PENALTY } from '../js/recommend.js';

test('the bye penalty is added to a BENCH score', () => {
  // Three RBs, two of them sharing bye 7, against 2 RB slots. A fourth RB on
  // bye 7 leaves only 1 available that week against a required 2 -> shortfall 1.
  // NOTE the fixture: with 3 RBs on byes 7/10/12 a fourth on bye 7 yields ZERO,
  // because 2 remain available. Depth genuinely covers it. Fixtures here were
  // verified arithmetically, not by eye.
  const mine = [{ pos: 'RB', rank: 5, bye: 7 }, { pos: 'RB', rank: 20, bye: 7 },
                { pos: 'RB', rank: 25, bye: 10 }];
  const s = rosterState(SPOTS, mine);
  const doubled = scorePlayer({ pos: 'RB', rank: 50, bye: 7 }, s, {});
  const fresh = scorePlayer({ pos: 'RB', rank: 50, bye: 14 }, s, {});
  assert.equal(doubled.reason, 'BENCH', 'the reason still describes the slot');
  assert.equal(fresh.score, 50, 'a fresh bye adds nothing');
  assert.equal(doubled.score, 50 + BYE_PENALTY, 'stacking a third on bye 7 costs 1 week');
});

test('the bye penalty reaches the FILLS branch, not only BENCH', () => {
  // The regression this guards: applying the penalty at one return site and
  // forgetting the other three.
  //
  // In the FILLS branch a position's slots are by definition not yet full, so
  // total <= slots and EVERY bye causes a shortfall — there is no clean-FILLS
  // fixture to compare against. Isolate the penalty with byePenalty: 0 instead.
  const s = rosterState(SPOTS, [{ pos: 'WR', rank: 8, bye: 7 }]);
  const cand = { pos: 'WR', rank: 40, bye: 7 };
  const withPenalty = scorePlayer(cand, s, {}, {});
  const without = scorePlayer(cand, s, {}, { byePenalty: 0 });
  assert.equal(withPenalty.reason, 'FILLS WR');
  assert.equal(without.score, 40 - STARTER_BONUS);
  assert.equal(withPenalty.score - without.score, BYE_PENALTY * 2,
    'two players for two slots means both bye weeks are short');
});

test('the bye penalty reaches the FLEX branch', () => {
  const mine = [{ pos: 'RB', rank: 5, bye: 7 }, { pos: 'RB', rank: 20, bye: 10 }];
  const s = rosterState(SPOTS, mine);
  const doubled = scorePlayer({ pos: 'RB', rank: 50, bye: 7 }, s, {});
  assert.equal(doubled.reason, 'FILLS FLEX');
  assert.equal(doubled.score, 50 - FLEX_BONUS + BYE_PENALTY);
});

test('the bye penalty reaches the K/DST WAIT branch', () => {
  const s = rosterState(SPOTS, []);
  const k = scorePlayer({ pos: 'K', rank: 150, bye: 7 }, s, {});
  assert.equal(k.reason, 'WAIT');
  // One slot, one body: its own bye is always a shortfall of 1.
  assert.equal(k.score, 150 + KDEF_PENALTY + BYE_PENALTY);
});

test('the bye penalty reaches the urgent K/DST FILLS branch too', () => {
  // The restructured function has FIVE score-assignment sites, not four: the
  // urgent K/DST case is a separate arm from WAIT. Skipping the penalty on that
  // arm alone left every other test in this suite green, so it needs its own.
  // 13 non-K/DST players -> 3 picks left against 2 K/DST slots -> urgent.
  const thirteen = Array.from({ length: 13 }, (_, i) => p('WR', i + 1));
  const s = rosterState(SPOTS, thirteen);
  assert.equal(s.kdefUrgent, true, 'the hold-back trigger must still fire here');
  const k = scorePlayer({ pos: 'K', rank: 150, bye: 7 }, s, {});
  assert.equal(k.reason, 'FILLS K');
  // One K slot, this K the only body: its own bye is a shortfall of 1.
  assert.equal(k.score, 150 - STARTER_BONUS + BYE_PENALTY);
  assert.equal(k.byeWarning, 'BYE 7 ×1');
});

test('byeWarning names the week and count, and is null when covered', () => {
  // Needs real depth for a clean case to exist: 3 WRs on 7/7/10 against 2 slots.
  const s = rosterState(SPOTS, [
    { pos: 'WR', rank: 8, bye: 7 }, { pos: 'WR', rank: 30, bye: 7 },
    { pos: 'WR', rank: 44, bye: 10 },
  ]);
  assert.equal(scorePlayer({ pos: 'WR', rank: 60, bye: 14 }, s, {}).byeWarning, null,
    'a fresh bye against covered slots warns about nothing');
  const w = scorePlayer({ pos: 'WR', rank: 60, bye: 7 }, s, {}).byeWarning;
  assert.match(w, /7/, 'names the week');
  assert.match(w, /1/, 'names the count');
});

test('an excluded player gets no bye commentary and stays Infinity', () => {
  const s = rosterState(SPOTS, [
    { pos: 'QB', rank: 1, bye: 7 }, { pos: 'QB', rank: 2, bye: 7 },
    { pos: 'QB', rank: 3, bye: 7 },
  ]);
  const r = scorePlayer({ pos: 'QB', rank: 10, bye: 7 }, s, { QB: 3 });
  assert.equal(r.excluded, true);
  assert.equal(r.score, Infinity);
  assert.equal(r.byeWarning, null);
});

test('weights.byePenalty overrides the constant', () => {
  const s = rosterState(SPOTS, [{ pos: 'WR', rank: 8, bye: 7 }]);
  const cand = { pos: 'WR', rank: 40, bye: 7 };
  const base = scorePlayer(cand, s, {}, { byePenalty: 0 }).score;
  assert.equal(scorePlayer(cand, s, {}, { byePenalty: 30 }).score - base, 30 * 2);
});

test('a player with no bye data is never penalized', () => {
  const s = rosterState(SPOTS, [{ pos: 'WR', rank: 8, bye: 7 }]);
  const r = scorePlayer({ pos: 'WR', rank: 40, bye: null }, s, {});
  assert.equal(r.score, 40 - STARTER_BONUS);
  assert.equal(r.byeWarning, null);
});

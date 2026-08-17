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
  // Pins the non-negativity the PEAK accumulation guarantees: `shortfall` starts
  // at 0 and every week merges in via `Math.max(shortfall, ...)`, so the result
  // can never fall below that starting value no matter how negative a single
  // week's raw figure is. There is no separate per-week floor in the code — an
  // earlier version wrapped each week in its own `Math.max(0, ...)`, but that was
  // dead: the outer accumulation already clamps at 0 by construction, so removing
  // it changed nothing (136/136 still pass, and it is identical to the old code
  // over 1,764,438 brute-forced inputs).
  //
  // Three bodies against ONE required starter leaves slack 2 in every week, so
  // each week's raw figure is -1 here — deep enough that a mutant which drops the
  // accumulator's own starting value (e.g. seeding it from the first week's raw
  // figure instead of 0) returns -1 instead of 0, and this assertion catches it.
  assert.equal(byeShortfall(7, [10, 12], 1), 0);
  assert.equal(byeShortfall(7, [10, 12, 14], 1), 0);
});

test('a bye of 0 is a real week, not missing data', () => {
  // 0 is finite but falsy. Swapping Number.isFinite for a truthiness check would
  // silently treat week 0 as "no bye" and skip the penalty entirely; nothing else
  // in the suite uses 0, so that mutation would otherwise ship undetected.
  //
  // These are PEAK weekly figures, not season sums. The two mixed-week rows below
  // were 2 under the summed shortfall (one lost starter-week in week 0 plus one in
  // week 7); the peak of those two weeks is 1. The rows that discriminate bye 0
  // from missing data are the first two: a truthiness guard reads bye 0 as "no
  // bye" and returns 0 for both.
  assert.equal(byeShortfall(0, [], 2), 1, 'a lone bye-0 player is short in week 0');
  assert.equal(byeShortfall(0, [0], 2), 2,
    'two players both on bye 0: week 0 loses both starters at once');
  assert.equal(byeShortfall(0, [7], 2), 1,
    'bye 0 is its own distinct week, so the byes spread and the worst week loses one');
  assert.equal(byeShortfall(7, [0], 2), 1,
    'a rostered bye-0 is a real body AND a real week, and a real week apart from 7');
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
  // forgetting the other four.
  //
  // The state here is HAND-BUILT rather than from rosterState: rosterState cannot
  // produce an open starting slot at a position that already holds slots-many
  // bodies, because assignRosterSlots fills every dedicated slot before FLEX/BN.
  // A real state DOES charge this arm — one RB rostered, the second RB slot open
  // and a candidate stacking that bye, see the stacking tests below — this fixture
  // just exercises the arm at a THIRD body, which only a hand-built state reaches.
  assert.equal(avoidableByeShortfall(7, [7, 10], 2), 1,
    'the fixture must have something avoidable to charge');
  const s = {
    openStarters: { WR: 1 }, openFlex: 0, posCounts: {},
    posByes: { WR: [7, 10] }, posSlots: { WR: 2 },
    picksRemaining: 5, kdefNeeded: 0, kdefUrgent: false,
  };
  const cand = { pos: 'WR', rank: 40, bye: 7 };
  const withPenalty = scorePlayer(cand, s, {}, {});
  const without = scorePlayer(cand, s, {}, { byePenalty: 0 });
  assert.equal(withPenalty.reason, 'FILLS WR');
  assert.equal(without.score, 40 - STARTER_BONUS);
  assert.equal(withPenalty.score, 40 - STARTER_BONUS + BYE_PENALTY);
  assert.equal(withPenalty.score - without.score, BYE_PENALTY,
    'a third body stacking week 7 behind byes 7 and 10 costs one avoidable week');
});

test('an open starting slot is charged only when the pick STACKS a rostered bye', () => {
  // The real rule, and the one an earlier SUMMED byeShortfall could not express.
  // A pick filling its own position's empty slot is charged when — and only when —
  // it doubles up on a bye that position already holds.
  //
  // Not charged: the first body at a position. `required` caps at the bodies
  // rostered, so a lone TE is short in his own bye week and every TE on the board
  // is short in his. Actual peak 1, no-such-week floor 1, avoidable 0.
  const empty = rosterState(SPOTS, []);
  const te = scorePlayer({ pos: 'TE', rank: 42, bye: 8 }, empty, {});
  assert.equal(te.reason, 'FILLS TE');
  assert.equal(byeShortfall(8, undefined, 1), 1, 'the raw cost is real...');
  assert.equal(te.score, 42 - STARTER_BONUS, '...and unavoidable, so uncharged');
  assert.equal(te.byeWarning, null);

  // CHARGED: one WR rostered on bye 7 and the second WR slot still open, candidate
  // WR also on bye 7. Both starters would be out in week 7 together — actual peak
  // 2 (2 required, 0 available) against a floor of 1 (byes spread across two weeks
  // still leaves one slot uncovered in each), so avoidable 1.
  //
  // This is the case the feature exists for and the case the summed shortfall
  // missed: [7,7] and [7,11] BOTH summed to 2, so a stacked pair was
  // indistinguishable from a spread one and cost nothing. This assertion was
  // `wr.score === 40 - STARTER_BONUS` with a null badge; reverting Math.max to +=
  // puts that silence back.
  const oneWr = rosterState(SPOTS, [{ pos: 'WR', rank: 8, bye: 7 }]);
  const wr = scorePlayer({ pos: 'WR', rank: 40, bye: 7 }, oneWr, {});
  assert.equal(wr.reason, 'FILLS WR', 'still describes the slot it fills');
  assert.equal(byeShortfall(7, [7], 2), 2, 'both starters out in week 7');
  assert.equal(byeShortfall(11, [7], 2), 1, 'spread byes peak one lower');
  assert.equal(avoidableByeShortfall(7, [7], 2), 1);
  assert.equal(wr.score, 40 - STARTER_BONUS + BYE_PENALTY, 'a different WR bye would have helped');
  assert.equal(wr.byeWarning, 'BYE 7 ×1');

  // And the WR who avoids it is charged nothing, on the same open slot.
  const spread = scorePlayer({ pos: 'WR', rank: 40, bye: 11 }, oneWr, {});
  assert.equal(spread.score, 40 - STARTER_BONUS);
  assert.equal(spread.byeWarning, null);
  assert.ok(spread.score < wr.score, 'so the stacking pick loses to the spreading one');
});

test('a second starter stacking the first one\'s bye loses to one that spreads it', () => {
  // THE headline case, and the one the feature was built for: "can't have an
  // entire position group with the same bye week". It had NO test, which is how it
  // stayed silent through the whole feature.
  //
  // RB1 rostered on bye 9, the RB2 slot still OPEN, two RB candidates a rank apart:
  // #20 on bye 9 (both starters out together in week 9) and #21 on bye 6 (the byes
  // spread). Both are 'FILLS RB'.
  //
  //   stacker  20 - 12 + 6*1 = 14   badge BYE 9 ×1
  //   spreader 21 - 12 + 6*0 =  9   no badge
  //
  // Under the SUMMED byeShortfall both candidates measured avoidable 0 — [9,9] and
  // [9,6] both sum to 2 — so the stacker scored 8, was unbadged, and was
  // recommended OVER the candidate that avoids the clash. Peak separates them:
  // [9,9] peaks at 2 against a [9,6] floor of 1.
  const s = rosterState(SPOTS, [{ pos: 'RB', rank: 6, name: 'my RB1', bye: 9 }]);
  assert.equal(s.openStarters.RB, 1, 'the second RB slot must still be open');
  assert.equal(s.posSlots.RB, 2);
  assert.deepEqual(s.posByes.RB, [9]);

  const stacker = { pos: 'RB', rank: 20, name: 'Stacker', bye: 9 };
  const spreader = { pos: 'RB', rank: 21, name: 'Spreader', bye: 6 };

  assert.equal(byeShortfall(9, [9], 2), 2, 'both RBs out in week 9');
  assert.equal(byeShortfall(6, [9], 2), 1, 'spread byes peak one lower — the floor');
  assert.equal(avoidableByeShortfall(9, [9], 2), 1);
  assert.equal(avoidableByeShortfall(6, [9], 2), 0);

  const stacked = scorePlayer(stacker, s, LIMITS);
  const spread = scorePlayer(spreader, s, LIMITS);
  assert.equal(stacked.reason, 'FILLS RB');
  assert.equal(spread.reason, 'FILLS RB');

  // Charged...
  assert.equal(stacked.score, 20 - STARTER_BONUS + BYE_PENALTY, 'stacker is charged');
  assert.equal(stacked.score, 14);
  assert.equal(spread.score, 21 - STARTER_BONUS, 'spreader is not');
  assert.equal(spread.score, 9);
  // ...badged...
  assert.equal(stacked.byeWarning, 'BYE 9 ×1');
  assert.equal(spread.byeWarning, null);
  // ...and demoted below the candidate that avoids the clash, through the real
  // board sort and not just by score arithmetic.
  assert.ok(spread.score < stacked.score);
  const ranked = recommendOrder([stacker, spreader], s, LIMITS);
  assert.equal(ranked[0].player.name, 'Spreader',
    'the dashboard must not recommend putting both starting RBs on one bye week');
  assert.equal(ranked[1].player.name, 'Stacker');

  // And the penalty is what reorders them: with it switched off the stacker's
  // better rank wins, 8 to 9 — exactly what shipped before this fix.
  const off = recommendOrder([stacker, spreader], s, LIMITS, { byePenalty: 0 });
  assert.equal(off[0].player.name, 'Stacker');
  assert.equal(off[0].score, 8);
});

test('an empty starting slot outranks bench depth despite an unavoidable bye', () => {
  // tools/calibrate-bye.mjs, reduced to the row that forced this change. RB
  // slots full (byes 7 and 10), FLEX open, TE empty. The first TE fills an
  // EMPTY STARTING SLOT and is the most valuable pick on the board, but under
  // the raw-shortfall score he was demoted below FLEX depth: 42 - 12 + 6*1 = 36
  // against the fresh-bye RB's 40 - 6 + 0 = 34 (and 42 at byePenalty 12).
  // Charging only the avoidable shortfall restores him: 42 - 12 + 0 = 30.
  const s = rosterState(SPOTS, [
    { pos: 'RB', rank: 6, bye: 7 }, { pos: 'RB', rank: 9, bye: 10 },
  ]);
  const firstTe = { pos: 'TE', rank: 42, bye: 8 };
  const freshRb = { pos: 'RB', rank: 40, bye: 14 };
  const te = scorePlayer(firstTe, s, LIMITS);
  const rb = scorePlayer(freshRb, s, LIMITS);
  assert.equal(te.reason, 'FILLS TE');
  assert.equal(rb.reason, 'FILLS FLEX');
  assert.equal(te.score, 30);
  assert.equal(rb.score, 34);
  assert.ok(te.score < rb.score, 'filling an empty starting slot wins');
  assert.equal(recommendOrder([freshRb, firstTe], s, LIMITS)[0].player.pos, 'TE',
    'and it wins through the real board sort, not just by score arithmetic');
});

test('the bye penalty reaches the FLEX branch', () => {
  const mine = [{ pos: 'RB', rank: 5, bye: 7 }, { pos: 'RB', rank: 20, bye: 10 }];
  const s = rosterState(SPOTS, mine);
  const doubled = scorePlayer({ pos: 'RB', rank: 50, bye: 7 }, s, {});
  assert.equal(doubled.reason, 'FILLS FLEX');
  assert.equal(doubled.score, 50 - FLEX_BONUS + BYE_PENALTY);
});

test('the bye penalty reaches the K/DST WAIT branch', () => {
  // A K already rostered on bye 7 (so the K slot is filled -> WAIT, not FILLS)
  // and a second K on bye 7 behind him. One K slot, two bodies: raw 1 and
  // avoidable 1, because any other bye would have covered week 7.
  assert.equal(byeShortfall(7, [7], 1), 1);
  assert.equal(avoidableByeShortfall(7, [7], 1), 1);
  const s = rosterState(SPOTS, [{ pos: 'K', rank: 140, bye: 7 }]);
  assert.equal(s.kdefUrgent, false, 'plenty of picks left, so this is the WAIT arm');
  const k = scorePlayer({ pos: 'K', rank: 150, bye: 7 }, s, {});
  assert.equal(k.reason, 'WAIT');
  assert.equal(k.score, 150 + KDEF_PENALTY + BYE_PENALTY);
  assert.equal(k.byeWarning, 'BYE 7 ×1', 'and the badge agrees with the charge');
});

test('a lone K is quiet in BOTH the score and the badge', () => {
  // Was 'the bye penalty reaches the urgent K/DST FILLS branch too', asserting
  // 150 - 12 + BYE_PENALTY while byeWarning stayed null — the old pairing, where
  // the score charged the RAW shortfall and only the badge used the avoidable
  // one. One K slot with this K the only body: every K on the board is short in
  // his own bye week, so no different pick helps, and now NEITHER the score nor
  // the badge says anything. A mutant putting the raw shortfall back in the
  // score scores 144 here and fails.
  // 13 non-K/DST players -> 3 picks left against 2 K/DST slots -> urgent.
  const thirteen = Array.from({ length: 13 }, (_, i) => p('WR', i + 1));
  const s = rosterState(SPOTS, thirteen);
  assert.equal(s.kdefUrgent, true, 'the hold-back trigger must still fire here');
  const k = scorePlayer({ pos: 'K', rank: 150, bye: 7 }, s, {});
  assert.equal(k.reason, 'FILLS K');
  assert.equal(byeShortfall(7, undefined, 1), 1, 'the raw shortfall is real...');
  assert.equal(avoidableByeShortfall(7, undefined, 1), 0, '...and unavoidable');
  assert.equal(k.score, 150 - STARTER_BONUS);
  assert.equal(k.byeWarning, null);
});

test('the bye penalty reaches the urgent K/DST FILLS branch too', () => {
  // The restructured function has FIVE score-assignment sites, not four: the
  // urgent K/DST case is a separate arm from WAIT. Skipping the penalty on that
  // arm alone left every other test in this suite green, so it needs its own.
  //
  // Hand-built state, for the same reason as the FILLS WR test above: an open
  // starting slot never coexists with slots-many bodies in a real rosterState.
  // K has exactly ONE slot, so an open K slot means zero Ks rostered and there is
  // no held bye for a candidate to stack onto — unlike a two-slot position, where
  // a real state does charge this arm (see the stacking tests below).
  assert.equal(avoidableByeShortfall(7, [7], 1), 1);
  const s = {
    openStarters: { K: 1 }, openFlex: 0, posCounts: {},
    posByes: { K: [7] }, posSlots: { K: 1 },
    picksRemaining: 1, kdefNeeded: 1, kdefUrgent: true,
  };
  const k = scorePlayer({ pos: 'K', rank: 150, bye: 7 }, s, {});
  assert.equal(k.reason, 'FILLS K');
  assert.equal(k.score, 150 - STARTER_BONUS + BYE_PENALTY);
  assert.equal(scorePlayer({ pos: 'K', rank: 150, bye: 7 }, s, {}, { byePenalty: 0 }).score,
    150 - STARTER_BONUS);
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

test('weights.byePenalty overrides the constant, and scales the AVOIDABLE count', () => {
  // Two RBs already on bye 7 against two RB slots, a third RB on bye 7: raw 2,
  // avoidable 1. The injected weight multiplies the avoidable count, so the gap
  // is 30 and not 60 — the fixture discriminates the two measures rather than
  // just proving the override is wired up.
  assert.equal(byeShortfall(7, [7, 7], 2), 2);
  assert.equal(avoidableByeShortfall(7, [7, 7], 2), 1);
  const s = rosterState(SPOTS, [
    { pos: 'RB', rank: 5, bye: 7 }, { pos: 'RB', rank: 20, bye: 7 },
  ]);
  const cand = { pos: 'RB', rank: 50, bye: 7 };
  const base = scorePlayer(cand, s, {}, { byePenalty: 0 }).score;
  assert.equal(base, 50 - FLEX_BONUS);
  assert.equal(scorePlayer(cand, s, {}, { byePenalty: 30 }).score - base, 30 * 1);
});

test('a player with no bye data is never penalized', () => {
  const s = rosterState(SPOTS, [{ pos: 'WR', rank: 8, bye: 7 }]);
  const r = scorePlayer({ pos: 'WR', rank: 40, bye: null }, s, {});
  assert.equal(r.score, 40 - STARTER_BONUS);
  assert.equal(r.byeWarning, null);
});

// --- Score AND badge use the AVOIDABLE shortfall ---------------------------
//
// Found in review: on an empty roster 8 of 8 candidates carried a non-null
// byeWarning, because the first player at any position is always short in his
// own bye week and `required` caps at `total`. A warning that always fires
// teaches the user to ignore it, so the BADGE was derived from
// avoidableByeShortfall while the SCORE kept the raw byeShortfall.
//
// That split is gone. tools/calibrate-bye.mjs showed the raw penalty was uniform
// only WITHIN a position, so across positions it demoted the first body at an
// empty starting slot below bench depth — see 'an empty starting slot outranks
// bench depth' above. Both now read the same avoidable measure, and the pairing
// tests below pin THAT: they fail if the score ever goes back to raw.
import { avoidableByeShortfall } from '../js/recommend.js';

test('the first player at a position is short but not badged', () => {
  // Table row 1: nothing rostered at RB (2 slots), candidate RB bye 7 -> 1 / 1.
  assert.equal(byeShortfall(7, [], 2), 1, 'the raw shortfall is real');
  assert.equal(avoidableByeShortfall(7, [], 2), 0,
    'every RB on the board is short in his own bye week here — not a choice');
  const s = rosterState(SPOTS, []);
  const r = scorePlayer({ pos: 'RB', rank: 30, bye: 7 }, s, {});
  assert.equal(r.byeWarning, null);
  assert.equal(r.score, 30 - STARTER_BONUS, 'and not charged for it either');
});

test('a fresh bye against covered slots is neither short nor badged', () => {
  // Table row 2: rostered byes 7 and 10 at RB, candidate RB bye 12 -> 0 / 0.
  assert.equal(byeShortfall(12, [7, 10], 2), 0);
  assert.equal(avoidableByeShortfall(12, [7, 10], 2), 0);
  const s = rosterState(SPOTS, [
    { pos: 'RB', rank: 5, bye: 7 }, { pos: 'RB', rank: 20, bye: 10 },
  ]);
  assert.equal(scorePlayer({ pos: 'RB', rank: 50, bye: 12 }, s, {}).byeWarning, null);
});

test('doubling up on a bye a different pick would have dodged IS badged', () => {
  // Table row 3, the only badged row: rostered byes 7 and 10 at RB, candidate
  // RB bye 7 -> 1 / 0. Depth covers every week except the one he stacks.
  assert.equal(byeShortfall(7, [7, 10], 2), 1);
  assert.equal(avoidableByeShortfall(7, [7, 10], 2), 1);
  const s = rosterState(SPOTS, [
    { pos: 'RB', rank: 5, bye: 7 }, { pos: 'RB', rank: 20, bye: 10 },
  ]);
  const r = scorePlayer({ pos: 'RB', rank: 50, bye: 7 }, s, {});
  // The exact string the UI renders — the separator is U+00D7 MULTIPLICATION
  // SIGN, not the letter x. Both views print this string verbatim rather than
  // rebuilding it, so this assertion is what pins the rendered text.
  assert.equal(r.byeWarning, `BYE 7 ×1`);
  assert.equal(r.score, 50 - FLEX_BONUS + BYE_PENALTY, 'and the penalty is charged');
});

test('two bodies on DIFFERENT byes against two slots is unavoidable, so not badged', () => {
  // Table row 4: one WR rostered on bye 7, candidate WR bye 11 -> peak 1 /
  // avoidable 0. Two players cannot cover two slots in either bye week, so the
  // worst week still loses one starter and no other bye on the board fixes it.
  //
  // Was 2 / 0 while byeShortfall summed the season: week 7 short one plus week 11
  // short one. The peak of those two weeks is 1, and the no-such-week floor is 1
  // too, so the avoidable figure is unchanged — this pick is still silent. What
  // moved is the STACKED sibling of this fixture (candidate bye 7), which the sum
  // scored identically at 2 and peak scores 2 against a floor of 1: see 'an open
  // starting slot is charged only when the pick STACKS a rostered bye'.
  assert.equal(byeShortfall(11, [7], 2), 1);
  assert.equal(byeShortfall(7, [7], 2), 2, 'and stacking the SAME bye peaks higher');
  assert.equal(avoidableByeShortfall(11, [7], 2), 0);
  const s = rosterState(SPOTS, [{ pos: 'WR', rank: 8, bye: 7 }]);
  assert.equal(scorePlayer({ pos: 'WR', rank: 40, bye: 11 }, s, {}).byeWarning, null);
});

test('an unavoidable shortfall is charged to NEITHER the score nor the badge', () => {
  // THE pairing, first direction. Table row 4 again: one WR rostered on bye 7,
  // candidate WR on bye 11, two WR slots. Peak 1, avoidable 0 — two bodies cannot
  // cover two slots in a bye week even when the byes are spread, so the residue is
  // structural depth and no other pick on the board would have been better.
  // (Peak 1, not the sum's 2; the avoidable figure is 0 under both.) A mutant
  // putting the raw shortfall back into the score scores 40 - 12 + 6*1 = 34 here
  // instead of 28.
  assert.equal(byeShortfall(11, [7], 2), 1);
  assert.equal(avoidableByeShortfall(11, [7], 2), 0);
  const s = rosterState(SPOTS, [{ pos: 'WR', rank: 8, bye: 7 }]);
  const r = scorePlayer({ pos: 'WR', rank: 40, bye: 11 }, s, {});
  assert.equal(r.byeWarning, null, 'badge silent');
  assert.equal(r.score, 40 - STARTER_BONUS, 'and the score silent with it');
});

test('score and badge count the SAME weeks when raw and avoidable differ', () => {
  // THE pairing, second direction, and the one that discriminates the measures
  // by arithmetic rather than by nullity: two RBs already on bye 7 against 2 RB
  // slots, a third RB on bye 7. Raw 2, avoidable 1 (one of those two short weeks
  // is structural depth, not this pick's fault). The badge says ×1 and the score
  // is charged for 1, not 2 — the previous version of this test asserted
  // 50 - 6 + 6*2 = 56 for the score, so a raw-shortfall mutant is caught here on
  // the number even where it is caught nowhere on nullity.
  assert.equal(byeShortfall(7, [7, 7], 2), 2);
  assert.equal(avoidableByeShortfall(7, [7, 7], 2), 1);
  const s = rosterState(SPOTS, [
    { pos: 'RB', rank: 5, bye: 7 }, { pos: 'RB', rank: 20, bye: 7 },
  ]);
  const cand = { pos: 'RB', rank: 50, bye: 7 };
  const r = scorePlayer(cand, s, {});
  const base = scorePlayer(cand, s, {}, { byePenalty: 0 }).score;
  assert.equal(r.byeWarning, 'BYE 7 ×1', 'the badge says ×1, not the raw ×2');
  assert.equal(r.score, 50 - FLEX_BONUS + BYE_PENALTY * 1);
  // Stated as the invariant itself, so it survives a fixture change: whatever the
  // slot bonus was, the penalty in the score is BYE_PENALTY times the number the
  // badge printed.
  assert.equal(r.score - base, BYE_PENALTY * avoidableByeShortfall(7, [7, 7], 2),
    'the score charges the avoidable count');
  assert.notEqual(r.score - base, BYE_PENALTY * byeShortfall(7, [7, 7], 2),
    'and NOT the raw one — a score built from byeShortfall fails here');
});

test('a missing candidate bye is never avoidable', () => {
  assert.equal(avoidableByeShortfall(null, [7, 7], 2), 0);
  assert.equal(avoidableByeShortfall(undefined, [7, 7], 2), 0);
});

test('avoidableByeShortfall tolerates the same degenerate inputs', () => {
  assert.equal(avoidableByeShortfall(7, [], 0), 0);
  assert.equal(avoidableByeShortfall(7, undefined, 2), 0);
  assert.equal(avoidableByeShortfall(7, [], undefined), 0);
});

test('bye 0 is a real week, and NO_SUCH_WEEK never collides with it', () => {
  // The sentinel is -1, not 0: a real CSV can carry bye 0, and a sentinel of 0
  // would make the floor for a bye-0 board look like a week somebody holds.
  assert.equal(byeShortfall(0, [0, 10], 2), 1);
  assert.equal(avoidableByeShortfall(0, [0, 10], 2), 1,
    'stacking a bye-0 on an existing bye-0 is just as avoidable as any other');
});

test('the avoidable shortfall never exceeds the actual one, over a full sweep', () => {
  // The invariant behind both the `actual === 0` short circuit and the Math.max
  // clamp in avoidableByeShortfall: a bye nobody holds is normally no WORSE than
  // a real one, so actual - floor is normally not negative.
  //
  // "Normally" is the whole point of the negative rosters below. That argument
  // holds for every input THIS APP can produce, because a negative bye week is
  // unrepresentable here (cleanBye in js/csv.js matches /\d+/, and
  // pickToManualPlayer sets null) — but the sentinel NO_SUCH_WEEK is -1, so a
  // roster of -1s is a roster of players holding the sentinel week, and the
  // floor stops being a floor:
  //
  //   byeShortfall( 7, [-1,-1,-1], 2) = 1   (actual)
  //   byeShortfall(-1, [-1,-1,-1], 2) = 2   (floor)
  //   actual - floor = -1                   -> the Math.max clamp fires
  //
  // So over the function's own input domain the clamp is REACHABLE, and deleting
  // it makes the `avoidable >= 0` assertion below fail rather than changing
  // nothing observable. (The two guards only substitute for each other one at a
  // time: dropping the short circuit alone leaves the clamp to catch this;
  // dropping both returns a negative badge count.)
  const byes = [null, 0, 1, 7, 10, 12];
  const rosters = [[], [7], [7, 7], [7, 10], [null], [0, 7], [7, 7, 10], [null, 7],
    [-1], [-1, -1, -1]];
  let sawPositive = false;
  for (const cand of byes) {
    for (const roster of rosters) {
      for (const slots of [0, 1, 2, 3]) {
        const actual = byeShortfall(cand, roster, slots);
        const avoidable = avoidableByeShortfall(cand, roster, slots);
        assert.ok(avoidable >= 0, `negative badge count for ${cand}/${roster}/${slots}`);
        assert.ok(avoidable <= actual,
          `avoidable ${avoidable} > actual ${actual} for ${cand}/${roster}/${slots}`);
        if (avoidable > 0) sawPositive = true;
      }
    }
  }
  assert.ok(sawPositive, 'the sweep must actually reach a badged case, or it proves nothing');
});

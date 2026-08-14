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

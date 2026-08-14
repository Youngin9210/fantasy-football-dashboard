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
